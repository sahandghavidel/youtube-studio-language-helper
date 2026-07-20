import {
  COMPONENTS,
  COMPONENT_LABELS,
  COMPONENT_STATUS,
  JOB_STATUS,
  LANGUAGE_STATUS,
  STABILITY_WINDOW_MS,
  STATUS_TEXT,
  TRANSFER_CHUNK_BYTES
} from "./lib/constants.js";
import { clearDirectoryHandle, getDirectoryHandle, saveDirectoryHandle } from "./lib/directory-store.js";
import { filesFromDirectoryHandle, parseAssetFiles, snapshotsEqual } from "./lib/folder-parser.js";
import { appendJobLog, clearJob, createJob, loadJob, nextIncompleteWork, saveJob, setComponentResult } from "./lib/job-store.js";
import { expandLanguageTargets } from "./lib/language-mapping.js";
import { pacingForTransition } from "./lib/pacing.js";
import { buildCompletionNotification, buildFailureNotification, sendTelegramNotification } from "./lib/telegram-notifier.js";
import { validateParsedFolder } from "./lib/validation.js";

const state = {
  directoryHandle: null,
  fallbackFiles: null,
  validation: null,
  stableSnapshot: null,
  stabilityConfirmed: false,
  folderName: null,
  page: null,
  tabId: null,
  job: null,
  studioLabels: null,
  mappingErrors: [],
  runToken: 0,
  pauseRequested: false,
  stopRequested: false,
  busy: false,
  unexpectedErrors: 0,
  permissionNeeded: false
};

const ui = Object.fromEntries(Array.from(document.querySelectorAll("[id]")).map((element) => [element.id, element]));

function setBusy(value, message = null) {
  state.busy = value;
  if (message) ui["job-message"].textContent = message;
  renderControls();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

async function initialize() {
  wireEvents();
  await Promise.allSettled([restoreDirectory(), refreshStudioPage(), restoreJob()]);
  render();
}

function wireEvents() {
  ui["choose-folder"].addEventListener("click", chooseFolder);
  ui["grant-folder"].addEventListener("click", grantFolderAccess);
  ui["directory-fallback"].addEventListener("change", handleFallbackSelection);
  ui["refresh-page"].addEventListener("click", refreshStudioPage);
  ui["dry-run"].addEventListener("click", runDryRun);
  ui.start.addEventListener("click", startJob);
  ui.pause.addEventListener("click", pauseJob);
  ui.resume.addEventListener("click", resumeJob);
  ui.stop.addEventListener("click", stopJob);
  ui.retry.addEventListener("click", retryFailed);
  ui.reset.addEventListener("click", resetJob);
  ui["select-all"].addEventListener("click", () => setAllSelected(true));
  ui["select-none"].addEventListener("click", () => setAllSelected(false));
  ui["language-list"].addEventListener("change", handleLanguageSelection);
  ui["language-list"].addEventListener("click", handleLanguageAction);
  ui["copy-log"].addEventListener("click", copyLog);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.activeJob?.newValue) {
      const externallyPaused = state.job?.status === JOB_STATUS.RUNNING
        && changes.activeJob.newValue.status === JOB_STATUS.PAUSED;
      state.job = changes.activeJob.newValue;
      if (externallyPaused) {
        state.pauseRequested = true;
        ui["job-message"].textContent = state.job.pauseReason || "The queue was paused by a Studio safety check.";
      }
      render();
    }
  });
}

async function chooseFolder() {
  try {
    if (typeof window.showDirectoryPicker !== "function") {
      ui["directory-fallback"].click();
      return;
    }
    const handle = await window.showDirectoryPicker({ mode: "read", id: "youtube-language-assets" });
    state.directoryHandle = handle;
    state.permissionNeeded = false;
    state.fallbackFiles = null;
    state.folderName = handle.name;
    await saveDirectoryHandle(handle);
    await validateCurrentFolder(true);
  } catch (error) {
    if (error.name !== "AbortError") reportLocalError("choose-folder", error);
  }
}

async function restoreDirectory() {
  try {
    const handle = await getDirectoryHandle();
    if (!handle) return;
    state.directoryHandle = handle;
    state.folderName = handle.name;
    const permission = await handle.queryPermission({ mode: "read" });
    if (permission === "granted") {
      state.permissionNeeded = false;
      await validateCurrentFolder(false);
    } else {
      state.permissionNeeded = true;
      ui["grant-folder"].classList.remove("hidden");
      ui["folder-note"].textContent = "Chrome remembers this folder, but read permission must be granted again.";
    }
  } catch (error) {
    reportLocalError("restore-folder", error);
  }
}

async function grantFolderAccess() {
  if (!state.directoryHandle) return;
  const permission = await state.directoryHandle.requestPermission({ mode: "read" });
  if (permission === "granted") {
    state.permissionNeeded = false;
    ui["grant-folder"].classList.add("hidden");
    await validateCurrentFolder(true);
  }
}

