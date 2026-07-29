import type { AssessmentCodeScope, AssessmentThreadComment } from '../types.ts';

export type AssessmentSide = 'additions' | 'deletions';

export type AssessmentRoutingAnchor = {
  endLine?: number;
  kind: 'file' | 'line';
  path: string;
  side?: AssessmentSide;
  startLine?: number;
};

export type AssessmentThreadCandidate = {
  anchor?: AssessmentRoutingAnchor;
  thread: { comments: ReadonlyArray<AssessmentThreadComment>; id: string };
};

export type AssessmentChangedRange = {
  endLine: number;
  oldPath?: string;
  path: string;
  side: AssessmentSide;
  startLine: number;
};

export type AssessmentRoutingContext = {
  changedRanges: ReadonlyArray<AssessmentChangedRange>;
  codeScope: AssessmentCodeScope;
};

export type AssessmentSelection =
  | {
      candidate: AssessmentThreadCandidate;
      codeScope: AssessmentCodeScope;
      kind: 'eligible';
    }
  | {
      candidate: AssessmentThreadCandidate;
      kind: 'diagnostic';
      reason: 'missing-anchor' | 'no-code-scope';
    };

const overlaps = (leftStart: number, leftEnd: number, rightStart: number, rightEnd: number) =>
  leftStart <= rightEnd && leftEnd >= rightStart;

const anchorIsRoutable = (anchor: AssessmentRoutingAnchor) =>
  anchor.kind === 'file' ||
  (anchor.side != null && anchor.startLine != null && anchor.endLine != null);

const anchorTouchesRange = (anchor: AssessmentRoutingAnchor, range: AssessmentChangedRange) =>
  (anchor.path === range.path || anchor.path === range.oldPath) &&
  (anchor.kind === 'file' ||
    (anchor.side === range.side &&
      anchor.startLine != null &&
      anchor.endLine != null &&
      overlaps(anchor.startLine, anchor.endLine, range.startLine, range.endLine)));

/**
 * Route current-review threads against the captured single diff without
 * consulting resolution state or reviewer identity.
 */
export const selectWalkthroughAssessmentCandidates = (
  candidates: ReadonlyArray<AssessmentThreadCandidate>,
  context: AssessmentRoutingContext,
): ReadonlyArray<AssessmentSelection> =>
  candidates.map((candidate) => {
    if (!candidate.anchor || !anchorIsRoutable(candidate.anchor)) {
      return { candidate, kind: 'diagnostic', reason: 'missing-anchor' };
    }
    if (!context.changedRanges.some((range) => anchorTouchesRange(candidate.anchor!, range))) {
      return { candidate, kind: 'diagnostic', reason: 'no-code-scope' };
    }
    return { candidate, codeScope: context.codeScope, kind: 'eligible' };
  });

export const eligibleWalkthroughAssessmentCandidates = (
  selections: ReadonlyArray<AssessmentSelection>,
) =>
  selections.filter(
    (selection): selection is Extract<AssessmentSelection, { kind: 'eligible' }> =>
      selection.kind === 'eligible',
  );
