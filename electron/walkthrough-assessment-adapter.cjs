// @ts-check

const { getSectionWalkthroughHunks } = require('../core/lib/narrative-walkthrough-diff.cjs');

/**
 * Preserve provider facts while delegating semantic normalization to Core.
 * Resolution, edit capabilities, reviewer kind, and URLs never enter the input.
 *
 * @param {ReadonlyArray<import('../core/types.ts').PullRequestExistingReviewComment>} comments
 * @param {import('../core/types.ts').AssessmentCodeScope} codeScope
 * @param {(input: {codeScope: import('../core/types.ts').AssessmentCodeScope, comments: ReadonlyArray<import('../core/types.ts').PullRequestExistingReviewComment>}) => import('../core/types.ts').AssessmentInput} normalizeAssessmentInput
 */
const toAssessmentThreadCandidates = (comments, codeScope, normalizeAssessmentInput) => {
  const groups = new Map();
  for (const comment of comments) {
    const threadId = comment.threadId ?? comment.id;
    groups.set(threadId, [...(groups.get(threadId) ?? []), comment]);
  }
  return [...groups.values()].map((threadComments) => {
    const orderedComments = threadComments.toSorted(
      (left, right) =>
        Date.parse(left.submittedAt ?? '') - Date.parse(right.submittedAt ?? '') ||
        left.id.localeCompare(right.id),
    );
    const anchored = orderedComments.find(
      (comment) =>
        comment.anchor === 'file' ||
        (comment.filePath && comment.lineNumber != null && comment.side),
    );
    const anchor =
      anchored?.anchor === 'file'
        ? { kind: 'file', path: anchored.filePath }
        : anchored?.filePath && anchored.lineNumber != null && anchored.side
          ? {
              endLine: anchored.lineNumber,
              kind: 'line',
              path: anchored.filePath,
              side: anchored.side,
              startLine: anchored.startLineNumber ?? anchored.lineNumber,
            }
          : undefined;
    return {
      ...(anchor ? { anchor } : {}),
      thread: normalizeAssessmentInput({ codeScope, comments: orderedComments }).thread,
    };
  });
};

/** @param {ReadonlyArray<import('../core/types.ts').WalkthroughCapturedContext['files'][number]>} files */
const toAssessmentChangedRanges = (files) =>
  files.flatMap((file) =>
    file.sections.flatMap((section) =>
      section.binary
        ? []
        : getSectionWalkthroughHunks(file, section).flatMap((hunk) => [
            ...(hunk.additionCount > 0
              ? [
                  {
                    endLine: hunk.additionEnd,
                    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
                    path: file.path,
                    side: 'additions',
                    startLine: hunk.additionStart,
                  },
                ]
              : []),
            ...(hunk.deletionCount > 0
              ? [
                  {
                    endLine: hunk.deletionEnd,
                    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
                    path: file.path,
                    side: 'deletions',
                    startLine: hunk.deletionStart,
                  },
                ]
              : []),
          ]),
    ),
  );

/** @param {ReadonlyArray<import('../core/types.ts').PullRequestExistingReviewComment>} comments */
const capturedThreadStateById = (comments) => {
  const result = new Map();
  const groups = new Map();
  for (const comment of comments) {
    const threadId = comment.threadId ?? comment.id;
    groups.set(threadId, [...(groups.get(threadId) ?? []), comment]);
  }
  for (const [threadId, threadComments] of groups) {
    const root = threadComments.toSorted(
      (left, right) =>
        Date.parse(left.submittedAt ?? '') - Date.parse(right.submittedAt ?? '') ||
        left.id.localeCompare(right.id),
    )[0];
    result.set(threadId, root?.isThreadResolved === true ? 'resolved' : 'open');
  }
  return result;
};

module.exports = {
  capturedThreadStateById,
  toAssessmentChangedRanges,
  toAssessmentThreadCandidates,
};
