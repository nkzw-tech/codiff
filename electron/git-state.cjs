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
  createPullRequestSource,
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
  createGitLabPosition,
  createMergeRequestFetchRefspecs,
  listMergeRequestHistory,
  normalizeGitLabReviewComment,
  parseGitLabMergeRequestUrl,
  readMergeRequestImageContent,
  readMergeRequestState,
  submitMergeRequestComment,
  submitMergeRequestReview,
} = require('./git-state/merge-request.cjs');
const { parseReviewUrl } = require('./review-source.cjs');
const {
  readDiffSectionContent: readWorkingTreeDiffSectionContent,
  readDiffImageContent: readWorkingTreeDiffImageContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readWorkingTreeState,
} = require('./git-state/working-tree.cjs');

/**
 * @typedef {import('../core/types.ts').DiffSectionContentRequest} DiffSectionContentRequest
 * @typedef {import('../core/types.ts').DiffImageContentRequest} DiffImageContentRequest
 * @typedef {import('../core/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../core/types.ts').RepositoryHistory} RepositoryHistory
 * @typedef {import('../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../core/types.ts').ReviewSource} ReviewSource
 */

/** @param {string} launchPath @param {ReviewSource} [source] @param {{showWhitespace?: boolean}} [options] @returns {Promise<RepositoryState>} */
const readRepositoryState = async (launchPath, source = { type: 'working-tree' }, options = {}) => {
  const state =
    source.type === 'pull-request'
      ? await (isGitLabReviewSource(source) ? readMergeRequestState : readPullRequestState)(
          launchPath,
          source,
        )
      : source.type === 'commit'
        ? await readCommitState(launchPath, source.ref)
        : source.type === 'range'
          ? await readRangeState(launchPath, source.base, source.head, source.symmetric)
          : source.type === 'branch' || source.type === 'branch-diff'
            ? await readBranchState(launchPath, source)
            : await readWorkingTreeState(launchPath, {
                eagerContents: false,
                showWhitespace: options.showWhitespace,
              });
  const branch = (await gitOrEmpty(state.root, ['symbolic-ref', '--short', 'HEAD'])).trim() || null;
  return { ...state, branch };
};

/**
 * An implicit walkthrough reviews local changes when present and otherwise
 * reviews the current commit. Explicit sources always retain their semantics.
 *
 * @param {string} launchPath
 * @param {ReviewSource} [source]
 * @param {{showWhitespace?: boolean}} [options]
 * @returns {Promise<RepositoryState>}
 */
const readWalkthroughRepositoryState = async (launchPath, source, options = {}) => {
  const state = await readRepositoryState(launchPath, source, options);
  if (source || state.source.type !== 'working-tree' || state.files.length > 0) {
    return state;
  }

  const head = (await gitOrEmpty(state.root, ['rev-parse', '--verify', 'HEAD'])).trim();
  return head ? readRepositoryState(launchPath, { ref: 'HEAD', type: 'commit' }, options) : state;
};

/** @param {Extract<ReviewSource, {type: 'pull-request'}>} source */
const isGitLabReviewSource = (source) =>
  source.provider === 'gitlab' || parseReviewUrl(source.url)?.provider === 'gitlab';

/** @param {Extract<ReviewSource, {type: 'branch' | 'branch-diff'}>} source */
const getBranchHistoryRef = (source) =>
  source.type === 'branch-diff' ? `${source.baseRef}..${source.headRef}` : `${source.ref}..HEAD`;

/** @param {string} launchPath @param {number} [limit] @param {ReviewSource} [source] @returns {Promise<RepositoryHistory>} */
const readRepositoryHistory = (launchPath, limit, source) =>
  source?.type === 'pull-request'
    ? (isGitLabReviewSource(source) ? listMergeRequestHistory : listPullRequestHistory)(
        launchPath,
        source,
        limit,
      )
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
    ? (isGitLabReviewSource(request.source)
        ? readMergeRequestImageContent
        : readPullRequestImageContent)(launchPath, request.source, request.path)
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
  createGitLabPosition,
  createMergeRequestFetchRefspecs,
  createPullRequestSection,
  createPullRequestSource,
  getPullRequestHeadImageSource,
  listRepositoryHistory: readRepositoryHistory,
  normalizeGitHubPullRequestCommit,
  normalizeGitHubReviewComment,
  normalizeGitLabReviewComment,
  normalizePullRequestComment,
  parseStatus,
  parseGitHubPullRequestUrl,
  parseGitLabMergeRequestUrl,
  selectUnresolvedReviewComments,
  readBranchState,
  readDiffSectionContent,
  readDiffImageContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readCommitState,
  readPullRequestState,
  readRepositoryState,
  readWalkthroughRepositoryState,
  readWorkingTreeState,
  resolvePullRequestContentRefs,
  submitPullRequestComment: (launchPath, request) =>
    (isGitLabReviewSource(request.source) ? submitMergeRequestComment : submitPullRequestComment)(
      launchPath,
      request,
    ),
  submitPullRequestReview: (launchPath, request) =>
    (isGitLabReviewSource(request.source) ? submitMergeRequestReview : submitPullRequestReview)(
      launchPath,
      request,
    ),
  validateRepositoryPath,
};
