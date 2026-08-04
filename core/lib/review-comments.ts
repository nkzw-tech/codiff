import type {
  ChangedFile,
  DiffSection,
  ProviderCommentSubmission,
  ProviderReviewCommentPosition,
  PullRequestExistingReviewComment,
  RepositoryState,
  ReviewCommentPosition,
  Revision,
  ShareCommentSubmission,
  SubmittedReviewComment,
} from '../types.ts';
import type {
  CodeViewInstance,
  LocalReviewNote,
  ProviderCommentDraft,
  ProviderInlineComment,
  RenderedSubmittedReviewComment,
  ReviewComment,
  ReviewCommentCreation,
  ReviewDraft,
  ShareCommentDraft,
  ShareInlineComment,
} from './app-types.ts';
import { parseSectionDiffWithOptions } from './diff.ts';
import { isCommitRevision } from './review-history.ts';

export const isInteractiveReviewEvent = (event: PointerEvent) =>
  event.composedPath().some(
    (target) =>
      // oxlint-disable-next-line @nkzw/no-instanceof
      target instanceof HTMLElement &&
      (target.closest('button, textarea, input, select, a') ||
        target.closest('.review-comment-thread')),
  );

export const hasActiveTextSelection = () => {
  const selection = window.getSelection();
  return selection != null && selection.rangeCount > 0 && !selection.isCollapsed;
};

export const isLocalReviewNote = (comment: ReviewComment): comment is LocalReviewNote =>
  comment.kind === 'local-note';

export const isProviderCommentDraft = (comment: ReviewComment): comment is ProviderCommentDraft =>
  comment.kind === 'provider-draft';

export const isShareCommentDraft = (comment: ReviewComment): comment is ShareCommentDraft =>
  comment.kind === 'share-draft';

export const isSubmittedReviewComment = (
  comment: ReviewComment,
): comment is RenderedSubmittedReviewComment => comment.kind === 'submitted-comment';

export const isProviderInlineComment = (comment: ReviewComment): comment is ProviderInlineComment =>
  isSubmittedReviewComment(comment) && comment.destination === 'provider';

export const isShareInlineComment = (comment: ReviewComment): comment is ShareInlineComment =>
  isSubmittedReviewComment(comment) && comment.destination === 'share';

export const isReviewDraft = (comment: ReviewComment): comment is ReviewDraft =>
  isLocalReviewNote(comment) || isProviderCommentDraft(comment) || isShareCommentDraft(comment);

export const isProviderReviewCommentPosition = (
  position: ReviewCommentPosition,
): position is ProviderReviewCommentPosition =>
  isCommitRevision(position.range.base) && isCommitRevision(position.range.head);

export const getReviewCommentRendererSectionId = (comment: ReviewComment) =>
  isReviewDraft(comment) ? comment.sectionId : comment.resolvedSectionId;

export const isFileReviewComment = (
  comment: Pick<ReviewComment, 'anchor' | 'lineNumber' | 'side'>,
) => comment.anchor === 'file' || comment.lineNumber == null || comment.side == null;

export const isLineReviewComment = (
  comment: ReviewComment,
): comment is ReviewComment & { lineNumber: number; side: 'additions' | 'deletions' } =>
  !isFileReviewComment(comment);

type ReviewPatchRow = {
  additionLineNumber?: number;
  deletionLineNumber?: number;
  patchLineIndex: number;
  patchLines: ReadonlyArray<string>;
  prefix: '+' | '-' | ' ';
  side?: ReviewComment['side'];
};

const matchesReviewPatchLine = (
  row: ReviewPatchRow,
  lineNumber: number,
  side: ReviewComment['side'],
) =>
  row.side
    ? row.side === side &&
      (side === 'additions'
        ? row.additionLineNumber === lineNumber
        : row.deletionLineNumber === lineNumber)
    : side === 'additions'
      ? row.additionLineNumber === lineNumber
      : row.deletionLineNumber === lineNumber;

export function updateStickyHeaderState(viewer: CodeViewInstance) {
  for (const item of viewer.getRenderedItems()) {
    const header = item.element.querySelector<HTMLElement>('.codiff-file-header');
    if (!header) {
      continue;
    }

    const headerTop = header.getBoundingClientRect().top;
    const itemTop = item.element.getBoundingClientRect().top;
    header.classList.toggle('stuck', headerTop > itemTop + 0.5);
  }
}

