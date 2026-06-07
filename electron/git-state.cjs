// @ts-check

const { gitOrEmpty, parseStatus, validateRepositoryPath } = require('./git-state/common.cjs');
const {
  listRepositoryHistory,
  readBranchImageContent,
  readBranchSectionContent,
  readBranchState,
  readCommitImageContent,
  readCommitSectionContent,
  readCommitState,
  readRangeImageContent,
  readRangeSectionContent,
  readRangeState,
} = require('./git-state/commit.cjs');
const {
  collectResolvedReviewCommentIds,
  createPullRequestHistoryFetchRefspecs,
  createPullRequestSection,
  getPullRequestHeadImageSource,
  listPullRequestHistory,
  normalizeGitHubPullRequestCommit,
  normalizeGitHubReviewComment,
  normalizePullRequestComment,
  parseGitHubPullRequestUrl,
  readPullRequestImageContent,
  readPullRequestState,
  resolvePullRequestContentRefs,
  selectUnresolvedReviewComments,
  submitPullRequestComment,
  submitPullRequestReview,
} = require('./git-state/pull-request.cjs');
const {
  readDiffSectionContent: readWorkingTreeDiffSectionContent,
  readDiffImageContent: readWorkingTreeDiffImageContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readWorkingTreeState,
} = require('./git-state/working-tree.cjs');

/**
 * @typedef {import('../src/types.ts').DiffSectionContentRequest} DiffSectionContentRequest
 * @typedef {import('../src/types.ts').DiffImageContentRequest} DiffImageContentRequest
 * @typedef {import('../src/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../src/types.ts').RepositoryHistory} RepositoryHistory
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
        : source.type === 'range'
          ? await readRangeState(launchPath, source.base, source.head, source.symmetric)
          : source.type === 'branch' || source.type === 'branch-diff'
            ? await readBranchState(launchPath, source)
            : await readWorkingTreeState(launchPath, { eagerContents: false });
  const branch = (await gitOrEmpty(state.root, ['symbolic-ref', '--short', 'HEAD'])).trim() || null;
  return { ...state, branch };
};

/** @param {Extract<ReviewSource, {type: 'branch' | 'branch-diff'}>} source */
const getBranchHistoryRef = (source) =>
  source.type === 'branch-diff' ? `${source.baseRef}..${source.headRef}` : `${source.ref}..HEAD`;

/** @param {string} launchPath @param {number} [limit] @param {ReviewSource} [source] @returns {Promise<RepositoryHistory>} */
const readRepositoryHistory = (launchPath, limit, source) =>
  source?.type === 'pull-request'
    ? listPullRequestHistory(launchPath, source, limit)
    : listRepositoryHistory(
        launchPath,
        limit,
        source?.type === 'branch' || source?.type === 'branch-diff'
          ? getBranchHistoryRef(source)
          : undefined,
      );

/** @param {string} launchPath @param {DiffSectionContentRequest} request */
const readDiffSectionContent = async (launchPath, request) =>
  request.source?.type === 'range'
    ? readRangeSectionContent(
        launchPath,
        request.source.base,
        request.source.head,
        request.source.symmetric,
        request.path,
        { force: request.force },
      )
    : request.source?.type === 'branch' || request.source?.type === 'branch-diff'
      ? readBranchSectionContent(launchPath, request.source, request.path, {
          force: request.force,
        })
      : request.kind === 'commit' || request.source?.type === 'commit'
        ? readCommitSectionContent(launchPath, request.source?.ref || 'HEAD', request.path, {
            force: request.force,
          })
        : readWorkingTreeDiffSectionContent(launchPath, request);

/** @param {string} launchPath @param {DiffImageContentRequest} request @returns {Promise<DiffImageContentResult>} */
const readDiffImageContent = (launchPath, request) =>
  request.source?.type === 'pull-request'
    ? readPullRequestImageContent(launchPath, request.source, request.path)
    : request.source?.type === 'range'
      ? readRangeImageContent(
          launchPath,
          request.source.base,
          request.source.head,
          request.source.symmetric,
          request.path,
        )
      : request.source?.type === 'branch' || request.source?.type === 'branch-diff'
        ? readBranchImageContent(launchPath, request.source, request.path)
        : request.kind === 'commit' || request.source?.type === 'commit'
          ? readCommitImageContent(launchPath, request.source?.ref || 'HEAD', request.path)
          : readWorkingTreeDiffImageContent(launchPath, request);

module.exports = {
  collectResolvedReviewCommentIds,
  createPullRequestHistoryFetchRefspecs,
  createPullRequestSection,
  getPullRequestHeadImageSource,
  listRepositoryHistory: readRepositoryHistory,
  normalizeGitHubPullRequestCommit,
  normalizeGitHubReviewComment,
  normalizePullRequestComment,
  parseStatus,
  parseGitHubPullRequestUrl,
  selectUnresolvedReviewComments,
  readBranchState,
  readDiffSectionContent,
  readDiffImageContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readCommitState,
  readPullRequestState,
  readRepositoryState,
  readWorkingTreeState,
  resolvePullRequestContentRefs,
  submitPullRequestComment,
  submitPullRequestReview,
  validateRepositoryPath,
};
