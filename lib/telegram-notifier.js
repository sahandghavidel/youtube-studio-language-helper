export const TELEGRAM_NOTIFICATION_ENDPOINT = "http://localhost:9540/api/notifications/telegram";
const NOTIFICATION_TIMEOUT_MS = 8_000;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]);
}

function selectedTargets(job) {
  return (job?.targets || []).filter((target) => target.selected);
}

export function buildCompletionNotification(job) {
  const targets = selectedTargets(job);
  const complete = targets.filter((target) => target.status === "Complete").length;
  return [
    "✅ <b>YouTube language upload complete</b>",
    `Video: ${escapeHtml(job?.videoTitle || "Unknown video")}`,
    `Video ID: ${escapeHtml(job?.videoId || "Unknown")}`,
    `Destinations completed: ${complete}/${targets.length}`,
    `Folder: ${escapeHtml(job?.folderName || "Unknown")}`
  ].join("\n");
}

export function buildFailureNotification(job, { language = null, operation = null, reason = null } = {}) {
  return [
    "⚠️ <b>YouTube language upload paused</b>",
    `Video: ${escapeHtml(job?.videoTitle || "Unknown video")}`,
    `Video ID: ${escapeHtml(job?.videoId || "Unknown")}`,
    language ? `Language: ${escapeHtml(language)}` : null,
    operation ? `Step: ${escapeHtml(operation)}` : null,
    `Reason: ${escapeHtml(reason || job?.pauseReason || "Unknown error")}`
  ].filter(Boolean).join("\n");
}

export async function sendTelegramNotification(message, { fetchImpl = fetch, timeoutMs = NOTIFICATION_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(TELEGRAM_NOTIFICATION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true) {
      return {
        success: false,
        uncertain: !/^(Telegram API error: [45]\d\d|Telegram credentials are not configured)/.test(payload?.error || ""),
        error: typeof payload?.error === "string"
          ? payload.error
          : `Local Telegram notification route returned HTTP ${response.status}.`
      };
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      uncertain: true,
      error: error?.name === "AbortError"
        ? `Local Telegram notification route timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`
        : `Local Telegram notification route is unavailable: ${error?.message || String(error)}`
    };
  } finally {
    clearTimeout(timer);
  }
}

export function buildWatchNotification(session, issue) {
  return [
    "⚠️ <b>YouTube folder watcher needs attention</b>",
    `Video: ${escapeHtml(session.videoTitle || session.videoId)} (${escapeHtml(session.videoId)})`,
    `Folder: ${escapeHtml(session.folder)}`,
    ...[issue.language, issue.component, issue.file].filter(Boolean).map(escapeHtml),
    escapeHtml(issue.reason),
    escapeHtml(issue.action)
  ].join("\n");
}