async function handleFallbackSelection(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  const nextFolderName = files[0].webkitRelativePath?.split("/")[0] || "Selected folder";
  const sameFallbackFolder = Boolean(state.fallbackFiles && state.folderName === nextFolderName);
  state.directoryHandle = null;
  state.permissionNeeded = false;
  state.fallbackFiles = files;
  state.folderName = nextFolderName;
  if (!sameFallbackFolder) {
    state.stableSnapshot = null;
    state.fallbackCheckedAt = 0;
  }
  await clearDirectoryHandle();
  await validateFiles(files, false);
  event.target.value = "";
  ui["folder-note"].textContent = "Directory fallback selected. Re-select the same folder after five seconds to confirm file stability.";
}

async function validateCurrentFolder(checkStability) {
  if (!state.directoryHandle) return;
  setBusy(true, "Reading and validating the selected folder…");
  try {
    const firstFiles = await filesFromDirectoryHandle(state.directoryHandle);
    await validateFiles(firstFiles, false);
    if (checkStability) {
      ui["folder-note"].textContent = `Checking that files remain unchanged for ${STABILITY_WINDOW_MS / 1000} seconds…`;
      await new Promise((resolve) => setTimeout(resolve, STABILITY_WINDOW_MS));
      const secondFiles = await filesFromDirectoryHandle(state.directoryHandle);
      const secondParsed = await parseAssetFiles(secondFiles);
      state.stabilityConfirmed = snapshotsEqual(state.stableSnapshot, secondParsed.snapshot);
      if (state.stabilityConfirmed) {
        state.stableSnapshot = secondParsed.snapshot;
        await validateFiles(secondFiles, true);
      } else {
        ui["folder-note"].textContent = "One or more files changed during validation. Wait for exports to finish, then choose the folder again.";
      }
    }
  } finally {
    setBusy(false);
    render();
  }
}

async function validateFiles(files, stable) {
  const parsed = await parseAssetFiles(files);
  state.validation = await validateParsedFolder(parsed);
  if (state.fallbackFiles && state.stableSnapshot && Date.now() - (state.fallbackCheckedAt || 0) >= STABILITY_WINDOW_MS) {
    state.stabilityConfirmed = snapshotsEqual(state.stableSnapshot, parsed.snapshot);
  } else if (!state.directoryHandle) {
    state.stabilityConfirmed = false;
  }
  state.stableSnapshot = parsed.snapshot;
  state.fallbackCheckedAt = Date.now();
  if (stable) state.stabilityConfirmed = true;
  state.studioLabels = null;
  state.mappingErrors = [];
  render();
}

async function currentFiles() {
  if (state.directoryHandle) return filesFromDirectoryHandle(state.directoryHandle);
  return state.fallbackFiles || [];
}

async function refreshStudioPage() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const preferred = tabs[0];
    if (!preferred?.id) throw new Error("Chrome did not provide the active tab. Keep the Languages tab active and try Refresh again.");
    const response = await connectToStudio(preferred.id);
    if (!response?.ok) throw new Error(response?.error?.message || "Studio content script did not respond.");
    state.tabId = preferred.id;
    state.page = response.page;
    if (!state.page.ok) throw new Error("The Studio page is not a signed-in Languages page for one identifiable video.");
    ui["connection-error"].textContent = "";
    ui["connection-error"].classList.add("hidden");
    setConnection("Connected", "success");
    render();
    return state.page;
  } catch (error) {
    state.page = null;
    state.tabId = null;
    setConnection("Studio unavailable", "danger");
    ui["connection-error"].textContent = error.message;
    ui["connection-error"].classList.remove("hidden");
    ui["job-message"].textContent = error.message;
    render();
    return null;
  }
}

async function connectToStudio(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "INSPECT_PAGE" });
  } catch (initialError) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
    try {
      return await chrome.tabs.sendMessage(tabId, { type: "INSPECT_PAGE" });
    } catch (retryError) {
      throw new Error(`Could not connect to the Studio page after reinjecting the helper: ${retryError.message || initialError.message}`);
    }
  }
}

function setConnection(text, tone) {
  ui["connection-badge"].textContent = text;
  ui["connection-badge"].className = `badge ${tone}`;
}

async function restoreJob() {
  state.job = await loadJob();
  if (state.job?.status === JOB_STATUS.RUNNING) {
    state.job.status = JOB_STATUS.PAUSED;
    state.job.pauseReason = "The side panel or Chrome restarted while the job was running. Review the interrupted component, then use Retry Failed and Resume.";
    for (const target of state.job.targets) {
      for (const component of COMPONENTS) {
        if (target.components[component].status === COMPONENT_STATUS.WORKING) {
          target.components[component].status = COMPONENT_STATUS.FAILED;
          target.components[component].phase = "failed";
          target.components[component].message = "Interrupted before Studio success could be verified.";
        }
      }
      updateTargetStatus(target);
    }
    appendJobLog(state.job, { level: "warning", operation: "restart-recovery", message: state.job.pauseReason, retrySafe: true });
    await saveJob(state.job);
  }
}

