import { buildWatchNotification, sendTelegramNotification, TELEGRAM_NOTIFICATION_ENDPOINT } from "./telegram-notifier.js";
import { pauseWatch, WATCH_MONITOR_LOCK, WATCH_KEY } from "./watch-folder.js";

const OUTBOX = "watchTelegramOutbox";
const STORAGE_LOCK = "watch-telegram-delivery";

// Keep undelivered alerts even if the user fixes the problem or changes folders.
export async function updateOutbox(storage, session, deliver, now = Date.now()) {
  const { [OUTBOX]: entries = {} } = await storage.get(OUTBOX);
  const active = new Set();
  for (const issue of Object.values(session?.issues || {})) {
    active.add(issue.id);
    entries[issue.id] ??= { message: buildWatchNotification(session, issue), status: "pending", next: 0 };
  }
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.status === "pending" && entry.next <= now) {
      entry.status = "sending";
      await storage.set({ [OUTBOX]: entries });
      const result = await deliver(entry.message);
      entry.status = result.success ? "sent" : result.uncertain ? "unconfirmed" : "pending";
      entry.next = now + 60_000;
    } else if (entry.status === "sending") {
      // Chrome exited between dispatch and acknowledgement. Replaying could send twice.
      entry.status = "unconfirmed";
    }
    if (!active.has(id) && entry.status === "sent" && now - entry.next > 7 * 86400_000) delete entries[id];
  }
  await storage.set({ [OUTBOX]: entries });
}

async function deliverWatchAlert(message) {
  try {
    const health = await fetch(TELEGRAM_NOTIFICATION_ENDPOINT, { signal: AbortSignal.timeout(5000) });
    if (!health.ok || !(await health.json()).environment?.configured) return { success: false };
  } catch {
    return { success: false };
  }
  return sendTelegramNotification(message);
}

export async function checkWatchOwner() {
  await navigator.locks.request(WATCH_MONITOR_LOCK, { ifAvailable: true }, async lock => {
    if (!lock) return;
    const session = (await chrome.storage.local.get(WATCH_KEY))[WATCH_KEY];
    if (!session?.enabled || !session.monitorId) return;
    pauseWatch(session, "The side panel closed while folder monitoring was active.",
      "Reopen the helper on the paired Studio video and start watching again.");
    await chrome.storage.local.set({ [WATCH_KEY]: session });
  });
}

export function flushWatchAlerts(snapshot) {
  return navigator.locks.request(STORAGE_LOCK, async () => {
    const session = snapshot ?? (await chrome.storage.local.get(WATCH_KEY))[WATCH_KEY];
    await updateOutbox(chrome.storage.local, session, deliverWatchAlert);
  });
}
