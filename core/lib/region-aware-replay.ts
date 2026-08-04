/**
 * Provider-neutral regional replay for one revised file.
 *
 * The four inputs are B0 (earlier base), H0 (earlier head), B1 (later base),
 * and H1 (later head). Reviewer-visible output is built only from
 * Expected Replay → H1 clean regions and B1 → H1 conflict regions; H0 → H1
 * is never used as a fallback.
 */

export const regionAwareReplayAlgorithmVersion = 'region-aware-replay-v1:conflict-only-anchors';
/**
 * Versions the ordered region projection and its renderer-facing provenance.
 * This is distinct from replay semantics so cache invalidation can remain
 * narrow when only closure, coordinates, or projection records change.
 */
export const regionAwareReplayProjectionVersion = 'region-aware-projection-v1';
export const regionAwareMovedBlockPolicy = 'conflict-only-anchors';

const MAX_EDIT_DISTANCE = 10_000;
const CONTEXT_LINES = 3;

export type LineRange = {
  end: number;
  start: number;
};

export type RegionReplaySource = 'current-patch' | 'prior-patch' | 'target-base-movement';

export type RegionEditBlock = {
  afterPath: string | null;
  afterRange: LineRange;
  beforePath: string | null;
  beforeRange: LineRange;
  id: string;
  leadingContext: ReadonlyArray<string>;
  postimage: ReadonlyArray<string>;
  preimage: ReadonlyArray<string>;
  source: RegionReplaySource;
  trailingContext: ReadonlyArray<string>;
};

export type RegionReplayInput = {
  earlierBase: string | null | undefined;
  earlierBasePath?: string | null;
  earlierHead: string | null | undefined;
  earlierHeadPath?: string | null;
  laterBase: string | null | undefined;
  laterBasePath?: string | null;
  laterHead: string | null | undefined;
  laterHeadPath?: string | null;
  oldPath?: string;
  path: string;
};

/** Host control that must not affect the deterministic replay result. */
export type RegionReplayControl = {
  signal?: AbortSignal;
};

export type ReplayEditOutcome =
  | {
      earlierBaseRange: LineRange;
      earlierHeadRange: LineRange;
      expectedRange: LineRange;
      kind: 'absorbed';
      laterBaseRange: LineRange;
      priorEditId: string;
      provenance: 'exact-base-operation' | 'mapped-postimage';
    }
  | {
      earlierBaseRange: LineRange;
      earlierHeadRange: LineRange;
      expectedRange: LineRange;
      kind: 'applied';
      laterBaseRange: LineRange;
      priorEditId: string;
      provenance: 'mapped-preimage';
    }
  | {
      earlierBaseRange: LineRange;
      earlierHeadRange: LineRange;
      kind: 'conflict';
      laterBaseRange: LineRange;
      priorEditId: string;
      reason: 'ambiguous-anchor' | 'context-mismatch' | 'missing-anchor' | 'overlapping-edit';
      scope: 'file' | 'region';
    };

export type RegionReplayText = {
  content: string;
  path: string | null;
  range: LineRange;
  source: 'expected-replay' | 'later-base' | 'later-head';
};

export type ReplayCleanProjectionRegion = {
  affectedCurrentEditIds: ReadonlyArray<string>;
  closureEvidence: ReadonlyArray<string>;
  completeness: 'complete';
  expectedReplay: RegionReplayText;
  kind: 'replay-clean';
  laterBaseRange: LineRange;
  laterHead: RegionReplayText;
  priorEditIds: ReadonlyArray<string>;
  targetBaseEditIds: ReadonlyArray<string>;
};

export type ReplayConflictProjectionRegion = {
  affectedCurrentEditIds: ReadonlyArray<string>;
  closureEvidence: ReadonlyArray<string>;
  completeness: 'complete';
  kind: 'replay-conflict';
  laterBase: RegionReplayText;
  laterBaseRange: LineRange;
  laterHead: RegionReplayText;
  priorEditIds: ReadonlyArray<string>;
  priorEdits: ReadonlyArray<RegionEditBlock>;
  targetBaseEditIds: ReadonlyArray<string>;
};

export type IncompleteReplayProjectionRegion = {
  affectedCurrentEditIds: ReadonlyArray<string>;
  closureEvidence: ReadonlyArray<string>;
  completeness: 'incomplete';
  kind: 'incomplete';
  laterBaseRange: LineRange;
  missingEvidence: ReadonlyArray<string>;
  priorEditIds: ReadonlyArray<string>;
  targetBaseEditIds: ReadonlyArray<string>;
};

export type RegionReplayProjectionRegion =
  | IncompleteReplayProjectionRegion
  | ReplayCleanProjectionRegion
  | ReplayConflictProjectionRegion;

export type RegionReplayFileProjection = {
  algorithm: typeof regionAwareReplayAlgorithmVersion;
  currentEdits: ReadonlyArray<RegionEditBlock>;
  endpointPaths: {
    earlierBase: string | null;
    earlierHead: string | null;
    laterBase: string | null;
    laterHead: string | null;
  };
  expectedReplay: string | null;
  outcomes: ReadonlyArray<ReplayEditOutcome>;
  path: string;
  priorEdits: ReadonlyArray<RegionEditBlock>;
  regions: ReadonlyArray<RegionReplayProjectionRegion>;
  targetBaseEdits: ReadonlyArray<RegionEditBlock>;
};

