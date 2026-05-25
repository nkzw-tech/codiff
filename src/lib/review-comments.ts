import type { CodeViewLineSelection } from '@pierre/diffs';
import type { ChangedFile, DiffSection, RepositoryState } from '../types.ts';
import type { CodeViewInstance, ReviewComment } from './app-types.ts';
import { parseSectionDiffWithOptions } from './diff.ts';

export const isInteractiveReviewEvent = (event: PointerEvent) =>
  event.composedPath().some(
    (target) =>
      // oxlint-disable-next-line @nkzw/no-instanceof
      target instanceof HTMLElement &&
      (target.closest('button, textarea, input, select, a') ||
        target.closest('.review-comment-thread')),
  );

export const getReviewCommentLineSelection = (comment: ReviewComment): CodeViewLineSelection => ({
  id: `diff:${comment.sectionId}`,
  range: {
    end: comment.lineNumber,
    ...(comment.startSide != null && comment.startSide !== comment.side
      ? { endSide: comment.side }
      : {}),
    side: comment.startSide ?? comment.side,
    start: comment.startLineNumber ?? comment.lineNumber,
  },
});

type ReviewPatchRow = {
  additionLineNumber?: number;
  deletionLineNumber?: number;
  prefix: '+' | '-' | ' ';
  side?: ReviewComment['side'];
  text: string;
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

export const getReviewSideLabel = (side: ReviewComment['side']) =>
  side === 'additions' ? 'New' : 'Old';

export const getReviewCommentStartSide = (comment: Pick<ReviewComment, 'side' | 'startSide'>) =>
  comment.startSide ?? comment.side;

export const getReviewCommentLineLabel = (
  comment: Pick<ReviewComment, 'lineNumber' | 'side' | 'startLineNumber' | 'startSide'>,
) => {
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
  comment: Pick<ReviewComment, 'lineNumber' | 'side' | 'startLineNumber' | 'startSide'>,
) => {
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

export const getCommentKey = (
  comment: Pick<
    ReviewComment,
    'lineNumber' | 'sectionId' | 'side' | 'startLineNumber' | 'startSide'
  >,
) =>
  `${comment.sectionId}:${comment.side}:${comment.lineNumber}:${comment.startLineNumber ?? comment.lineNumber}:${
    comment.startSide ?? comment.side
  }`;

export const getReviewCommentsDigest = (comments: ReadonlyArray<ReviewComment>) =>
  comments
    .map(
      (comment) =>
        `${comment.id}:${comment.sectionId}:${comment.side}:${comment.lineNumber}:${
          comment.startLineNumber ?? ''
        }:${comment.startSide ?? ''}:${
          comment.githubSubmit?.status ?? ''
        }:${comment.githubSubmit?.error ?? ''}`,
    )
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

export const getReviewCommentPatchContext = (
  file: ChangedFile,
  section: DiffSection,
  comment: ReviewComment,
  showWhitespace: boolean,
) => {
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
            prefix: ' ',
            text: fileDiff.additionLines[content.additionLineIndex + index] ?? '',
          });
        }
        deletionLineNumber += content.lines;
        additionLineNumber += content.lines;
        continue;
      }

      for (let index = 0; index < content.deletions; index += 1) {
        rows.push({
          deletionLineNumber: deletionLineNumber + index,
          prefix: '-',
          side: 'deletions',
          text: fileDiff.deletionLines[content.deletionLineIndex + index] ?? '',
        });
      }

      for (let index = 0; index < content.additions; index += 1) {
        rows.push({
          additionLineNumber: additionLineNumber + index,
          prefix: '+',
          side: 'additions',
          text: fileDiff.additionLines[content.additionLineIndex + index] ?? '',
        });
      }

      deletionLineNumber += content.deletions;
      additionLineNumber += content.additions;
    }

    const startLine = comment.startLineNumber ?? comment.lineNumber;
    const startSide = getReviewCommentStartSide(comment);
    const endLine = comment.lineNumber;
    const targetIndex = rows.findIndex((row) => matchesReviewPatchLine(row, endLine, comment.side));
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
      return `${row.prefix}${formatReviewLineNumber(lineNumber ?? '')} | ${row.text}`;
    });

    return [hunk.hunkSpecs?.trim(), ...context].filter(Boolean).join('\n');
  }

  return section.summary?.reason || section.patch.trim() || 'No patch context available.';
};

export const buildReviewCommentsMarkdown = (
  files: ReadonlyArray<ChangedFile>,
  comments: ReadonlyArray<ReviewComment>,
  showWhitespace: boolean,
) => {
  const pendingComments = comments.filter((comment) => !comment.isReadOnly && comment.body.trim());
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const orderedComments = pendingComments.sort((left, right) => {
    const leftFileIndex = files.findIndex((file) => file.path === left.filePath);
    const rightFileIndex = files.findIndex((file) => file.path === right.filePath);
    return (
      leftFileIndex - rightFileIndex ||
      left.lineNumber - right.lineNumber ||
      left.id.localeCompare(right.id)
    );
  });

  const markdown = orderedComments
    .map((comment, index) => {
      const file = filesByPath.get(comment.filePath);
      const section = file?.sections.find((candidate) => candidate.id === comment.sectionId);
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

  return markdown ? `# Address these Review Comments\n\n${markdown}` : '';
};

export const getReviewCommentsFromState = (state: RepositoryState): ReadonlyArray<ReviewComment> =>
  state.source.type === 'pull-request'
    ? (state.reviewComments ?? []).flatMap((comment) => {
        const file = state.files.find((candidate) => candidate.path === comment.filePath);
        const section = file?.sections[0];
        return section
          ? [
              {
                author: comment.author,
                body: comment.body,
                filePath: comment.filePath,
                id: comment.id,
                ...(comment.isOutdated ? { isOutdated: true } : {}),
                isReadOnly: true,
                lineNumber: comment.lineNumber,
                sectionId: section.id,
                side: comment.side,
                ...getReviewCommentRangeProps(comment),
                submittedAt: comment.submittedAt,
                url: comment.url,
              },
            ]
          : [];
      })
    : [];

export const getVisibleReviewComments = (
  comments: ReadonlyArray<ReviewComment>,
  showOutdated: boolean,
): ReadonlyArray<ReviewComment> =>
  showOutdated ? comments : comments.filter((comment) => !comment.isOutdated);

export const shouldDiscardReviewCommentOnEscape = (
  body: string,
  confirmDiscard: (message: string) => boolean = window.confirm,
) => body.trim().length === 0 || confirmDiscard('Discard this review comment?');
