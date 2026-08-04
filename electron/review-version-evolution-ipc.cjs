// @ts-check

/**
 * Keep the IPC call aligned with the review-history function's optional
 * versions slot. Controls are deliberately the fifth argument.
 *
 * @param {typeof import('./git-state/review-history.cjs').classifyReviewVersionEvolution} classify
 * @param {string} repoRoot
 * @param {Extract<import('../core/types.ts').ReviewSource, {type: 'pull-request'}>} source
 * @param {import('../core/types.ts').ReviewVersionRangeRequest} range
 * @param {{
 *   comparisonRun?: {artifactRuns?: Map<string, Promise<any>>},
 *   onProgress?: (progress: import('../core/types.ts').ReviewVersionEvolutionProgress) => void,
 *   signal?: AbortSignal,
 * }} controls
 */
const loadReviewVersionEvolution = (classify, repoRoot, source, range, controls) =>
  classify(repoRoot, source, range, undefined, controls);

module.exports = { loadReviewVersionEvolution };