const getReviewSideLabel = (side: ReviewComment['side']) => (side === 'additions' ? 'New' : 'Old');

const getReviewCommentStartSide = (comment: Pick<ReviewComment, 'side' | 'startSide'>) =>
  comment.startSide ?? comment.side;

export const getReviewCommentLineLabel = (
  comment: Pick<ReviewComment, 'anchor' | 'lineNumber' | 'side' | 'startLineNumber' | 'startSide'>,
) => {
  if (isFileReviewComment(comment)) {
    return 'File';
  }
  const startLineNumber = comment.startLineNumber;
  const startSide = getReviewCommentStartSide(comment);
  if (
    startLineNumber == null ||
    (startLineNumber === comment.lineNumber && startSide === comment.side)
  ) {
    return `${getReviewSideLabel(comment.side)} line ${comment.lineNumber}`;
  }

  if (startSide === comment.side) {
    return `${getReviewSideLabel(comment.side)} lines ${startLineNumber}-${comment.lineNumber}`;
  }

  return `${getReviewSideLabel(startSide)} line ${startLineNumber} to ${getReviewSideLabel(
    comment.side,
  )} line ${comment.lineNumber}`;
};

export const getReviewCommentRangeProps = (
  comment: Pick<ReviewComment, 'anchor' | 'lineNumber' | 'side' | 'startLineNumber' | 'startSide'>,
) => {
  if (isFileReviewComment(comment)) {
    return { anchor: 'file' as const };
  }
  const startLineNumber = comment.startLineNumber;
  if (startLineNumber == null) {
    return {};
  }

  const startSide = getReviewCommentStartSide(comment);
  return startLineNumber !== comment.lineNumber || startSide !== comment.side
    ? {
        startLineNumber,
        ...(startSide !== comment.side ? { startSide } : {}),
      }
    : {};
};

const getCommentSubmissionFields = (comment: ReviewDraft) => ({
  ...(comment.anchor ? { anchor: comment.anchor } : {}),
  body: comment.body,
  filePath: comment.filePath,
  ...(comment.lineNumber != null ? { lineNumber: comment.lineNumber } : {}),
  ...(comment.side ? { side: comment.side } : {}),
  ...getReviewCommentRangeProps(comment),
  ...(comment.threadId ? { threadId: comment.threadId } : {}),
});

export const toProviderCommentSubmission = (
  comment: ProviderCommentDraft,
): ProviderCommentSubmission => {
  if (comment.threadId) {
    return {
      ...getCommentSubmissionFields(comment),
      threadId: comment.threadId,
    };
  }

  const position = comment.position;
  if (!position || !isProviderReviewCommentPosition(position)) {
    throw new Error('Provider comments require an exact immutable commit position.');
  }

  return {
    ...getCommentSubmissionFields(comment),
    position: {
      range: {
        base: position.range.base,
        head: position.range.head,
      },
    },
  };
};

export const toShareCommentSubmission = (comment: ShareCommentDraft): ShareCommentSubmission =>
  comment.position
    ? {
        ...getCommentSubmissionFields(comment),
        position: comment.position,
      }
    : {
        ...getCommentSubmissionFields(comment),
        sectionId: comment.sectionId,
      };

export const toProviderSubmittedReviewComment = (
  comment: PullRequestExistingReviewComment,
  submission: ProviderCommentSubmission,
): SubmittedReviewComment => ({
  ...(comment.anchor ? { anchor: comment.anchor } : {}),
  author: comment.author,
  body: comment.body,
  ...(comment.canDelete ? { canDelete: true } : {}),
  ...(comment.canEdit ? { canEdit: true } : {}),
  ...(comment.canReplyThread === false ? { canReplyThread: false } : {}),
  ...(comment.canResolveThread ? { canResolveThread: true } : {}),
  destination: 'provider',
  filePath: comment.filePath,
  id: comment.id,
  ...(comment.isOutdated ? { isOutdated: true } : {}),
  isReadOnly: true,
  ...(comment.isThreadResolved ? { isThreadResolved: true } : {}),
  ...(comment.lineNumber != null ? { lineNumber: comment.lineNumber } : {}),
  ...(submission.position ? { position: submission.position } : {}),
  ...(comment.side ? { side: comment.side } : {}),
  ...(comment.startLineNumber != null ? { startLineNumber: comment.startLineNumber } : {}),
  ...(comment.startSide ? { startSide: comment.startSide } : {}),
  ...(comment.submittedAt ? { submittedAt: comment.submittedAt } : {}),
  ...(comment.threadId ? { threadId: comment.threadId } : {}),
  ...(comment.url ? { url: comment.url } : {}),
});

