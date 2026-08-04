import type { LiveReviewState, WalkthroughHunk, WalkthroughModel } from '../types.ts';

export type ThreadAssessmentComponent = NonNullable<
  WalkthroughModel['assessments']
>['items'][number];

export type ThreadAssessmentDisplay = {
  capturedThreadState: 'open' | 'resolved';
  component: ThreadAssessmentComponent;
  currentStateLabel?: 'Currently open' | 'Currently resolved';
};

export type AssessmentDestination =
  | { kind: 'stop'; stopId: string; stopIndex: number }
  | { kind: 'support'; supportId: string };

type AssessmentDestinationAnchor = {
  filePath: string;
  lineNumber?: number;
  side?: 'additions' | 'deletions';
  startLineNumber?: number;
};

const hunkOwnsAnchor = (
  hunk: WalkthroughHunk,
  anchor: AssessmentDestinationAnchor,
  requireLine: boolean,
) => {
  if (hunk.path !== anchor.filePath && hunk.oldPath !== anchor.filePath) {
    return false;
  }
  if (!requireLine || anchor.lineNumber == null) {
    return true;
  }
  const side = anchor.side;
  const lineStart = anchor.startLineNumber ?? anchor.lineNumber;
  const lineEnd = anchor.lineNumber;
  const overlaps = (start?: number, end?: number) =>
    start != null && end != null && lineStart <= end && lineEnd >= start;
  if (side === 'additions') {
    return (
      overlaps(hunk.additionStart, hunk.additionEnd) ||
      (hunk.anchor.side !== 'deletions' && overlaps(hunk.anchor.startLine, hunk.anchor.endLine))
    );
  }
  if (side === 'deletions') {
    return (
      overlaps(hunk.deletionStart, hunk.deletionEnd) ||
      (hunk.anchor.side !== 'additions' && overlaps(hunk.anchor.startLine, hunk.anchor.endLine))
    );
  }
  return (
    overlaps(hunk.additionStart, hunk.additionEnd) ||
    overlaps(hunk.deletionStart, hunk.deletionEnd) ||
    overlaps(hunk.anchor.startLine, hunk.anchor.endLine)
  );
};

const scopeOwnsGroup = (
  walkthrough: WalkthroughModel,
  scope: ThreadAssessmentComponent['identity']['codeScope'] | undefined,
  chapterId: string | undefined,
  supportId: string | undefined,
) => {
  if (!scope || (scope.type !== 'commit' && scope.type !== 'evolution-unit')) {
    return true;
  }
  const matchingUnit = walkthrough.units?.find((unit) =>
    scope.type === 'commit'
      ? unit.identity.kind === 'commit' && unit.identity.sha === scope.sha
      : unit.identity.kind === 'evolution-unit' && unit.identity.unitId === scope.unitId,
  );
  if (!matchingUnit) {
    return true;
  }
  return chapterId
    ? matchingUnit.chapterIds.includes(chapterId)
    : supportId
      ? matchingUnit.supportIds.includes(supportId)
      : false;
};

const resolveAssessmentDestination = (
  walkthrough: WalkthroughModel,
  anchors: ReadonlyArray<AssessmentDestinationAnchor>,
  scope?: ThreadAssessmentComponent['identity']['codeScope'],
): AssessmentDestination | null => {
  const candidates: Array<{
    destination: AssessmentDestination;
    hunks: ReadonlyArray<WalkthroughHunk>;
  }> = [];
  let stopIndex = 0;
  for (const chapter of walkthrough.chapters) {
    for (const stop of chapter.stops) {
      if (scopeOwnsGroup(walkthrough, scope, chapter.id, undefined)) {
        candidates.push({
          destination: { kind: 'stop', stopId: stop.id, stopIndex },
          hunks: stop.hunks,
        });
      }
      stopIndex += 1;
    }
  }
  for (const support of walkthrough.support) {
    if (scopeOwnsGroup(walkthrough, scope, undefined, support.id)) {
      candidates.push({
        destination: { kind: 'support', supportId: support.id },
        hunks: support.hunks,
      });
    }
  }

  for (const requireLine of [true, false]) {
    for (const anchor of anchors.toReversed()) {
      const matches = candidates.filter((candidate) =>
        candidate.hunks.some((hunk) => hunkOwnsAnchor(hunk, anchor, requireLine)),
      );
      if (matches.length === 1) {
        return matches[0]!.destination;
      }
    }
  }
  return anchors.length === 0 && candidates.length === 1 ? candidates[0]!.destination : null;
};

export const buildAssessmentDestinationIndex = (
  walkthrough: WalkthroughModel,
): ReadonlyMap<string, AssessmentDestination> => {
  const destinations = new Map<string, AssessmentDestination>();
  for (const component of walkthrough.assessments?.items ?? []) {
    const destination = resolveAssessmentDestination(
      walkthrough,
      component.input.thread.comments.flatMap((comment) =>
        comment.anchor ? [comment.anchor] : [],
      ),
      component.identity.codeScope,
    );
    if (!destination) {
      throw new Error(
        `Assessment '${component.identity.threadId}' does not map to a walkthrough stop or Support block.`,
      );
    }
    destinations.set(component.identity.threadId, destination);
  }
  return destinations;
};

export const findPendingAssessmentDestination = (
  walkthrough: WalkthroughModel,
  comment: AssessmentDestinationAnchor,
): AssessmentDestination | null => resolveAssessmentDestination(walkthrough, [comment]);

export const currentThreadStateById = (
  comments: ReadonlyArray<{
    id: string;
    isThreadResolved?: boolean;
    threadId?: string;
  }>,
) => {
  const state = new Map<string, 'open' | 'resolved'>();
  for (const comment of comments) {
    const threadId = comment.threadId ?? comment.id;
    const current = state.get(threadId);
    if (current !== 'open') {
      state.set(threadId, comment.isThreadResolved === true ? 'resolved' : 'open');
    }
  }
  return state;
};

export const assessmentComponentByThreadId = (
  walkthrough: WalkthroughModel,
): ReadonlyMap<string, ThreadAssessmentComponent> =>
  new Map(
    walkthrough.assessments?.items.map((component) => [component.identity.threadId, component]),
  );

export const getThreadAssessmentDisplay = (
  component: ThreadAssessmentComponent | undefined,
  liveReviewState: LiveReviewState | undefined,
): ThreadAssessmentDisplay | null => {
  if (!component) {
    return null;
  }
  const capturedThreadState = component.capturedPresentationState.threadState;
  const currentThreadState = liveReviewState?.currentThreadStateById?.get(
    component.identity.threadId,
  );
  return {
    capturedThreadState,
    component,
    ...(currentThreadState && currentThreadState !== capturedThreadState
      ? {
          currentStateLabel:
            currentThreadState === 'resolved' ? 'Currently resolved' : 'Currently open',
        }
      : {}),
  };
};
