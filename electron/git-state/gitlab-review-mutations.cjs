// @ts-check

const { createHash } = require('node:crypto');
const { git } = require('./common.cjs');
const {
  targetResolutionError,
  validateCurrentReviewCommentTarget,
} = require('./review-comment-target.cjs');

/**
 * @typedef {import('../../core/types.ts').PullRequestReviewComment} PullRequestReviewComment
 * @typedef {{request: (request: {body?: unknown, method?: 'DELETE' | 'GET' | 'POST', path: string}) => Promise<any>}} GitLabMutationTransport
 */

/** @param {string} path @param {number | undefined} oldLine @param {number | undefined} newLine */
const getGitLabLineCode = (path, oldLine, newLine) =>
  `${createHash('sha1').update(path).digest('hex')}_${oldLine || 0}_${newLine || 0}`;

/** @param {string} diff */
const createGitLabDiffLineMap = (diff) => {
  const lines = new Map();
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      lines.set(`additions:${newLine}`, { newLine });
      newLine += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      lines.set(`deletions:${oldLine}`, { oldLine });
      oldLine += 1;
    } else if (oldLine > 0 && newLine > 0 && line.startsWith(' ')) {
      const value = { newLine, oldLine };
      lines.set(`additions:${newLine}`, value);
      lines.set(`deletions:${oldLine}`, value);
      oldLine += 1;
      newLine += 1;
    }
  }
  return lines;
};

/** @param {PullRequestReviewComment} comment @param {any} metadata @param {any} diff */
const createGitLabPosition = (comment, metadata, diff) => {
  const oldPath = diff?.old_path || comment.filePath;
  const newPath = diff?.new_path || comment.filePath;
  const targetRange = comment.position?.range;
  const targetBaseSha =
    targetRange?.base && 'sha' in targetRange.base
      ? targetRange.base.sha
      : metadata.diff_refs?.base_sha;
  const targetHeadSha =
    targetRange?.head && 'sha' in targetRange.head
      ? targetRange.head.sha
      : metadata.diff_refs?.head_sha || metadata.sha;
  if (comment.anchor === 'file' || comment.lineNumber == null || comment.side == null) {
    return {
      base_sha: targetBaseSha,
      head_sha: targetHeadSha,
      new_path: newPath,
      old_path: oldPath,
      position_type: 'file',
      start_sha: metadata.diff_refs?.start_sha,
    };
  }
  const lineMap = createGitLabDiffLineMap(diff?.diff || '');
  const endLines = lineMap.get(`${comment.side}:${comment.lineNumber}`) || {
    ...(comment.side === 'deletions'
      ? { oldLine: comment.lineNumber }
      : { newLine: comment.lineNumber }),
  };
  const position = {
    base_sha: targetBaseSha,
    head_sha: targetHeadSha,
    new_path: newPath,
    old_path: oldPath,
    position_type: 'text',
    start_sha: metadata.diff_refs?.start_sha,
    ...(endLines.oldLine ? { old_line: endLines.oldLine } : {}),
    ...(endLines.newLine ? { new_line: endLines.newLine } : {}),
  };
  if (typeof comment.startLineNumber === 'number') {
    const startSide = comment.startSide ?? comment.side;
    const startLines = lineMap.get(`${startSide}:${comment.startLineNumber}`) || {
      ...(startSide === 'deletions'
        ? { oldLine: comment.startLineNumber }
        : { newLine: comment.startLineNumber }),
    };
    position.line_range = {
      end: {
        line_code: getGitLabLineCode(newPath, endLines.oldLine, endLines.newLine),
        ...(endLines.oldLine ? { old_line: endLines.oldLine } : {}),
        ...(endLines.newLine ? { new_line: endLines.newLine } : {}),
        type: comment.side === 'deletions' ? 'old' : 'new',
      },
      start: {
        line_code: getGitLabLineCode(newPath, startLines.oldLine, startLines.newLine),
        ...(startLines.oldLine ? { old_line: startLines.oldLine } : {}),
        ...(startLines.newLine ? { new_line: startLines.newLine } : {}),
        type: startSide === 'deletions' ? 'old' : 'new',
      },
    };
  }
  return position;
};

const findGitLabTargetDiff = (diffs, filePath) =>
  diffs.find((candidate) => candidate.new_path === filePath || candidate.old_path === filePath);

