// @ts-check

/**
 * @typedef {import('../../core/types.ts').PullRequestReviewComment} PullRequestReviewComment
 * @typedef {{newPath: string, oldPath?: string, patch?: string}} ReviewTargetFile
 * @typedef {{baseSha?: string, files: ReadonlyArray<ReviewTargetFile>, headSha?: string}} CurrentReviewTarget
 */

/** @param {string} reason */
const targetResolutionError = (reason) =>
  Object.assign(new Error(`target-resolution-failed: ${reason}`), {
    code: 'target-resolution-failed',
  });

/** @param {any} revision */
const rangeCommitSha = (revision) =>
  revision &&
  (revision.kind == null || revision.kind === 'commit') &&
  typeof revision.sha === 'string'
    ? revision.sha
    : null;

/** @param {string} patch */
const createDiffLineMap = (patch) => {
  const lines = new Set();
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      lines.add(`additions:${newLine}`);
      newLine += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      lines.add(`deletions:${oldLine}`);
      oldLine += 1;
    } else if (oldLine > 0 && newLine > 0 && line.startsWith(' ')) {
      lines.add(`additions:${newLine}`);
      lines.add(`deletions:${oldLine}`);
      oldLine += 1;
      newLine += 1;
    }
  }
  return lines;
};

/** @param {ReviewTargetFile} file @param {string} filePath */
const targetFileMatches = (file, filePath) =>
  file.newPath === filePath || file.oldPath === filePath;

/**
 * Validate every immutable coordinate before a provider mutation is attempted.
 * Replies target an existing provider thread and are validated by that thread
 * endpoint instead of by a new diff position.
 *
 * @param {PullRequestReviewComment} comment
 * @param {CurrentReviewTarget} target
 * @returns {ReviewTargetFile | undefined}
 */
const validateCurrentReviewCommentTarget = (comment, target) => {
  if (comment.threadId) {
    return undefined;
  }
  const range = comment.position?.range;
  const baseSha = rangeCommitSha(range?.base);
  const headSha = rangeCommitSha(range?.head);
  if (!baseSha || !headSha) {
    throw targetResolutionError('The draft has no immutable review range.');
  }
  if (!target.baseSha || !target.headSha) {
    throw targetResolutionError('The provider did not return a complete current review range.');
  }
  if (baseSha !== target.baseSha || headSha !== target.headSha) {
    throw targetResolutionError(
      'The draft range no longer matches the current review. Refresh before submitting.',
    );
  }
  const file = target.files.find((candidate) => targetFileMatches(candidate, comment.filePath));
  if (!file) {
    throw targetResolutionError(`File ${comment.filePath} is not in the target diff.`);
  }
  if (comment.anchor === 'file' || comment.lineNumber == null || comment.side == null) {
    return file;
  }
  const lineMap = createDiffLineMap(file.patch || '');
  if (!lineMap.has(`${comment.side}:${comment.lineNumber}`)) {
    throw targetResolutionError(
      `Line ${comment.lineNumber} on the ${comment.side} side is not in the target diff.`,
    );
  }
  if (typeof comment.startLineNumber === 'number') {
    const startSide = comment.startSide ?? comment.side;
    if (!lineMap.has(`${startSide}:${comment.startLineNumber}`)) {
      throw targetResolutionError(
        `Range start ${comment.startLineNumber} on the ${startSide} side is not in the target diff.`,
      );
    }
  }
  return file;
};

module.exports = {
  createDiffLineMap,
  targetResolutionError,
  validateCurrentReviewCommentTarget,
};
