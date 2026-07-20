export const PACING_RANGES = Object.freeze({
  betweenComponents: Object.freeze({ min: 10_000, max: 20_000 }),
  betweenLanguages: Object.freeze({ min: 30_000, max: 60_000 }),
  beforeStudioCommit: Object.freeze({ min: 1_000, max: 2_000 })
});

export function randomDelayMs({ min, max }, random = Math.random) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
    throw new TypeError("A pacing range requires finite values with 0 <= min <= max.");
  }
  const sample = Math.min(0.999999999999, Math.max(0, Number(random())));
  return Math.floor(min + sample * (max - min + 1));
}

export function pacingForTransition(currentWork, nextWork, random = Math.random) {
  if (!currentWork || !nextWork) return null;
  const languageChanged = currentWork.target.id !== nextWork.target.id;
  const range = languageChanged ? PACING_RANGES.betweenLanguages : PACING_RANGES.betweenComponents;
  return {
    kind: languageChanged ? "between-languages" : "between-components",
    milliseconds: randomDelayMs(range, random),
    fromLanguage: currentWork.target.targetLanguage,
    toLanguage: nextWork.target.targetLanguage,
    nextComponent: nextWork.component
  };
}
