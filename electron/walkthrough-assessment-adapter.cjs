// @ts-check

const { getSectionWalkthroughHunks } = require('../core/lib/narrative-walkthrough-diff.cjs');

/** @param {import('../core/types.ts').Revision | undefined} revision */
const revisionSha = (revision) =>
  revision && revision.kind !== 'index' && revision.kind !== 'working-copy'
    ? revision.sha
    : undefined;

/**
 * @param {ReadonlyArray<import('../core/types.ts').ReviewVersionOption>} versions
 * @param {import('../core/types.ts').GenerateLocalReviewWalkthroughRequest['selection'] | import('../core/types.ts').WalkthroughGenerationRequest['review']} selection
 */
const buildAssessmentVersionContext = (versions, selection) => {
  const ordered = [...versions].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
  const versionById = new Map();
  const versionByHeadSha = new Map();
  for (const [order, version] of ordered.entries()) {
    const assessmentVersion = { order, versionId: version.versionId };
    versionById.set(version.versionId, assessmentVersion);
    const headSha = revisionSha(version.range.head);
    if (headSha) versionByHeadSha.set(headSha, assessmentVersion);
  }

  const ensureVersion = (versionId, headSha, fallbackOrder) => {
    const existing = versionById.get(versionId) ?? versionByHeadSha.get(headSha);
    if (existing) return existing;
    const created = { order: fallbackOrder, versionId };
    versionById.set(versionId, created);
    if (headSha) versionByHeadSha.set(headSha, created);
    return created;
  };

  let from;
  let to;
  if (selection.relation === 'version-comparison') {
    const requestSelection = 'fromVersionId' in selection;
    const beforeHeadSha = requestSelection
      ? undefined
      : revisionSha(selection.comparison.before.head);
    const afterHeadSha = requestSelection
      ? undefined
      : revisionSha(selection.comparison.after.head);
    const fromVersionId = requestSelection
      ? selection.fromVersionId
      : (versionByHeadSha.get(beforeHeadSha)?.versionId ??
        `comparison-from:${beforeHeadSha ?? 'unknown'}`);
    const toVersionId = requestSelection
      ? selection.toVersionId
      : (versionByHeadSha.get(afterHeadSha)?.versionId ??
        `comparison-to:${afterHeadSha ?? 'unknown'}`);
    from = ensureVersion(
      fromVersionId,
      beforeHeadSha,
      (versionById.get(toVersionId)?.order ?? 1) - 1,
    );
    to = ensureVersion(toVersionId, afterHeadSha, from.order + 1);
  } else {
    const baseSha = revisionSha(selection.range.base);
    const headSha = revisionSha(selection.range.head);
    const first = ordered[0];
    const last = ordered.find((version) => version.isHead) ?? ordered.at(-1);
    from = first
      ? versionById.get(first.versionId)
      : ensureVersion(`target-base:${baseSha ?? 'unknown'}`, baseSha, 0);
    to = last
      ? versionById.get(last.versionId)
      : ensureVersion(`target-head:${headSha ?? 'unknown'}`, headSha, from.order + 1);
  }

  return { currentVersion: to, from, to, versionByHeadSha, versionById };
};

/** @param {import('../core/types.ts').PullRequestExistingReviewComment} comment */
const commentHeadSha = (comment) =>
  comment.versionHeadSha ??
  comment.positionIdentity?.headSha ??
  revisionSha(comment.position?.range.head);

/**
 * @param {import('../core/types.ts').PullRequestExistingReviewComment} comment
 * @param {{
 *   versionById: ReadonlyMap<string, import('../core/lib/walkthrough-assessment-relevance.ts').AssessmentReviewVersion>,
 *   versionByHeadSha: ReadonlyMap<string, import('../core/lib/walkthrough-assessment-relevance.ts').AssessmentReviewVersion>,
 * }} context
 */
const originalVersionFor = (comment, context) =>
  (comment.versionId ? context.versionById.get(comment.versionId) : undefined) ??
  (comment.position?.versionId ? context.versionById.get(comment.position.versionId) : undefined) ??
  context.versionByHeadSha.get(commentHeadSha(comment));

/**
 * @param {import('../core/types.ts').PullRequestExistingReviewComment} comment
 * @param {import('../core/lib/walkthrough-assessment-relevance.ts').AssessmentReviewVersion | undefined} version
 */