/** @param {PullRequestReviewComment} comment @param {any} metadata @param {ReadonlyArray<any>} diffs */
const resolveGitLabCommentTarget = async (comment, metadata, diffs) => {
  const target = {
    baseSha: metadata.diff_refs?.base_sha,
    files: diffs.map((diff) => ({
      newPath: diff.new_path,
      oldPath: diff.old_path,
      patch: diff.diff,
    })),
    headSha: metadata.diff_refs?.head_sha || metadata.sha,
  };
  validateCurrentReviewCommentTarget(comment, target);
  const diff = findGitLabTargetDiff(diffs, comment.filePath);
  if (!diff) {
    throw targetResolutionError(`File ${comment.filePath} is not in the target diff.`);
  }
  return { diff, metadata };
};

/** @param {unknown} event */
const getGitLabReviewQuickAction = (event) => {
  if (event === 'APPROVE') return '/submit_review approve';
  if (event === 'COMMENT') return null;
  if (event === 'REQUEST_CHANGES') return '/submit_review request_changes';
  throw new Error(`GitLab merge request reviews do not support ${String(event)}.`);
};

/**
 * @param {{
 *   createTransport: (repoRoot: string, mergeRequest: any) => GitLabMutationTransport,
 *   getDiscussionReplyEndpoint: (mergeRequest: any, threadId: string) => string,
 *   mergeRequestEndpoint: (mergeRequest: any, suffix?: string) => string,
 *   normalizeSubmittedGitLabReviewComment: (note: any, submittedComment: PullRequestReviewComment, url: string, threadId?: string) => import('../../core/types.ts').PullRequestExistingReviewComment | null,
 *   parseGitLabMergeRequestUrl: (value: string) => any,
 *   readMergeRequestDiffs: (repoRoot: string, mergeRequest: any, transport?: GitLabMutationTransport) => Promise<ReadonlyArray<any>>,
 *   readMergeRequestMetadata: (repoRoot: string, mergeRequest: any, transport?: GitLabMutationTransport) => Promise<any>,
 *   selectMergeRequestRemote: (repoRoot: string, mergeRequest: any) => any,
 * }} dependencies
 */
