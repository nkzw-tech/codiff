// @ts-check

const { gitOrEmpty, parseStatus, validateRepositoryPath } = require('./git-state/common.cjs');
const {
  listArcRepositoryHistory,
  normalizeArcanumReviewComment,
  parseArcNameStatus,
  readArcImageContent,
  readArcIdentity,
  readArcRepositoryChangeSignature,
  readArcSectionContent,
  readArcState,
  submitArcPullRequestComment,
} = require('./git-state/arc.cjs');
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
  readRepositoryChangeSignature: readGitRepositoryChangeSignature,
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

/** @param {unknown} error */
const isNotGitRepositoryError = (error) =>
  /not a git repository/i.test(error instanceof Error ? error.message : String(error));

/** @param {ReviewSource | undefined} source */
const isArcSource = (source) =>
  source?.type === 'arc-working-tree' ||
  source?.type === 'arc-branch' ||
  source?.type === 'arc-range' ||
  source?.type === 'arc-commit' ||
  source?.type === 'arc-pull-request';

/** @param {ReviewSource} source */
const isWorkingTreeSource = (source) =>
  source.type === 'working-tree' || source.type === 'arc-working-tree';

/** @param {string} launchPath @param {ReviewSource} [source] @param {{showWhitespace?: boolean}} [options] @returns {Promise<RepositoryState>} */
const readRepositoryState = async (launchPath, source, options = {}) => {
  let state;
  if (isArcSource(source)) {
    state = await readArcState(launchPath, source, { showWhitespace: options.showWhitespace });
  } else if (source?.type === 'pull-request') {
    state = await (isGitLabReviewSource(source) ? readMergeRequestState : readPullRequestState)(
      launchPath,
      source,
    );
  } else if (source?.type === 'commit') {
    state = await readCommitState(launchPath, source.ref);
  } else if (source?.type === 'range') {
    state = await readRangeState(launchPath, source.base, source.head, source.symmetric);
  } else if (source?.type === 'branch' || source?.type === 'branch-diff') {
    state = await readBranchState(launchPath, source);
  } else {
    state = await readWorkingTreeState(launchPath, {
      eagerContents: false,
      showWhitespace: options.showWhitespace,
    }).catch(async (error) => {
      if (isNotGitRepositoryError(error)) {
        try {
          return await readArcState(launchPath, { type: 'arc-working-tree' }, options);
        } catch {
          throw error;
        }
      }
      throw error;
    });
  }

  const branch =
    (await gitOrEmpty(state.root, ['symbolic-ref', '--short', 'HEAD'])).trim() || state.branch;
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
  if (source || !isWorkingTreeSource(state.source) || state.files.length > 0) {
    return state;
  }

  if (state.source.type === 'arc-working-tree') {
    const history = await listArcRepositoryHistory(state.root, 1, state.source);
    return history.entries.length > 0
      ? readRepositoryState(launchPath, { ref: 'HEAD', type: 'arc-commit' }, options)
      : state;
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
  isArcSource(source)
    ? listArcRepositoryHistory(launchPath, limit, source)
    : source?.type === 'pull-request'
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
const readDiffSectionContent = async (launchPath, request) => {
  if (isArcSource(request.source)) {
    return readArcSectionContent(launchPath, request);
  }

  if (request.source?.type === 'range') {
    return readRangeSectionContent(
      launchPath,
      request.source.base,
      request.source.head,
      request.source.symmetric,
      request.path,
      { force: request.force },
    );
  }

  if (request.source?.type === 'branch' || request.source?.type === 'branch-diff') {
    return readBranchSectionContent(launchPath, request.source, request.path, {
      force: request.force,
    });
  }

  if (request.kind === 'commit' || request.source?.type === 'commit') {
    return readCommitSectionContent(launchPath, request.source?.ref || 'HEAD', request.path, {
      force: request.force,
    });
  }

  return readWorkingTreeDiffSectionContent(launchPath, request);
};

/** @param {string} launchPath @param {DiffImageContentRequest} request @returns {Promise<DiffImageContentResult>} */
const readDiffImageContent = (launchPath, request) => {
  if (isArcSource(request.source)) {
    return readArcImageContent(launchPath, request);
  }

  if (request.source?.type === 'pull-request') {
    return (
      isGitLabReviewSource(request.source)
        ? readMergeRequestImageContent
        : readPullRequestImageContent
    )(launchPath, request.source, request.path);
  }

  if (request.source?.type === 'range') {
    return readRangeImageContent(
      launchPath,
      request.source.base,
      request.source.head,
      request.source.symmetric,
      request.path,
    );
  }

  if (request.source?.type === 'branch' || request.source?.type === 'branch-diff') {
    return readBranchImageContent(launchPath, request.source, request.path);
  }

  if (request.kind === 'commit' || request.source?.type === 'commit') {
    return readCommitImageContent(launchPath, request.source?.ref || 'HEAD', request.path);
  }

  return readWorkingTreeDiffImageContent(launchPath, request);
};

/** @param {string} launchPath @param {Iterable<string>} [additionalPaths] */
const readRepositoryChangeSignature = async (launchPath, additionalPaths = []) => {
  try {
    return await readGitRepositoryChangeSignature(launchPath, additionalPaths);
  } catch (error) {
    if (!isNotGitRepositoryError(error)) {
      throw error;
    }
    return readArcRepositoryChangeSignature(launchPath, additionalPaths);
  }
};

/** @param {string} launchPath */
const readLocalIdentity = async (launchPath) => {
  try {
    return await readArcIdentity(launchPath);
  } catch {
    // Fall through to Git/global identity when Arc is unavailable.
  }

  try {
    const identity = await readGitIdentity(launchPath);
    if (identity.name || identity.email) {
      return identity;
    }
  } catch (error) {
    if (!isNotGitRepositoryError(error)) {
      throw error;
    }
  }
  return readArcIdentity(launchPath);
};

module.exports = {
  collectResolvedReviewCommentIds,
  createPullRequestHistoryFetchRefspecs,
  createGitLabPosition,
  createMergeRequestFetchRefspecs,
  createPullRequestSection,
  getPullRequestHeadImageSource,
  listRepositoryHistory: readRepositoryHistory,
  normalizeGitHubPullRequestCommit,
  normalizeGitHubReviewComment,
  normalizeArcanumReviewComment,
  normalizeGitLabReviewComment,
  normalizePullRequestComment,
  parseArcNameStatus,
  parseStatus,
  parseGitHubPullRequestUrl,
  parseGitLabMergeRequestUrl,
  selectUnresolvedReviewComments,
  readBranchState,
  readDiffSectionContent,
  readDiffImageContent,
  readGitIdentity: readLocalIdentity,
  readRepositoryChangeSignature,
  readCommitState,
  readPullRequestState,
  readRepositoryState,
  readWalkthroughRepositoryState,
  readWorkingTreeState,
  resolvePullRequestContentRefs,
  submitPullRequestComment: (launchPath, request) =>
    request.source.type === 'arc-pull-request'
      ? submitArcPullRequestComment(launchPath, request)
      : (isGitLabReviewSource(request.source)
          ? submitMergeRequestComment
          : submitPullRequestComment)(launchPath, request),
  submitPullRequestReview: (launchPath, request) => {
    // TODO(arcadia): Replace this guard with a real Arcanum review-verdict call when
    // Arcanum exposes Approve/Request changes through the available API/tooling.
    if (request.source.type === 'arc-pull-request') {
      throw new Error(
        'Arcadia review verdicts are not supported yet. Add inline comments instead.',
      );
    }
    return (
      isGitLabReviewSource(request.source) ? submitMergeRequestReview : submitPullRequestReview
    )(launchPath, request);
  },
  validateRepositoryPath,
};
