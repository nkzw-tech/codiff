import type {
  ChangedFile,
  DiffSection,
  NarrativeWalkthrough,
  WalkthroughOrder,
  WalkthroughPhase,
  WalkthroughRestItem,
  WalkthroughSegment,
  WalkthroughStop,
} from '../types.ts';
import { getFirstVisibleSection } from './diff.ts';

export type NarrativeLineCount = {
  added: number;
  deleted: number;
};

/** A stop resolved to its segment and given a global position in the order. */
export type WalkthroughStopView = WalkthroughStop & {
  index: number;
  segment: WalkthroughSegment;
};

/** A phase with the stops that belong to it, in order. */
export type WalkthroughPhaseView = WalkthroughPhase & {
  stops: ReadonlyArray<WalkthroughStopView>;
};

/** A "rest" item resolved to its segment. */
export type WalkthroughRestView = WalkthroughRestItem & {
  segment: WalkthroughSegment;
};

/** The "rest" grouped by reason, preserving first-seen order. */
export type WalkthroughRestReason = {
  files: ReadonlyArray<WalkthroughRestView>;
  reason: string;
};

/** Everything a narrative order needs to render, derived from the document. */
export type WalkthroughOrderView = {
  order: WalkthroughOrder;
  phases: ReadonlyArray<WalkthroughPhaseView>;
  rest: ReadonlyArray<WalkthroughRestView>;
  restByReason: ReadonlyArray<WalkthroughRestReason>;
  restTotals: NarrativeLineCount;
  sequence: ReadonlyArray<WalkthroughStopView>;
  totals: NarrativeLineCount;
};

const sumLineCount = (items: ReadonlyArray<{ segment: WalkthroughSegment }>): NarrativeLineCount =>
  items.reduce(
    (totals, { segment }) => ({
      added: totals.added + segment.added,
      deleted: totals.deleted + segment.deleted,
    }),
    { added: 0, deleted: 0 },
  );

const groupRestByReason = (
  rest: ReadonlyArray<WalkthroughRestView>,
): ReadonlyArray<WalkthroughRestReason> => {
  const groups: Array<{ files: Array<WalkthroughRestView>; reason: string }> = [];
  const byReason = new Map<string, { files: Array<WalkthroughRestView>; reason: string }>();
  for (const item of rest) {
    let group = byReason.get(item.reason);
    if (!group) {
      group = { files: [], reason: item.reason };
      byReason.set(item.reason, group);
      groups.push(group);
    }
    group.files.push(item);
  }
  return groups;
};

/** Resolve the order to render: the requested id, the default, or the first. */
export const resolveOrder = (
  walkthrough: NarrativeWalkthrough,
  orderId?: string | null,
): WalkthroughOrder | null => {
  if (walkthrough.orders.length === 0) {
    return null;
  }
  return (
    walkthrough.orders.find((order) => order.id === orderId) ??
    walkthrough.orders.find((order) => order.id === walkthrough.defaultOrder) ??
    walkthrough.orders[0]
  );
};

/**
 * Build the full view-model for one reading order: stops resolved to their
 * segments and indexed, phases populated with their stops, and "the rest"
 * resolved and grouped by reason. Stops/rest whose segment can't be found are
 * dropped (the normalizer should prevent this, but the UI stays defensive).
 */
export const buildOrderView = (
  walkthrough: NarrativeWalkthrough,
  orderId?: string | null,
): WalkthroughOrderView | null => {
  const order = resolveOrder(walkthrough, orderId);
  if (!order) {
    return null;
  }

  const segmentsById = new Map(walkthrough.segments.map((segment) => [segment.id, segment]));

  const sequence: Array<WalkthroughStopView> = [];
  for (const stop of order.sequence) {
    const segment = segmentsById.get(stop.segmentId);
    if (segment) {
      sequence.push({ ...stop, index: sequence.length, segment });
    }
  }

  const phases: Array<WalkthroughPhaseView> = order.phases.map((phase) => ({
    ...phase,
    stops: sequence.filter((stop) => stop.phaseId === phase.id),
  }));

  const rest: Array<WalkthroughRestView> = [];
  for (const item of order.rest) {
    const segment = segmentsById.get(item.segmentId);
    if (segment) {
      rest.push({ ...item, segment });
    }
  }

  return {
    order,
    phases,
    rest,
    restByReason: groupRestByReason(rest),
    restTotals: sumLineCount(rest),
    sequence,
    totals: sumLineCount(sequence),
  };
};

/** The changed file + diff section a segment anchors into, if present in the diff. */
export type ResolvedSegmentFile = {
  file: ChangedFile;
  section: DiffSection;
};

/**
 * Resolve a segment to its live `ChangedFile` and `DiffSection`. Prefers the
 * anchor's `sectionId`, then falls back to the file's first visible section.
 */
export const resolveSegmentFile = (
  segment: WalkthroughSegment,
  files: ReadonlyArray<ChangedFile>,
  showWhitespace: boolean,
): ResolvedSegmentFile | null => {
  const file = files.find((candidate) => candidate.path === segment.path);
  if (!file) {
    return null;
  }

  const section =
    (segment.anchor.sectionId
      ? file.sections.find((candidate) => candidate.id === segment.anchor.sectionId)
      : undefined) ?? getFirstVisibleSection(file, showWhitespace);
  if (!section) {
    return null;
  }

  return { file, section };
};

export const granularityLabel: Record<WalkthroughSegment['granularity'], string> = {
  file: 'whole file',
  hunk: 'hunk',
  line: 'line',
};

export const importanceLabel: Record<WalkthroughStop['importance'], string> = {
  context: 'Context',
  critical: 'Critical',
  normal: 'Key change',
};
