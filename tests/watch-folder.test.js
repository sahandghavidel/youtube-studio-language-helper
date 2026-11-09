import test from "node:test";
import assert from "node:assert/strict";
import { FakeFile, validSrt, wavBytes, m4aBytes, languageFiles } from "./helpers/fake-file.js";
import { scanWatch, previewWatch } from "../lib/watch-folder.js";

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

test("retry targets the exact blocked file and never replays a recovered or visible upload", async () => {
  const f = fixture();
  const key = JSON.stringify(["Arabic", "subtitle"]);
  f.files.push(new FakeFile("Arabic.srt", validSrt()), new FakeFile("Arabic - audio.wav", wavBytes()));
  const observations = new Map();
  const retry = () => scanWatch(f.session, f.io, observations, key);
  f.session.results[key] = {language:"Arabic", component:"subtitle", file:"Arabic.srt", outcome:"blocked"};
  const start = f.io.now();
  await retry();
  f.io.now = () => start + 10000;
  await retry(); await retry();
  assert.deepEqual(f.calls, [["Arabic","subtitle","Arabic.srt"]]);
  for (const [component, state, file] of [["audio","Processing... 95%","Arabic - audio.wav"], ["subtitle","1 Published","Arabic.srt"]]) {
    const id = JSON.stringify(["Arabic",component]);
    f.session.results[id] = {language:"Arabic", component, file, outcome:"blocked"};
    f.rows.splice(0, f.rows.length, {language:"Arabic", [component]:state});
    f.page.videoId = "wrong";
    await assert.rejects(scanWatch(f.session,f.io,observations,id), /bound tab/);
    f.page.videoId = f.session.videoId;
    await scanWatch(f.session,f.io,observations,id);
    assert.equal(f.session.results[id].outcome,"skipped");
  }
  assert.equal(f.calls.length,1);
});

test("repeat scans and an unsuccessful explicit retry preserve the same blocked incident", async () => {
  const f = fixture(); const key = JSON.stringify(["Arabic","subtitle"]);
  f.io.process = async () => ({outcome:"blocked", message:"Existing draft"});
  f.files.push(new FakeFile("Arabic.srt",validSrt()));
  await f.scan(); await f.scan(); const id = f.session.issues[key].id;
  await f.scan(65000);
  const obs = new Map();
  await scanWatch(f.session,f.io,obs,key); await f.scan(65000);
  await scanWatch(f.session,f.io,obs,key);
  assert.equal(f.session.issues[key].id,id);
});

test("existing and later metadata and thumbnails run independently, then reopens skip completed work", async () => {
  const f = fixture();
  const assets = languageFiles("Arabic");
  const payloads = [];
  f.io.process = async (target, component) => {
    payloads.push([component, target.source.title, target.source.description]);
    return {outcome:"complete"};
  };
  f.files.push(assets[3], assets[1]);
  await f.scan(); await f.scan(); await f.scan(65000);
  f.files.push(assets[0], assets[2]);
  await f.scan(); await f.scan(65000); await f.scan(65000);
  assert.deepEqual(payloads.map(p => p[0]), ["subtitle", "thumbnail", "metadata", "audio"]);
  assert.deepEqual(payloads[2], ["metadata","Translated title","Translated description"]);
  await scanWatch(structuredClone(f.session), f.io, new Map());
  assert.equal(payloads.length,4);
});

test("invalid metadata is held without preventing a good SRT, and preview reconciles each Studio component", async () => {
  const f = fixture();
  f.files.push(...languageFiles("Arabic"));
  f.files[0] = new FakeFile("Arabic - metadata.json","null");
  await f.scan(); await f.scan();
  assert.equal(f.calls[0][1],"subtitle");
  const rows = [{language:"Arabic", subtitle:"1 Published", audio:"Processing", thumbnail:"Draft"}];
  const preview = await previewWatch(f.files,"",["Arabic"],rows,{});
  assert.deepEqual(preview.map(r => [r[1],r[3]]), [["metadata","Hold"],["subtitle","Skip"],["audio","Skip"],["thumbnail","Review"]]);
  assert.equal((await previewWatch(languageFiles("Arabic"),"",["Arabic"],[],{},["Arabic"]))[0][3],"Review");
});

test("existing baseline excludes metadata and thumbnail unless opted in, and published items are never replayed", async () => {
  const f = fixture();
  const [metadata,,,thumbnail] = languageFiles("Arabic");
  f.files.push(metadata, thumbnail); f.session.baseline = [metadata.name, thumbnail.name];
  await f.scan(); await f.scan(); assert.equal(f.calls.length,0);
  f.rows.push({language:"Arabic",metadata:"Published",thumbnail:"Published"});
  f.session.baseline = []; await f.scan(); await f.scan();
  assert.deepEqual(Object.values(f.session.results).map(r=>r.outcome),["skipped","skipped"]);
  assert.equal(f.calls.length,0);
});