type LineEdit = {
  kind: 'delete' | 'equal' | 'insert';
  line: string;
};

type TextDocument = {
  endsWithNewline: boolean;
  lines: ReadonlyArray<string>;
};

type BoundaryMap = {
  ambiguousBoundaries: ReadonlySet<number>;
  ambiguousLines: ReadonlySet<number>;
  boundaries: ReadonlyMap<number, number>;
  lines: ReadonlyMap<number, number>;
};

type RangeMapping =
  | { kind: 'mapped'; range: LineRange }
  | { kind: 'unmapped'; reason: 'ambiguous-anchor' | 'missing-anchor' };

type ExpectedTransform = {
  baseRange: LineRange;
  delta: number;
};

type MutableConflictRegion = {
  closureEvidence: Set<string>;
  currentIds: Set<string>;
  priorIds: Set<string>;
  range: LineRange;
  targetBaseIds: Set<string>;
};

const throwIfAborted = (signal?: AbortSignal) => signal?.throwIfAborted();

const range = (start: number, end: number): LineRange => ({ end, start });

const sameRange = (first: LineRange, second: LineRange) =>
  first.start === second.start && first.end === second.end;

const sameLines = (first: ReadonlyArray<string>, second: ReadonlyArray<string>) =>
  first.length === second.length && first.every((line, index) => line === second[index]);

const documentFromText = (value: string | null): TextDocument => {
  if (value == null || value.length === 0) {
    return { endsWithNewline: false, lines: [] };
  }
  const endsWithNewline = value.endsWith('\n');
  return {
    endsWithNewline,
    lines: (endsWithNewline ? value.slice(0, -1) : value).split('\n'),
  };
};

const textFromLines = (lines: ReadonlyArray<string>, endsWithNewline: boolean) =>
  `${lines.join('\n')}${endsWithNewline && lines.length > 0 ? '\n' : ''}`;

const textSlice = (
  document: TextDocument,
  path: string | null,
  source: RegionReplayText['source'],
  slice: LineRange,
): RegionReplayText => ({
  content: textFromLines(
    document.lines.slice(slice.start, slice.end),
    document.endsWithNewline && slice.end === document.lines.length,
  ),
  path,
  range: slice,
  source,
});

const rangesTouch = (first: LineRange, second: LineRange) => {
  if (first.start === first.end && second.start === second.end) {
    return first.start === second.start;
  }
  if (first.start === first.end) {
    return first.start >= second.start && first.start <= second.end;
  }
  if (second.start === second.end) {
    return second.start >= first.start && second.start <= first.end;
  }
  return first.start < second.end && second.start < first.end;
};

const unionRange = (first: LineRange, second: LineRange): LineRange =>
  range(Math.min(first.start, second.start), Math.max(first.end, second.end));

const unionRanges = (ranges: ReadonlyArray<LineRange>): LineRange | null =>
  ranges.reduce<LineRange | null>(
    (combined, candidate) => (combined ? unionRange(combined, candidate) : candidate),
    null,
  );

const myersEditScript = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
  signal?: AbortSignal,
): ReadonlyArray<LineEdit> | null => {
  throwIfAborted(signal);
  if (left.length === 0 && right.length === 0) {
    return [];
  }
  if (left.length === 0) {
    return right.map((line) => ({ kind: 'insert' as const, line }));
  }
  if (right.length === 0) {
    return left.map((line) => ({ kind: 'delete' as const, line }));
  }
  if (Math.abs(left.length - right.length) > MAX_EDIT_DISTANCE) {
    return null;
  }

  const maximum = Math.min(left.length + right.length, MAX_EDIT_DISTANCE);
  const offset = maximum;
  const frontier = new Int32Array(maximum * 2 + 1);
  const trace: Array<Int32Array> = [];
  let solved = false;
  for (let distance = 0; distance <= maximum; distance += 1) {
    throwIfAborted(signal);
    trace.push(frontier.slice());
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      throwIfAborted(signal);
      let leftIndex: number;
      if (
        diagonal === -distance ||
        (diagonal !== distance &&
          frontier[diagonal - 1 + offset]! < frontier[diagonal + 1 + offset]!)
      ) {
        leftIndex = frontier[diagonal + 1 + offset]!;
      } else {
        leftIndex = frontier[diagonal - 1 + offset]! + 1;
      }
      let rightIndex = leftIndex - diagonal;
      while (
        leftIndex < left.length &&
        rightIndex < right.length &&
        left[leftIndex] === right[rightIndex]
      ) {
        leftIndex += 1;
        rightIndex += 1;
      }
      frontier[diagonal + offset] = leftIndex;
      if (leftIndex >= left.length && rightIndex >= right.length) {
        solved = true;
        break;
      }
    }
    if (solved) {
      break;
    }
  }
  if (!solved) {
    return null;
  }

  let leftIndex = left.length;
  let rightIndex = right.length;
  const edits: Array<LineEdit> = [];
  for (let distance = trace.length - 1; distance > 0; distance -= 1) {
    throwIfAborted(signal);
    const previous = trace[distance]!;
    const diagonal = leftIndex - rightIndex;
    const previousDiagonal =
      diagonal === -distance ||
      (diagonal !== distance && previous[diagonal - 1 + offset]! < previous[diagonal + 1 + offset]!)
        ? diagonal + 1
        : diagonal - 1;
    const previousLeft = previous[previousDiagonal + offset]!;
    const previousRight = previousLeft - previousDiagonal;
    const afterEditLeft = previousDiagonal === diagonal + 1 ? previousLeft : previousLeft + 1;
    while (leftIndex > afterEditLeft) {
      leftIndex -= 1;
      rightIndex -= 1;
      edits.push({ kind: 'equal', line: left[leftIndex]! });
    }
    edits.push({
      kind: previousDiagonal === diagonal + 1 ? 'insert' : 'delete',
      line: previousDiagonal === diagonal + 1 ? right[previousRight]! : left[previousLeft]!,
    });
    leftIndex = previousLeft;
    rightIndex = previousRight;
  }
  while (leftIndex > 0) {
    throwIfAborted(signal);
    leftIndex -= 1;
    rightIndex -= 1;
    edits.push({ kind: 'equal', line: left[leftIndex]! });
  }
  edits.reverse();
  return edits;
};