export const toRenderedSubmittedReviewComment = (
  comment: SubmittedReviewComment,
  draft?: ProviderCommentDraft | ShareCommentDraft,
): RenderedSubmittedReviewComment => ({
  ...comment,
  kind: 'submitted-comment',
  ...(comment.resolvedSectionId
    ? { resolvedSectionId: comment.resolvedSectionId }
    : draft
      ? { resolvedSectionId: draft.sectionId }
      : {}),
});

export const toPullRequestExistingReviewComment = (
  comment: RenderedSubmittedReviewComment,
): PullRequestExistingReviewComment => ({
  ...(comment.anchor ? { anchor: comment.anchor } : {}),
  author: comment.author,
  body: comment.body,
  ...(comment.canDelete ? { canDelete: true } : {}),
  ...(comment.canEdit ? { canEdit: true } : {}),
  ...(comment.canReplyThread === false ? { canReplyThread: false } : {}),
  ...(comment.canResolveThread ? { canResolveThread: true } : {}),
  filePath: comment.filePath,
  id: comment.id,
  ...(comment.isOutdated ? { isOutdated: true } : {}),
  ...(comment.isThreadResolved ? { isThreadResolved: true } : {}),
  ...(comment.lineNumber != null ? { lineNumber: comment.lineNumber } : {}),
  ...(comment.position ? { position: comment.position } : {}),
  ...(comment.sectionId ? { sectionId: comment.sectionId } : {}),
  ...(comment.side ? { side: comment.side } : {}),
  ...getReviewCommentRangeProps(comment),
  ...(comment.submittedAt ? { submittedAt: comment.submittedAt } : {}),
  ...(comment.threadId ? { threadId: comment.threadId } : {}),
  ...(comment.url ? { url: comment.url } : {}),
});

export const mergeReviewComments = (
  snapshotComments: ReadonlyArray<RenderedSubmittedReviewComment>,
  localComments: ReadonlyArray<ReviewDraft>,
): ReadonlyArray<ReviewComment> => {
  const snapshotIds = new Set(snapshotComments.map((comment) => comment.id));
  return [...snapshotComments, ...localComments.filter((comment) => !snapshotIds.has(comment.id))];
};

const isPendingPullRequestReviewComment = (comment: ProviderCommentDraft) =>
  !comment.threadId &&
  comment.remoteSubmit?.status !== 'submitting' &&
  comment.body.trim().length > 0;

export const getPendingPullRequestReviewComments = (
  comments: ReadonlyArray<ProviderCommentDraft>,
  activeDraft: Pick<ProviderCommentDraft, 'body' | 'id'> | null = null,
) => {
  return comments.flatMap((comment) => {
    const candidate =
      activeDraft?.id === comment.id ? { ...comment, body: activeDraft.body } : comment;
    return isPendingPullRequestReviewComment(candidate) ? [candidate] : [];
  });
};

export const findReusableReviewCommentDraft = (
  comments: ReadonlyArray<ReviewDraft>,
  activeDraft: Pick<ReviewDraft, 'body' | 'id'> | null = null,
) =>
  comments.find(
    (comment) =>
      comment.body.length === 0 &&
      !(activeDraft?.id === comment.id && activeDraft.body.trim().length > 0),
  );

export const getCommentKey = (comment: ReviewComment | ReviewCommentCreation) => {
  const sectionId =
    'kind' in comment
      ? (getReviewCommentRendererSectionId(comment) ?? 'unresolved')
      : comment.sectionId;
  return isFileReviewComment(comment)
    ? `${sectionId}:file`
    : `${sectionId}:${comment.side}:${comment.lineNumber}:${
        comment.startLineNumber ?? comment.lineNumber
      }:${comment.startSide ?? comment.side}`;
};