function selectedRecords() {
  return (state.validation?.records || []).filter((record) => record.selected !== false);
}

function expandedTargets() {
  const result = expandLanguageTargets(selectedRecords(), state.studioLabels);
  state.mappingErrors = result.errors;
  return result.targets;
}

async function runDryRun() {
  if (!state.page || !state.validation || !state.stabilityConfirmed) return;
  setBusy(true, "Dry Run is inspecting Studio. It will not add or upload anything.");
  try {
    await refreshStudioPage();
    const binding = { videoId: state.page.videoId, channelId: state.page.channelId };
    const response = await chrome.tabs.sendMessage(state.tabId, { type: "DRY_RUN", binding });
    if (!response?.ok) throwRemote(response, "dry-run");
    state.studioLabels = response.studioLabels;
    const targets = expandedTargets();
    if (state.mappingErrors.length) throw new Error(state.mappingErrors.map((error) => error.message).join(" "));
    const newJob = createJob({ page: state.page, folderName: state.folderName, records: selectedRecords(), targets });
    state.job = mergeExistingProgress(newJob, state.job);
    state.job.dryRunCompletedAt = new Date().toISOString();
    appendJobLog(state.job, {
      operation: "dry-run",
      message: `Dry Run completed with ${selectedRecords().length} selected asset sets and ${targets.length} Studio destinations. No Studio changes were made.`
    });
    reconcileJobRows(state.job, response.rows);
    await saveJob(state.job);
    ui["job-message"].textContent = "Dry Run passed. Review selections and press Start when ready.";
  } catch (error) {
    reportLocalError("dry-run", error);
  } finally {
    setBusy(false);
    render();
  }
}

function mergeExistingProgress(newJob, existing) {
  if (!existing || existing.id !== newJob.id) return newJob;
  const oldTargets = new Map(existing.targets.map((target) => [target.id, target]));
  newJob.targets = newJob.targets.map((target) => {
    const old = oldTargets.get(target.id);
    return old ? { ...target, selected: old.selected, status: old.status, components: old.components, overwrite: old.overwrite || {} } : target;
  });
  newJob.logs = existing.logs || [];
  newJob.createdAt = existing.createdAt;
  return newJob;
}

function reconcileJobRows(job, rows) {
  const rowMap = new Map((rows || []).map((row) => [row.language, row]));
  for (const target of job.targets) {
    const row = rowMap.get(target.targetLanguage);
    if (!row) continue;
    if (target.components.subtitle.status === COMPONENT_STATUS.COMPLETE && !/published/i.test(row.subtitle || "")) {
      target.components.subtitle.status = COMPONENT_STATUS.WAITING;
      target.components.subtitle.message = "Stored completion could not be verified in Studio and will be checked again.";
    }
    const audioState = row.audio || "";
    const audioTransferConfirmed = /published/i.test(audioState)
      || (/processing/i.test(audioState) && /\b\d{1,3}%/.test(audioState));
    if (target.components.audio.status === COMPONENT_STATUS.COMPLETE && !audioTransferConfirmed) {
      target.components.audio.status = COMPONENT_STATUS.WAITING;
      target.components.audio.message = /processing/i.test(audioState)
        ? "Studio shows Processing without a percentage; Resume will wait for transfer confirmation."
        : "Stored completion could not be verified in Studio and will be checked again.";
    }
    markVisibleExistingComponent(target, "metadata", row.metadata, /published/i);
    markVisibleExistingComponent(target, "subtitle", row.subtitle, /published/i);
    markVisibleExistingComponent(target, "audio", row.audio, /published|processing/i);
    markVisibleExistingComponent(target, "thumbnail", row.thumbnail, /published/i);
    updateTargetStatus(target);
  }
}

function markVisibleExistingComponent(target, component, visibleState, pattern) {
  if (!pattern.test(visibleState || "")) return;
  if (target.components[component].status === COMPONENT_STATUS.COMPLETE) return;
  target.components[component].status = COMPONENT_STATUS.SKIPPED;
  target.components[component].phase = "visible-summary-skip";
  target.components[component].message = `Dry Run found existing Studio state in the main table (${visibleState}); language details will not be opened.`;
  target.components[component].verifiedAt = new Date().toISOString();
}

