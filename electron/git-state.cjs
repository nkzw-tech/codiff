// @ts-check

const { gitOrEmpty, parseStatus, validateRepositoryPath } = require('./git-state/common.cjs');
const {
  listRepositoryHistory,
  readCommitSectionContent,
  readCommitState,
} = require('./git-state/commit.cjs');
const {
  normalizeGitHubReviewComment,
  normalizePullRequestComment,
  parseGitHubPullRequestUrl,
  readPullRequestState,
  submitPullRequestComment,
  submitPullRequestReview,
} = require('./git-state/pull-request.cjs');
const {
  readDiffSectionContent: readWorkingTreeDiffSectionContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readWorkingTreeState,
} = require('./git-state/working-tree.cjs');

/**
 * @typedef {import('../src/types.ts').DiffSectionContentRequest} DiffSectionContentRequest
 * @typedef {import('../src/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../src/types.ts').ReviewSource} ReviewSource
 */

/** @param {string} launchPath @param {ReviewSource} [source] @returns {Promise<RepositoryState>} */
const readRepositoryState = async (launchPath, source = { type: 'working-tree' }) => {
  const state =
    source.type === 'pull-request'
      ? await readPullRequestState(launchPath, source)
      : source.type === 'commit'
        ? await readCommitState(launchPath, source.ref)
        : await readWorkingTreeState(launchPath, { eagerContents: false });
  const branch = (await gitOrEmpty(state.root, ['symbolic-ref', '--short', 'HEAD'])).trim() || null;
  return { ...state, branch };
};

/** @param {string} launchPath @param {DiffSectionContentRequest} request */
const readDiffSectionContent = async (launchPath, request) =>
  request.kind === 'commit' || request.source?.type === 'commit'
    ? readCommitSectionContent(launchPath, request.source?.ref || 'HEAD', request.path, {
        force: request.force,
      })
    : readWorkingTreeDiffSectionContent(launchPath, request);

module.exports = {
  listRepositoryHistory,
  normalizeGitHubReviewComment,
  normalizePullRequestComment,
  parseStatus,
  parseGitHubPullRequestUrl,
  readDiffSectionContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readCommitState,
  readPullRequestState,
  readRepositoryState,
  readWorkingTreeState,
  submitPullRequestComment,
  submitPullRequestReview,
  validateRepositoryPath,
};