const createEditBlocks = (
  source: RegionReplaySource,
  before: TextDocument,
  beforePath: string | null,
  after: TextDocument,
  afterPath: string | null,
  signal?: AbortSignal,
): ReadonlyArray<RegionEditBlock> | null => {
  const edits = myersEditScript(before.lines, after.lines, signal);
  if (edits == null) {
    return null;
  }
  const blocks: Array<RegionEditBlock> = [];
  let cursor = 0;
  let beforeIndex = 0;
  let afterIndex = 0;
  while (cursor < edits.length) {
    throwIfAborted(signal);
    const edit = edits[cursor]!;
    if (edit.kind === 'equal') {
      cursor += 1;
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }
    const beforeStart = beforeIndex;
    const afterStart = afterIndex;
    const preimage: Array<string> = [];
    const postimage: Array<string> = [];
    while (cursor < edits.length && edits[cursor]!.kind !== 'equal') {
      throwIfAborted(signal);
      const changed = edits[cursor]!;
      if (changed.kind === 'delete') {
        preimage.push(changed.line);
        beforeIndex += 1;
      } else {
        postimage.push(changed.line);
        afterIndex += 1;
      }
      cursor += 1;
    }
    blocks.push({
      afterPath,
      afterRange: range(afterStart, afterIndex),
      beforePath,
      beforeRange: range(beforeStart, beforeIndex),
      id: `${source}:${blocks.length}`,
      leadingContext: before.lines.slice(Math.max(0, beforeStart - CONTEXT_LINES), beforeStart),
      postimage,
      preimage,
      source,
      trailingContext: before.lines.slice(beforeIndex, beforeIndex + CONTEXT_LINES),
    });
  }
  return blocks;
};

const MAX_ANCHOR_CANDIDATES = 256;

const sequenceOccursExactlyOnce = (
  document: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
  signal?: AbortSignal,
): boolean => {
  if (expected.length === 0) {
    return false;
  }
  let candidates = 0;
  let occurrences = 0;
  for (let index = 0; index <= document.length - expected.length; index += 1) {
    throwIfAborted(signal);
    if (document[index] !== expected[0]) {
      continue;
    }
    candidates += 1;
    // A highly repetitive anchor is intentionally treated as ambiguous. This
    // cap keeps an adversarial repeated-line file from turning anchor proof
    // into quadratic work while preserving the conservative replay policy.
    if (candidates > MAX_ANCHOR_CANDIDATES) {
      return false;
    }
    if (!sameLines(document.slice(index, index + expected.length), expected)) {
      continue;
    }
    occurrences += 1;
    if (occurrences > 1) {
      return false;
    }
  }
  return occurrences === 1;
};

const uniqueEqualRun = (
  before: TextDocument,
  after: TextDocument,
  beforeStart: number,
  afterStart: number,
  length: number,
  signal?: AbortSignal,
) => {
  const lines = before.lines.slice(beforeStart, beforeStart + length);
  return (
    sameLines(lines, after.lines.slice(afterStart, afterStart + length)) &&
    sequenceOccursExactlyOnce(before.lines, lines, signal) &&
    sequenceOccursExactlyOnce(after.lines, lines, signal)
  );
};

const sequenceStarts = (
  document: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
  signal?: AbortSignal,
) => {
  if (expected.length === 0) {
    return [];
  }
  const starts: Array<number> = [];
  for (let index = 0; index <= document.length - expected.length; index += 1) {
    throwIfAborted(signal);
    if (document[index] !== expected[0]) {
      continue;
    }
    if (sameLines(document.slice(index, index + expected.length), expected)) {
      starts.push(index);
      if (starts.length > MAX_ANCHOR_CANDIDATES) {
        return starts;
      }
    }
  }
  return starts;
};

