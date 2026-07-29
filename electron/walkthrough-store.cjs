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
const stableValue = (value) => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
};

/** @param {unknown} left @param {unknown} right */
const valuesEqual = (left, right) =>
  JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));

/** @param {import('../core/types.ts').AssessmentIdentity} identity */
const assessmentIdentityKey = (identity) => JSON.stringify(stableValue(identity));

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

/**
 * Replace exactly one assessment identity if the stored component still
 * matches the caller's scheduling snapshot. Pending claims deliberately stay
 * in memory and never enter the persisted artifact.
 *
 * @param {string} cacheKey
 * @param {{
 *   component: import('../core/types.ts').AssessmentComponent,
 *   expectedComponent: import('../core/types.ts').AssessmentComponent | null,
 * }} replacement
 * @returns {{
 *   status: 'idempotent' | 'missing' | 'replaced' | 'stale',
 *   walkthrough: import('../core/types.ts').WalkthroughArtifactV5 | null,
 * }}
 */
const replaceStoredAssessment = (cacheKey, { component, expectedComponent }) => {
  const stored = readStoredWalkthrough(cacheKey);
  if (!stored || stored.version !== 5) {
    return { status: 'missing', walkthrough: null };
  }
  const items = stored.assessments?.items ?? [];
  const index = items.findIndex((item) => valuesEqual(item.identity, component.identity));
  const current = index === -1 ? null : items[index];

  if (current && valuesEqual(current, component)) {
    return { status: 'idempotent', walkthrough: stored };
  }
  if (!valuesEqual(current, expectedComponent)) {
    return { status: 'stale', walkthrough: stored };
  }

  const nextItems = [...items];
  if (index === -1) {
    nextItems.push(component);
  } else {
    nextItems[index] = component;
  }
  nextItems.sort((left, right) =>
    assessmentIdentityKey(left.identity).localeCompare(assessmentIdentityKey(right.identity)),
  );
  const walkthrough = { ...stored, assessments: { items: nextItems } };
  writeStoredWalkthrough(cacheKey, walkthrough);
  return { status: 'replaced', walkthrough };
};

module.exports = {
  getWalkthroughStorePath,
  readStoredWalkthrough,
  replaceStoredAssessment,
  writeStoredWalkthrough,
};