async function startJob() {
  if (!canStart()) return;
  const selectedCount = state.job.targets.filter((target) => target.selected).length;
  const approved = window.confirm(`Start sequential processing for ${selectedCount} Studio language destinations on video ${state.page.videoId}? Existing components will not be deleted or replaced without explicit confirmation.`);
  if (!approved) return;
  state.pauseRequested = false;
  state.stopRequested = false;
  state.unexpectedErrors = 0;
  state.job.status = JOB_STATUS.RUNNING;
  state.job.pauseReason = null;
  await saveJob(state.job);
  await chrome.runtime.sendMessage({ type: "SET_RUNTIME_TARGET", tabId: state.tabId, videoId: state.page.videoId, channelId: state.page.channelId });
  void runQueue(++state.runToken);
}

async function runQueue(token) {
  setBusy(true, "Processing the sequential queue…");
  try {
    const freshFiles = await currentFiles();
    const parsed = await parseAssetFiles(freshFiles);
    if (!snapshotsEqual(state.stableSnapshot, parsed.snapshot)) throw new Error("Folder files changed after preflight. The job was paused before uploading.");
    const validation = await validateParsedFolder(parsed);
    const records = new Map(validation.records.map((record) => [record.language, record]));

    let restoredCooldownCompleted = true;
    if (state.job.cooldown?.until > Date.now()) {
      restoredCooldownCompleted = await waitForQueueCooldown(token, state.job.cooldown);
    } else if (state.job.cooldown) {
      state.job.cooldown = null;
      await saveJob(state.job);
    }

    while (restoredCooldownCompleted && token === state.runToken && !state.pauseRequested && !state.stopRequested) {
      const work = nextIncompleteWork(state.job);
      if (!work) break;
      const { target, component } = work;
      const record = records.get(target.sourceLanguage);
      if (!record?.ready) throw new Error(`Source files for ${target.sourceLanguage} are no longer valid.`);
      state.job.currentTargetId = target.id;
      target.status = STATUS_TEXT[component];
      setComponentResult(state.job, target.id, component, { status: COMPONENT_STATUS.WORKING, message: null, phase: "preparing" });
      appendJobLog(state.job, { operation: component, language: target.targetLanguage, message: `Starting ${component}.` });
      await saveJob(state.job);
      render();

      let failureNotification = null;
      let componentOutcome = null;
      try {
        const result = await prepareAndRunComponent(target, component, record);
        componentOutcome = result;
        applyComponentOutcome(target, component, result);
        state.unexpectedErrors = 0;
      } catch (error) {
        state.unexpectedErrors += 1;
        setComponentResult(state.job, target.id, component, { status: COMPONENT_STATUS.FAILED, message: error.message, phase: "failed" });
        target.status = LANGUAGE_STATUS.FAILED;
        appendJobLog(state.job, diagnosticLog(error, component, target.targetLanguage));
        state.pauseRequested = true;
        state.job.pauseReason = `Paused after ${target.targetLanguage} ${component} failed. Review the diagnostic, then use Retry Failed and Resume.`;
        failureNotification = buildFailureNotification(state.job, {
          language: target.targetLanguage,
          operation: component,
          reason: error.message
        });
      }

      updateTargetStatus(target);
      await saveJob(state.job);
      render();
      if (failureNotification) {
        await notifyTelegramAndLog(failureNotification, "error-notification", target.targetLanguage);
        await saveJob(state.job);
        render();
      }

      if (!state.pauseRequested && !state.stopRequested) {
        const nextWork = nextIncompleteWork(state.job);
        const pacing = pacingForTransition(work, nextWork, { fastSkip: componentOutcome?.fastSkip === true });
        if (pacing) {
          const completed = await beginQueueCooldown(token, pacing);
          if (!completed) break;
        }
      }
    }

    if (state.stopRequested) {
      state.job.status = JOB_STATUS.STOPPED;
      state.job.pauseReason = "Stopped by the user after the current atomic component finished.";
    } else if (state.pauseRequested) {
      state.job.status = JOB_STATUS.PAUSED;
      state.job.pauseReason ||= "Paused by the user after the current atomic component finished.";
    } else if (!nextIncompleteWork(state.job)) {
      state.job.status = JOB_STATUS.COMPLETE;
      state.job.pauseReason = null;
      state.job.cooldown = null;
      appendJobLog(state.job, { operation: "queue", message: "All selected destinations reached a terminal component state." });
      await chrome.runtime.sendMessage({ type: "CLEAR_RUNTIME_TARGET" });
      await saveJob(state.job);
      await notifyTelegramAndLog(buildCompletionNotification(state.job), "completion-notification");
    }
    await saveJob(state.job);
  } catch (error) {
    state.job.status = JOB_STATUS.PAUSED;
    state.job.pauseReason = error.message;
    appendJobLog(state.job, diagnosticLog(error, "queue", null));
    await saveJob(state.job);
    await notifyTelegramAndLog(buildFailureNotification(state.job, {
      operation: "queue",
      reason: error.message
    }), "error-notification");
    await saveJob(state.job);
  } finally {
    setBusy(false, state.job.pauseReason || (state.job.status === JOB_STATUS.COMPLETE ? "Queue complete." : "Queue stopped."));
    render();
  }
}