const buildBoundaryMap = (
  before: TextDocument,
  after: TextDocument,
  edits: ReadonlyArray<RegionEditBlock>,
  signal?: AbortSignal,
): BoundaryMap => {
  const lineScript = myersEditScript(before.lines, after.lines, signal);
  const lines = new Map<number, number>();
  const boundaries = new Map<number, number>();
  const ambiguousLines = new Set<number>();
  const ambiguousBoundaries = new Set<number>();
  if (lineScript == null) {
    return { ambiguousBoundaries, ambiguousLines, boundaries, lines };
  }
  if (sameLines(before.lines, after.lines) && before.endsWithNewline === after.endsWithNewline) {
    for (let index = 0; index < before.lines.length; index += 1) {
      lines.set(index, index);
    }
    for (let boundary = 0; boundary <= before.lines.length; boundary += 1) {
      boundaries.set(boundary, boundary);
    }
    return { ambiguousBoundaries, ambiguousLines, boundaries, lines };
  }

  const equalRuns: Array<{ afterStart: number; beforeStart: number; length: number }> = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  let runBeforeStart: number | null = null;
  let runAfterStart: number | null = null;
  let runLength = 0;
  const finishEqualRun = () => {
    if (runBeforeStart != null && runAfterStart != null && runLength > 0) {
      equalRuns.push({
        afterStart: runAfterStart,
        beforeStart: runBeforeStart,
        length: runLength,
      });
    }
    runBeforeStart = null;
    runAfterStart = null;
    runLength = 0;
  };
  for (const edit of lineScript) {
    throwIfAborted(signal);
    if (edit.kind === 'equal') {
      if (runBeforeStart == null || runAfterStart == null) {
        runBeforeStart = beforeIndex;
        runAfterStart = afterIndex;
      }
      runLength += 1;
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }
    finishEqualRun();
    if (edit.kind === 'delete') {
      beforeIndex += 1;
    } else {
      afterIndex += 1;
    }
  }
  finishEqualRun();

  for (const equalRun of equalRuns) {
    throwIfAborted(signal);
    const trusted = uniqueEqualRun(
      before,
      after,
      equalRun.beforeStart,
      equalRun.afterStart,
      equalRun.length,
      signal,
    );
    for (let offset = 0; offset < equalRun.length; offset += 1) {
      throwIfAborted(signal);
      const beforeLine = equalRun.beforeStart + offset;
      const afterLine = equalRun.afterStart + offset;
      if (trusted) {
        lines.set(beforeLine, afterLine);
      } else {
        ambiguousLines.add(beforeLine);
      }
    }
    for (let offset = 0; offset <= equalRun.length; offset += 1) {
      throwIfAborted(signal);
      const beforeBoundary = equalRun.beforeStart + offset;
      const afterBoundary = equalRun.afterStart + offset;
      if (!trusted) {
        ambiguousBoundaries.add(beforeBoundary);
        continue;
      }
      const existing = boundaries.get(beforeBoundary);
      if (existing != null && existing !== afterBoundary) {
        boundaries.delete(beforeBoundary);
        ambiguousBoundaries.add(beforeBoundary);
      } else {
        boundaries.set(beforeBoundary, afterBoundary);
      }
    }
  }

  // The conservative moved-block policy permits only untouched canonical
  // boundaries. A base operation owns both of its touching boundaries.
  for (const edit of edits) {
    throwIfAborted(signal);
    for (let boundary = edit.beforeRange.start; boundary <= edit.beforeRange.end; boundary += 1) {
      boundaries.delete(boundary);
    }
    // If a base operation deletes or replaces text that occurs at more than
    // one B0 locus, its selected diff alignment is not an identity proof for
    // the other candidates. Mark all of those candidate anchors unsafe rather
    // than replaying a prior edit at an arbitrary repeated-text location.
    const repeatedPreimages = sequenceStarts(before.lines, edit.preimage, signal);
    if (repeatedPreimages.length > 1) {
      for (const start of repeatedPreimages) {
        throwIfAborted(signal);
        for (let line = start; line < start + edit.preimage.length; line += 1) {
          throwIfAborted(signal);
          lines.delete(line);
          ambiguousLines.add(line);
        }
        for (let boundary = start; boundary <= start + edit.preimage.length; boundary += 1) {
          throwIfAborted(signal);
          boundaries.delete(boundary);
          ambiguousBoundaries.add(boundary);
        }
      }
    }
  }
  return { ambiguousBoundaries, ambiguousLines, boundaries, lines };
};

const mapRange = (source: LineRange, map: BoundaryMap): RangeMapping => {
  const ambiguous = () =>
    source.start === source.end
      ? map.ambiguousBoundaries.has(source.start)
      : [...Array(source.end - source.start + 1).keys()].some(
          (offset) =>
            map.ambiguousBoundaries.has(source.start + offset) ||
            (offset < source.end - source.start && map.ambiguousLines.has(source.start + offset)),
        );
  const unmapped = (): RangeMapping => ({
    kind: 'unmapped',
    reason: ambiguous() ? 'ambiguous-anchor' : 'missing-anchor',
  });
  if (source.start === source.end) {
    const boundary = map.boundaries.get(source.start);
    return boundary == null ? unmapped() : { kind: 'mapped', range: range(boundary, boundary) };
  }
  const first = map.lines.get(source.start);
  if (first == null) {
    return unmapped();
  }
  for (let index = source.start; index < source.end; index += 1) {
    if (map.lines.get(index) !== first + index - source.start) {
      return unmapped();
    }
  }
  return { kind: 'mapped', range: range(first, first + source.end - source.start) };
};