const getCommentTextDigest = (value: string | null | undefined) =>
  value ? `${value.length},${value.split('\n').length}` : '0,0';

export const getReviewCommentsDigest = (comments: ReadonlyArray<ReviewComment>) =>
  comments
    .map((comment) => {
      const sectionId = getReviewCommentRendererSectionId(comment) ?? comment.sectionId ?? '';
      return `${comment.id}:${sectionId}:${comment.side}:${comment.lineNumber}:${
        comment.startLineNumber ?? ''
      }:${comment.startSide ?? ''}:${comment.anchor ?? ''}:${getCommentTextDigest(
        comment.body,
      )}:${comment.codexReply?.status ?? ''}:${getCommentTextDigest(
        comment.codexReply?.body,
      )}:${getCommentTextDigest(comment.codexReply?.error)}:${
        comment.remoteSubmit?.status ?? ''
      }:${comment.remoteSubmit?.error ?? ''}:${comment.threadId ?? ''}:${
        comment.canResolveThread === true ? '1' : '0'
      }:${comment.isThreadResolved === true ? '1' : '0'}`;
    })
    .join('\0');

const getMarkdownFence = (content: string) => {
  let fence = '```';
  while (content.includes(fence)) {
    fence += '`';
  }
  return fence;
};

const indentMarkdown = (value: string) =>
  value
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n');

const formatReviewLineNumber = (lineNumber: number | string) => String(lineNumber).padStart(4);
// @pierre/diffs keeps source line terminators; copied Markdown rows add their own separators.
const trimReviewPatchLineTerminator = (line: string) =>
  line.endsWith('\r\n') ? line.slice(0, -2) : line.endsWith('\n') ? line.slice(0, -1) : line;

const getReviewPatchText = (lines: ReadonlyArray<string>, index: number) =>
  trimReviewPatchLineTerminator(lines[index] ?? '');

export const getReviewCommentPatchContext = (
  file: ChangedFile,
  section: DiffSection,
  comment: ReviewComment,
  showWhitespace: boolean,
) => {
  if (isFileReviewComment(comment)) {
    return section.summary?.reason || section.patch.trim() || 'No patch context available.';
  }
  const fileDiff = parseSectionDiffWithOptions(file, section, showWhitespace);

  for (const hunk of fileDiff.hunks) {
    const rows: Array<ReviewPatchRow> = [];
    let deletionLineNumber = hunk.deletionStart;
    let additionLineNumber = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let index = 0; index < content.lines; index += 1) {
          rows.push({
            additionLineNumber: additionLineNumber + index,
            deletionLineNumber: deletionLineNumber + index,
            patchLineIndex: content.additionLineIndex + index,
            patchLines: fileDiff.additionLines,
            prefix: ' ',
          });
        }
        deletionLineNumber += content.lines;
        additionLineNumber += content.lines;
        continue;
      }

      for (let index = 0; index < content.deletions; index += 1) {
        rows.push({
          deletionLineNumber: deletionLineNumber + index,
          patchLineIndex: content.deletionLineIndex + index,
          patchLines: fileDiff.deletionLines,
          prefix: '-',
          side: 'deletions',
        });
      }

      for (let index = 0; index < content.additions; index += 1) {
        rows.push({
          additionLineNumber: additionLineNumber + index,
          patchLineIndex: content.additionLineIndex + index,
          patchLines: fileDiff.additionLines,
          prefix: '+',
          side: 'additions',
        });
      }

      deletionLineNumber += content.deletions;
      additionLineNumber += content.additions;
    }

    const side = comment.side ?? 'additions';
    const startLine = comment.startLineNumber ?? comment.lineNumber ?? 1;
    const startSide = getReviewCommentStartSide(comment) ?? side;
    const endLine = comment.lineNumber ?? 1;
    const targetIndex = rows.findIndex((row) => matchesReviewPatchLine(row, endLine, side));
    const rangeStartIndex = rows.findIndex((row) =>
      matchesReviewPatchLine(row, startLine, startSide),
    );

    if (targetIndex === -1) {
      continue;
    }

    const anchorStart = rangeStartIndex === -1 ? targetIndex : rangeStartIndex;
    const start = Math.max(0, Math.min(anchorStart, targetIndex) - 3);
    const end = Math.min(rows.length, Math.max(anchorStart, targetIndex) + 4);
    const context = rows.slice(start, end).map((row) => {
      const lineNumber =
        row.prefix === '+'
          ? row.additionLineNumber
          : row.prefix === '-'
            ? row.deletionLineNumber
            : `${row.deletionLineNumber ?? ''}/${row.additionLineNumber ?? ''}`;
      return `${row.prefix}${formatReviewLineNumber(lineNumber ?? '')} | ${getReviewPatchText(
        row.patchLines,
        row.patchLineIndex,
      )}`;
    });

    return [hunk.hunkSpecs?.trim(), ...context].filter(Boolean).join('\n');
  }

  return section.summary?.reason || section.patch.trim() || 'No patch context available.';
};

