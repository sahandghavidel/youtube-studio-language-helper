import { classifyAssetFilename } from "./folder-parser.js";
import { targetsForSourceLanguage } from "./language-mapping.js";

export function folderLanguages(files) {
  const names = files.filter(file => !file.name.startsWith("."))
    .map(file => classifyAssetFilename(file.name)?.language)
    .filter(name => name && !/^English\b/i.test(name));
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

export function selectionKey(page, folder) {
  return JSON.stringify(["watch-selection", page.channelId, page.videoId, folder.name]);
}

export function watchDestinations(sources) {
  return [...new Set(sources.flatMap(language => targetsForSourceLanguage(language)))];
}