async function notifyTelegramAndLog(message, operation, language = null) {
  const result = await sendTelegramNotification(message);
  appendJobLog(state.job, {
    level: result.success ? "info" : "warning",
    operation,
    language,
    message: result.success
      ? "Telegram notification sent through the local Ultimate Video Editor server."
      : `Telegram notification was not sent: ${result.error}`,
    retrySafe: true
  });
  return result;
}

async function beginQueueCooldown(token, pacing) {
  const seconds = Math.ceil(pacing.milliseconds / 1000);
  const reason = pacing.kind === "after-visible-skip"
    ? `Brief ${seconds}s settle after skipping visible existing work for ${pacing.fromLanguage}.`
    : pacing.kind === "between-languages"
    ? `Cooling down ${seconds}s before ${pacing.toLanguage}.`
    : `Cooling down ${seconds}s before ${COMPONENT_LABELS[pacing.nextComponent]} for ${pacing.toLanguage}.`;
  state.job.cooldown = {
    kind: pacing.kind,
    until: Date.now() + pacing.milliseconds,
    reason,
    fromLanguage: pacing.fromLanguage,
    toLanguage: pacing.toLanguage,
    nextComponent: pacing.nextComponent
  };
  appendJobLog(state.job, {
    operation: "pacing",
    language: pacing.toLanguage,
    message: reason
  });
  await saveJob(state.job);
  return waitForQueueCooldown(token, state.job.cooldown);
}

async function waitForQueueCooldown(token, cooldown) {
  while (Date.now() < cooldown.until) {
    if (token !== state.runToken || state.pauseRequested || state.stopRequested) return false;
    const remainingSeconds = Math.max(1, Math.ceil((cooldown.until - Date.now()) / 1000));
    ui["job-message"].textContent = `${cooldown.reason.replace(/\d+s/, `${remainingSeconds}s`)} Pause or Stop remains available.`;
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, cooldown.until - Date.now())));
  }
  if (token !== state.runToken || state.pauseRequested || state.stopRequested) return false;
  state.job.cooldown = null;
  await saveJob(state.job);
  ui["job-message"].textContent = "Cooldown complete. Continuing the sequential queue…";
  return true;
}

async function prepareAndRunComponent(target, component, record) {
  const response = await chrome.tabs.sendMessage(state.tabId, {
    type: "PREPARE_COMPONENT",
    binding: { videoId: state.job.videoId, channelId: state.job.channelId },
    targetLanguage: target.targetLanguage,
    component,
    payload: {
      title: record.title,
      description: record.description,
      allowOverwrite: Boolean(target.overwrite?.[component])
    }
  });
  if (!response?.ok) throwRemote(response, component);
  if (response.result.outcome !== "upload-ready") return response.result;
  const file = record.files[component];
  if (!file) throw new Error(`No ${component} file is available for ${record.language}.`);
  return transferFile(file, component, target.targetLanguage);
}

function applyComponentOutcome(target, component, result) {
  const status = result.outcome === "complete" ? COMPONENT_STATUS.COMPLETE
    : result.outcome === "skipped" ? COMPONENT_STATUS.SKIPPED
      : result.outcome === "blocked" ? COMPONENT_STATUS.BLOCKED
        : COMPONENT_STATUS.FAILED;
  setComponentResult(state.job, target.id, component, { status, message: result.message || null, phase: result.outcome });
  appendJobLog(state.job, {
    level: status === COMPONENT_STATUS.BLOCKED ? "warning" : status === COMPONENT_STATUS.FAILED ? "error" : "info",
    operation: component,
    language: target.targetLanguage,
    message: result.message || result.outcome,
    retrySafe: status !== COMPONENT_STATUS.COMPLETE
  });
}

function updateTargetStatus(target) {
  const statuses = Object.values(target.components).map((component) => component.status);
  if (statuses.some((status) => status === COMPONENT_STATUS.FAILED)) target.status = LANGUAGE_STATUS.FAILED;
  else if (statuses.some((status) => status === COMPONENT_STATUS.BLOCKED)) target.status = LANGUAGE_STATUS.BLOCKED;
  else if (statuses.every((status) => [COMPONENT_STATUS.COMPLETE, COMPONENT_STATUS.SKIPPED].includes(status))) target.status = LANGUAGE_STATUS.COMPLETE;
  else target.status = LANGUAGE_STATUS.WAITING;
}