const revisionKind = (revision: Revision) => revision.kind ?? 'commit';

const revisionsMatch = (left: Revision, right: Revision) => {
  const leftKind = revisionKind(left);
  const rightKind = revisionKind(right);
  if (leftKind !== rightKind) {
    return false;
  }
  return leftKind !== 'commit' || ('sha' in left && 'sha' in right && left.sha === right.sha);
};

const rangesMatch = (left: DiffSection['range'], right: DiffSection['range']) =>
  left != null &&
  right != null &&
  revisionsMatch(left.base, right.base) &&
  revisionsMatch(left.head, right.head);

export const getReviewCommentSection = (
  file: ChangedFile,
  comment: Pick<
    ReviewComment,
    'anchor' | 'lineNumber' | 'position' | 'side' | 'startLineNumber' | 'startSide'
  > & { sectionId?: string },
  showWhitespace: boolean,
) => {
  const positionedRange = comment.position?.range;
  if (positionedRange) {
    const section = file.sections.find((candidate) =>
      rangesMatch(candidate.range, positionedRange),
    );
    if (section) {
      return section;
    }
  }

  if (comment.sectionId) {
    const section = file.sections.find((candidate) => candidate.id === comment.sectionId);
    if (section) {
      return section;
    }
  }

  if (isFileReviewComment(comment)) {
    return file.sections[0];
  }

  const side = comment.side ?? 'additions';
  const line = comment.lineNumber ?? 1;
  const startLine = comment.startLineNumber ?? line;
  const startSide = comment.startSide ?? side;
  return file.sections.find((section) => {
    const parsed = parseSectionDiffWithOptions(file, section, showWhitespace);
    return parsed.hunks.some((hunk) => {
      let oldLine = hunk.deletionStart;
      let newLine = hunk.additionStart;
      let hasStart = false;
      let hasEnd = false;
      for (const content of hunk.hunkContent) {
        if (content.type === 'context') {
          if (
            (startSide === 'additions' &&
              startLine >= newLine &&
              startLine < newLine + content.lines) ||
            (startSide === 'deletions' &&
              startLine >= oldLine &&
              startLine < oldLine + content.lines)
          ) {
            hasStart = true;
          }
          if (
            (side === 'additions' && line >= newLine && line < newLine + content.lines) ||
            (side === 'deletions' && line >= oldLine && line < oldLine + content.lines)
          ) {
            hasEnd = true;
          }
          oldLine += content.lines;
          newLine += content.lines;
          continue;
        }
        if (side === 'deletions' && line >= oldLine && line < oldLine + content.deletions) {
          hasEnd = true;
        }
        if (
          startSide === 'deletions' &&
          startLine >= oldLine &&
          startLine < oldLine + content.deletions
        ) {
          hasStart = true;
        }
        if (side === 'additions' && line >= newLine && line < newLine + content.additions) {
          hasEnd = true;
        }
        if (
          startSide === 'additions' &&
          startLine >= newLine &&
          startLine < newLine + content.additions
        ) {
          hasStart = true;
        }
        oldLine += content.deletions;
        newLine += content.additions;
      }
      return hasStart && hasEnd;
    });
  });
};

