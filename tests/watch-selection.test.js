import test from "node:test";
import assert from "node:assert/strict";
import { folderLanguages, selectionKey, watchDestinations } from "../lib/watch-selection.js";

test("metadata-only source is selectable; English and editor temporary files are ignored", () => {
  const names = ["Spanish (United States) - metadata.json", "Spanish (United States).srt",
    "Arabic - metadata.json", "English - United Kingdom.srt", ".temp.srt", "video.mp4"];
  assert.deepEqual(folderLanguages(names.map(name => ({ name }))), ["Arabic", "Spanish (United States)"]);
  assert.deepEqual(watchDestinations(["Spanish (United States)"]), ["Spanish", "Spanish (United States)"]);
});

test("language preference keys are scoped to the video, channel and folder", () => {
  const page = {videoId:"v1", channelId:"c1"};
  const key = selectionKey(page, {name:"folder"});
  assert.notEqual(selectionKey({...page, videoId:"v2"}, {name:"folder"}), key);
  assert.notEqual(selectionKey({...page, channelId:"c2"}, {name:"folder"}), key);
  assert.notEqual(selectionKey(page, {name:"other"}), key);
});
