// @ts-check

const { createHash, randomUUID } = require('node:crypto');
const { mkdir, open, readFile, rename, unlink } = require('node:fs/promises');
const { dirname, join, resolve } = require('node:path');

const MAX_PLAN_REVIEW_BYTES = 2 * 1024 * 1024;
const PLAN_REVIEW_LOCK_STALE_MS = 10_000;
/** @type {Map<string, Promise<unknown>>} */
const operationQueues = new Map();

/** @param {string} userDataPath @param {string} planFile */
const getPlanReviewPath = (userDataPath, planFile) => {
  const key = createHash('sha256').update(resolve(planFile)).digest('hex');
  return join(userDataPath, 'plan-reviews', `${key}.json`);
};

/** @param {unknown} value */
const isRecord = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value */
const isString = (value) => typeof value === 'string';

/** @param {unknown} value */
const isOptionalString = (value) => value == null || isString(value);

/** @param {unknown} value */
const isAuthor = (value) =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.name) &&
  isOptionalString(value.avatarUrl) &&
  isOptionalString(value.email);

/** @param {unknown} value */
const isAnchor = (value) => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.kind !== 'block' && value.kind !== 'text') ||
    !isRecord(value.block) ||
    !isString(value.block.fingerprint) ||
    !Array.isArray(value.block.path) ||
    !value.block.path.every((part) => Number.isInteger(part) && part >= 0) ||
    !isOptionalString(value.block.runtimeKey) ||
    !isString(value.block.text) ||
    !isString(value.block.type)
  ) {
    return false;
  }
  if (value.kind === 'block') {
    return value.quote == null;
  }
  return (
    isRecord(value.quote) &&
    Number.isInteger(value.quote.start) &&
    value.quote.start >= 0 &&
    Number.isInteger(value.quote.end) &&
    value.quote.end >= value.quote.start &&
    isString(value.quote.exact) &&
    isString(value.quote.prefix) &&
    isString(value.quote.suffix)
  );
};

/** @param {unknown} value */
const isMessage = (value) =>
  isRecord(value) &&
  isAuthor(value.author) &&
  isString(value.body) &&
  isString(value.createdAt) &&
  isString(value.id) &&
  isString(value.updatedAt);

/** @param {unknown} value */
const isResolution = (value) =>
  value == null ||
  (isRecord(value) &&
    (value.reason === 'agent-handled' || value.reason === 'anchor-removed') &&
    isString(value.resolvedAt));

/** @param {unknown} value */
const isThread = (value) =>
  isRecord(value) &&
  isAnchor(value.anchor) &&
  isString(value.createdAt) &&
  isAuthor(value.createdBy) &&
  isString(value.id) &&
  Array.isArray(value.messages) &&
  value.messages.every(isMessage) &&
  isResolution(value.resolution) &&
  (value.status === 'open' || value.status === 'resolved') &&
  isString(value.updatedAt);

/** @param {unknown} value */
const normalizePlanReview = (value) => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.document) ||
    typeof value.document.id !== 'string' ||
    typeof value.document.path !== 'string' ||
    typeof value.document.version !== 'string' ||
    !Array.isArray(value.threads) ||
    !value.threads.every(isThread)
  ) {
    throw new Error('Invalid plan review.');
  }

  return value;
};

/** @param {unknown} review */
const serializePlanReview = (review) => {
  const content = `${JSON.stringify(normalizePlanReview(review), null, 2)}\n`;
  if (Buffer.byteLength(content, 'utf8') > MAX_PLAN_REVIEW_BYTES) {
    throw new Error('Plan review exceeds the 2 MB limit.');
  }
  return content;
};

/** @param {string} userDataPath @param {string} planFile */
const readPlanReview = async (userDataPath, planFile) => {
  return readPlanReviewAtPath(getPlanReviewPath(userDataPath, planFile));
};