const baseEditsExactlyAbsorb = (
  prior: RegionEditBlock,
  targetBaseEdits: ReadonlyArray<RegionEditBlock>,
): RegionEditBlock | null =>
  targetBaseEdits.find((candidate) => {
    if (!sameRange(candidate.beforeRange, prior.beforeRange)) {
      return false;
    }
    if (!sameLines(candidate.preimage, prior.preimage)) {
      return false;
    }
    if (prior.preimage.length === 0) {
      return sameLines(candidate.postimage, prior.postimage);
    }
    if (prior.postimage.length === 0) {
      // An empty deletion postimage is not enough: the target-base operation
      // must prove it deleted this exact preimage at the same range.
      return candidate.postimage.length === 0;
    }
    return sameLines(candidate.postimage, prior.postimage);
  }) ?? null;

const translatedBoundary = (
  boundary: number,
  side: 'end' | 'start',
  transforms: ReadonlyArray<ExpectedTransform>,
) =>
  transforms.reduce((translated, transform) => {
    if (
      transform.baseRange.end < boundary ||
      (transform.baseRange.end === boundary &&
        transform.baseRange.start !== transform.baseRange.end)
    ) {
      return translated + transform.delta;
    }
    if (
      transform.baseRange.start === transform.baseRange.end &&
      (transform.baseRange.start < boundary ||
        (transform.baseRange.start === boundary && side === 'end'))
    ) {
      return translated + transform.delta;
    }
    return translated;
  }, boundary);

const translateRange = (
  source: LineRange,
  transforms: ReadonlyArray<ExpectedTransform>,
): LineRange =>
  range(
    translatedBoundary(source.start, 'start', transforms),
    translatedBoundary(source.end, 'end', transforms),
  );

const startsWithLines = (
  source: ReadonlyArray<string>,
  start: number,
  expected: ReadonlyArray<string>,
) => sameLines(source.slice(start, start + expected.length), expected);

const projectionBoundary = (
  boundary: number,
  side: 'end' | 'start',
  edits: ReadonlyArray<RegionEditBlock>,
) => {
  let offset = 0;
  for (const edit of edits) {
    const before = edit.beforeRange;
    const after = edit.afterRange;
    if (before.start === before.end && boundary === before.start) {
      return side === 'start' ? after.start : after.end;
    }
    if (boundary < before.start) {
      return boundary + offset;
    }
    if (boundary === before.start) {
      return after.start;
    }
    if (boundary < before.end) {
      return side === 'start' ? after.start : after.end;
    }
    if (boundary === before.end) {
      return after.end;
    }
    offset += after.end - after.start - (before.end - before.start);
  }
  return boundary + offset;
};

const projectRangeToLaterHead = (
  source: LineRange,
  edits: ReadonlyArray<RegionEditBlock>,
): LineRange =>
  range(
    projectionBoundary(source.start, 'start', edits),
    projectionBoundary(source.end, 'end', edits),
  );

const closeConflictRegion = (
  region: MutableConflictRegion,
  priorOutcomes: ReadonlyArray<ReplayEditOutcome>,
  targetBaseEdits: ReadonlyArray<RegionEditBlock>,
  currentEdits: ReadonlyArray<RegionEditBlock>,
  signal?: AbortSignal,
): MutableConflictRegion => {
  let changed = true;
  while (changed) {
    throwIfAborted(signal);
    changed = false;
    for (const outcome of priorOutcomes) {
      throwIfAborted(signal);
      if (!rangesTouch(region.range, outcome.laterBaseRange)) {
        continue;
      }
      const expanded = unionRange(region.range, outcome.laterBaseRange);
      if (!sameRange(expanded, region.range)) {
        region.range = expanded;
        changed = true;
      }
      region.priorIds.add(outcome.priorEditId);
      region.closureEvidence.add(`prior:${outcome.priorEditId}`);
    }
    for (const edit of targetBaseEdits) {
      throwIfAborted(signal);
      if (!rangesTouch(region.range, edit.afterRange)) {
        continue;
      }
      const expanded = unionRange(region.range, edit.afterRange);
      if (!sameRange(expanded, region.range)) {
        region.range = expanded;
        changed = true;
      }
      region.targetBaseIds.add(edit.id);
      region.closureEvidence.add(`target-base:${edit.id}`);
    }
    for (const edit of currentEdits) {
      throwIfAborted(signal);
      if (!rangesTouch(region.range, edit.beforeRange)) {
        continue;
      }
      const expanded = unionRange(region.range, edit.beforeRange);
      if (!sameRange(expanded, region.range)) {
        region.range = expanded;
        changed = true;
      }
      region.currentIds.add(edit.id);
      region.closureEvidence.add(`current:${edit.id}`);
    }
  }
  return region;
};