const anchorForComment = (comment, version) => {
  if (!version || typeof comment.filePath !== 'string' || !comment.filePath) {
    return undefined;
  }
  if (comment.anchor === 'file') {
    return { kind: 'file', path: comment.filePath, version };
  }
  if (
    typeof comment.lineNumber !== 'number' ||
    (comment.side !== 'additions' && comment.side !== 'deletions')
  ) {
    return undefined;
  }
  return {
    endLine: comment.lineNumber,
    kind: 'line',
    path: comment.filePath,
    side: comment.side,
    startLine: comment.startLineNumber ?? comment.lineNumber,
    version,
  };
};

/** @param {import('../core/types.ts').PullRequestExistingReviewComment} comment */
const legacyAnchorForComment = (comment) => {
  if (comment.anchor === 'file' && comment.filePath) {
    return { kind: 'file', path: comment.filePath };
  }
  if (
    comment.filePath &&
    typeof comment.lineNumber === 'number' &&
    (comment.side === 'additions' || comment.side === 'deletions')
  ) {
    return {
      endLine: comment.lineNumber,
      kind: 'line',
      path: comment.filePath,
      side: comment.side,
      startLine: comment.startLineNumber ?? comment.lineNumber,
    };
  }
  return undefined;
};

/**
 * Preserve provider facts while delegating normalized assessment input to Core.
 * The three-argument form retains the legacy single-diff projection; the
 * four-argument form attaches original/current review-version coordinates.
 *
 * @param {ReadonlyArray<import('../core/types.ts').PullRequestExistingReviewComment>} comments
 * @param {ReturnType<typeof buildAssessmentVersionContext> | import('../core/types.ts').AssessmentCodeScope} contextOrCodeScope
 * @param {import('../core/types.ts').AssessmentCodeScope | ((input: {codeScope: import('../core/types.ts').AssessmentCodeScope, comments: ReadonlyArray<import('../core/types.ts').PullRequestExistingReviewComment>}) => import('../core/types.ts').AssessmentInput)} codeScopeOrNormalize
 * @param {((input: {codeScope: import('../core/types.ts').AssessmentCodeScope, comments: ReadonlyArray<import('../core/types.ts').PullRequestExistingReviewComment>}) => import('../core/types.ts').AssessmentInput) | undefined} maybeNormalize
 */
const toAssessmentThreadCandidates = (
  comments,
  contextOrCodeScope,
  codeScopeOrNormalize,
  maybeNormalize,
) => {
  const versionContext = maybeNormalize ? contextOrCodeScope : undefined;
  const codeScope = maybeNormalize ? codeScopeOrNormalize : contextOrCodeScope;
  const normalizeAssessmentInput = maybeNormalize ?? codeScopeOrNormalize;
  if (typeof normalizeAssessmentInput !== 'function' || !('type' in codeScope)) {
    throw new Error('Assessment thread projection requires a code scope and normalizer.');
  }
  const groups = new Map();
  for (const comment of comments) {
    const threadId = comment.threadId ?? comment.id;
    const group = groups.get(threadId) ?? [];
    group.push(comment);
    groups.set(threadId, group);
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
    if (!versionContext || !('currentVersion' in versionContext)) {
      const anchor = anchored ? legacyAnchorForComment(anchored) : undefined;
      return {
        ...(anchor ? { anchor } : {}),
        thread: normalizeAssessmentInput({
          codeScope,
          comments: orderedComments,
        }).thread,
      };
    }
    const originalVersion = anchored ? originalVersionFor(anchored, versionContext) : undefined;
    return {
      ...(anchored && anchored.isOutdated !== true
        ? {
            currentAnchor: anchorForComment(anchored, versionContext.currentVersion),
          }
        : {}),
      ...(anchored ? { originalAnchor: anchorForComment(anchored, originalVersion) } : {}),
      thread: normalizeAssessmentInput({ codeScope, comments: orderedComments }).thread,
    };
  });
};

/** @param {ReadonlyArray<import('../core/types.ts').ChangedFile | import('../core/types.ts').WalkthroughCapturedContext['files'][number]>} files */
const toAssessmentChangedRanges = (files) =>
  files.flatMap((file) =>
    file.sections.flatMap((section) =>
      getSectionWalkthroughHunks(file, section).flatMap((hunk) =>
        hunk.kind !== 'patch'
          ? []
          : [
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
            ],
      ),
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
  buildAssessmentVersionContext,
  capturedThreadStateById,
  toAssessmentChangedRanges,
  toAssessmentThreadCandidates,
};
