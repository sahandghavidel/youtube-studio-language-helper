const SUFFIXES = Object.freeze([
  { component: "metadata", suffix: " - metadata.json" },
  { component: "audio", suffix: " - audio.wav" },
  { component: "audio", suffix: " - audio.m4a" },
  { component: "thumbnail", suffix: " - Thumbnail.png" },
  { component: "subtitle", suffix: ".srt" }
]);

function relativeName(file) {
  const path = file.webkitRelativePath || file.relativePath || file.name;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return { name: file.name, nested: false };
  return { name: parts.at(-1), nested: parts.length > 2 };
}

export function classifyAssetFilename(filename) {
  for (const definition of SUFFIXES) {
    if (!filename.endsWith(definition.suffix)) continue;
    const language = filename.slice(0, -definition.suffix.length);
    if (!language) return null;
    return { ...definition, language };
  }
  return null;
}

export function metadataSnapshot(files) {
  return files
    .map((file) => {
      const info = relativeName(file);
      return {
        name: info.name,
        size: Number(file.size || 0),
        lastModified: Number(file.lastModified || 0)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function snapshotsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((entry, index) => (
    entry.name === right[index].name
    && entry.size === right[index].size
    && entry.lastModified === right[index].lastModified
  ));
}

export async function parseAssetFiles(fileList) {
  const files = Array.from(fileList || []);
  const groups = new Map();
  const ignored = [];
  const globalErrors = [];

  for (const file of files) {
    const info = relativeName(file);
    if (info.nested) {
      globalErrors.push({ code: "nested-file", message: `Nested file is not supported: ${file.webkitRelativePath || file.name}` });
      continue;
    }
    const classification = classifyAssetFilename(info.name);
    if (!classification) {
      ignored.push(info.name);
      continue;
    }
    if (/^English(?:\b|\s|\()/i.test(classification.language)) {
      ignored.push(info.name);
      continue;
    }
    const group = groups.get(classification.language) || {
      language: classification.language,
      files: {},
      errors: []
    };
    if (group.files[classification.component]) {
      group.errors.push({
        code: "duplicate-component",
        component: classification.component,
        message: `Duplicate ${classification.component} file for ${classification.language}.`
      });
    } else {
      group.files[classification.component] = file;
    }
    groups.set(classification.language, group);
  }

  const records = [];
  for (const group of groups.values()) {
    if (group.files.metadata) {
      try {
        const raw = await group.files.metadata.text();
        const metadata = JSON.parse(raw);
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
          throw new Error("Expected a metadata object.");
        }
        group.metadata = metadata;
      } catch (error) {
        group.errors.push({ code: "invalid-json", component: "metadata", message: `Metadata JSON could not be parsed: ${error.message}` });
      }
    }
    records.push(group);
  }

  records.sort((a, b) => a.language.localeCompare(b.language));
  return { records, ignored: ignored.sort(), globalErrors, snapshot: metadataSnapshot(files) };
}

export async function filesFromDirectoryHandle(directoryHandle) {
  const files = [];
  for await (const entry of directoryHandle.values()) {
    if (entry.kind !== "file") continue;
    files.push(await entry.getFile());
  }
  return files;
}