const coalesceConflictRegions = (
  regions: ReadonlyArray<MutableConflictRegion>,
): Array<MutableConflictRegion> => {
  const coalesced: Array<MutableConflictRegion> = [];
  for (const candidate of [...regions].toSorted(
    (first, second) => first.range.start - second.range.start || first.range.end - second.range.end,
  )) {
    const prior = coalesced.at(-1);
    if (!prior || prior.range.end < candidate.range.start) {
      coalesced.push(candidate);
      continue;
    }
    prior.range = unionRange(prior.range, candidate.range);
    candidate.priorIds.forEach((id) => prior.priorIds.add(id));
    candidate.currentIds.forEach((id) => prior.currentIds.add(id));
    candidate.targetBaseIds.forEach((id) => prior.targetBaseIds.add(id));
    candidate.closureEvidence.forEach((entry) => prior.closureEvidence.add(entry));
    prior.closureEvidence.add('coalesced');
  }
  return coalesced;
};

const expandConflictToStableAnchors = (
  region: MutableConflictRegion,
  boundaryMap: BoundaryMap,
  laterBaseLength: number,
) => {
  const stableBoundaries = [...new Set(boundaryMap.boundaries.values())].toSorted(
    (first, second) => first - second,
  );
  const start = stableBoundaries.filter((boundary) => boundary <= region.range.start).at(-1) ?? 0;
  const end = stableBoundaries.find((boundary) => boundary >= region.range.end) ?? laterBaseLength;
  const expanded = range(start, end);
  if (!sameRange(expanded, region.range)) {
    region.range = expanded;
    region.closureEvidence.add(`stable-anchor:${start}:${end}`);
  }
  return region;
};

const conflictState = (regions: ReadonlyArray<MutableConflictRegion>) =>
  regions
    .map((region) =>
      [
        `${region.range.start}:${region.range.end}`,
        [...region.priorIds].toSorted().join(','),
        [...region.targetBaseIds].toSorted().join(','),
        [...region.currentIds].toSorted().join(','),
      ].join('|'),
    )
    .toSorted()
    .join(';');

const closeConflictRegionsToFixedPoint = (
  initialRegions: ReadonlyArray<MutableConflictRegion>,
  priorOutcomes: ReadonlyArray<ReplayEditOutcome>,
  targetBaseEdits: ReadonlyArray<RegionEditBlock>,
  currentEdits: ReadonlyArray<RegionEditBlock>,
  boundaryMap: BoundaryMap,
  laterBaseLength: number,
  signal?: AbortSignal,
) => {
  let regions = [...initialRegions];
  let previousState = '';
  const maximumIterations =
    (initialRegions.length +
      priorOutcomes.length +
      targetBaseEdits.length +
      currentEdits.length +
      1) *
    2;
  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    throwIfAborted(signal);
    for (const region of regions) {
      throwIfAborted(signal);
      closeConflictRegion(region, priorOutcomes, targetBaseEdits, currentEdits, signal);
      expandConflictToStableAnchors(region, boundaryMap, laterBaseLength);
      closeConflictRegion(region, priorOutcomes, targetBaseEdits, currentEdits, signal);
    }
    regions = coalesceConflictRegions(regions);
    for (const region of regions) {
      throwIfAborted(signal);
      closeConflictRegion(region, priorOutcomes, targetBaseEdits, currentEdits, signal);
      expandConflictToStableAnchors(region, boundaryMap, laterBaseLength);
      closeConflictRegion(region, priorOutcomes, targetBaseEdits, currentEdits, signal);
    }
    const nextState = conflictState(regions);
    if (nextState === previousState) {
      return regions;
    }
    previousState = nextState;
  }
  // Every operation can only be added once and every range can only expand,
  // so the bound above is defensive. Returning the monotonic final state is
  // safer than discarding the conflict when a malformed input hits it.
  return regions;
};

const incompleteProjection = (
  input: RegionReplayInput,
  missingEvidence: ReadonlyArray<string>,
): RegionReplayFileProjection => ({
  algorithm: regionAwareReplayAlgorithmVersion,
  currentEdits: [],
  endpointPaths: {
    earlierBase: input.earlierBasePath ?? input.oldPath ?? input.path,
    earlierHead: input.earlierHeadPath ?? input.path,
    laterBase: input.laterBasePath ?? input.oldPath ?? input.path,
    laterHead: input.laterHeadPath ?? input.path,
  },
  expectedReplay: null,
  outcomes: [],
  path: input.path,
  priorEdits: [],
  regions: [
    {
      affectedCurrentEditIds: [],
      closureEvidence: ['incomplete-input'],
      completeness: 'incomplete',
      kind: 'incomplete',
      laterBaseRange: range(0, 0),
      missingEvidence,
      priorEditIds: [],
      targetBaseEditIds: [],
    },
  ],
  targetBaseEdits: [],
});

/**
 * Materialize one exact regional replay projection. This is deliberately
 * synchronous and pure: Artifact Sources acquire endpoints before calling it,
 * and a missing endpoint returns an explicit incomplete region rather than a
 * direct-head or approximate-patch fallback. Host cancellation stays outside
 * the semantic input and prevents an obsolete projection from being returned.
 */
