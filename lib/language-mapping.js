const SOURCE_TARGET_OVERRIDES = Object.freeze({
  Bengali: ["Bangla"],
  Chinese: ["Chinese", "Chinese (Simplified)"],
  "Spanish (United States)": ["Spanish", "Spanish (United States)"],
  French: ["French", "French (France)"],
  "Portuguese (Brazil)": ["Portuguese", "Portuguese (Brazil)"]
});

const LANGUAGE_CODE_TARGETS = Object.freeze({
  bn: "Bangla",
  "bn-BD": "Bangla",
  "bn-IN": "Bangla (India)",
  zh: "Chinese",
  "zh-CN": "Chinese (Simplified)",
  "zh-Hans": "Chinese (Simplified)",
  "zh-TW": "Chinese (Traditional)",
  "zh-Hant": "Chinese (Traditional)",
  "es-US": "Spanish (United States)",
  "fr-FR": "French (France)",
  "pt-BR": "Portuguese (Brazil)"
});

export function targetsForSourceLanguage(language, languageCode = null) {
  const override = SOURCE_TARGET_OVERRIDES[language];
  if (override) return [...override];
  const codeTarget = languageCode ? LANGUAGE_CODE_TARGETS[languageCode] : null;
  return [codeTarget || language];
}

export function expandLanguageTargets(languageRecords, studioLabels = null) {
  const available = studioLabels ? new Set(studioLabels) : null;
  const seenTargets = new Map();
  const targets = [];
  const errors = [];

  for (const record of languageRecords) {
    for (const targetLanguage of targetsForSourceLanguage(record.language, record.languageCode)) {
      const targetKey = targetLanguage.toLocaleLowerCase("en-US");
      const prior = seenTargets.get(targetKey);
      if (prior && prior.sourceLanguage !== record.language) {
        errors.push({
          code: "duplicate-target",
          language: record.language,
          targetLanguage,
          message: `${record.language} and ${prior.sourceLanguage} both map to ${targetLanguage}.`
        });
        continue;
      }
      if (available && !available.has(targetLanguage)) {
        errors.push({
          code: "studio-language-missing",
          language: record.language,
          targetLanguage,
          message: `YouTube Studio does not currently offer the exact label ${targetLanguage}.`
        });
      }
      seenTargets.set(targetKey, record);
      targets.push({
        id: `${record.language}::${targetLanguage}`,
        sourceLanguage: record.language,
        targetLanguage,
        languageCode: record.languageCode || null,
        selected: record.selected !== false,
        source: record
      });
    }
  }

  return { targets, errors };
}

export function getConfiguredMappings() {
  return {
    sourceOverrides: structuredClone(SOURCE_TARGET_OVERRIDES),
    languageCodes: structuredClone(LANGUAGE_CODE_TARGETS)
  };
}
