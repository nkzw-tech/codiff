// @ts-check

const { createHash, randomUUID } = require('node:crypto');
const { mkdir, open, readdir, rename, stat, unlink } = require('node:fs/promises');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { readBoundedFile } = require('./bounded-file.cjs');
const { mapWithConcurrency } = require('./bounded-map.cjs');

const FORMAT_VERSION = 1;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_PRUNE_STAT_CONCURRENCY = 8;
const inFlight = new Map();

const cacheDirectory = () =>
  process.env.CODIFF_REVIEW_HISTORY_CACHE_DIR || join(homedir(), '.codiff', 'review-history');

/** @param {unknown} key */
const serializeKey = (key) => JSON.stringify(key);
/** @param {unknown} key */
const cachePath = (key) =>
  join(cacheDirectory(), `${createHash('sha256').update(serializeKey(key)).digest('hex')}.json`);

/** @param {string} path */
const discard = async (path) => {
  try {
    await unlink(path);
  } catch {
    // Missing or unwritable corrupt entries behave exactly like cache misses.
  }
};

/** @param {unknown} key @returns {Promise<any | null>} */
const readReviewHistoryCache = async (key) => {
  const path = cachePath(key);
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_RECORD_BYTES) {
      await discard(path);
      return null;
    }
    const result = await readBoundedFile(path, MAX_RECORD_BYTES);
    if (result.status === 'too-large') {
      await discard(path);
      return null;
    }
    const record = JSON.parse(result.buffer.toString('utf8'));
    if (
      !record ||
      typeof record !== 'object' ||
      record.formatVersion !== FORMAT_VERSION ||
      record.key !== serializeKey(key) ||
      !Object.hasOwn(record, 'value')
    ) {
      await discard(path);
      return null;
    }
    return record.value;
  } catch {
    return null;
  }
};

const pruneReviewHistoryCache = async () => {
  const directory = cacheDirectory();
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const candidates = await mapWithConcurrency(
    names.filter((name) => name.endsWith('.json')),
    MAX_PRUNE_STAT_CONCURRENCY,
    async (name) => {
      const path = join(directory, name);
      try {
        const metadata = await stat(path);
        return { mtimeMs: metadata.mtimeMs, path, size: metadata.size };
      } catch {
        return null;
      }
    },
  );
  /** @type {Array<{mtimeMs: number, path: string, size: number}>} */
  const entries = [];
  for (const candidate of candidates) {
    if (candidate) entries.push(candidate);
  }
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of entries) {
    if (total <= MAX_TOTAL_BYTES) break;
    await discard(entry.path);
    total -= entry.size;
  }
};

/** @param {unknown} key @param {unknown} value */
const writeReviewHistoryCache = async (key, value) => {
  const text = JSON.stringify({
    formatVersion: FORMAT_VERSION,
    key: serializeKey(key),
    value,
  });
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) {
    return false;
  }
  const directory = cacheDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = cachePath(key);
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await discard(temporaryPath);
    throw error;
  }
  await pruneReviewHistoryCache();
  return true;
};

/**
 * Deduplicate one immutable load, using disk only for successful serializable values.
 * @param {unknown} key
 * @param {() => Promise<any>} load
 * @param {{shareInFlight?: boolean}} [options]
 */
const loadReviewHistoryCached = async (key, load, options = {}) => {
  const id = serializeKey(key);
  const shareInFlight = options.shareInFlight !== false;
  if (shareInFlight) {
    const active = inFlight.get(id);
    if (active) return active;
  }
  const pending = (async () => {
    const cached = await readReviewHistoryCache(key);
    if (cached != null) return cached;
    const value = await load();
    try {
      await writeReviewHistoryCache(key, value);
    } catch {
      // History remains usable when the cache directory is unavailable.
    }
    return value;
  })();
  if (shareInFlight) {
    inFlight.set(id, pending);
  }
  try {
    return await pending;
  } finally {
    if (shareInFlight && inFlight.get(id) === pending) {
      inFlight.delete(id);
    }
  }
};

module.exports = {
  FORMAT_VERSION,
  MAX_RECORD_BYTES,
  MAX_TOTAL_BYTES,
  cachePath,
  loadReviewHistoryCached,
  readReviewHistoryCache,
  writeReviewHistoryCache,
};
