// @ts-check

const { createHash } = require('node:crypto');
const { getReviewedDiffSignature } = require('./reviewed-diff-signature.cjs');

/** @param {unknown} value */
const normalizeReviewText = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  return value.trim() || null;
};

/**
 * @param {{
 *   profile: import('../core/types.ts').GenerationProfile,
 *   request: unknown,
 *   state: import('../core/types.ts').RepositoryState,
 * }} input
 */
const buildWalkthroughGenerationCacheIdentity = ({ profile, request, state }) => ({
  profile,
  request,
  reviewedDiffSignature: getReviewedDiffSignature(state.files),
  source:
    state.source.type === 'pull-request'
      ? {
          description: normalizeReviewText(state.source.description),
          headSha: state.source.headSha ?? null,
          number: state.source.number ?? null,
          provider: state.source.provider ?? null,
          projectPath: state.source.projectPath ?? null,
          targetBranch: state.source.targetBranch ?? null,
          title: normalizeReviewText(state.source.title),
          url: state.source.url,
        }
      : state.source,
  version: 1,
});

/** @param {Parameters<typeof buildWalkthroughGenerationCacheIdentity>[0]} input */
const getWalkthroughGenerationCacheKey = (input) =>
  `walkthrough-generation:${createHash('sha256')
    .update(JSON.stringify(buildWalkthroughGenerationCacheIdentity(input)))
    .digest('hex')}`;

module.exports = { buildWalkthroughGenerationCacheIdentity, getWalkthroughGenerationCacheKey };
