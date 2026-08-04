// @ts-check

/** CJS bridge to Core's format-neutral walkthrough task runner (ESM). */

const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

/** @type {Promise<typeof import('../core/walkthrough-generation.ts')> | null} */
let modulePromise = null;

const loadWalkthroughGeneration = async () => {
  if (!modulePromise) {
    const modulePath = join(__dirname, '../core/dist/walkthrough-generation.mjs');
    modulePromise = import(pathToFileURL(modulePath).href);
  }
  return modulePromise;
};

/**
 * Convert the canonical parent-before-child review stack into generation units.
 * @param {ReadonlyArray<import('../core/types.ts').ReviewCommitSummary>} commits
 * @returns {ReadonlyArray<import('../core/types.ts').ReviewCommitUnit>}
 */
const createCommitWalkthroughUnits = (commits) =>
  commits.map((commit, order) => ({ commit, kind: 'commit', order, reviewable: true }));

/**
 * Internal structured generation stage used by the narrative coordinator.
 * @param {Parameters<typeof import('../core/lib/generate-review-walkthrough.ts').generateReviewWalkthrough>[0]} input
 */
const runStructuredWalkthroughGeneration = async (input) => {
  const module = await loadWalkthroughGeneration();
  return module.generateReviewWalkthrough(input);
};

/**
 * @param {Parameters<typeof import('../core/lib/walkthrough-generation-tasks.ts').runWalkthroughGenerationTasks>[0]} input
 */
const runWalkthroughGenerationTasks = async (input) => {
  const module = await loadWalkthroughGeneration();
  return module.runWalkthroughGenerationTasks(input);
};

module.exports = {
  createCommitWalkthroughUnits,
  loadWalkthroughGeneration,
  runStructuredWalkthroughGeneration,
  runWalkthroughGenerationTasks,
};
