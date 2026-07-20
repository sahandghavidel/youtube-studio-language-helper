import test from "node:test";
import assert from "node:assert/strict";
import { PACING_RANGES, pacingForTransition, randomDelayMs } from "../lib/pacing.js";

function work(id, language, component) {
  return { target: { id, targetLanguage: language }, component };
}

test("random delay includes both configured boundaries", () => {
  assert.equal(randomDelayMs({ min: 10_000, max: 20_000 }, () => 0), 10_000);
  assert.equal(randomDelayMs({ min: 10_000, max: 20_000 }, () => 1), 20_000);
});

test("components in the same language use the 10 to 20 second range", () => {
  const pacing = pacingForTransition(work("de", "German", "metadata"), work("de", "German", "subtitle"), { random: () => 0.5 });
  assert.equal(pacing.kind, "between-components");
  assert.ok(pacing.milliseconds >= PACING_RANGES.betweenComponents.min);
  assert.ok(pacing.milliseconds <= PACING_RANGES.betweenComponents.max);
});

test("a new language uses the 30 to 60 second range", () => {
  const pacing = pacingForTransition(work("de", "German", "thumbnail"), work("fr", "French", "metadata"), { random: () => 0.5 });
  assert.equal(pacing.kind, "between-languages");
  assert.ok(pacing.milliseconds >= PACING_RANGES.betweenLanguages.min);
  assert.ok(pacing.milliseconds <= PACING_RANGES.betweenLanguages.max);
});

test("a visible-table skip uses only the brief 0.5 to 1.5 second range", () => {
  const pacing = pacingForTransition(
    work("de", "German", "audio"),
    work("fr", "French", "metadata"),
    { fastSkip: true, random: () => 0.5 }
  );
  assert.equal(pacing.kind, "after-visible-skip");
  assert.ok(pacing.milliseconds >= PACING_RANGES.afterVisibleSkip.min);
  assert.ok(pacing.milliseconds <= PACING_RANGES.afterVisibleSkip.max);
});

test("no delay is created after the final component", () => {
  assert.equal(pacingForTransition(work("de", "German", "thumbnail"), null), null);
});