/** @param {string} path */
const readPlanReviewAtPath = async (path) => {
  try {
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_PLAN_REVIEW_BYTES) {
      throw new Error('Plan review exceeds the 2 MB limit.');
    }
    return normalizePlanReview(JSON.parse(raw));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

/** @template T @param {string} path @param {() => Promise<T>} operation */
const withPlanReviewLock = async (path, operation) => {
  await mkdir(dirname(path), { recursive: true });
  // Only plan reviews take this lock, so `proper-lockfile` and its dependency
  // tree stay out of the startup path.
  const release = await require('proper-lockfile').lock(path, {
    realpath: false,
    retries: {
      factor: 1,
      maxTimeout: 100,
      minTimeout: 100,
      randomize: true,
      retries: 150,
    },
    stale: PLAN_REVIEW_LOCK_STALE_MS,
    update: PLAN_REVIEW_LOCK_STALE_MS / 2,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
};

/** @template T @param {string} path @param {() => Promise<T>} operation */
const queuePlanReviewOperation = async (path, operation) => {
  const previous = operationQueues.get(path) ?? Promise.resolve();
  const queued = previous
    .catch(() => {})
    .then(operation)
    .finally(() => {
      if (operationQueues.get(path) === queued) {
        operationQueues.delete(path);
      }
    });
  operationQueues.set(path, queued);
  return queued;
};

/** @param {string} path @param {string} content */
const atomicWrite = async (path, content) => {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, 'wx', 0o600);
  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
    await file.close();
    await rename(temporaryPath, path);
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
};

/** @param {unknown} currentReview @param {unknown} nextReview */
const preserveResolvedThreads = (currentReview, nextReview) => {
  const current = currentReview ? normalizePlanReview(currentReview) : null;
  const next = normalizePlanReview(nextReview);
  if (!current) {
    return next;
  }
  const currentThreads = new Map(current.threads.map((thread) => [thread.id, thread]));
  return {
    ...next,
    threads: next.threads.map((thread) => {
      const storedThread = currentThreads.get(thread.id);
      if (storedThread?.status !== 'resolved' || thread.status === 'resolved') {
        return thread;
      }
      return {
        ...thread,
        ...(storedThread.resolution ? { resolution: storedThread.resolution } : {}),
        status: 'resolved',
        updatedAt: storedThread.updatedAt,
      };
    }),
  };
};

/** @param {string} path @param {unknown} review */
const writePlanReviewAtPath = async (path, review) => {
  const normalized = normalizePlanReview(review);
  return queuePlanReviewOperation(path, () =>
    withPlanReviewLock(path, async () => {
      const nextReview = preserveResolvedThreads(await readPlanReviewAtPath(path), normalized);
      await atomicWrite(path, serializePlanReview(nextReview));
      return nextReview;
    }),
  );
};

/** @param {string} userDataPath @param {string} planFile @param {unknown} review */
const writePlanReview = async (userDataPath, planFile, review) =>
  writePlanReviewAtPath(getPlanReviewPath(userDataPath, planFile), review);

/**
 * @param {string} path
 * @param {ReadonlyArray<string>} threadIds
 * @param {'agent-handled' | 'anchor-removed'} reason
 */
const resolvePlanReviewThreadsAtPath = async (path, threadIds, reason) => {
  return queuePlanReviewOperation(path, () =>
    withPlanReviewLock(path, async () => {
      const review = await readPlanReviewAtPath(path);
      if (!review) {
        throw new Error(`Plan review not found at ${path}.`);
      }

      const requestedIds = new Set(threadIds);
      const resolvedAt = new Date().toISOString();
      const resolvedIds = [];
      const nextReview = {
        ...review,
        threads: review.threads.map((thread) => {
          if (!requestedIds.has(thread.id) || thread.status === 'resolved') {
            return thread;
          }
          resolvedIds.push(thread.id);
          return {
            ...thread,
            resolution: { reason, resolvedAt },
            status: 'resolved',
            updatedAt: resolvedAt,
          };
        }),
      };
      const knownIds = new Set(review.threads.map((thread) => thread.id));
      const missingIds = threadIds.filter((id) => !knownIds.has(id));
      if (resolvedIds.length > 0) {
        await atomicWrite(path, serializePlanReview(nextReview));
      }
      return { missingIds, resolvedIds, review: nextReview };
    }),
  );
};

module.exports = {
  getPlanReviewPath,
  readPlanReview,
  resolvePlanReviewThreadsAtPath,
  writePlanReview,
};
