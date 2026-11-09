import test from "node:test";
import assert from "node:assert/strict";
import { FakeFile, validSrt, wavBytes, m4aBytes } from "./helpers/fake-file.js";
import { scanWatch } from "../lib/watch-folder.js";

function fixture() {
  const session = { videoId:"video-A", channelId:"channel-A", sources:["Arabic"], labels:["Arabic"], baseline:[], results:{} };
  const page = { ...session, ok:true };
  const rows = [], files = [], calls = [], observed = new Map();
  let now = 100;
  const io = {
    now:()=>now, inspect:async()=>({page,rows}), files:async()=>files, save:async()=>{},
    process:async(target,component,file)=>{ calls.push([target.targetLanguage,component,file.name]); return {outcome:"complete"}; }
  };
  return {session,page,rows,files,calls,io,scan:async(step=5000)=>{now+=step;return scanWatch(session,io,observed);}};
}
test("late Arabic SRT and audio publish once each; other languages and temporary files are ignored",async()=>{
  const f=fixture();await f.scan();
  f.files.push(new FakeFile("Arabic.srt",validSrt()),new FakeFile("French.srt",validSrt()),new FakeFile(".media-1.tmp","data"));
  await f.scan();assert.equal(f.calls.length,0);await f.scan();await f.scan();
  f.files.push(new FakeFile("Arabic - audio.wav",wavBytes()));
  await f.scan();await f.scan(65000);await f.scan(65000);
  assert.deepEqual(f.calls,[["Arabic","subtitle","Arabic.srt"],["Arabic","audio","Arabic - audio.wav"]]);
  // Simulate panel reopening with a fresh observation map and persisted ledger.
  const restored=structuredClone(f.session);const observations=new Map();
  await scanWatch(restored,f.io,observations);await scanWatch(restored,{...f.io,now:()=>f.io.now()+6000},observations);
  assert.equal(f.calls.length,2);
});
test("wrong channel/video, visible work, baseline, and ambiguous formats never publish",async()=>{
  const f=fixture();
  f.files.push(new FakeFile("Arabic.srt",validSrt()),new FakeFile("Arabic - audio.m4a",m4aBytes()),new FakeFile("Arabic - audio.wav",wavBytes()));
  f.page.videoId="other";await assert.rejects(f.scan(),/paused/);f.page.videoId=f.session.videoId;
  f.page.channelId="other";await assert.rejects(f.scan(),/paused/);f.page.channelId=f.session.channelId;
  f.session.baseline=["Arabic.srt"];await f.scan();assert.match(await f.scan(),/Duplicate/);
  f.session.baseline=[];f.rows.push({language:"Arabic",subtitle:"Published",audio:"Processing"});await f.scan();
  f.session.format=".wav";await f.scan();assert.equal(f.calls.length,0);
});
test("interrupted operation is never silently replayed",async()=>{
  const f=fixture();f.files.push(new FakeFile("Arabic.srt",validSrt()));await f.scan();
  f.io.process=async()=>{throw Error("interrupted")};await assert.rejects(f.scan(),/interrupted/);
  await assert.rejects(f.scan(),/Review/);f.rows.push({language:"Arabic",subtitle:"Published"});await f.scan();
  assert.equal(Object.values(f.session.results)[0].outcome,"skipped");
});

test("all mode starts empty and discovers later languages with one-to-many destinations", async () => {
  const f = fixture();
  Object.assign(f.session, { mode: "all", sources: [], labels: ["Arabic", "Spanish", "Spanish (United States)"] });
  await f.scan();
  f.files.push(new FakeFile("Spanish (United States).srt", validSrt()), new FakeFile("English.srt", validSrt()));
  await f.scan(); await f.scan(); await f.scan(65000);
  f.files.push(new FakeFile("Arabic - audio.wav", wavBytes()));
  await f.scan(); await f.scan(65000); await f.scan(65000);
  assert.deepEqual(f.calls.map(([language, component]) => [language, component]),
    [["Spanish", "subtitle"], ["Spanish (United States)", "subtitle"], ["Arabic", "audio"]]);
});

test("unsupported new language is held without blocking supported arrivals", async () => {
  const f = fixture();
  f.session.mode = "all";
  f.files.push(new FakeFile("Unmapped.srt", validSrt()), new FakeFile("Arabic.srt", validSrt()));
  await f.scan(); await f.scan();
  assert.match(await f.scan(), /Unmapped/);
  assert.deepEqual(f.calls, [["Arabic", "subtitle", "Arabic.srt"]]);
});