async function transferFile(file, component, language) {
  const transferId = crypto.randomUUID();
  const port = chrome.tabs.connect(state.tabId, { name: "language-helper-file-transfer" });
  let closed = false;
  let lastPersistedPhase = null;
  const waiters = [];
  let terminalResolve;
  let terminalReject;
  const terminal = new Promise((resolve, reject) => { terminalResolve = resolve; terminalReject = reject; });

  port.onMessage.addListener((message) => {
    if (message.transferId !== transferId) return;
    if (message.type === "ack") waiters.shift()?.resolve(message);
    if (message.type === "progress" && message.message) {
      ui["job-message"].textContent = message.message;
      const target = state.job?.targets.find((item) => item.id === state.job.currentTargetId && item.targetLanguage === language);
      const componentState = target?.components?.[component];
      if (componentState) {
        componentState.message = message.message;
        componentState.phase = message.phase || componentState.phase;
        if (message.phase && message.phase !== lastPersistedPhase) {
          lastPersistedPhase = message.phase;
          void saveJob(state.job);
        }
      }
    }
    if (message.type === "complete") terminalResolve(message.result);
    if (message.type === "error") terminalReject(remoteError(message.error, component));
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    const error = new Error("File transfer disconnected. The job was paused safely.");
    waiters.splice(0).forEach((waiter) => waiter.reject(error));
    terminalReject(error);
  });

  const sendAndAck = (message, timeout = 60_000) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error("File transfer port is closed."));
    const timer = setTimeout(() => reject(new Error("Timed out waiting for a file-transfer acknowledgement.")), timeout);
    waiters.push({
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
    port.postMessage(message);
  });

  try {
    await sendAndAck({ type: "start", transferId, component, language, name: file.name, size: file.size, mimeType: file.type, lastModified: file.lastModified });
    let index = 0;
    for (let offset = 0; offset < file.size; offset += TRANSFER_CHUNK_BYTES) {
      if (state.pauseRequested || state.stopRequested) throw new Error("Transfer paused before the file was attached.");
      const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + TRANSFER_CHUNK_BYTES)).arrayBuffer());
      await sendAndAck({ type: "chunk", transferId, index, data: bytesToBase64(bytes) });
      index += 1;
      ui["job-message"].textContent = `${language}: transferring ${COMPONENT_LABELS[component]} ${formatBytes(Math.min(file.size, offset + bytes.byteLength))} / ${formatBytes(file.size)}`;
    }
    port.postMessage({ type: "end", transferId });
    return await terminal;
  } finally {
    try { port.disconnect(); } catch { /* already disconnected */ }
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + stride)));
  }
  return btoa(binary);
}

function throwRemote(response, operation) {
  throw remoteError(response?.error || { message: `${operation} failed without a diagnostic.` }, operation);
}

function remoteError(payload, operation) {
  const error = new Error(payload?.message || `${operation} failed.`);
  error.diagnostic = payload?.diagnostic || { operation, expected: "successful Studio operation", found: error.message, retrySafe: true };
  return error;
}

function diagnosticLog(error, operation, language) {
  const diagnostic = error.diagnostic || {};
  return {
    level: "error",
    operation: diagnostic.operation || operation,
    language,
    message: error.message,
    expected: diagnostic.expected,
    found: diagnostic.found,
    retrySafe: diagnostic.retrySafe ?? true
  };
}

async function pauseJob() {
  if (!state.job || state.job.status !== JOB_STATUS.RUNNING) return;
  state.pauseRequested = true;
  ui["job-message"].textContent = "Pause requested. The extension will stop after the current atomic component.";
  renderControls();
}

async function resumeJob() {
  if (!state.job || ![JOB_STATUS.PAUSED, JOB_STATUS.STOPPED].includes(state.job.status)) return;
  state.pauseRequested = false;
  state.stopRequested = false;
  state.job.status = JOB_STATUS.RUNNING;
  state.job.pauseReason = null;
  await saveJob(state.job);
  await chrome.runtime.sendMessage({ type: "SET_RUNTIME_TARGET", tabId: state.tabId, videoId: state.job.videoId, channelId: state.job.channelId });
  void runQueue(++state.runToken);
}

async function stopJob() {
  if (!state.job || state.job.status !== JOB_STATUS.RUNNING) return;
  state.stopRequested = true;
  ui["job-message"].textContent = "Stop requested. Progress will remain saved.";
  renderControls();
}

async function retryFailed() {
  if (!state.job) return;
  for (const target of state.job.targets) {
    for (const component of COMPONENTS) {
      if (target.components[component].status === COMPONENT_STATUS.FAILED) {
        target.components[component].status = COMPONENT_STATUS.WAITING;
        target.components[component].phase = "waiting";
        target.components[component].message = null;
      }
    }
    updateTargetStatus(target);
  }
  appendJobLog(state.job, { operation: "retry", message: "Failed components were reset to Waiting." });
  await saveJob(state.job);
  render();
}

