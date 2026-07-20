export const COMPONENTS = Object.freeze(["metadata", "subtitle", "audio", "thumbnail"]);

export const COMPONENT_LABELS = Object.freeze({
  metadata: "Metadata",
  subtitle: "Subtitle",
  audio: "Audio",
  thumbnail: "Thumbnail"
});

export const JOB_STATUS = Object.freeze({
  READY: "ready",
  RUNNING: "running",
  PAUSED: "paused",
  STOPPED: "stopped",
  COMPLETE: "complete",
  FAILED: "failed"
});

export const COMPONENT_STATUS = Object.freeze({
  WAITING: "waiting",
  VALIDATING: "validating",
  WORKING: "working",
  COMPLETE: "complete",
  SKIPPED: "skipped",
  BLOCKED: "blocked",
  FAILED: "failed"
});

export const LANGUAGE_STATUS = Object.freeze({
  WAITING: "Waiting",
  VALIDATING: "Validating",
  ADDING_LANGUAGE: "Adding language",
  ADDING_METADATA: "Adding title and description",
  UPLOADING_SUBTITLE: "Uploading subtitles",
  UPLOADING_AUDIO: "Uploading audio",
  UPLOADING_THUMBNAIL: "Uploading thumbnail",
  WAITING_FOR_YOUTUBE: "Waiting for YouTube",
  COMPLETE: "Complete",
  SKIPPED: "Skipped",
  PAUSED: "Paused",
  FAILED: "Failed",
  BLOCKED: "Blocked"
});

export const TITLE_MAX_LENGTH = 100;
export const DESCRIPTION_MAX_LENGTH = 5000;
export const STABILITY_WINDOW_MS = 5000;
export const TRANSFER_CHUNK_BYTES = 1024 * 1024;
export const MAX_LOG_ENTRIES = 500;
export const HEARTBEAT_TIMEOUT_MS = 90_000;

export const STUDIO_URL_PATTERN = /^https:\/\/studio\.youtube\.com\/video\/([^/?#]+)\/translations(?:[/?#]|$)/;

export const STATUS_TEXT = Object.freeze({
  metadata: "Adding title and description",
  subtitle: "Uploading subtitles",
  audio: "Uploading audio",
  thumbnail: "Uploading thumbnail"
});
