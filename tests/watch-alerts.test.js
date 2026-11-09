import test from "node:test";
import assert from "node:assert/strict";
import { updateOutbox } from "../lib/watch-alerts.js";
import { openWatchIssue, pauseWatch } from "../lib/watch-folder.js";

function fixture() {
  let data = {};
  const storage = {
    get: async () => structuredClone(data),
    set: async patch => Object.assign(data, structuredClone(patch))
  };
  const session = {videoTitle:"Test <video>",videoId:"videoA",folder:"1634",enabled:true};
  pauseWatch(session, "Folder access expired.", "Grant access and resume.");
  return {storage, session};
}
test("offline alert survives resolution, then sends only once across repeated flushes", async () => {
  const {storage, session} = fixture();
  let attempts = 0;
  const send = async message => {
    assert.match(message,/Test &lt;video&gt;/);
    return {success:++attempts > 1};
  };
  await updateOutbox(storage,session,send,0);
  await updateOutbox(storage,session,send,1000);
  await updateOutbox(storage,null,send,60000);
  await updateOutbox(storage,session,send,120000);
  assert.equal(attempts,2);
});
test("ambiguous delivery stays unconfirmed without a second send", async () => {
  const {storage,session} = fixture();
  let attempts = 0;
  const send = async () => { attempts++; return {success:false, uncertain:true}; };
  await updateOutbox(storage,session,send,0);
  await updateOutbox(storage,session,send,120000);
  assert.equal(attempts,1);
  assert.equal(Object.values((await storage.get()).watchTelegramOutbox)[0].status,"unconfirmed");
});
test("repeated pause is one issue and a recurrence after recovery gets a new alert", () => {
  const {session} = fixture();
  const id = session.issues.paused.id;
  pauseWatch(session,"Folder access expired.","Resume.");
  assert.equal(session.issues.paused.id,id);
  delete session.issues.paused;
  openWatchIssue(session,"paused","Folder access expired.","Resume.");
  assert.notEqual(session.issues.paused.id,id);
});