async function resetJob() {
  if (!state.job) return;
  if (!window.confirm("Reset this job and remove all saved component progress? The selected folder will remain remembered.")) return;
  state.runToken += 1;
  state.pauseRequested = true;
  state.job = null;
  state.studioLabels = null;
  await clearJob();
  await chrome.runtime.sendMessage({ type: "CLEAR_RUNTIME_TARGET" });
  render();
}

function setAllSelected(selected) {
  if (!state.validation || state.job?.status === JOB_STATUS.RUNNING) return;
  for (const record of state.validation.records) record.selected = selected;
  state.studioLabels = null;
  state.job = null;
  render();
}

function handleLanguageSelection(event) {
  const checkbox = event.target.closest('input[data-source-language]');
  if (!checkbox || !state.validation) return;
  const record = state.validation.records.find((item) => item.language === checkbox.dataset.sourceLanguage);
  if (record) record.selected = checkbox.checked;
  state.studioLabels = null;
  state.job = null;
  render();
}

async function handleLanguageAction(event) {
  const button = event.target.closest("button[data-overwrite-target]");
  if (!button || !state.job) return;
  const target = state.job.targets.find((item) => item.id === button.dataset.overwriteTarget);
  const component = button.dataset.component;
  if (!target || !["metadata", "thumbnail"].includes(component)) return;
  const approved = window.confirm(`Allow replacing the existing ${component} for ${target.targetLanguage}? This approval applies only to this component and this job.`);
  if (!approved) return;
  target.overwrite ||= {};
  target.overwrite[component] = true;
  target.components[component].status = COMPONENT_STATUS.WAITING;
  target.components[component].message = "Overwrite explicitly approved; waiting to retry.";
  updateTargetStatus(target);
  appendJobLog(state.job, { level: "warning", operation: "overwrite-approved", language: target.targetLanguage, message: `Explicit overwrite approval recorded for ${component}.` });
  await saveJob(state.job);
  render();
}

function canDryRun() {
  return Boolean(state.page?.ok && state.validation && state.stabilityConfirmed && selectedRecords().length && selectedRecords().every((record) => record.ready) && !state.busy);
}

function canStart() {
  return Boolean(canDryRun() && state.job?.dryRunCompletedAt && state.job.id.includes(state.page.videoId) && state.job.targets.some((target) => target.selected));
}

function render() {
  renderIdentity();
  renderStats();
  renderPreflight();
  renderControls();
  renderLanguages();
  renderLogs();
}

function renderIdentity() {
  ui["channel-value"].textContent = state.page?.channelName || state.page?.channelId || "—";
  ui["video-title-value"].textContent = state.page?.videoTitle || "—";
  ui["video-id-value"].textContent = state.page?.videoId || "—";
  ui["folder-value"].textContent = state.folderName || "None selected";
  ui["grant-folder"].classList.toggle("hidden", !state.permissionNeeded);
}

function renderStats() {
  const counts = state.validation?.counts || { found: 0, ready: 0, incomplete: 0 };
  ui["found-count"].textContent = counts.found;
  ui["destination-count"].textContent = state.validation ? expandLanguageTargets(selectedRecords()).targets.length : 0;
  ui["ready-count"].textContent = counts.ready;
  ui["incomplete-count"].textContent = counts.incomplete;
}

function renderPreflight() {
  ui["stability-badge"].textContent = state.stabilityConfirmed ? "Files stable" : "Stability required";
  ui["stability-badge"].className = `badge ${state.stabilityConfirmed ? "success" : "warning"}`;
  if (!state.validation) {
    ui["preflight-report"].textContent = "Choose an exported asset folder to begin validation.";
    return;
  }
  const errors = [
    ...state.validation.globalErrors.map((entry) => entry.message),
    ...state.validation.records.flatMap((record) => record.errors.map((entry) => `${record.language}: ${entry.message}`)),
    ...state.mappingErrors.map((entry) => entry.message)
  ];
  const ignored = state.validation.ignored.length;
  ui["preflight-report"].innerHTML = errors.length
    ? `<p class="error"><strong>${errors.length} validation issue${errors.length === 1 ? "" : "s"}</strong></p><ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>`
    : `<p class="ok"><strong>All translated source sets pass validation.</strong></p><p>${ignored} unrelated/source file${ignored === 1 ? "" : "s"} ignored. ${state.stabilityConfirmed ? "File sizes and modification times remained unchanged." : "Stability confirmation is still required."}</p>`;
}

