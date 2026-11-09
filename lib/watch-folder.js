import { STABILITY_WINDOW_MS } from "./constants.js";
import { classifyAssetFilename, parseAssetFiles } from "./folder-parser.js";
import { validateParsedFolder } from "./validation.js";
import { expandLanguageTargets } from "./language-mapping.js";
import { pacingForTransition } from "./pacing.js";

export const WATCH_KEY = "folderWatchV1";
export const QUEUE_LOCK = "studio-language-component-queue";

export function assertWatchPage(binding, page) {
  if (!page?.ok || !binding.channelId || binding.channelId !== page.channelId || binding.videoId !== page.videoId) {
    throw new Error("Watch paused: the bound tab must show the original channel and video’s Languages page.");
  }
}

export function matchFiles(files, sources) {
  return files.filter(file => {
    const item = classifyAssetFilename(file.name);
    return item && ["subtitle", "audio"].includes(item.component) && (sources === null || sources.includes(item.language)) && !/^English\b/i.test(item.language) && !file.name.startsWith(".");
  });
}

// One scan executes at most one Studio component. The next scan reads fresh handles and rows.
export async function scanWatch(session, io, observations) {
  const page = await io.inspect();
  assertWatchPage(session, page.page);
  const files = matchFiles(await io.files(), session.mode === "all" ? null : session.sources);
  const now = io.now();
  const ready = new Set();
  const names = new Set(files.map(file => file.name));
  for (const name of observations.keys()) if (!names.has(name)) observations.delete(name);
  for (const file of files) {
    const version = JSON.stringify([file.size, file.lastModified]);
    const old = observations.get(file.name);
    if (old?.version !== version) observations.set(file.name, { version, since: now });
    else if (now - old.since >= STABILITY_WINDOW_MS) ready.add(file.name);
  }
  const chosen = files.filter(file => {
    const item = classifyAssetFilename(file.name);
    if (!session.format || item.component !== "audio" || file.name.endsWith(session.format)) return true;
    return !names.has(item.language + " - audio" + session.format);
  });
  const validation = await validateParsedFolder(await parseAssetFiles(chosen));
  const { targets, errors } = expandLanguageTargets(validation.records, session.labels);
  if (errors.length && session.mode !== "all") throw new Error(errors.map(e => e.message).join(" "));
  const held = errors.map(e => e.message);
  const unavailable = new Set(errors.map(e => e.targetLanguage));
  for (const target of targets) {
    if (unavailable.has(target.targetLanguage)) continue;
    const record = target.source;
    for (const component of ["subtitle", "audio"]) {
      const file = record.files[component];
      if (!file) continue;
      const key = JSON.stringify([target.targetLanguage, component]);
      const prior = session.results[key];
      if (prior && prior.outcome !== "working") continue;
      const row = page.rows.find(row => row.language === target.targetLanguage);
      const visible = new RegExp(component === "audio" ? "published|processing" : "published", "i").test(row?.[component] || "");
      if (prior?.outcome === "working" && !visible) {
        throw new Error(`Review the interrupted ${target.targetLanguage} ${component} in Studio before resuming. No automatic retry.`);
      }
      if (session.baseline.includes(file.name) || !ready.has(file.name)) continue;
      if (!record.availableComponents.includes(component) || !record.ready) {
        held.push(`${target.sourceLanguage} ${component}: ${record.errors.map(error => error.message).join(" ")}`);
        continue;
      }
      if (session.last && !visible) {
        const pacing = pacingForTransition({ target: { id: session.last.target } }, { target, component },
          { fastSkip: session.last.fastSkip, lastMutationAtMs: session.last.at, nowMs: now, random: () => 1 });
        if (now - session.last.finishedAt < pacing.milliseconds) continue;
      }
      const entry = { language: target.targetLanguage, component, file: file.name };
      if (visible) {
        session.results[key] = { ...entry, outcome: "skipped", message: row[component] };
      } else {
        // Persist before the first Studio mutation. If Chrome exits, reconcile before retrying.
        session.results[key] = { ...entry, outcome: "working" };
        await io.save(session);
        const result = await io.process(target, component, file);
        if (!["complete", "skipped", "blocked"].includes(result?.outcome)) throw new Error("Unverified Studio result.");
        session.results[key] = { ...entry, outcome: result.outcome, message: result.message };
        session.last = { target: target.id, finishedAt: io.now(), at: result.mutationCommittedAtMs || null, fastSkip: !!result.fastSkip };
      }
      await io.save(session);
      return `${entry.language} ${component}: ${session.results[key].outcome}`;
    }
  }
  return held.join(" · ") || "Watching for new subtitles and audio.";
}
