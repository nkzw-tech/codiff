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
 *   generationRequest: import('../core/types.ts').WalkthroughGenerationRequest,
 *   profile: import('../core/types.ts').GenerationProfile,
 *   state: import('../core/types.ts').RepositoryState,
 * }} input
 */
const buildLocalReviewWalkthroughCacheIdentity = ({ generationRequest, profile, state }) => ({
  generationRequest,
  profile,
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
  version: 2,
});

/** @param {Parameters<typeof buildLocalReviewWalkthroughCacheIdentity>[0]} input */
const getLocalReviewWalkthroughCacheKey = (input) =>
  `local-review:${createHash('sha256')
    .update(JSON.stringify(buildLocalReviewWalkthroughCacheIdentity(input)))
    .digest('hex')}`;

module.exports = {
  buildLocalReviewWalkthroughCacheIdentity,
  getLocalReviewWalkthroughCacheKey,
};
