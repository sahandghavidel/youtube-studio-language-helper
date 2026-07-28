import test from "node:test";
import assert from "node:assert/strict";
import { parseAssetFiles } from "../lib/folder-parser.js";
import { validateParsedFolder } from "../lib/validation.js";
import { FakeFile, languageFiles, m4aBytes } from "./helpers/fake-file.js";

test("accepts the current three-field JSON structure", async () => {
  const result = await validateParsedFolder(await parseAssetFiles(languageFiles("French")));
  assert.equal(result.counts.ready, 1);
  assert.equal(result.records[0].languageCode, null);
});

test("accepts an optional non-empty languageCode", async () => {
  const result = await validateParsedFolder(await parseAssetFiles(languageFiles("German (Germany)", { languageCode: "de-DE" })));
  assert.equal(result.records[0].ready, true);
  assert.equal(result.records[0].languageCode, "de-DE");
});

test("rejects JSON language and filename mismatches", async () => {
  const files = languageFiles("French");
  files[0] = new FakeFile("French - metadata.json", JSON.stringify({ language: "French (France)", title: "Title", description: "Description" }));
  const result = await validateParsedFolder(await parseAssetFiles(files));
  assert.equal(result.records[0].errors.some((error) => error.code === "language-mismatch"), true);
});

test("accepts a partial asset set and reports the missing component as unavailable", async () => {
  const files = languageFiles("French").filter((file) => !file.name.endsWith(" - audio.wav"));
  const result = await validateParsedFolder(await parseAssetFiles(files));
  assert.equal(result.records[0].ready, true);
  assert.equal(result.records[0].errors.some((error) => error.code === "missing-audio"), false);
  assert.equal(result.records[0].availableComponents.includes("audio"), false);
});

test("accepts M4A audio", async () => {
  const files = languageFiles("French").filter((file) => !file.name.endsWith(" - audio.wav"));
  files.push(new FakeFile("French - audio.m4a", m4aBytes(), { type: "audio/mp4" }));
  const result = await validateParsedFolder(await parseAssetFiles(files));
  assert.equal(result.records[0].ready, true);
  assert.equal(result.records[0].availableComponents.includes("audio"), true);
});

test("rejects duplicate language components", async () => {
  const files = languageFiles("French");
  files.push(new FakeFile("French.srt", "1\n00:00:00,000 --> 00:00:01,000\nDuplicate"));
  const result = await validateParsedFolder(await parseAssetFiles(files));
  assert.equal(result.records[0].ready, false);
  assert.equal(result.records[0].errors.some((error) => error.code === "duplicate-component"), true);
});

test("rejects over-limit metadata", async () => {
  const result = await validateParsedFolder(await parseAssetFiles(languageFiles("French", { title: "x".repeat(101), description: "y".repeat(5001) })));
  const codes = result.records[0].errors.map((error) => error.code);
  assert.equal(codes.includes("title-length"), true);
  assert.equal(codes.includes("description-length"), true);
});