export const buildReviewCommentsMarkdown = (
  files: ReadonlyArray<ChangedFile>,
  comments: ReadonlyArray<ReviewComment>,
  showWhitespace: boolean,
  prefix?: string,
) => {
  const pendingComments = comments.filter(
    (comment): comment is ReviewDraft => isReviewDraft(comment) && Boolean(comment.body.trim()),
  );
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const orderedComments = pendingComments.sort((left, right) => {
    const leftFileIndex = files.findIndex((file) => file.path === left.filePath);
    const rightFileIndex = files.findIndex((file) => file.path === right.filePath);
    return (
      leftFileIndex - rightFileIndex ||
      (left.lineNumber ?? 0) - (right.lineNumber ?? 0) ||
      left.id.localeCompare(right.id)
    );
  });

  const markdown = orderedComments
    .map((comment, index) => {
      const file = filesByPath.get(comment.filePath);
      const section = file ? getReviewCommentSection(file, comment, showWhitespace) : undefined;
      const context =
        file && section
          ? getReviewCommentPatchContext(file, section, comment, showWhitespace)
          : 'No patch context available.';
      const fence = getMarkdownFence(context);

      return [
        `${index + 1}. **${comment.filePath}** (${getReviewCommentLineLabel(comment)})`,
        '',
        indentMarkdown(`${fence}diff\n${context}\n${fence}`),
        '',
        indentMarkdown(comment.body.trim()),
      ].join('\n');
    })
    .join('\n\n');

  const resolvedPrefix =
    prefix == null ? '# Address these Review Comments\n\n' : prefix ? `${prefix}\n\n` : '';
  return markdown ? `${resolvedPrefix}${markdown}` : '';
};

export const getReviewCommentsFromState = (
  state: RepositoryState,
  destination: 'provider' | 'share' = 'provider',
): ReadonlyArray<RenderedSubmittedReviewComment> =>
  (state.reviewComments ?? []).map((comment) => {
    const file = state.files.find((candidate) => candidate.path === comment.filePath);
    const section = file ? getReviewCommentSection(file, comment, false) : undefined;
    const common = {
      author: comment.author,
      body: comment.body,
      ...(comment.canDelete ? { canDelete: true } : {}),
      ...(comment.canEdit ? { canEdit: true } : {}),
      ...(comment.canReplyThread === false ? { canReplyThread: false } : {}),
      ...(comment.canResolveThread ? { canResolveThread: true } : {}),
      filePath: comment.filePath,
      id: comment.id,
      ...(comment.isOutdated ? { isOutdated: true } : {}),
      isReadOnly: true as const,
      kind: 'submitted-comment' as const,
      ...(comment.isThreadResolved ? { isThreadResolved: true } : {}),
      ...(comment.anchor === 'file' ? { anchor: 'file' as const } : {}),
      ...(comment.lineNumber != null ? { lineNumber: comment.lineNumber } : {}),
      ...(section ? { resolvedSectionId: section.id } : {}),
      ...(comment.side ? { side: comment.side } : {}),
      ...getReviewCommentRangeProps(comment),
      ...(comment.submittedAt ? { submittedAt: comment.submittedAt } : {}),
      ...(comment.threadId ? { threadId: comment.threadId } : {}),
      ...(comment.url ? { url: comment.url } : {}),
    };

    return destination === 'share'
      ? {
          ...common,
          destination,
          ...(comment.position ? { position: comment.position } : {}),
          ...(comment.sectionId ? { sectionId: comment.sectionId } : {}),
        }
      : {
          ...common,
          destination,
          ...(comment.position && isProviderReviewCommentPosition(comment.position)
            ? { position: comment.position }
            : {}),
        };
  });

export const getVisibleReviewComments = (
  comments: ReadonlyArray<ReviewComment>,
  showOutdated: boolean,
): ReadonlyArray<ReviewComment> =>
  showOutdated ? comments : comments.filter((comment) => !comment.isOutdated);

export const shouldDiscardReviewCommentOnEscape = (
  body: string,
  confirmDiscard: (message: string) => boolean = window.confirm,
) => body.trim().length === 0 || confirmDiscard('Discard this review comment?');
