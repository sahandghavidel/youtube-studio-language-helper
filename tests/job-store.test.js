import test from "node:test";
import assert from "node:assert/strict";
import { COMPONENT_STATUS } from "../lib/constants.js";
import { createJob, nextIncompleteWork, setComponentResult } from "../lib/job-store.js";
import { languageFiles } from "./helpers/fake-file.js";

function record(language) {
  const [metadata, subtitle, audio, thumbnail] = languageFiles(language);
  return { language, selected: true, files: { metadata, subtitle, audio, thumbnail } };
}

test("resume selects the first incomplete component, not completed work", () => {
  const source = record("French");
  const job = createJob({
    page: { videoId: "video", channelId: "channel", videoTitle: "Title" },
    folderName: "Folder",
    records: [source],
    targets: [{ id: "French::French", sourceLanguage: "French", targetLanguage: "French", selected: true }]
  });
  setComponentResult(job, "French::French", "metadata", { status: COMPONENT_STATUS.COMPLETE });
  setComponentResult(job, "French::French", "subtitle", { status: COMPONENT_STATUS.COMPLETE });
  const next = nextIncompleteWork(job);
  assert.equal(next.component, "audio");
  assert.equal(job.targets[0].components.audio.phase, "waiting");
});

test("component phases persist independently for resumable UI checkpoints", () => {
  const source = record("French");
  const job = createJob({
    page: { videoId: "video", channelId: "channel", videoTitle: "Title" },
    folderName: "Folder",
    records: [source],
    targets: [{ id: "French::French", sourceLanguage: "French", targetLanguage: "French", selected: true }]
  });
  setComponentResult(job, "French::French", "audio", {
    status: COMPONENT_STATUS.WORKING,
    phase: "audio-waiting-popup-published",
    message: "Waiting for popup confirmation."
  });
  assert.equal(job.targets[0].components.audio.phase, "audio-waiting-popup-published");
  assert.equal(job.targets[0].components.audio.message, "Waiting for popup confirmation.");
});

test("blocked components are terminal and do not prevent later work", () => {
  const source = record("French");
  const job = createJob({
    page: { videoId: "video", channelId: "channel", videoTitle: "Title" },
    folderName: "Folder",
    records: [source],
    targets: [{ id: "French::French", sourceLanguage: "French", targetLanguage: "French", selected: true }]
  });
  setComponentResult(job, "French::French", "metadata", { status: COMPONENT_STATUS.COMPLETE });
  setComponentResult(job, "French::French", "subtitle", { status: COMPONENT_STATUS.COMPLETE });
  setComponentResult(job, "French::French", "audio", { status: COMPONENT_STATUS.BLOCKED });
  assert.equal(nextIncompleteWork(job).component, "thumbnail");
});
