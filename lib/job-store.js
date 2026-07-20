import { COMPONENTS, COMPONENT_STATUS, JOB_STATUS, LANGUAGE_STATUS, MAX_LOG_ENTRIES } from "./constants.js";

const ACTIVE_JOB_KEY = "activeJob";

export function makeJobIdentity({ videoId, channelId, folderName }) {
  return `${channelId || "unknown-channel"}::${videoId}::${folderName}`;
}

export function createJob({ page, folderName, records, targets }) {
  const now = new Date().toISOString();
  const recordMap = new Map(records.map((record) => [record.language, record]));
  return {
    version: 1,
    id: makeJobIdentity({ videoId: page.videoId, channelId: page.channelId, folderName }),
    videoId: page.videoId,
    channelId: page.channelId,
    videoTitle: page.videoTitle,
    folderName,
    status: JOB_STATUS.READY,
    pauseReason: null,
    createdAt: now,
    updatedAt: now,
    currentTargetId: null,
    dryRunCompletedAt: null,
    targets: targets.map((target) => {
      const record = recordMap.get(target.sourceLanguage);
      return {
        id: target.id,
        sourceLanguage: target.sourceLanguage,
        targetLanguage: target.targetLanguage,
        languageCode: target.languageCode,
        selected: target.selected !== false,
        status: LANGUAGE_STATUS.WAITING,
        errors: [],
        sourceMeta: {
          metadata: fileMeta(record.files.metadata),
          subtitle: fileMeta(record.files.subtitle),
          audio: fileMeta(record.files.audio),
          thumbnail: fileMeta(record.files.thumbnail)
        },
        components: Object.fromEntries(COMPONENTS.map((component) => [component, {
          status: COMPONENT_STATUS.WAITING,
          message: null,
          verifiedAt: null
        }]))
      };
    }),
    logs: []
  };
}

function fileMeta(file) {
  if (!file) return null;
  return { name: file.name, size: file.size, lastModified: file.lastModified, type: file.type || "" };
}

export function appendJobLog(job, entry) {
  const log = {
    at: new Date().toISOString(),
    level: entry.level || "info",
    operation: entry.operation || null,
    language: entry.language || null,
    message: String(entry.message || "").slice(0, 1000),
    expected: entry.expected ? String(entry.expected).slice(0, 500) : null,
    found: entry.found ? String(entry.found).slice(0, 500) : null,
    retrySafe: entry.retrySafe ?? null
  };
  job.logs = [...(job.logs || []), log].slice(-MAX_LOG_ENTRIES);
  job.updatedAt = log.at;
  return job;
}

export function setComponentResult(job, targetId, component, result) {
  const target = job.targets.find((item) => item.id === targetId);
  if (!target) throw new Error(`Unknown target ${targetId}.`);
  if (!COMPONENTS.includes(component)) throw new Error(`Unknown component ${component}.`);
  target.components[component] = {
    ...target.components[component],
    ...result,
    verifiedAt: result.status === COMPONENT_STATUS.COMPLETE || result.status === COMPONENT_STATUS.SKIPPED
      ? new Date().toISOString()
      : target.components[component].verifiedAt
  };
  job.updatedAt = new Date().toISOString();
  return job;
}

export function nextIncompleteWork(job) {
  for (const target of job.targets) {
    if (!target.selected) continue;
    for (const component of COMPONENTS) {
      const status = target.components[component].status;
      if (![COMPONENT_STATUS.COMPLETE, COMPONENT_STATUS.SKIPPED, COMPONENT_STATUS.BLOCKED].includes(status)) {
        return { target, component };
      }
    }
  }
  return null;
}

export async function loadJob() {
  const result = await chrome.storage.local.get(ACTIVE_JOB_KEY);
  return result[ACTIVE_JOB_KEY] || null;
}

export async function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [ACTIVE_JOB_KEY]: job });
  return job;
}

export async function clearJob() {
  await chrome.storage.local.remove(ACTIVE_JOB_KEY);
}