function renderControls() {
  const status = state.job?.status;
  ui["dry-run"].disabled = !canDryRun();
  ui.start.disabled = !canStart() || status === JOB_STATUS.RUNNING;
  ui.pause.disabled = status !== JOB_STATUS.RUNNING || state.pauseRequested;
  ui.resume.disabled = ![JOB_STATUS.PAUSED, JOB_STATUS.STOPPED].includes(status) || !state.page?.ok || state.busy;
  ui.stop.disabled = status !== JOB_STATUS.RUNNING || state.stopRequested;
  ui.retry.disabled = !state.job?.targets.some((target) => Object.values(target.components).some((component) => component.status === COMPONENT_STATUS.FAILED));
  ui.reset.disabled = !state.job || status === JOB_STATUS.RUNNING;
}

function renderLanguages() {
  if (!state.validation) {
    ui["language-list"].innerHTML = '<p class="empty-state">No folder selected.</p>';
    return;
  }
  const jobTargetsBySource = new Map();
  for (const target of state.job?.targets || []) {
    const group = jobTargetsBySource.get(target.sourceLanguage) || [];
    group.push(target);
    jobTargetsBySource.set(target.sourceLanguage, group);
  }
  ui["language-list"].innerHTML = state.validation.records.map((record) => {
    const targets = jobTargetsBySource.get(record.language) || expandLanguageTargets([record]).targets.map((target) => ({
      ...target,
      status: record.ready ? LANGUAGE_STATUS.WAITING : LANGUAGE_STATUS.FAILED,
      components: Object.fromEntries(COMPONENTS.map((component) => [component, { status: record.ready ? COMPONENT_STATUS.WAITING : COMPONENT_STATUS.FAILED, message: null }]))
    }));
    return targets.map((target, targetIndex) => renderTargetRow(record, target, targetIndex === 0)).join("");
  }).join("");
}

function renderTargetRow(record, target, showCheckbox) {
  const messages = [...record.errors.map((error) => error.message), ...Object.entries(target.components || {}).flatMap(([component, result]) => result.message ? [`${COMPONENT_LABELS[component]}: ${result.message}`] : [])];
  const overwriteButtons = Object.entries(target.components || {}).filter(([component, result]) => (
    result.status === COMPONENT_STATUS.BLOCKED
    && ["metadata", "thumbnail"].includes(component)
    && /overwrite confirmation|required|already exists/i.test(result.message || "")
    && !target.overwrite?.[component]
  )).map(([component]) => `<button class="overwrite-button" data-overwrite-target="${escapeHtml(target.id)}" data-component="${component}" type="button">Allow ${escapeHtml(component)} overwrite</button>`).join("");
  return `<article class="language-row ${messages.length ? "has-error" : ""}">
    <div class="language-top">
      <label class="language-choice">
        ${showCheckbox ? `<input type="checkbox" data-source-language="${escapeHtml(record.language)}" ${record.selected !== false ? "checked" : ""} ${state.job?.status === JOB_STATUS.RUNNING ? "disabled" : ""}>` : '<span aria-hidden="true">↳</span>'}
        <span>${escapeHtml(record.language)}<small class="target-label">Studio: ${escapeHtml(target.targetLanguage)}</small></span>
      </label>
      <span class="language-state">${escapeHtml(target.status || LANGUAGE_STATUS.WAITING)}</span>
    </div>
    <div class="components">${COMPONENTS.map((component) => `<span class="component ${escapeHtml(target.components?.[component]?.status || COMPONENT_STATUS.WAITING)}" title="${escapeHtml(target.components?.[component]?.message || "")}">${escapeHtml(COMPONENT_LABELS[component])}</span>`).join("")}</div>
    ${messages.length ? `<p class="row-error">${messages.map(escapeHtml).join(" ")}</p>` : ""}
    ${overwriteButtons}
  </article>`;
}

function renderLogs() {
  const logs = state.job?.logs || [];
  ui["log-count"].textContent = logs.length;
  ui["activity-log"].innerHTML = logs.length ? logs.slice().reverse().map((entry) => `<li class="${escapeHtml(entry.level)}"><time>${escapeHtml(new Date(entry.at).toLocaleTimeString())}</time> ${entry.language ? `[${escapeHtml(entry.language)}] ` : ""}${escapeHtml(entry.operation || "activity")}: ${escapeHtml(entry.message)}${entry.expected ? ` Expected: ${escapeHtml(entry.expected)}.` : ""}${entry.found ? ` Found: ${escapeHtml(entry.found)}.` : ""}</li>`).join("") : "<li>No activity yet.</li>";
}

async function copyLog() {
  const logs = state.job?.logs || [];
  const text = logs.map((entry) => `${entry.at} ${entry.level.toUpperCase()} ${entry.language || "-"} ${entry.operation || "activity"}: ${entry.message}`).join("\n");
  await navigator.clipboard.writeText(text || "No activity yet.");
}

function reportLocalError(operation, error) {
  ui["job-message"].textContent = error.message;
  if (state.job) {
    appendJobLog(state.job, diagnosticLog(error, operation, null));
    void saveJob(state.job);
  }
  render();
}

void initialize();
