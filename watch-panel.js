import { folderLanguages, selectionKey, watchDestinations } from "./lib/watch-selection.js";
import { filesFromDirectoryHandle } from "./lib/folder-parser.js";
import { expandLanguageTargets } from "./lib/language-mapping.js";
import { getDirectoryHandle, saveDirectoryHandle, getWatchSelection, saveWatchSelection } from "./lib/directory-store.js";
import { assertWatchPage, matchFiles, QUEUE_LOCK, scanWatch, WATCH_KEY } from "./lib/watch-folder.js";

export async function initializeWatch({ state, ui, transfer, refreshStudio }) {
  let session = (await chrome.storage.local.get(WATCH_KEY))[WATCH_KEY];
  let handle, observer, timer, busy = false, stopping = false, locked = false;
  let observations = new Map();
  const save = value => chrome.storage.local.set({ [WATCH_KEY]: value });
  const note = text => { ui["watch-status"].textContent = text; };
  let choices = [], selected = new Set(), mode = "all", contextKey, contextFolder, refreshId = 0;
  function drawChoices() {
    ui["watch-all"].checked = mode === "all";
    ui["watch-selected"].checked = mode === "selected";
    const list = ui["watch-languages"];
    list.hidden = mode === "all";
    list.replaceChildren();
    if (mode === "selected") {
      for (const language of [...new Set([...choices, ...selected])].sort((a,b) => a.localeCompare(b))) {
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = language;
        box.checked = selected.has(language);
        label.append(box, " " + language);
        list.append(label);
      }
      if (!list.childNodes.length) list.textContent = "Choose a folder with translated assets to select languages.";
    }
    const destinations = watchDestinations(mode === "all" ? choices : [...selected]);
    ui["watch-preview"].textContent = [
      destinations.length ? "Studio destinations: " + destinations.join(", ") : "No destinations selected yet.",
      mode === "all" ? "New languages that arrive later are included automatically." : "",
    ].filter(Boolean).join(" ");
  }
  async function refreshChoices() {
    const id = ++refreshId;
    const folder = state.directoryHandle, page = state.page;
    if (!folder || !page?.ok) {
      contextKey = null; contextFolder = null; choices = []; selected.clear(); mode = "all"; drawChoices(); return;
    }
    const key = selectionKey(page, folder);
    const sameContext = key === contextKey && folder === contextFolder;
    const accessible = await folder.queryPermission({ mode: "read" }) === "granted";
    const files = accessible ? await filesFromDirectoryHandle(folder) : [];
    let preference;
    if (!sameContext) {
      preference = await getWatchSelection(key, folder);
      if (!preference && session?.videoId === page.videoId && session.channelId === page.channelId) {
        const prior = await getDirectoryHandle("watch-directory");
        if (prior && await folder.isSameEntry(prior)) {
          preference = { mode: session.mode || "selected", sources: session.sources };
        }
      }
    }
    if (id !== refreshId) return;
    if (!sameContext) {
      selected = new Set(preference?.sources || []);
      mode = preference?.mode || "all";
    }
    contextKey = key; contextFolder = folder; choices = folderLanguages(files);
    drawChoices();
  }
  function changed() {
    drawChoices();
    if (contextKey) void saveWatchSelection(contextKey, contextFolder, { mode, sources: [...selected] })
      .catch(error => note(error.message));
  }
  function refreshIfOpen() {
    if (ui["watch-section"].open && !locked) void refreshChoices().catch(error => note(error.message));
  }
  ui["watch-section"].addEventListener("toggle", refreshIfOpen);
  document.addEventListener("watch-context-changed", refreshIfOpen);
  ui["watch-all"].addEventListener("change", () => { mode = "all"; changed(); });
  ui["watch-selected"].addEventListener("change", () => { mode = "selected"; changed(); });
  ui["watch-languages"].addEventListener("change", ({target}) => {
    if (target.checked) selected.add(target.value); else selected.delete(target.value);
    changed();
  });
  function render() {
    const active = Boolean(session?.enabled);
    ui["watch-start"].disabled = active || locked;
    ui["watch-stop"].disabled = !active;
    for (const key of ["watch-scope", "watch-existing", "watch-format"]) ui[key].disabled = active;
    for (const selector of [".identity-card", ".controls-card", ".languages-card"]) {
      document.querySelector(selector).inert = active || locked;
    }
    ui["watch-results"].textContent = Object.values(session?.results || {}).map(item =>
      `${item.language} · ${item.component} · ${item.outcome}${item.message ? " — " + item.message : ""}`
    ).join("\n");
  }
  const inspect = async () => {
    const reply = await chrome.tabs.sendMessage(session.tabId, { type: "INSPECT_PAGE" });
    if (!reply?.ok) throw new Error("The paired Studio tab is unavailable.");
    assertWatchPage(session, reply.page);
    return reply;
  };
  async function allowedFiles() {
    if (await handle.queryPermission({ mode: "read" }) !== "granted") throw new Error("Folder access expired. Grant access and resume.");
    return filesFromDirectoryHandle(handle);
  }
  async function process(target, component, file) {
    if (stopping) throw new Error("Watch stopped.");
    await inspect();
    const currentFile = await (await handle.getFileHandle(file.name)).getFile();
    if (currentFile.size !== file.size || currentFile.lastModified !== file.lastModified) throw new Error(`${file.name} changed during validation.`);
    const binding = { videoId: session.videoId, channelId: session.channelId };
    const reply = await chrome.tabs.sendMessage(session.tabId, { type: "PREPARE_COMPONENT", watch: true,
      binding, targetLanguage: target.targetLanguage, component, payload: { allowOverwrite: false } });
    if (!reply?.ok) throw new Error(reply?.error?.message || "Studio preparation failed.");
    if (reply.result.outcome !== "upload-ready") return reply.result;
    return transfer(currentFile, component, target.targetLanguage, { tabId: session.tabId, binding, note });
  }
  function disconnect() {
    clearInterval(timer);
    observer?.disconnect();
    observer = null;
  }
  async function scan() {
    if (!session?.enabled || busy || stopping) return;
    busy = true;
    try {
      const status = await scanWatch(session, { inspect, files: allowedFiles, now: Date.now, save, process }, observations);
      note(status);
    } catch (error) {
      session.enabled = false;
      session.reason = error.message;
      await save(session);
      note(`Paused: ${error.message}`);
      disconnect();
    } finally {
      busy = false;
      render();
    }
  }
  async function monitor(configure) {
    if (locked) return;
    await navigator.locks.request(QUEUE_LOCK, { ifAvailable: true }, async lock => {
      if (!lock) { note("Another queue is open. Stop it before starting watch mode."); return; }
      locked = true;
      try {
        await configure();
        observations = new Map();
        stopping = false;
        render();
        if ("FileSystemObserver" in globalThis) {
          try {
            observer = new FileSystemObserver(() => { void scan(); });
            await observer.observe(handle);
          } catch { observer?.disconnect(); observer = null; }
        }
        timer = setInterval(() => { void scan(); }, 5000);
        await scan();
        while (session.enabled || busy) await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        await refreshChoices().catch(error => note(error.message));
  if (session?.enabled) { session.enabled = false; session.reason = error.message; await save(session); }
        note(error.message);
      } finally {
        disconnect();
        locked = false;
        render();
      }
    });
  }
  async function configure() {
    if (state.busy || state.job?.status === "running") throw new Error("Finish or pause the manual queue first.");
    const page = await refreshStudio();
    if (!page?.ok || !state.directoryHandle) throw new Error("Choose a live folder and open the Studio Languages tab first.");
    handle = state.directoryHandle;
    const files = await allowedFiles();
    await refreshChoices();
    const sources = mode === "all" ? folderLanguages(files) : [...selected].sort();
    if (mode === "selected" && !sources.length) throw new Error("Select at least one language.");
    const previousHandle = await getDirectoryHandle("watch-directory");
    const same = session?.channelId === page.channelId && session.videoId === page.videoId &&
      previousHandle && await handle.isSameEntry(previousHandle);
    const scope = mode === "all" ? null : sources;
    const binding = { videoId: page.videoId, channelId: page.channelId };
    const dry = await chrome.tabs.sendMessage(state.tabId, { type: "DRY_RUN", binding });
    if (!dry?.ok) throw new Error(dry?.error?.message || "Studio preflight failed.");
    const labels = [...new Set([...dry.studioLabels, ...dry.rows.map(row => row.language)])];
    const { targets, errors } = expandLanguageTargets(sources.map(language => ({ language })), labels);
    if (errors.length && mode !== "all") throw new Error(errors.map(e => e.message).join(" "));
    const include = ui["watch-existing"].checked;
    const unavailable = new Set(errors.map(e => e.targetLanguage));
    const destinations = targets.map(t => t.targetLanguage).filter(name => !unavailable.has(name));
    if (!confirm(`Watch ${handle.name} for “${page.videoTitle}” (${page.videoId}) on channel ${page.channelId}?\nPublish missing subtitles and audio for: ${destinations.join(", ") || "none currently"}.\n${mode === "all" ? "New languages arriving later are included.\n" : ""}${errors.length ? "Held: " + [...unavailable].join(", ") + "\n" : ""}\n${include ? "Include existing files." : "Watch new arrivals and resume any pending work."}`)) throw new Error("Watch was not started.");
    const eligibleNames = matchFiles(files, scope).map(file => file.name);
    const previousEligible = same ? matchFiles(files, session.mode === "all" ? null : session.sources) : [];
    const previousNames = new Set(previousEligible.map(file => file.name));
    const baseline = same ? [...new Set([...session.baseline, ...eligibleNames.filter(name => !previousNames.has(name))])] : eligibleNames;
    session = { ...binding, tabId: state.tabId, folder: handle.name, mode, sources, labels, enabled: true,
      format: ui["watch-format"].value,
      baseline: include ? [] : baseline,
      results: same ? session.results : {}, last: same ? session.last : null };
    for (const [key, item] of Object.entries(session.results)) {
      if (item.outcome !== "working") continue;
      const row = dry.rows.find(row => row.language === item.language);
      if ((item.component === "subtitle" ? /published/i : /published|processing/i).test(row?.[item.component] || "")) continue;
      if (!confirm(`The last ${item.language} ${item.component} upload was interrupted. Have you checked Studio and confirmed it is safe to retry?`)) {
        session.enabled = false;
        throw new Error("Watch paused for review.");
      }
      delete session.results[key];
    }
    await saveDirectoryHandle(handle, "watch-directory");
    await save(session);
  }
  ui["watch-start"].addEventListener("click", () => void monitor(configure));
  ui["watch-stop"].addEventListener("click", async () => {
    stopping = true;
    session.enabled = false;
    disconnect();
    await save(session);
    note(busy ? "Stopping after the current component." : "Watch stopped.");
    render();
  });
  if (session) {
    ui["watch-format"].value = session.format || "";
    note(session.reason || "Watch stopped.");
  }
  await refreshChoices().catch(error => note(error.message));
  if (session?.enabled) {
    ui["watch-section"].open = true;
    void monitor(async () => {
      handle = await getDirectoryHandle("watch-directory");
      if (!handle) throw new Error("Choose the original folder again.");
      await inspect();
    });
  }
  render();
}
