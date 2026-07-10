// @ts-check

// Persist the most recently generated narrative walkthrough for a repository +
// review source so reopening Codiff shows the same walkthrough instantly instead
// of regenerating. Stored under ~/.codiff/walkthroughs/ keyed by a hash of the
// caller-supplied key (agent + repo root + source), alongside the git commit and
// working-tree signature it was generated against so staleness can be reported.

const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { homedir } = require('node:os');
const { join } = require('node:path');

/**
 * @typedef {import('../core/types.ts').NarrativeWalkthrough} NarrativeWalkthrough
 * @typedef {{
 *   version: 1;
 *   walkthrough: NarrativeWalkthrough;
 *   head: string;
 *   signature: string;
 *   generatedAt: string;
 *   sessionId?: string;
 * }} StoredWalkthrough
 */

// Guard against a corrupt/huge file blocking startup.
const MAX_STORED_WALKTHROUGH_BYTES = 8 * 1024 * 1024;

const getWalkthroughStoreDir = () => join(homedir(), '.codiff', 'walkthroughs');

/** @param {string} key */
const getWalkthroughStorePath = (key) =>
  join(getWalkthroughStoreDir(), `${createHash('sha256').update(key).digest('hex')}.json`);

/**
 * @param {string} key
 * @returns {StoredWalkthrough | null}
 */
const readStoredWalkthrough = (key) => {
  const path = getWalkthroughStorePath(key);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const text = readFileSync(path, 'utf8');
    if (text.length > MAX_STORED_WALKTHROUGH_BYTES) {
      return null;
    }
    const parsed = JSON.parse(text);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.walkthrough ||
      typeof parsed.walkthrough !== 'object'
    ) {
      return null;
    }
    return /** @type {StoredWalkthrough} */ (parsed);
  } catch {
    // A malformed or unreadable store is treated as "nothing saved".
    return null;
  }
};

/**
 * @param {string} key
 * @param {StoredWalkthrough} value
 */
const writeStoredWalkthrough = (key, value) => {
  const dir = getWalkthroughStoreDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = getWalkthroughStorePath(key);
  // Write to a temp file and rename so a crash never leaves a half-written store.
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value));
  renameSync(tempPath, path);
};

module.exports = {
  getWalkthroughStorePath,
  readStoredWalkthrough,
  writeStoredWalkthrough,
};