export const projectRegionAwareReplay = (
  input: RegionReplayInput,
  control: RegionReplayControl = {},
): RegionReplayFileProjection => {
  const { signal } = control;
  throwIfAborted(signal);
  const endpoints = [
    ['Earlier Base', input.earlierBase],
    ['Earlier HEAD', input.earlierHead],
    ['Later Base', input.laterBase],
    ['Later HEAD', input.laterHead],
  ] as const;
  const missingEvidence = endpoints
    .filter(([, content]) => content === undefined)
    .map(([name]) => `${name} content is unavailable.`);
  const binaryEvidence = endpoints
    .filter(([, content]) => typeof content === 'string' && content.includes('\0'))
    .map(([name]) => `${name} is non-textual.`);
  if (missingEvidence.length > 0 || binaryEvidence.length > 0) {
    return incompleteProjection(input, [...missingEvidence, ...binaryEvidence]);
  }

  const earlierBase = documentFromText(input.earlierBase ?? null);
  const earlierHead = documentFromText(input.earlierHead ?? null);
  const laterBase = documentFromText(input.laterBase ?? null);
  const laterHead = documentFromText(input.laterHead ?? null);
  const endpointPaths = {
    earlierBase: input.earlierBasePath ?? input.oldPath ?? input.path,
    earlierHead: input.earlierHeadPath ?? input.path,
    laterBase: input.laterBasePath ?? input.oldPath ?? input.path,
    laterHead: input.laterHeadPath ?? input.path,
  };
  const priorEdits = createEditBlocks(
    'prior-patch',
    earlierBase,
    endpointPaths.earlierBase,
    earlierHead,
    endpointPaths.earlierHead,
    signal,
  );
  const targetBaseEdits = createEditBlocks(
    'target-base-movement',
    earlierBase,
    endpointPaths.earlierBase,
    laterBase,
    endpointPaths.laterBase,
    signal,
  );
  const currentEdits = createEditBlocks(
    'current-patch',
    laterBase,
    endpointPaths.laterBase,
    laterHead,
    endpointPaths.laterHead,
    signal,
  );
  if (priorEdits == null || targetBaseEdits == null || currentEdits == null) {
    return incompleteProjection(input, [
      'An endpoint diff exceeds the regional replay edit bound.',
    ]);
  }

  const boundaryMap = buildBoundaryMap(earlierBase, laterBase, targetBaseEdits, signal);
  const expectedLines = [...laterBase.lines];
  let expectedEndsWithNewline = laterBase.endsWithNewline;
  const transforms: Array<ExpectedTransform> = [];
  const outcomes: Array<ReplayEditOutcome> = [];

  for (const prior of priorEdits) {
    throwIfAborted(signal);
    const rangeMapping = mapRange(prior.beforeRange, boundaryMap);
    const baseAbsorption = baseEditsExactlyAbsorb(prior, targetBaseEdits);
    if (rangeMapping.kind === 'unmapped') {
      if (baseAbsorption) {
        outcomes.push({
          earlierBaseRange: prior.beforeRange,
          earlierHeadRange: prior.afterRange,
          expectedRange: baseAbsorption.afterRange,
          kind: 'absorbed',
          laterBaseRange: baseAbsorption.afterRange,
          priorEditId: prior.id,
          provenance: 'exact-base-operation',
        });
        continue;
      }
      const overlaps = targetBaseEdits.filter((edit) =>
        rangesTouch(edit.beforeRange, prior.beforeRange),
      );
      const laterBaseRange =
        unionRanges(overlaps.map((edit) => edit.afterRange)) ?? range(0, laterBase.lines.length);
      outcomes.push({
        earlierBaseRange: prior.beforeRange,
        earlierHeadRange: prior.afterRange,
        kind: 'conflict',
        laterBaseRange,
        priorEditId: prior.id,
        reason: overlaps.length > 0 ? 'overlapping-edit' : rangeMapping.reason,
        scope: overlaps.length > 0 ? 'region' : 'file',
      });
      continue;
    }

    const mappedRange = rangeMapping.range;
    const expectedRange = translateRange(mappedRange, transforms);
    if (prior.preimage.length === 0) {
      if (startsWithLines(expectedLines, expectedRange.start, prior.postimage)) {
        outcomes.push({
          earlierBaseRange: prior.beforeRange,
          earlierHeadRange: prior.afterRange,
          expectedRange: range(expectedRange.start, expectedRange.start + prior.postimage.length),
          kind: 'absorbed',
          laterBaseRange: mappedRange,
          priorEditId: prior.id,
          provenance: 'mapped-postimage',
        });
        continue;
      }
      expectedLines.splice(expectedRange.start, 0, ...prior.postimage);
      transforms.push({ baseRange: mappedRange, delta: prior.postimage.length });
      if (prior.beforeRange.end === earlierBase.lines.length) {
        expectedEndsWithNewline = earlierHead.endsWithNewline;
      }
      outcomes.push({
        earlierBaseRange: prior.beforeRange,
        earlierHeadRange: prior.afterRange,
        expectedRange: range(expectedRange.start, expectedRange.start + prior.postimage.length),
        kind: 'applied',
        laterBaseRange: mappedRange,
        priorEditId: prior.id,
        provenance: 'mapped-preimage',
      });
      continue;
    }

    if (!sameLines(expectedLines.slice(expectedRange.start, expectedRange.end), prior.preimage)) {
      outcomes.push({
        earlierBaseRange: prior.beforeRange,
        earlierHeadRange: prior.afterRange,
        kind: 'conflict',
        laterBaseRange: mappedRange,
        priorEditId: prior.id,
        reason: 'context-mismatch',
        scope: 'region',
      });
      continue;
    }
    expectedLines.splice(expectedRange.start, prior.preimage.length, ...prior.postimage);
    transforms.push({
      baseRange: mappedRange,
      delta: prior.postimage.length - prior.preimage.length,
    });
    if (prior.beforeRange.end === earlierBase.lines.length) {
      expectedEndsWithNewline = earlierHead.endsWithNewline;
    }
    outcomes.push({
      earlierBaseRange: prior.beforeRange,
      earlierHeadRange: prior.afterRange,
      expectedRange: range(expectedRange.start, expectedRange.start + prior.postimage.length),
      kind: 'applied',
      laterBaseRange: mappedRange,
      priorEditId: prior.id,
      provenance: 'mapped-preimage',
    });
  }

  const conflictRegions = outcomes
    .filter(
      (outcome): outcome is Extract<ReplayEditOutcome, { kind: 'conflict' }> =>
        outcome.kind === 'conflict',
    )
    .map<MutableConflictRegion>((outcome) => ({
      closureEvidence: new Set([`seed:${outcome.priorEditId}:${outcome.reason}`]),
      currentIds: new Set(),
      priorIds: new Set([outcome.priorEditId]),
      range: outcome.laterBaseRange,
      targetBaseIds: new Set(),
    }));
  const closedConflicts = closeConflictRegionsToFixedPoint(
    conflictRegions,
    outcomes,
    targetBaseEdits,
    currentEdits,
    boundaryMap,
    laterBase.lines.length,
    signal,
  );

  const expectedReplay: TextDocument = {
    endsWithNewline: expectedEndsWithNewline,
    lines: expectedLines,
  };
  const targetBaseIdsForRange = (candidate: LineRange) =>
    targetBaseEdits
      .filter((edit) => rangesTouch(candidate, edit.afterRange))
      .map((edit) => edit.id);
  const regions: Array<RegionReplayProjectionRegion> = [];
  let cursor = 0;
  for (const conflict of closedConflicts) {
    throwIfAborted(signal);
    if (cursor < conflict.range.start) {
      const cleanRange = range(cursor, conflict.range.start);
      const expectedRange = translateRange(cleanRange, transforms);
      const laterHeadRange = projectRangeToLaterHead(cleanRange, currentEdits);
      regions.push({
        affectedCurrentEditIds: [],
        closureEvidence: ['clean-complement'],
        completeness: 'complete',
        expectedReplay: textSlice(expectedReplay, null, 'expected-replay', expectedRange),
        kind: 'replay-clean',
        laterBaseRange: cleanRange,
        laterHead: textSlice(laterHead, endpointPaths.laterHead, 'later-head', laterHeadRange),
        priorEditIds: outcomes
          .filter(
            (outcome) =>
              outcome.kind !== 'conflict' && rangesTouch(cleanRange, outcome.laterBaseRange),
          )
          .map((outcome) => outcome.priorEditId),
        targetBaseEditIds: targetBaseIdsForRange(cleanRange),
      });
    }
    const laterHeadRange = projectRangeToLaterHead(conflict.range, currentEdits);
    regions.push({
      affectedCurrentEditIds: [...conflict.currentIds].toSorted(),
      closureEvidence: [...conflict.closureEvidence].toSorted(),
      completeness: 'complete',
      kind: 'replay-conflict',
      laterBase: textSlice(laterBase, endpointPaths.laterBase, 'later-base', conflict.range),
      laterBaseRange: conflict.range,
      laterHead: textSlice(laterHead, endpointPaths.laterHead, 'later-head', laterHeadRange),
      priorEditIds: [...conflict.priorIds].toSorted(),
      priorEdits: priorEdits.filter((edit) => conflict.priorIds.has(edit.id)),
      targetBaseEditIds: [...conflict.targetBaseIds].toSorted(),
    });
    cursor = Math.max(cursor, conflict.range.end);
  }
  throwIfAborted(signal);
  if (cursor < laterBase.lines.length || regions.length === 0) {
    const cleanRange = range(cursor, laterBase.lines.length);
    const expectedRange = translateRange(cleanRange, transforms);
    const laterHeadRange = projectRangeToLaterHead(cleanRange, currentEdits);
    regions.push({
      affectedCurrentEditIds: [],
      closureEvidence: ['clean-complement'],
      completeness: 'complete',
      expectedReplay: textSlice(expectedReplay, null, 'expected-replay', expectedRange),
      kind: 'replay-clean',
      laterBaseRange: cleanRange,
      laterHead: textSlice(laterHead, endpointPaths.laterHead, 'later-head', laterHeadRange),
      priorEditIds: outcomes
        .filter(
          (outcome) =>
            outcome.kind !== 'conflict' && rangesTouch(cleanRange, outcome.laterBaseRange),
        )
        .map((outcome) => outcome.priorEditId),
      targetBaseEditIds: targetBaseIdsForRange(cleanRange),
    });
  }

  return {
    algorithm: regionAwareReplayAlgorithmVersion,
    currentEdits,
    endpointPaths,
    expectedReplay: textFromLines(expectedReplay.lines, expectedReplay.endsWithNewline),
    outcomes,
    path: input.path,
    priorEdits,
    regions,
    targetBaseEdits,
  };
};
