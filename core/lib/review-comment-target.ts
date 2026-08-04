import type {
  ChangedFile,
  DiffRange,
  DiffSection,
  ProviderReviewCommentPosition,
  ReviewCommentPosition,
  Revision,
} from '../types.ts';
import { parseSectionDiffWithOptions } from './diff.ts';
import { isCommitRevision } from './review-history.ts';

type ReviewCommentTargetFailure = {
  reason:
    | 'anchor-not-in-target'
    | 'ambiguous-target-range'
    | 'file-not-in-target'
    | 'missing-target-range'
    | 'non-commit-target'
    | 'section-not-in-target';
  status: 'read-only';
};

export type ShareCommentTargetResolution =
  | ReviewCommentTargetFailure
  | {
      position: ReviewCommentPosition;
      sectionId?: never;
      status: 'enabled';
    }
  | {
      position?: never;
      sectionId: string;
      status: 'enabled';
    };

export type ProviderCommentTargetResolution =
  | ReviewCommentTargetFailure
  | {
      position: ProviderReviewCommentPosition;
      status: 'enabled';
    };

type ReviewCommentTargetInput = {
  anchor?: 'file' | 'line';
  file: ChangedFile;
  lineNumber?: number;
  section?: DiffSection;
  showWhitespace: boolean;
  side?: 'additions' | 'deletions';
  startLineNumber?: number;
  startSide?: 'additions' | 'deletions';
};

const revisionKind = (revision: Revision) => revision.kind ?? 'commit';

const revisionsMatch = (left: Revision, right: Revision) => {
  const leftKind = revisionKind(left);
  const rightKind = revisionKind(right);
  return (
    leftKind === rightKind &&
    (leftKind !== 'commit' || ('sha' in left && 'sha' in right && left.sha === right.sha))
  );
};

export const diffRangesMatch = (left: DiffRange | undefined, right: DiffRange | undefined) =>
  left != null &&
  right != null &&
  revisionsMatch(left.base, right.base) &&
  revisionsMatch(left.head, right.head);

const lineExistsInSection = (
  file: ChangedFile,
  section: DiffSection,
  lineNumber: number,
  side: 'additions' | 'deletions',
  showWhitespace: boolean,
) => {
  const parsed = parseSectionDiffWithOptions(file, section, showWhitespace);
  return parsed.hunks.some((hunk) => {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        const start = side === 'additions' ? newLine : oldLine;
        if (lineNumber >= start && lineNumber < start + content.lines) {
          return true;
        }
        oldLine += content.lines;
        newLine += content.lines;
        continue;
      }
      const start = side === 'additions' ? newLine : oldLine;
      const length = side === 'additions' ? content.additions : content.deletions;
      if (lineNumber >= start && lineNumber < start + length) {
        return true;
      }
      oldLine += content.deletions;
      newLine += content.additions;
    }
    return false;
  });
};

const targetContainsAnchor = ({
  anchor,
  file,
  lineNumber,
  section,
  showWhitespace,
  side,
  startLineNumber,
  startSide,
}: ReviewCommentTargetInput & { section: DiffSection }) => {
  if (anchor === 'file' || lineNumber == null) {
    return true;
  }
  const endSide = side ?? 'additions';
  const resolvedStartSide = startSide ?? endSide;
  return (
    lineExistsInSection(file, section, lineNumber, endSide, showWhitespace) &&
    (startLineNumber == null ||
      lineExistsInSection(file, section, startLineNumber, resolvedStartSide, showWhitespace))
  );
};

export const resolveShareCommentTarget = ({
  displayedFiles,
  ...input
}: ReviewCommentTargetInput & {
  displayedFiles: ReadonlyArray<ChangedFile>;
}): ShareCommentTargetResolution => {
  const candidates = displayedFiles.filter(
    (candidate) => candidate.path === input.file.path || candidate.oldPath === input.file.path,
  );
  if (candidates.length === 0) {
    return { reason: 'file-not-in-target', status: 'read-only' };
  }
  if (!input.section) {
    return { reason: 'section-not-in-target', status: 'read-only' };
  }
  const targets = candidates.flatMap((file) =>
    file.sections
      .filter((section) => section.id === input.section?.id)
      .map((section) => ({ file, section })),
  );
  if (targets.length === 0) {
    return { reason: 'section-not-in-target', status: 'read-only' };
  }
  if (targets.length > 1) {
    return { reason: 'ambiguous-target-range', status: 'read-only' };
  }
  const target = targets[0]!;
  if (!targetContainsAnchor({ ...input, file: target.file, section: target.section })) {
    return { reason: 'anchor-not-in-target', status: 'read-only' };
  }
  return target.section.range
    ? { position: { range: target.section.range }, status: 'enabled' }
    : { sectionId: target.section.id, status: 'enabled' };
};

export const resolveProviderCommentTarget = ({
  canonicalFiles,
  ...input
}: ReviewCommentTargetInput & {
  canonicalFiles: ReadonlyArray<ChangedFile>;
}): ProviderCommentTargetResolution => {
  const canonicalFileCandidates = canonicalFiles.filter(
    (candidate) => candidate.path === input.file.path || candidate.oldPath === input.file.path,
  );
  if (canonicalFileCandidates.length === 0) {
    return { reason: 'file-not-in-target', status: 'read-only' };
  }
  const targetRange = input.section?.range;
  if (!targetRange) {
    return { reason: 'missing-target-range', status: 'read-only' };
  }
  if (!isCommitRevision(targetRange.base) || !isCommitRevision(targetRange.head)) {
    return { reason: 'non-commit-target', status: 'read-only' };
  }
  const canonicalSections = canonicalFileCandidates.flatMap((file) =>
    file.sections.flatMap((section) =>
      diffRangesMatch(section.range, targetRange) ? [{ file, section }] : [],
    ),
  );
  if (canonicalSections.length === 0) {
    return { reason: 'section-not-in-target', status: 'read-only' };
  }
  if (canonicalSections.length > 1) {
    return { reason: 'ambiguous-target-range', status: 'read-only' };
  }
  const target = canonicalSections[0]!;
  if (!targetContainsAnchor({ ...input, file: target.file, section: target.section })) {
    return { reason: 'anchor-not-in-target', status: 'read-only' };
  }
  return {
    position: {
      range: {
        base: targetRange.base,
        head: targetRange.head,
      },
    },
    status: 'enabled',
  };
};
