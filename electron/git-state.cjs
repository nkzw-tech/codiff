// @ts-check

const {
  git,
  gitOrEmpty,
  parseStatus,
  runWithCommandSignal,
  validateRepositoryPath,
} = require('./git-state/common.cjs');
const {
  listRepositoryHistory,
  readBranchState,
  readBranchWorkingTreeState,
  readCommitState,
  readResolvedCommitState,
  readRangeState,
} = require('./git-state/commit.cjs');
const {
  createRepositoryWatcherSnapshot,
  parseRepositoryWatcherStatus,
  setRepositoryWatcherInitialSnapshot,
  transferRepositoryWatcherInitialSnapshot,
} = require('./repository-watcher.cjs');
const {
  PENDING_REVIEW_COMMENT_ERROR,
  collectResolvedReviewCommentIds,
  createPullRequestHistoryFetchRefspecs,
  createPullRequestSource,
  listPullRequestHistory,
  normalizeGitHubPullRequestCommit,
  normalizeGitHubReviewComment,
  normalizePullRequestComment,
  parseGitHubPullRequestUrl,
  readPullRequestReviewComments,
  readPullRequestState,
  selectUnresolvedReviewComments,
  submitPullRequestComment,
  submitPullRequestReview,
} = require('./git-state/pull-request.cjs');
const { createPullRequestSection } = require('./git-state/review-range-sections.cjs');
const {
  createGitLabPosition,
  createMergeRequestFetchRefspecs,
  listMergeRequestHistory,
  normalizeGitLabReviewComment,
  parseGitLabMergeRequestUrl,
  readMergeRequestReviewComments,
  readMergeRequestState,
  submitMergeRequestComment,
  submitMergeRequestReview,
} = require('./git-state/merge-request.cjs');
const { parseReviewUrl } = require('./review-source.cjs');
const { readGitIdentity, readWorkingTreeState } = require('./git-state/working-tree.cjs');
const { annotateGeneratedFiles } = require('./generated-files.cjs');
const { readRevisionContent } = require('./review-content.cjs');

/**
 * @typedef {import('../core/types.ts').RepositoryHistory} RepositoryHistory
 * @typedef {import('../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../core/types.ts').ReviewSource} ReviewSource
 */

/** @param {string} launchPath @param {ReviewSource} [source] @param {{repositoryRoot?: string; showWhitespace?: boolean}} [options] @returns {Promise<RepositoryState>} */
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
            : source.type === 'branch-working-tree'
              ? await readBranchWorkingTreeState(launchPath, source, {
                  showWhitespace: options.showWhitespace,
                })
              : await readWorkingTreeState(launchPath, {
                  eagerContents: false,
                  repositoryRoot: options.repositoryRoot,
                  showWhitespace: options.showWhitespace,
                });
  const comparisonState =
    source.type === 'commit' ||
    source.type === 'range' ||
    source.type === 'branch' ||
    source.type === 'branch-diff';
  const generatedRevision =
    state.source.type === 'pull-request' && state.source.headSha
      ? {
          label: { kind: 'commit', text: state.source.headSha.slice(0, 7) },
          sha: state.source.headSha,
        }
      : {
          kind: /** @type {const} */ ('working-copy'),
          label: { kind: /** @type {const} */ ('review-marker'), text: 'Working Copy' },
        };
  const [branch, annotatedState] = await Promise.all([
    source.type === 'pull-request'
      ? Promise.resolve('')
      : gitOrEmpty(state.root, ['symbolic-ref', '--short', 'HEAD']),
    comparisonState ? state : annotateGeneratedFiles(state, generatedRevision),
  ]);
  return transferRepositoryWatcherInitialSnapshot(state, {
    ...annotatedState,
    branch: branch.trim() || null,
  });
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
  if (source) {
    return readRepositoryState(launchPath, source, options);
  }

  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const status = parseRepositoryWatcherStatus(
    await git(repoRoot, [
      'status',
      '--porcelain=v2',
      '--branch',
      '--no-ahead-behind',
      '-z',
      '-uall',
    ]),
  );
  if (status.paths.length > 0) {
    return readRepositoryState(launchPath, undefined, options);
  }

  const [head, branchHead] = status.head.split('\0');
  const branch = branchHead && branchHead !== '(detached)' ? branchHead : null;
  if (/^[0-9a-f]+$/i.test(head)) {
    const state = await readResolvedCommitState(launchPath, repoRoot, head);
    return { ...state, branch };
  }

  return setRepositoryWatcherInitialSnapshot(
    {
      branch,
      files: [],
      generatedAt: Date.now(),
      launchPath,
      root: repoRoot,
      source: {
        type: 'working-tree',
      },
    },
    createRepositoryWatcherSnapshot(repoRoot, status),
  );
};

/** @param {Extract<ReviewSource, {type: 'pull-request'}>} source */
const isGitLabReviewSource = (source) =>
  source.provider === 'gitlab' || parseReviewUrl(source.url)?.provider === 'gitlab';

/** @param {Extract<ReviewSource, {type: 'branch' | 'branch-diff' | 'branch-working-tree'}>} source */
const getBranchHistoryRef = (source) =>
  source.type !== 'branch' && source.baseSha && source.headSha
    ? `${source.baseSha}..${source.headSha}`
    : `${source.ref}..HEAD`;

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
        source?.type === 'branch' ||
          source?.type === 'branch-diff' ||
          source?.type === 'branch-working-tree'
          ? getBranchHistoryRef(source)
          : undefined,
      );

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source */
const readReviewComments = (launchPath, source) =>
  (isGitLabReviewSource(source) ? readMergeRequestReviewComments : readPullRequestReviewComments)(
    launchPath,
    source,
  );

module.exports = {
  PENDING_REVIEW_COMMENT_ERROR,
  collectResolvedReviewCommentIds,
  createPullRequestHistoryFetchRefspecs,
  createGitLabPosition,
  createMergeRequestFetchRefspecs,
  createPullRequestSection,
  createPullRequestSource,
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
  readGitIdentity,
  readReviewComments,
  readCommitState,
  readPullRequestState,
  readRevisionContent,
  readRepositoryState,
  readWalkthroughRepositoryState,
  readWorkingTreeState,
  runWithCommandSignal,
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
