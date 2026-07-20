import test from "node:test";
import assert from "node:assert/strict";
import {
  TELEGRAM_NOTIFICATION_ENDPOINT,
  buildCompletionNotification,
  buildFailureNotification,
  sendTelegramNotification
} from "../lib/telegram-notifier.js";

const job = {
  videoTitle: "Title <draft>",
  videoId: "video-1",
  folderName: "1575 & translations",
  pauseReason: "Paused",
  targets: [
    { selected: true, status: "Complete" },
    { selected: true, status: "Failed" },
    { selected: false, status: "Complete" }
  ]
};

test("completion notification summarizes selected destinations and escapes HTML", () => {
  const message = buildCompletionNotification(job);
  assert.match(message, /Destinations completed: 1\/2/);
  assert.match(message, /Title &lt;draft&gt;/);
  assert.match(message, /1575 &amp; translations/);
});

test("failure notification includes the language, operation, and reason", () => {
  const message = buildFailureNotification(job, { language: "German", operation: "audio", reason: "Rate <limit>" });
  assert.match(message, /Language: German/);
  assert.match(message, /Step: audio/);
  assert.match(message, /Rate &lt;limit&gt;/);
});

test("notification posts only the message to the local Ultimate Video Editor route", async () => {
  let request = null;
  const result = await sendTelegramNotification("Done", {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
  });
  assert.deepEqual(result, { success: true });
  assert.equal(request.url, TELEGRAM_NOTIFICATION_ENDPOINT);
  assert.deepEqual(JSON.parse(request.options.body), { message: "Done" });
});

test("notification failures are returned instead of thrown", async () => {
  const result = await sendTelegramNotification("Failed", {
    fetchImpl: async () => { throw new Error("connection refused"); }
  });
  assert.equal(result.success, false);
  assert.match(result.error, /connection refused/);
});
