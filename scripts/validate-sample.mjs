import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseAssetFiles } from "../lib/folder-parser.js";
import { expandLanguageTargets } from "../lib/language-mapping.js";
import { validateParsedFolder } from "../lib/validation.js";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: node scripts/validate-sample.mjs /path/to/folder");

class DiskFile {
  constructor(path, info) {
    this.path = path;
    this.name = basename(path);
    this.size = info.size;
    this.lastModified = info.mtimeMs;
    this.type = "";
    this.webkitRelativePath = "";
  }

  async text() {
    return readFile(this.path, "utf8");
  }

  slice(start = 0, end = this.size) {
    return {
      arrayBuffer: async () => {
        const bytes = await readFile(this.path);
        const slice = bytes.subarray(start, end);
        return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
      }
    };
  }
}

const names = await readdir(directory);
const files = [];
for (const name of names) {
  const path = join(directory, name);
  const info = await stat(path);
  if (info.isFile()) files.push(new DiskFile(path, info));
}

const validated = await validateParsedFolder(await parseAssetFiles(files));
const selected = validated.records.filter((record) => record.ready);
const expanded = expandLanguageTargets(selected);
const summary = {
  folder: basename(directory),
  topLevelFiles: files.length,
  assetSets: validated.counts.found,
  ready: validated.counts.ready,
  incomplete: validated.counts.incomplete,
  studioDestinations: expanded.targets.length,
  ignoredFiles: validated.ignored.length,
  mappingErrors: expanded.errors,
  validationErrors: validated.records.flatMap((record) => record.errors.map((error) => ({ language: record.language, ...error })))
};

console.log(JSON.stringify(summary, null, 2));
if (summary.incomplete || summary.mappingErrors.length || summary.validationErrors.length) process.exitCode = 1;
