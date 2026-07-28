import { JOB_STATUS } from "./lib/constants.js";
import { appendJobLog, loadJob, saveJob } from "./lib/job-store.js";
import { buildFailureNotification, sendTelegramNotification } from "./lib/telegram-notifier.js";

const RUNTIME_KEY = "jobRuntime";
const HEARTBEAT_ALARM = "studio-heartbeat";

chrome.runtime.onInstalled.addListener(async () => {
  setDisplayKeepAwake(false);
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
  const job = await loadJob();
  setDisplayKeepAwake(job?.status === JOB_STATUS.RUNNING);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "SET_RUNTIME_TARGET") {
    setDisplayKeepAwake(true);
    chrome.storage.local.set({
      [RUNTIME_KEY]: {
        tabId: message.tabId,
        videoId: message.videoId,
        channelId: message.channelId,
        lastHeartbeatAt: Date.now()
      }
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "CLEAR_RUNTIME_TARGET") {
    setDisplayKeepAwake(false);
    chrome.storage.local.remove(RUNTIME_KEY).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "RELEASE_DISPLAY_KEEP_AWAKE") {
    setDisplayKeepAwake(false);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "CONTENT_HEARTBEAT") {
    chrome.storage.local.get(RUNTIME_KEY).then(({ [RUNTIME_KEY]: runtime }) => {
      if (runtime && runtime.tabId === sender.tab?.id) {
        runtime.lastHeartbeatAt = Date.now();
        chrome.storage.local.set({ [RUNTIME_KEY]: runtime });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { [RUNTIME_KEY]: runtime } = await chrome.storage.local.get(RUNTIME_KEY);
  if (runtime?.tabId === tabId) await pauseActiveJob("The bound YouTube Studio tab was closed.", "tab-closed");
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const { [RUNTIME_KEY]: runtime } = await chrome.storage.local.get(RUNTIME_KEY);
  if (!runtime || runtime.tabId !== tabId) return;
  const expected = `https://studio.youtube.com/video/${runtime.videoId}/translations`;
  if (!changeInfo.url.startsWith(expected)) {
    await pauseActiveJob("The bound Studio tab navigated away from the original video's Languages page.", "navigation-changed");
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  const job = await loadJob();
  setDisplayKeepAwake(job?.status === JOB_STATUS.RUNNING);
  const { [RUNTIME_KEY]: runtime } = await chrome.storage.local.get(RUNTIME_KEY);
  if (!runtime) return;
  try {
    const response = await chrome.tabs.sendMessage(runtime.tabId, { type: "PING" });
    if (!response?.ok) throw new Error("No reliable response from the Studio content script.");
    runtime.lastHeartbeatAt = Date.now();
    await chrome.storage.local.set({ [RUNTIME_KEY]: runtime });
  } catch {
    await pauseActiveJob("The Studio tab is unavailable or its automation helper is not responding.", "heartbeat-failed");
  }
});

async function pauseActiveJob(reason, operation) {
  const job = await loadJob();
  if (!job || job.status !== JOB_STATUS.RUNNING) return;
  setDisplayKeepAwake(false);
  job.status = JOB_STATUS.PAUSED;
  job.pauseReason = reason;
  appendJobLog(job, { level: "error", operation, message: reason, retrySafe: true });
  await saveJob(job);
  const notification = await sendTelegramNotification(buildFailureNotification(job, { operation, reason }));
  appendJobLog(job, {
    level: notification.success ? "info" : "warning",
    operation: "error-notification",
    message: notification.success
      ? "Telegram notification sent through the local Ultimate Video Editor server."
      : `Telegram notification was not sent: ${notification.error}`,
    retrySafe: true
  });
  await saveJob(job);
}

function setDisplayKeepAwake(active) {
  if (active) chrome.power.requestKeepAwake("display");
  else chrome.power.releaseKeepAwake();
}
