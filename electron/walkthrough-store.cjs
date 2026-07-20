// @ts-check

const { createHash, randomUUID } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const MAX_STORED_WALKTHROUGH_BYTES = 8 * 1024 * 1024;
const STORED_WALKTHROUGH_VERSION = 1;

const getWalkthroughStoreDir = () => join(homedir(), '.codiff', 'walkthroughs');

/** @param {string} cacheKey */
const getWalkthroughStorePath = (cacheKey) =>
  join(getWalkthroughStoreDir(), `${createHash('sha256').update(cacheKey).digest('hex')}.json`);

/** @param {unknown} value */
const isHunkGroup = (value) => {
  const group = /** @type {any} */ (value);
  return (
    group &&
    typeof group === 'object' &&
    typeof group.id === 'string' &&
    Array.isArray(group.hunkIds) &&
    group.hunkIds.every((id) => typeof id === 'string') &&
    Array.isArray(group.hunks) &&
    group.hunks.every(
      (hunk) =>
        hunk &&
        typeof hunk === 'object' &&
        typeof hunk.id === 'string' &&
        typeof hunk.path === 'string',
    )
  );
};

/** @param {unknown} value */
const isNarrativeWalkthrough = (value) => {
  const walkthrough = /** @type {any} */ (value);
  if (walkthrough && typeof walkthrough === 'object' && walkthrough.version === 5) {
    return Boolean(
      walkthrough.capturedContext &&
      typeof walkthrough.capturedContext === 'object' &&
      walkthrough.generationRequest &&
      typeof walkthrough.generationRequest === 'object' &&
      walkthrough.narrative &&
      typeof walkthrough.narrative === 'object',
    );
  }
  return (
    walkthrough &&
    typeof walkthrough === 'object' &&
    ['claude', 'codex', 'opencode', 'pi'].includes(walkthrough.agent) &&
    walkthrough.kind === 'narrative' &&
    walkthrough.version === 4 &&
    typeof walkthrough.focus === 'string' &&
    typeof walkthrough.generatedAt === 'string' &&
    typeof walkthrough.title === 'string' &&
    walkthrough.repo &&
    typeof walkthrough.repo === 'object' &&
    typeof walkthrough.repo.root === 'string' &&
    walkthrough.source &&
    typeof walkthrough.source === 'object' &&
    typeof walkthrough.source.type === 'string' &&
    Array.isArray(walkthrough.chapters) &&
    walkthrough.chapters.length > 0 &&
    walkthrough.chapters.every(
      (chapter) =>
        chapter &&
        typeof chapter === 'object' &&
        typeof chapter.id === 'string' &&
        typeof chapter.title === 'string' &&
        Array.isArray(chapter.stops) &&
        chapter.stops.length > 0 &&
        chapter.stops.every(isHunkGroup),
    ) &&
    Array.isArray(walkthrough.support) &&
    walkthrough.support.every(isHunkGroup)
  );
};

/**
 * @param {string} cacheKey
 * @returns {import('../core/types.ts').PersistedWalkthrough | null}
 */
const readStoredWalkthrough = (cacheKey) => {
  const path = getWalkthroughStorePath(cacheKey);
  if (!existsSync(path)) {
    return null;
  }

  try {
    if (statSync(path).size > MAX_STORED_WALKTHROUGH_BYTES) {
      return null;
    }
    const text = readFileSync(path, 'utf8');
    const record = JSON.parse(text);
    if (
      !record ||
      typeof record !== 'object' ||
      record.version !== STORED_WALKTHROUGH_VERSION ||
      record.cacheKey !== cacheKey ||
      !isNarrativeWalkthrough(record.walkthrough)
    ) {
      return null;
    }
    return record.walkthrough;
  } catch {
    return null;
  }
};

/**
 * @param {string} cacheKey
 * @param {import('../core/types.ts').PersistedWalkthrough} walkthrough
 */
const writeStoredWalkthrough = (cacheKey, walkthrough) => {
  const directory = getWalkthroughStoreDir();
  mkdirSync(directory, { recursive: true });
  const path = getWalkthroughStorePath(cacheKey);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      JSON.stringify({
        cacheKey,
        version: STORED_WALKTHROUGH_VERSION,
        walkthrough,
      }),
    );
    try {
      renameSync(temporaryPath, path);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (!existsSync(path) || (code !== 'EEXIST' && code !== 'EPERM')) {
        throw error;
      }
      rmSync(path, { force: true });
      renameSync(temporaryPath, path);
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
};

module.exports = {
  getWalkthroughStorePath,
  readStoredWalkthrough,
  writeStoredWalkthrough,
};
