import test from "node:test";
import assert from "node:assert/strict";
import { classifyAssetFilename, metadataSnapshot, parseAssetFiles, snapshotsEqual } from "../lib/folder-parser.js";
import { FakeFile, languageFiles } from "./helpers/fake-file.js";

test("classifies every contract filename by shared language basename", () => {
  assert.deepEqual(classifyAssetFilename("German (Germany) - audio.wav"), { component: "audio", suffix: " - audio.wav", language: "German (Germany)" });
  assert.deepEqual(classifyAssetFilename("German (Germany).srt"), { component: "subtitle", suffix: ".srt", language: "German (Germany)" });
  assert.deepEqual(classifyAssetFilename("German (Germany) - Thumbnail.png"), { component: "thumbnail", suffix: " - Thumbnail.png", language: "German (Germany)" });
  assert.deepEqual(classifyAssetFilename("German (Germany) - metadata.json"), { component: "metadata", suffix: " - metadata.json", language: "German (Germany)" });
  assert.equal(classifyAssetFilename("English - metadata.txt"), null);
});

test("parses complete language sets and ignores unrelated source files", async () => {
  const parsed = await parseAssetFiles([
    ...languageFiles("German (Germany)"),
    new FakeFile("English - metadata.txt", "source"),
    new FakeFile("English - United Kingdom.srt", "1\n00:00:00,000 --> 00:00:01,000\nSource")
  ]);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].language, "German (Germany)");
  assert.equal(parsed.records[0].metadata.title, "Translated title");
  assert.deepEqual(parsed.ignored, ["English - United Kingdom.srt", "English - metadata.txt"]);
});

test("detects duplicate companion files from fallback nested selections", async () => {
  const files = languageFiles("French");
  files.push(new FakeFile("French.srt", "duplicate", { webkitRelativePath: "Folder/French.srt" }));
  const parsed = await parseAssetFiles(files);
  assert.equal(parsed.records[0].errors.some((error) => error.code === "duplicate-component"), true);
});

test("metadata snapshots compare name, size, and modification time", () => {
  const files = languageFiles("French");
  const left = metadataSnapshot(files);
  const right = metadataSnapshot(files);
  assert.equal(snapshotsEqual(left, right), true);
  right[0].size += 1;
  assert.equal(snapshotsEqual(left, right), false);
});
