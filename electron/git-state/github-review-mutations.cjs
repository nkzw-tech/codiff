// @ts-check

const { git } = require('./common.cjs');
const { validateCurrentReviewCommentTarget } = require('./review-comment-target.cjs');

/**
 * @typedef {import('../../core/types.ts').PullRequestReviewComment} PullRequestReviewComment
 * @typedef {import('../../core/types.ts').SubmitPullRequestCommentRequest} SubmitPullRequestCommentRequest
 * @typedef {import('../../core/types.ts').SubmitPullRequestReviewRequest} SubmitPullRequestReviewRequest
 * @typedef {{number: number, owner: string, repo: string, url: string}} PullRequestReference
 * @typedef {{request: (request: {body?: unknown, method?: 'GET' | 'POST', paginate?: boolean, path: string, query?: Readonly<Record<string, boolean | number | string>>}) => Promise<any>}} GitHubMutationTransport
 * @typedef {{baseSha?: string, files: ReadonlyArray<{newPath: string, oldPath?: string, patch?: string}>, headSha?: string}} GitHubReviewTarget
 */

const PENDING_REVIEW_COMMENT_ERROR =
  'You already have a pending GitHub review on this pull request. Submit or discard it on GitHub, then retry. Your comment draft is still here.';

/** @param {PullRequestReviewComment['side']} side */
const toGitHubReviewSide = (side) => (side === 'deletions' ? 'LEFT' : 'RIGHT');

/** @param {PullRequestReviewComment} comment */
const normalizePullRequestComment = (comment) => {
  if (comment.anchor === 'file' || comment.lineNumber == null || comment.side == null) {
    return {
      body: comment.body,
      path: comment.filePath,
      subject_type: 'file',
    };
  }
  /** @type {{body: string, line: number, path: string, side: string, start_line?: number, start_side?: string}} */
  const payload = {
    body: comment.body,
    line: comment.lineNumber,
    path: comment.filePath,
    side: toGitHubReviewSide(comment.side),
  };
  const startSide = comment.startSide ?? comment.side;
  if (
    typeof comment.startLineNumber === 'number' &&
    comment.startLineNumber !== comment.lineNumber
  ) {
    payload.start_line = comment.startLineNumber;
    payload.start_side = toGitHubReviewSide(startSide);
  }
  return payload;
};

/** @param {unknown} error */
const isGitHubValidationError = (error) =>
  error instanceof Error && /(?:validation failed|http 422)/i.test(error.message);

/** @param {SubmitPullRequestReviewRequest} request */
const validatePullRequestReviewRequest = (request) => {
  const body = request.body?.trim() || '';
  if (request.event === 'COMMENT' && request.comments.length === 0 && !body) {
    throw new Error('A comment review requires an inline comment or a review comment.');
  }
};

/** @param {SubmitPullRequestReviewRequest} request @param {string} targetSha */
const createPullRequestReviewPayload = (request, targetSha) => {
  validatePullRequestReviewRequest(request);
  const body = request.body?.trim() || '';
  return {
    body:
      body ||
      (request.event === 'COMMENT'
        ? 'Review comments.'
        : request.event === 'REQUEST_CHANGES' && request.comments.length === 0
          ? 'Requesting changes.'
          : ''),
    commit_id: targetSha,
    comments: request.comments.map(normalizePullRequestComment),
    event: request.event,
  };
};

/**
 * @param {{
 *   assertPullRequestMatchesRepository: (repoRoot: string, pullRequest: PullRequestReference) => Promise<void>,
 *   createTransport: (repoRoot: string, pullRequest: PullRequestReference) => GitHubMutationTransport,
 *   normalizeGitHubReviewComment: (comment: any) => import('../../core/types.ts').PullRequestExistingReviewComment | null,
 *   parseGitHubPullRequestUrl: (value: string) => PullRequestReference,
 *   readCurrentTarget: (repoRoot: string, pullRequest: PullRequestReference, transport: GitHubMutationTransport) => Promise<GitHubReviewTarget>,
 * }} dependencies
 */