const createGitLabReviewMutations = ({
  createTransport,
  getDiscussionReplyEndpoint,
  mergeRequestEndpoint,
  normalizeSubmittedGitLabReviewComment,
  parseGitLabMergeRequestUrl,
  readMergeRequestDiffs,
  readMergeRequestMetadata,
  selectMergeRequestRemote,
}) => {
  /** @param {string} launchPath @param {any} request */
  const submitMergeRequestComment = async (launchPath, request) => {
    const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
    const mergeRequest = parseGitLabMergeRequestUrl(request.source.url);
    selectMergeRequestRemote(repoRoot, mergeRequest);
    const transport = createTransport(repoRoot, mergeRequest);
    if (request.comment.threadId) {
      const note = await transport.request({
        body: { body: request.comment.body },
        method: 'POST',
        path: getDiscussionReplyEndpoint(mergeRequest, request.comment.threadId),
      });
      const comment = normalizeSubmittedGitLabReviewComment(
        note,
        request.comment,
        mergeRequest.url,
      );
      if (!comment) {
        throw new Error('GitLab accepted the reply but did not return comment metadata.');
      }
      return comment;
    }
    const metadata = await readMergeRequestMetadata(repoRoot, mergeRequest, transport);
    const diffs = await readMergeRequestDiffs(repoRoot, mergeRequest, transport);
    const target = await resolveGitLabCommentTarget(request.comment, metadata, diffs);
    const discussion = await transport.request({
      body: {
        body: request.comment.body,
        position: createGitLabPosition(request.comment, target.metadata, target.diff),
      },
      method: 'POST',
      path: mergeRequestEndpoint(mergeRequest, '/discussions'),
    });
    const comment = normalizeSubmittedGitLabReviewComment(
      discussion.notes?.[0],
      request.comment,
      mergeRequest.url,
      discussion.id,
    );
    if (!comment) {
      throw new Error('GitLab accepted the comment but did not return comment metadata.');
    }
    return comment;
  };

  /** @param {string} launchPath @param {any} request */
  const submitMergeRequestReview = async (launchPath, request) => {
    /** @type {Array<{localDraftId: string | null, remoteDraftId: string | null}>} */
    const createdDrafts = [];
    /** @type {Array<string>} */
    const submittedDraftIds = [];
    /** @type {Array<string>} */
    const outcomeUnknownDraftIds = [];
    /** @type {GitLabMutationTransport | null} */
    let transport = null;
    let mergeRequest = null;
    try {
      const summary = typeof request.body === 'string' ? request.body.trim() : '';
      if (request.event === 'COMMENT' && request.comments.length === 0 && !summary) {
        throw new Error('A neutral review requires an inline comment or summary.');
      }
      const quickAction = getGitLabReviewQuickAction(request.event);
      const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
      mergeRequest = parseGitLabMergeRequestUrl(request.source.url);
      selectMergeRequestRemote(repoRoot, mergeRequest);
      transport = createTransport(repoRoot, mergeRequest);
      const metadata = await readMergeRequestMetadata(repoRoot, mergeRequest, transport);
      const currentHead = metadata.diff_refs?.head_sha || metadata.sha;
      if (!currentHead) {
        throw targetResolutionError('GitLab did not return the current merge request head.');
      }
      if (request.source.headSha && currentHead !== request.source.headSha) {
        throw targetResolutionError('The merge request head changed. Refresh before submitting.');
      }
      const diffs = await readMergeRequestDiffs(repoRoot, mergeRequest, transport);
      const targets = await Promise.all(
        request.comments.map(async (comment) => ({
          comment,
          target: await resolveGitLabCommentTarget(comment, metadata, diffs),
        })),
      );
      for (const { comment, target } of targets) {
        const localDraftId = typeof comment.localDraftId === 'string' ? comment.localDraftId : null;
        let createdDraft;
        try {
          createdDraft = await transport.request({
            body: {
              note: comment.body,
              position: createGitLabPosition(comment, target.metadata, target.diff),
            },
            method: 'POST',
            path: mergeRequestEndpoint(mergeRequest, '/draft_notes'),
          });
        } catch (error) {
          if (localDraftId) outcomeUnknownDraftIds.push(localDraftId);
          throw error;
        }
        const remoteDraftId =
          typeof createdDraft?.id === 'string' || typeof createdDraft?.id === 'number'
            ? String(createdDraft.id)
            : null;
        createdDrafts.push({ localDraftId, remoteDraftId });
        if (!remoteDraftId) {
          if (localDraftId) outcomeUnknownDraftIds.push(localDraftId);
          throw new Error('GitLab accepted a draft note but did not return its ID.');
        }
      }
      if (request.event === 'COMMENT') {
        await transport.request({
          body: {
            ...(summary ? { note: summary } : {}),
            reviewer_state: 'reviewed',
          },
          method: 'POST',
          path: mergeRequestEndpoint(mergeRequest, '/draft_notes/bulk_publish'),
        });
      } else {
        const finalBody = `${summary ? `${summary}\n\n` : ''}${quickAction}`;
        await transport.request({
          body: { body: finalBody },
          method: 'POST',
          path: mergeRequestEndpoint(mergeRequest, '/notes'),
        });
      }
      submittedDraftIds.push(
        ...createdDrafts.flatMap(({ localDraftId }) => (localDraftId ? [localDraftId] : [])),
      );
      return { status: /** @type {const} */ ('submitted'), submittedDraftIds };
    } catch (error) {
      /** @type {Array<string>} */
      const cleanupErrors = [];
      if (transport && mergeRequest) {
        for (const { localDraftId, remoteDraftId } of [...createdDrafts].reverse()) {
          if (!remoteDraftId) {
            if (localDraftId) outcomeUnknownDraftIds.push(localDraftId);
            continue;
          }
          try {
            await transport.request({
              method: 'DELETE',
              path: mergeRequestEndpoint(
                mergeRequest,
                `/draft_notes/${encodeURIComponent(remoteDraftId)}`,
              ),
            });
          } catch (cleanupError) {
            cleanupErrors.push(
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            );
            if (localDraftId) outcomeUnknownDraftIds.push(localDraftId);
          }
        }
      }
      const reason = error instanceof Error ? error.message : String(error);
      const uniqueOutcomeUnknownDraftIds = [...new Set(outcomeUnknownDraftIds)];
      return {
        ...(uniqueOutcomeUnknownDraftIds.length > 0
          ? { outcomeUnknownDraftIds: uniqueOutcomeUnknownDraftIds }
          : {}),
        reason:
          cleanupErrors.length > 0
            ? `${reason} GitLab draft cleanup also failed: ${cleanupErrors.join('; ')}`
            : reason,
        status: /** @type {const} */ ('failed'),
        submittedDraftIds: [],
      };
    }
  };

  return { submitMergeRequestComment, submitMergeRequestReview };
};

module.exports = {
  createGitLabPosition,
  createGitLabReviewMutations,
  resolveGitLabCommentTarget,
};
