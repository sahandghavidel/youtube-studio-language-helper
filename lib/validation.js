import { DESCRIPTION_MAX_LENGTH, TITLE_MAX_LENGTH } from "./constants.js";

const COMPONENTS = Object.freeze(["metadata", "subtitle", "audio", "thumbnail"]);
const SRT_TIMING = /(?:^|\n)\s*\d+\s*\r?\n\s*\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/;

function issue(code, message, component = null) {
  return { code, message, component };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function validateSrt(file) {
  if (!file || file.size === 0) return [issue("empty-subtitle", "Subtitle file is empty.", "subtitle")];
  let text;
  try {
    text = await file.text();
  } catch {
    return [issue("subtitle-read", "Subtitle file could not be read as UTF-8 text.", "subtitle")];
  }
  if (text.includes("\uFFFD")) return [issue("subtitle-encoding", "Subtitle file contains invalid UTF-8 replacement characters.", "subtitle")];
  if (!SRT_TIMING.test(text.replace(/^\uFEFF/, ""))) return [issue("subtitle-format", "Subtitle file does not contain a plausible numbered SRT timing block.", "subtitle")];
  return [];
}

async function validateAudio(file) {
  if (file.name.toLocaleLowerCase("en-US").endsWith(".m4a")) {
    if (file.size < 12) return [issue("empty-audio", "M4A file is empty or too small.", "audio")];
    const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (String.fromCharCode(...header.slice(4, 8)) !== "ftyp") {
      return [issue("audio-format", "Audio file is not a recognizable M4A/MP4 file.", "audio")];
    }
    return [];
  }
  if (!file || file.size < 44) return [issue("empty-audio", "WAV file is empty or too small.", "audio")];
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = String.fromCharCode(...header);
  if (!ascii.startsWith("RIFF") || ascii.slice(8, 12) !== "WAVE") {
    return [issue("audio-format", "Audio file is not a RIFF/WAVE file.", "audio")];
  }
  return [];
}

async function validatePng(file) {
  if (!file || file.size < 24) return [issue("empty-thumbnail", "Thumbnail file is empty or too small.", "thumbnail")];
  const bytes = new Uint8Array(await file.slice(0, 24).arrayBuffer());
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) {
    return [issue("thumbnail-format", "Thumbnail is not a PNG file.", "thumbnail")];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const errors = [];
  if (width < 640 || height < 360) errors.push(issue("thumbnail-dimensions", `Thumbnail dimensions ${width}×${height} are too small.`, "thumbnail"));
  const ratio = width / height;
  if (Math.abs(ratio - (16 / 9)) > 0.04) errors.push(issue("thumbnail-ratio", `Thumbnail ratio ${ratio.toFixed(3)} is not close to 16:9.`, "thumbnail"));
  return errors;
}

export async function validateLanguageRecord(record) {
  const errors = [...(record.errors || [])];
  for (const component of COMPONENTS) {
    if (record.files[component]?.size === 0) errors.push(issue(`empty-${component}`, `${component} file is empty.`, component));
  }

  const metadata = record.metadata;
  if (metadata) {
    if (!nonEmptyString(metadata.language)) errors.push(issue("metadata-language", "Metadata language must be a non-empty string.", "metadata"));
    if (!nonEmptyString(metadata.title)) errors.push(issue("metadata-title", "Metadata title must be a non-empty string.", "metadata"));
    if (!nonEmptyString(metadata.description)) errors.push(issue("metadata-description", "Metadata description must be a non-empty string.", "metadata"));
    if (Object.hasOwn(metadata, "languageCode") && !nonEmptyString(metadata.languageCode)) {
      errors.push(issue("metadata-language-code", "Optional languageCode must be a non-empty string when present.", "metadata"));
    }
    if (metadata.language !== record.language) {
      errors.push(issue("language-mismatch", `JSON language ${JSON.stringify(metadata.language)} does not match filename language ${JSON.stringify(record.language)}.`, "metadata"));
    }
    if (typeof metadata.title === "string" && metadata.title.length > TITLE_MAX_LENGTH) {
      errors.push(issue("title-length", `Title has ${metadata.title.length} characters; YouTube allows ${TITLE_MAX_LENGTH}.`, "metadata"));
    }
    if (typeof metadata.description === "string" && metadata.description.length > DESCRIPTION_MAX_LENGTH) {
      errors.push(issue("description-length", `Description has ${metadata.description.length} characters; YouTube allows ${DESCRIPTION_MAX_LENGTH}.`, "metadata"));
    }
  }

  if (record.files.subtitle) errors.push(...await validateSrt(record.files.subtitle));
  if (record.files.audio) errors.push(...await validateAudio(record.files.audio));
  if (record.files.thumbnail) errors.push(...await validatePng(record.files.thumbnail));

  const componentErrors = Object.fromEntries(COMPONENTS.map((component) => [
    component,
    errors.filter((entry) => entry.component === component)
  ]));
  const availableComponents = COMPONENTS.filter((component) => (
    record.files[component] && componentErrors[component].length === 0
  ));
  const globalErrors = errors.filter((entry) => !entry.component);

  return {
    ...record,
    languageCode: metadata?.languageCode || null,
    title: metadata?.title || "",
    description: metadata?.description || "",
    errors,
    componentErrors,
    availableComponents,
    ready: globalErrors.length === 0 && availableComponents.length > 0,
    selected: true
  };
}

export async function validateParsedFolder(parsed) {
  const records = await Promise.all(parsed.records.map(validateLanguageRecord));
  const duplicateLanguages = new Set();
  const seen = new Set();
  for (const record of records) {
    const key = record.language.toLocaleLowerCase("en-US");
    if (seen.has(key)) duplicateLanguages.add(key);
    seen.add(key);
  }
  for (const record of records) {
    if (duplicateLanguages.has(record.language.toLocaleLowerCase("en-US"))) {
      record.errors.push(issue("duplicate-language", `Duplicate language entry: ${record.language}.`));
      record.ready = false;
    }
  }
  return {
    ...parsed,
    records,
    counts: {
      found: records.length,
      ready: records.filter((record) => record.ready).length,
      incomplete: records.filter((record) => !record.ready).length
    }
  };
}