const createGitHubReviewMutations = ({
  assertPullRequestMatchesRepository,
  createTransport,
  normalizeGitHubReviewComment,
  parseGitHubPullRequestUrl,
  readCurrentTarget,
}) => {
  /** @param {PullRequestReference} pullRequest @param {GitHubMutationTransport} transport */
  const hasPendingPullRequestReview = async (pullRequest, transport) => {
    const reviews = await transport.request({
      paginate: true,
      path: `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/reviews`,
      query: { per_page: 100 },
    });
    return Array.isArray(reviews) && reviews.some((review) => review?.state === 'PENDING');
  };

  /** @param {string} launchPath @param {SubmitPullRequestCommentRequest} request */
  const submitPullRequestComment = async (launchPath, request) => {
    const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
    const pullRequest = parseGitHubPullRequestUrl(request.source.url);
    await assertPullRequestMatchesRepository(repoRoot, pullRequest);
    const transport = createTransport(repoRoot, pullRequest);
    const target = await readCurrentTarget(repoRoot, pullRequest, transport);
    validateCurrentReviewCommentTarget(request.comment, target);
    const replyTo = request.comment.threadId ? Number(request.comment.threadId) : null;
    if (request.comment.threadId && (!Number.isInteger(replyTo) || replyTo <= 0)) {
      throw new Error('GitHub review replies require a numeric provider thread ID.');
    }
    const rawComment = await transport
      .request({
        body: replyTo
          ? { body: request.comment.body, in_reply_to: replyTo }
          : {
              ...normalizePullRequestComment(request.comment),
              commit_id: target.headSha,
            },
        method: 'POST',
        path: `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/comments`,
      })
      .catch(async (error) => {
        if (isGitHubValidationError(error)) {
          const hasPendingReview = await hasPendingPullRequestReview(pullRequest, transport).catch(
            () => false,
          );
          if (hasPendingReview) {
            throw new Error(PENDING_REVIEW_COMMENT_ERROR);
          }
        }
        throw error;
      });
    const comment = normalizeGitHubReviewComment(rawComment);
    if (!comment) {
      throw new Error('GitHub accepted the comment but did not return line metadata.');
    }
    return comment;
  };

  /** @param {string} launchPath @param {SubmitPullRequestReviewRequest} request */
  const submitPullRequestReview = async (launchPath, request) => {
    /** @type {Array<string>} */
    const submittedDraftIds = [];
    try {
      validatePullRequestReviewRequest(request);
      const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
      const pullRequest = parseGitHubPullRequestUrl(request.source.url);
      await assertPullRequestMatchesRepository(repoRoot, pullRequest);
      const transport = createTransport(repoRoot, pullRequest);
      const target = await readCurrentTarget(repoRoot, pullRequest, transport);
      if (!target.headSha) {
        throw new Error('GitHub did not return the current pull request head.');
      }
      if (request.source.headSha && target.headSha !== request.source.headSha) {
        throw new Error('The pull request head changed. Refresh before submitting.');
      }
      for (const comment of request.comments) {
        validateCurrentReviewCommentTarget(comment, target);
      }
      await transport.request({
        body: createPullRequestReviewPayload(request, target.headSha),
        method: 'POST',
        path: `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/reviews`,
      });
      submittedDraftIds.push(
        ...request.comments
          .map((comment) => comment.localDraftId)
          .filter((id) => typeof id === 'string'),
      );
      return { status: /** @type {const} */ ('submitted'), submittedDraftIds };
    } catch (error) {
      return {
        reason: error instanceof Error ? error.message : String(error),
        status: /** @type {const} */ ('failed'),
        submittedDraftIds,
      };
    }
  };

  return { submitPullRequestComment, submitPullRequestReview };
};

module.exports = {
  PENDING_REVIEW_COMMENT_ERROR,
  createGitHubReviewMutations,
  normalizePullRequestComment,
};
