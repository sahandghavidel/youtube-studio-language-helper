import test from "node:test";
import assert from "node:assert/strict";
import { expandLanguageTargets, targetsForSourceLanguage } from "../lib/language-mapping.js";

test("expands approved one-to-many Studio mappings", () => {
  assert.deepEqual(targetsForSourceLanguage("Bengali"), ["Bangla"]);
  assert.deepEqual(targetsForSourceLanguage("Chinese"), ["Chinese", "Chinese (Simplified)"]);
  assert.deepEqual(targetsForSourceLanguage("Spanish (United States)"), ["Spanish", "Spanish (United States)"]);
  assert.deepEqual(targetsForSourceLanguage("French"), ["French", "French (France)"]);
  assert.deepEqual(targetsForSourceLanguage("Portuguese (Brazil)"), ["Portuguese", "Portuguese (Brazil)"]);
});

test("uses optional codes for future non-overridden names", () => {
  assert.deepEqual(targetsForSourceLanguage("Bengali India", "bn-IN"), ["Bangla (India)"]);
});

test("reports missing exact Studio labels", () => {
  const result = expandLanguageTargets([{ language: "French", selected: true }], ["French"]);
  assert.equal(result.targets.length, 2);
  assert.equal(result.errors[0].targetLanguage, "French (France)");
});

test("derives destination count without hardcoding", () => {
  const records = ["Bengali", "Chinese", "Spanish (United States)", "French", "Portuguese (Brazil)", "German (Germany)"].map((language) => ({ language }));
  assert.equal(expandLanguageTargets(records).targets.length, 10);
});
