import type { AssessmentCodeScope, AssessmentThreadComment, ReviewVersionId } from '../types.ts';

export type AssessmentReviewVersion = {
  order: number;
  versionId: ReviewVersionId;
};
export type AssessmentSide = 'additions' | 'deletions';

export type AssessmentRoutingAnchor = {
  endLine?: number;
  kind: 'file' | 'line';
  path: string;
  side?: AssessmentSide;
  startLine?: number;
  version?: AssessmentReviewVersion;
};

export type AssessmentThreadCandidate = {
  /** Legacy single-diff anchor retained for format-neutral callers. */
  anchor?: AssessmentRoutingAnchor;
  currentAnchor?: AssessmentRoutingAnchor;
  originalAnchor?: AssessmentRoutingAnchor;
  thread: { comments: ReadonlyArray<AssessmentThreadComment>; id: string };
};

export type AssessmentChangedRange = {
  endLine: number;
  oldPath?: string;
  path: string;
  side: AssessmentSide;
  startLine: number;
};

export type AssessmentUnitRoute = {
  changedRanges: ReadonlyArray<AssessmentChangedRange>;
  codeScope: Extract<AssessmentCodeScope, { type: 'commit' | 'evolution-unit' }>;
  interval?: { from: AssessmentReviewVersion; to: AssessmentReviewVersion };
};

export type AssessmentRoutingContext = {
  changedRanges: ReadonlyArray<AssessmentChangedRange>;
  codeScope: AssessmentCodeScope;
  from?: AssessmentReviewVersion;
  to?: AssessmentReviewVersion;
  unitRoutes?: ReadonlyArray<AssessmentUnitRoute>;
};

export type AssessmentSelection =
  | {
      candidate: AssessmentThreadCandidate;
      codeScope: AssessmentCodeScope;
      kind: 'eligible';
    }
  | {
      candidate: AssessmentThreadCandidate;
      kind: 'ineligible';
      reason: 'created-after-from' | 'post-to';
    }
  | {
      candidate: AssessmentThreadCandidate;
      kind: 'untouched';
      reason: 'provable-non-overlap';
    }
  | {
      candidate: AssessmentThreadCandidate;
      codeScopes?: ReadonlyArray<AssessmentCodeScope>;
      kind: 'diagnostic';
      reason: 'ambiguous-code-scope' | 'missing-anchor' | 'no-code-scope';
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

const anchorsFor = (candidate: AssessmentThreadCandidate) => {
  const versioned = [candidate.currentAnchor, candidate.originalAnchor].filter(
    (anchor): anchor is AssessmentRoutingAnchor => Boolean(anchor),
  );
  return versioned.length > 0 ? versioned : candidate.anchor ? [candidate.anchor] : [];
};

const touches = (
  candidate: AssessmentThreadCandidate,
  ranges: ReadonlyArray<AssessmentChangedRange>,
) =>
  anchorsFor(candidate).some((anchor) => ranges.some((range) => anchorTouchesRange(anchor, range)));

const candidateVersion = (candidate: AssessmentThreadCandidate) =>
  candidate.originalAnchor?.version ??
  candidate.currentAnchor?.version ??
  candidate.anchor?.version;

const routeOwnsCandidate = (candidate: AssessmentThreadCandidate, route: AssessmentUnitRoute) => {
  const version = candidateVersion(candidate);
  return (
    touches(candidate, route.changedRanges) &&
    (!route.interval ||
      (version != null &&
        version.order >= route.interval.from.order &&
        version.order <= route.interval.to.order))
  );
};

/**
 * Derive assessment demand without consulting captured or current resolution
 * state. Version-aware callers can distinguish untouched and out-of-interval
 * threads; legacy single-diff callers retain diagnostic non-overlap behavior.
 */
export const selectWalkthroughAssessmentCandidates = (
  candidates: ReadonlyArray<AssessmentThreadCandidate>,
  context: AssessmentRoutingContext,
): ReadonlyArray<AssessmentSelection> =>
  candidates.map((candidate) => {
    const anchors = anchorsFor(candidate);
    if (anchors.length === 0 || anchors.some((anchor) => !anchorIsRoutable(anchor))) {
      return { candidate, kind: 'diagnostic', reason: 'missing-anchor' };
    }

    const version = candidateVersion(candidate);
    const versionAware = context.from != null && context.to != null;
    if (versionAware && !version) {
      return { candidate, kind: 'diagnostic', reason: 'missing-anchor' };
    }
    if (versionAware && version!.order > context.to!.order) {
      return { candidate, kind: 'ineligible', reason: 'post-to' };
    }
    if (!touches(candidate, context.changedRanges)) {
      if (!versionAware) {
        return { candidate, kind: 'diagnostic', reason: 'no-code-scope' };
      }
      return version!.order <= context.from!.order
        ? { candidate, kind: 'untouched', reason: 'provable-non-overlap' }
        : { candidate, kind: 'ineligible', reason: 'created-after-from' };
    }

    const owners = context.unitRoutes?.filter((route) => routeOwnsCandidate(candidate, route));
    return {
      candidate,
      codeScope: owners?.length === 1 ? owners[0]!.codeScope : context.codeScope,
      kind: 'eligible',
    };
  });

export const eligibleWalkthroughAssessmentCandidates = (
  selections: ReadonlyArray<AssessmentSelection>,
) =>
  selections.filter(
    (selection): selection is Extract<AssessmentSelection, { kind: 'eligible' }> =>
      selection.kind === 'eligible',
  );

export const untouchedWalkthroughAssessmentCandidates = (
  selections: ReadonlyArray<AssessmentSelection>,
) =>
  selections.filter(
    (selection): selection is Extract<AssessmentSelection, { kind: 'untouched' }> =>
      selection.kind === 'untouched',
  );
