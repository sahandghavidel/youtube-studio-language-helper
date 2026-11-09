import { COMPONENTS, STABILITY_WINDOW_MS } from "./constants.js";
import { classifyAssetFilename, parseAssetFiles } from "./folder-parser.js";
import { validateParsedFolder } from "./validation.js";
import { expandLanguageTargets } from "./language-mapping.js";
import { pacingForTransition } from "./pacing.js";

export const WATCH_KEY = "folderWatchV1";
export const WATCH_MONITOR_LOCK = "studio-folder-monitor";
export const QUEUE_LOCK = "studio-language-component-queue";

export function assertWatchPage(binding, page) {
  if (!page?.ok || !binding.channelId || binding.channelId !== page.channelId || binding.videoId !== page.videoId) {
    throw new Error("Watch paused: the bound tab must show the original channel and video’s Languages page.");
  }
}

export function matchFiles(files, sources) {
  return files.filter(file => {
    const item = classifyAssetFilename(file.name);
    return item && (sources === null || sources.includes(item.language)) && !/^English\b/i.test(item.language) && !file.name.startsWith(".");
  });
}

export function openWatchIssue(session, key, reason, action, item = {}) {
  session.issues ??= {};
  if (session.issues[key]?.reason === reason) return;
  session.issues[key] = {
    id: crypto.randomUUID(), reason, action, language: item.language,
    component: item.component, file: item.file
  };
}

export function pauseWatch(session, reason, action) {
  session.enabled = false;
  session.reason = reason;
  const working = Object.values(session.results || {}).find(item => item.outcome === "working");
  openWatchIssue(session, "paused", reason, action, working);
}

export function alreadyInStudio(component, value) {
  return (component === "audio" ? /published|processing/i : /published/i).test(value || "");
}

export async function watchTargets(files, format, labels) {
  const names = new Set(files.map(file => file.name));
  const chosen = files.filter(file => {
    const item = classifyAssetFilename(file.name);
    if (!format || item.component !== "audio" || file.name.endsWith(format)) return true;
    return !names.has(item.language + " - audio" + format);
  });
  const validation = await validateParsedFolder(await parseAssetFiles(chosen));
  const { targets, errors } = expandLanguageTargets(validation.records.map(record => ({ ...record, languageCode: null })), labels);
  return { chosen, targets, errors };
}

export async function previewWatch(files, format, labels, rows, results, disabledLabels = []) {
  const { targets, errors } = await watchTargets(files, format, labels);
  const report = [];
  for (const target of targets) {
    const record = target.source;
    const row = rows.find(row => row.language === target.targetLanguage);
    for (const component of COMPONENTS) {
      const file = record.files[component];
      if (!file) continue;
      const prior = results[JSON.stringify([target.targetLanguage, component])];
      const mappingError = errors.find(error => error.targetLanguage === target.targetLanguage);
      const status = row?.[component] || "";
      let decision = "Add", reason = row ? "Studio row has no published item" : "New Studio language row";
      if (mappingError || !record.ready || !record.availableComponents.includes(component)) {
        decision = "Hold"; reason = mappingError?.message || record.errors.map(error => error.message).join(" ");
      } else if (alreadyInStudio(component, status) || ["complete", "skipped"].includes(prior?.outcome)) {
        decision = "Skip"; reason = alreadyInStudio(component, status) ? status : "Recorded " + prior.outcome;
      } else if (!row && disabledLabels.includes(target.targetLanguage)) {
        decision = "Review"; reason = "Studio language option is disabled and its row is unavailable";
      } else if (prior || (status && !/^[-–—]$|^add$/i.test(status))) {
        decision = "Review"; reason = prior?.message || status || prior.outcome;
      }
      report.push([target.targetLanguage, component, file.name, decision, reason]);
    }
  }
  return report;
}

// One scan executes at most one Studio component. The next scan reads fresh handles and rows.
export async function scanWatch(session, io, observations, retryKey = null) {
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
  const { chosen, targets, errors } = await watchTargets(files, session.format, session.labels);
  if (errors.length && session.mode !== "all") throw new Error(errors.map(e => e.message).join(" "));
  const held = errors.map(e => e.message);
  const unavailable = new Set(errors.map(e => e.targetLanguage));
  const heldKeys = new Set();
  function hold(key, reason, item) {
    heldKeys.add(key);
    openWatchIssue(session, key, reason, "Review the export file and its Studio language mapping in the helper.", item);
  }
  for (const error of errors) {
    const file = chosen.find(file => classifyAssetFilename(file.name)?.language === error.language &&
      ready.has(file.name) && !session.baseline.includes(file.name));
    if (file) hold("held:mapping:" + error.targetLanguage, error.message, { language: error.targetLanguage, file: file.name });
  }
  for (const target of targets) {
    if (unavailable.has(target.targetLanguage)) continue;
    for (const component of COMPONENTS) {
      const record = target.source;
      const file = record.files[component];
      if (!file || session.baseline.includes(file.name) || !ready.has(file.name)) continue;
      if (record.ready && record.availableComponents.includes(component)) continue;
      const reason = record.errors.filter(e => !e.component || e.component === component).map(e => e.message).join(" ");
      held.push(reason);
      hold("held:" + JSON.stringify([target.targetLanguage, component]), reason, { language: target.targetLanguage, component, file: file.name });
    }
  }
  for (const key of Object.keys(session.issues || {})) {
    const file = session.issues[key].file;
    if (key.startsWith("held:") && !heldKeys.has(key) && (!names.has(file) || ready.has(file))) {
      delete session.issues[key];
    }
  }
  for (const target of targets) {
    if (unavailable.has(target.targetLanguage)) continue;
    const record = target.source;
    for (const component of COMPONENTS) {
      const file = record.files[component];
      if (!file) continue;
      const key = JSON.stringify([target.targetLanguage, component]);
      const prior = session.results[key];
      if (retryKey && key !== retryKey) continue;
      const retry = retryKey === key && prior?.outcome === "blocked" && prior.file === file.name;
      if (retryKey && !retry) continue;
      if (prior && prior.outcome !== "working" && !retry) continue;
      const row = page.rows.find(row => row.language === target.targetLanguage);
      const visible = alreadyInStudio(component, row?.[component]);
      if (prior?.outcome === "working" && !visible) {
        throw new Error(`Review the interrupted ${target.targetLanguage} ${component} in Studio before resuming. No automatic retry.`);
      }
      if (!(retry && visible)) {
        if ((!retry && session.baseline.includes(file.name)) || !ready.has(file.name)) continue;
        if (!record.availableComponents.includes(component) || !record.ready) continue;
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
      if (session.results[key].outcome === "blocked") {
        openWatchIssue(session, key, session.results[key].message || "Studio blocked this upload.",
          "Check the Studio row, fix the problem, then choose Retry blocked file in the helper.", entry);
      } else if (session.issues) {
        delete session.issues[key];
      }
      await io.save(session);
      return `${entry.language} ${component}: ${session.results[key].outcome}`;
    }
  }
  return held.join(" · ") || (retryKey ? "Retry deferred. Check the paired folder, file stability, and upload cooldown." : "Watching for translated files.");
}
