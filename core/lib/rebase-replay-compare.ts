// Provider-neutral version comparison.
// Reviewer-facing orchestration is computeVersionComparePreferringReplay(),
// which builds exact B0/H0/B1/H1 regional replay projections. Providers supply
// endpoint metadata, patch files, and bounded blob reads; unavailable evidence
// remains an explicit incomplete projection.

import type { ChangedFile, GitSha, ReviewVersionId } from '../types.ts';
import {
  projectRegionAwareReplay,
  regionAwareReplayAlgorithmVersion,
  type RegionReplayFileProjection,
  type RegionReplayText,
} from './region-aware-replay.ts';

// === Localized line diff (bounded Myers O(ND) algorithm) ===

const MAX_DIFF_D = 1000;

type DiffEdit = {
  kind: 'delete' | 'equal' | 'insert';
  line: string;
};

/**
 * Compute the shortest edit script between two line arrays using Myers' O(ND) algorithm.
 * Returns null if the edit distance exceeds maxD (pathological input).
 */
const myersEditScript = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  maxD = MAX_DIFF_D,
): ReadonlyArray<DiffEdit> | null => {
  const N = a.length;
  const M = b.length;

  if (N === 0 && M === 0) {
    return [];
  }
  if (N === 0) {
    return b.map((line) => ({ kind: 'insert' as const, line }));
  }
  if (M === 0) {
    return a.map((line) => ({ kind: 'delete' as const, line }));
  }
  // Minimum possible edit distance is |N-M|; bail early if already too large.
  if (Math.abs(N - M) > maxD) {
    return null;
  }

  const MAX = Math.min(N + M, maxD);
  const offset = MAX;
  const size = 2 * MAX + 1;
  const v = new Int32Array(size);
  const trace: Array<Int32Array> = [];
  let solved = false;

  for (let d = 0; d <= MAX; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)) {
        x = v[k + 1 + offset]!;
      } else {
        x = v[k - 1 + offset]! + 1;
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= N && y >= M) {
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

  // Backtrack to build edit script.
  let x = N;
  let y = M;
  const edits: Array<DiffEdit> = [];

  for (let d = trace.length - 1; d > 0; d--) {
    const vPrev = trace[d]!;
    const k = x - y;

    let prevK: number;
    if (k === -d || (k !== d && vPrev[k - 1 + offset]! < vPrev[k + 1 + offset]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = vPrev[prevK + offset]!;
    const prevY = prevX - prevK;

    // Diagonal (equal) moves from after-edit position to current (x, y).
    const afterEditX = prevK === k + 1 ? prevX : prevX + 1;
    while (x > afterEditX) {
      x--;
      y--;
      edits.push({ kind: 'equal', line: a[x]! });
    }

    // The edit itself.
    if (prevK === k + 1) {
      edits.push({ kind: 'insert', line: b[prevY]! });
    } else {
      edits.push({ kind: 'delete', line: a[prevX]! });
    }

    x = prevX;
    y = prevY;
  }

  // Initial snake (d=0): remaining diagonals from (0,0).
  while (x > 0) {
    x--;
    y--;
    edits.push({ kind: 'equal', line: a[x]! });
  }

  edits.reverse();
  return edits;
};

/**
 * Format an edit script as unified diff hunks with limited context lines.
 * Returns an empty string when the edit script contains no changes.
 */
const formatUnifiedHunks = (
  edits: ReadonlyArray<DiffEdit>,
  leftEndsWithNewline: boolean,
  rightEndsWithNewline: boolean,
  contextLines = 3,
): string => {
  // Find positions of changes.
  const changePositions: Array<number> = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i]!.kind !== 'equal') {
      changePositions.push(i);
    }
  }
  if (changePositions.length === 0) {
    return '';
  }

  // Group changes into hunk ranges [start, end) with context.
  const hunkRanges: Array<[number, number]> = [];
  let hunkStart = Math.max(0, changePositions[0]! - contextLines);
  let hunkEnd = changePositions[0]! + 1;

  for (let i = 1; i < changePositions.length; i++) {
    const pos = changePositions[i]!;
    if (pos <= hunkEnd + 2 * contextLines) {
      hunkEnd = pos + 1;
    } else {
      hunkRanges.push([hunkStart, Math.min(edits.length, hunkEnd + contextLines)]);
      hunkStart = Math.max(0, pos - contextLines);
      hunkEnd = pos + 1;
    }
  }
  hunkRanges.push([hunkStart, Math.min(edits.length, hunkEnd + contextLines)]);

  // Pre-compute old/new line numbers at each edit position.
  const oldLineAt: Array<number> = [];
  const newLineAt: Array<number> = [];
  let oln = 1;
  let nln = 1;
  for (let i = 0; i < edits.length; i++) {
    oldLineAt.push(oln);
    newLineAt.push(nln);
    const kind = edits[i]!.kind;
    if (kind === 'equal' || kind === 'delete') {
      oln++;
    }
    if (kind === 'equal' || kind === 'insert') {
      nln++;
    }
  }
  const totalOldLines = oln - 1;
  const totalNewLines = nln - 1;

  // Format each hunk.
  const output: Array<string> = [];
  for (const [start, end] of hunkRanges) {
    const hunkEdits = edits.slice(start, end);
    const oldStart = oldLineAt[start]!;
    const newStart = newLineAt[start]!;
    let oldCount = 0;
    let newCount = 0;
    const body: Array<string> = [];

    for (let i = 0; i < hunkEdits.length; i++) {
      const edit = hunkEdits[i]!;
      if (edit.kind === 'equal') {
        body.push(` ${edit.line}`);
        oldCount++;
        newCount++;
        // Check for no-newline marker on the last line of both files.
        if (
          oldLineAt[start + i]! === totalOldLines &&
          newLineAt[start + i]! === totalNewLines &&
          !leftEndsWithNewline &&
          !rightEndsWithNewline
        ) {
          body.push(String.raw`\ No newline at end of file`);
        }
      } else if (edit.kind === 'delete') {
        body.push(`-${edit.line}`);
        oldCount++;
        // No-newline marker for last old line.
        if (oldLineAt[start + i]! === totalOldLines && !leftEndsWithNewline) {
          body.push(String.raw`\ No newline at end of file`);
        }
      } else {
        body.push(`+${edit.line}`);
        newCount++;
        // No-newline marker for last new line.
        if (newLineAt[start + i]! === totalNewLines && !rightEndsWithNewline) {
          body.push(String.raw`\ No newline at end of file`);
        }
      }
    }

    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    output.push(...body);
  }

  return output.join('\n') + '\n';
};

/**
 * Compute a localized unified diff between two file contents.
 * Returns `{ patchBody, incomplete }`.
 * `incomplete` is true when the edit distance exceeds the bounded cap,
 * in which case `patchBody` is empty and the caller should fall back.
 */
export const computeLineDiff = (
  left: string,
  right: string,
  contextLines = 3,
): { incomplete: boolean; patchBody: string } => {
  if (left === right) {
    return { incomplete: false, patchBody: '' };
  }

  const leftLines = left.length === 0 ? [] : left.replace(/\n$/, '').split('\n');
  const rightLines = right.length === 0 ? [] : right.replace(/\n$/, '').split('\n');

  const editScript = myersEditScript(leftLines, rightLines);
  if (!editScript) {
    return { incomplete: true, patchBody: '' };
  }

  const leftEndsWithNewline = left.length > 0 && left.endsWith('\n');
  const rightEndsWithNewline = right.length > 0 && right.endsWith('\n');
  const patchBody = formatUnifiedHunks(
    editScript,
    leftEndsWithNewline,
    rightEndsWithNewline,
    contextLines,
  );

  return { incomplete: false, patchBody };
};

// === Bounded concurrency pool ===

const poolMap = async <T>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> => {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      signal?.throwIfAborted();
      const index = nextIndex++;
      await fn(items[index]!);
      signal?.throwIfAborted();
    }
  };
  signal?.throwIfAborted();
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  signal?.throwIfAborted();
};

const replayBlobReadConcurrency = 8;

export type ReplayCompareEndpoint = {
  baseSha: GitSha;
  createdAt: string;
  headSha: GitSha;
  label: string;
  versionId: ReviewVersionId;
};

export type ReplayCompareRange = {
  from: ReplayCompareEndpoint;
  paths?: ReadonlyArray<string>;
  to: ReplayCompareEndpoint;
};

export type ReplayCompareHunkClass =
  | 'comment-anchored'
  | 'conflict-resolution'
  | 'incomplete'
  | 'intentional'
  | 'rebase-noise';

export type ReplayCompareFile = {
  classes: ReadonlyArray<ReplayCompareHunkClass>;
  file: ChangedFile;
  oldPath?: string;
  path: string;
  projection?: RegionReplayFileProjection;
  relatedCommentIds: ReadonlyArray<string>;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'unchanged-noise';
};

export type ReplayBaseRef = {
  committedAt: string | null;
  sha: GitSha;
  shortSha: string;
  webUrl?: string;
};

export type ReplayBaseMovementCommit = {
  authoredAt: string;
  authorName: string;
  sha: GitSha;
  shortSha: string;
  subject: string;
  webUrl: string;
};

export type ReplayBaseMovement = {
  changed: boolean;
  commits: ReadonlyArray<ReplayBaseMovementCommit>;
  commitsBetween: number | null;
  commitTimestampDeltaMs: number | null;
  diffStat: {
    additions: number;
    deletions: number;
    filesChanged: number;
  } | null;
  from: ReplayBaseRef;
  relationship: 'forward' | 'backward' | 'divergent' | 'unknown';
  to: ReplayBaseRef;
  truncated: boolean;
  warning?: string;
};

export type ReplayCompareResult = {
  algorithm: 'region-aware-replay';
  baseMovement?: ReplayBaseMovement;
  commentAssociations: ReadonlyArray<{
    commentId: string;
    filePath?: string;
    status: 'newly-anchored' | 'outdated' | 'resolved-by-change' | 'still-valid';
  }>;
  files: ReadonlyArray<ReplayCompareFile>;
  range: ReplayCompareRange;
  summary: {
    addedLines: number;
    baseMoved: boolean;
    commentsAffected: number;
    conflictFiles: number;
    deletedLines: number;
    empty: boolean;
    filesChanged: number;
    intentionalFiles: number;
    noiseFiles: number;
  };
  warnings?: ReadonlyArray<string>;
};

/**
 * Host-observable work performed by one exact regional replay. This is a
 * diagnostic side channel: it never enters the cached comparison result or
 * changes how missing evidence is represented.
 */
export type ReplayCompareDiagnostics = {
  artifactOnlyPairCount: number;
  elapsedMs: number;
  evidence: {
    elapsedMs: number;
    requested: number;
    resolved: number;
    unavailable: number;
  };
  projection: {
    attemptedPairs: number;
    conflictRegions: number;
    elapsedMs: number;
    incompleteRegions: number;
    renderedFiles: number;
    replayCleanRegions: number;
  };
};

const getVersionCompareLineStats = (files: ReadonlyArray<ReplayCompareFile>) => {
  let addedLines = 0;
  let deletedLines = 0;
  for (const file of files) {
    for (const section of file.file.sections) {
      for (const line of section.patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          addedLines += 1;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          deletedLines += 1;
        }
      }
    }
  }
  return { addedLines, deletedLines };
};

export type ReplayPatchFile = {
  /**
   * Complete artifacts can sometimes prove a one-sided file's entire text
   * directly from its patch, avoiding an otherwise unnecessary blob read.
   */
  coverage?: 'complete' | 'opaque' | 'truncated';
  /** Immutable final-side blob identity when the Artifact Source supplied it. */
  newObjectId?: string;
  newPath: string;
  /** Immutable initial-side blob identity when the Artifact Source supplied it. */
  oldObjectId?: string;
  oldPath: string;
  patchBody: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
};

/**
 * One trusted four-endpoint path identity. A patch's old path identifies its
 * base-side file and its new path identifies its head-side file; an added or
 * deleted patch deliberately has only one such endpoint. Pairing those
 * explicit endpoints lets a later rename stay one regional projection instead
 * of degrading into two unrelated incomplete files.
 */
type ReplayPathPair = {
  aliases: ReadonlyArray<string>;
  from: ReplayPatchFile | null;
  path: string;
  to: ReplayPatchFile | null;
};

export type ReplayCommentAnchor = {
  commentId: string;
  filePath: string;
  lineNumber?: number;
  position: {
    baseSha: GitSha;
    headSha: GitSha;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const comparisonDiffRange = (from: ReplayCompareEndpoint, to: ReplayCompareEndpoint) => ({
  base: {
    kind: 'commit' as const,
    label: { kind: 'version' as const, text: from.label },
    sha: from.headSha,
  },
  head: {
    kind: 'commit' as const,
    label: { kind: 'version' as const, text: to.label },
    sha: to.headSha,
  },
});

const createChangedFile = (
  path: string,
  oldPath: string | undefined,
  status: ChangedFile['status'],
  patchBody: string,
  headSha: string,
  range: ReturnType<typeof comparisonDiffRange>,
  kind: 'version-compare' | 'conflict' = 'version-compare',
): ChangedFile => {
  const sectionId = `${path}:commit:version-compare`;
  const headerOld = status === 'added' ? '/dev/null' : `a/${oldPath ?? path}`;
  const headerNew = status === 'deleted' ? '/dev/null' : `b/${path}`;
  const patch = `diff --git a/${oldPath ?? path} b/${path}\n--- ${headerOld}\n+++ ${headerNew}\n${patchBody}${
    patchBody.endsWith('\n') ? '' : '\n'
  }`;
  return {
    fingerprint: `${headSha}:${kind}:${status}:${oldPath ?? path}:${path}:${patch.length}`,
    ...(oldPath && oldPath !== path ? { oldPath } : {}),
    path,
    sections: [
      {
        binary: false,
        id: sectionId,
        kind: 'commit',
        loadState: 'ready',
        patch,
        range,
      },
    ],
    status,
  };
};

const classifyCommentAssociations = (
  comments: ReadonlyArray<ReplayCommentAnchor>,
  intentionalPaths: ReadonlySet<string>,
  from: ReplayCompareEndpoint,
  to: ReplayCompareEndpoint,
  addressedCommentIds: ReadonlySet<string> = new Set(),
) =>
  comments.map((comment) => {
    const onFrom =
      comment.position.headSha === from.headSha || comment.position.baseSha === from.baseSha;
    const pathTouched = intentionalPaths.has(comment.filePath);
    if (!onFrom) {
      return {
        commentId: comment.commentId,
        filePath: comment.filePath,
        status: pathTouched ? ('newly-anchored' as const) : ('still-valid' as const),
      };
    }
    if (addressedCommentIds.has(comment.commentId)) {
      return {
        commentId: comment.commentId,
        filePath: comment.filePath,
        status: 'resolved-by-change' as const,
      };
    }
    if (pathTouched) {
      return {
        commentId: comment.commentId,
        filePath: comment.filePath,
        status: 'outdated' as const,
      };
    }
    if (comment.position.headSha === to.headSha) {
      return {
        commentId: comment.commentId,
        filePath: comment.filePath,
        status: 'still-valid' as const,
      };
    }
    return {
      commentId: comment.commentId,
      filePath: comment.filePath,
      status: 'still-valid' as const,
    };
  });

export const replayCompareAlgorithmVersion = regionAwareReplayAlgorithmVersion;

export type BlobLookup = (path: string, ref: string) => Promise<string | null> | string | null;

/**
 * One immutable endpoint whose contents may be needed for regional replay.
 * `ref` is deliberately an endpoint SHA rather than an Artifact object ID:
 * callers can first use object IDs carried by their Range Artifacts, then
 * resolve only the remaining endpoint paths in one bounded operation.
 */
export type ReplayBlobRequest = {
  path: string;
  ref: string;
};

export type ReplayBlobBatchLookup = (
  requests: ReadonlyArray<ReplayBlobRequest>,
) => Promise<ReadonlyMap<string, string | null>> | ReadonlyMap<string, string | null>;

export const replayBlobRequestKey = ({ path, ref }: ReplayBlobRequest) => `${ref}:${path}`;

const beforePath = (file: ReplayPatchFile) => (file.status === 'added' ? null : file.oldPath);

const afterPath = (file: ReplayPatchFile) => (file.status === 'deleted' ? null : file.newPath);

const pairAliases = (from: ReplayPatchFile | null, to: ReplayPatchFile | null) =>
  [from?.oldPath, from?.newPath, to?.oldPath, to?.newPath].filter((path): path is string =>
    Boolean(path),
  );

const replayPairPath = (from: ReplayPatchFile | null, to: ReplayPatchFile | null) => {
  const file = to ?? from;
  if (!file) {
    throw new Error('A replay path pair requires at least one patch file.');
  }
  return afterPath(file) ?? beforePath(file) ?? file.newPath;
};

const uniqueMutualMatches = (
  fromFiles: ReadonlyArray<ReplayPatchFile>,
  toFiles: ReadonlyArray<ReplayPatchFile>,
  unmatchedFrom: ReadonlySet<number>,
  unmatchedTo: ReadonlySet<number>,
  matches: (from: ReplayPatchFile, to: ReplayPatchFile) => boolean,
) => {
  const pairs: Array<readonly [number, number]> = [];
  for (const toIndex of unmatchedTo) {
    const to = toFiles[toIndex]!;
    const fromCandidates = [...unmatchedFrom].filter((fromIndex) =>
      matches(fromFiles[fromIndex]!, to),
    );
    if (fromCandidates.length !== 1) {
      continue;
    }
    const fromIndex = fromCandidates[0]!;
    const toCandidates = [...unmatchedTo].filter((candidateToIndex) =>
      matches(fromFiles[fromIndex]!, toFiles[candidateToIndex]!),
    );
    if (toCandidates.length === 1) {
      pairs.push([fromIndex, toIndex]);
    }
  }
  return pairs;
};

/**
 * Pair version patch files only through paths explicitly named by the patches.
 * The primary relation is H0's path equaling B1's path. The fallback relations
 * cover two independently renamed versions that retain a common base-side or
 * head-side path. Every phase requires a unique mutual match, so an ambiguous
 * add/delete shape remains separate rather than inventing file identity.
 */
const pairReplayPatchFiles = (
  fromFiles: ReadonlyArray<ReplayPatchFile>,
  toFiles: ReadonlyArray<ReplayPatchFile>,
) => {
  const unmatchedFrom = new Set(fromFiles.map((_, index) => index));
  const unmatchedTo = new Set(toFiles.map((_, index) => index));
  const pairs: Array<ReplayPathPair> = [];
  const pairMatches = (matches: (from: ReplayPatchFile, to: ReplayPatchFile) => boolean) => {
    for (const [fromIndex, toIndex] of uniqueMutualMatches(
      fromFiles,
      toFiles,
      unmatchedFrom,
      unmatchedTo,
      matches,
    )) {
      if (!unmatchedFrom.delete(fromIndex) || !unmatchedTo.delete(toIndex)) {
        continue;
      }
      const from = fromFiles[fromIndex]!;
      const to = toFiles[toIndex]!;
      pairs.push({ aliases: pairAliases(from, to), from, path: replayPairPath(from, to), to });
    }
  };

  pairMatches((from, to) => {
    const fromAfter = afterPath(from);
    const toBefore = beforePath(to);
    return fromAfter != null && fromAfter === toBefore;
  });
  pairMatches((from, to) => {
    const fromBefore = beforePath(from);
    const toBefore = beforePath(to);
    return fromBefore != null && fromBefore === toBefore;
  });
  pairMatches((from, to) => {
    const fromAfter = afterPath(from);
    const toAfter = afterPath(to);
    return fromAfter != null && fromAfter === toAfter;
  });

  for (const fromIndex of unmatchedFrom) {
    const from = fromFiles[fromIndex]!;
    pairs.push({
      aliases: pairAliases(from, null),
      from,
      path: replayPairPath(from, null),
      to: null,
    });
  }
  for (const toIndex of unmatchedTo) {
    const to = toFiles[toIndex]!;
    pairs.push({ aliases: pairAliases(null, to), from: null, path: replayPairPath(null, to), to });
  }

  return pairs.toSorted(
    (first, second) =>
      first.path.localeCompare(second.path) ||
      first.aliases.join('\0').localeCompare(second.aliases.join('\0')),
  );
};

const selectReplayPathPairs = ({
  comments = [],
  fromFiles,
  paths,
  toFiles,
}: {
  comments?: ReadonlyArray<ReplayCommentAnchor>;
  fromFiles: ReadonlyArray<ReplayPatchFile>;
  paths?: ReadonlyArray<string>;
  toFiles: ReadonlyArray<ReplayPatchFile>;
}) => {
  const pairs = pairReplayPatchFiles(fromFiles, toFiles);
  if (paths?.length) {
    const requestedPaths = new Set(paths);
    const selectedPairs = pairs.filter((pair) =>
      pair.aliases.some((path) => requestedPaths.has(path)),
    );
    const selectedAliases = new Set(selectedPairs.flatMap((pair) => pair.aliases));
    const explicitOnlyPairs = [...requestedPaths]
      .filter((path) => !selectedAliases.has(path))
      .map(
        (path): ReplayPathPair => ({
          aliases: [path],
          from: null,
          path,
          to: null,
        }),
      );
    return [...selectedPairs, ...explicitOnlyPairs].toSorted((first, second) =>
      first.path.localeCompare(second.path),
    );
  }
  const knownPaths = new Set(pairs.flatMap((pair) => pair.aliases));
  const commentOnlyPairs = [...new Set(comments.map((comment) => comment.filePath))]
    .filter((path) => !knownPaths.has(path))
    .map(
      (path): ReplayPathPair => ({
        aliases: [path],
        from: null,
        path,
        to: null,
      }),
    );
  return [...pairs, ...commentOnlyPairs].toSorted((first, second) =>
    first.path.localeCompare(second.path),
  );
};

const regionalEndpointPaths = (
  fromFile: ReplayPatchFile | null,
  path: string,
  toFile: ReplayPatchFile | null,
) => ({
  earlierBasePath: fromFile?.oldPath ?? toFile?.oldPath ?? path,
  earlierHeadPath: fromFile?.newPath ?? fromFile?.oldPath ?? path,
  laterBasePath: toFile?.oldPath ?? fromFile?.oldPath ?? path,
  laterHeadPath: toFile?.newPath ?? toFile?.oldPath ?? path,
});

type OneSidedPatchSide = 'old' | 'new';

/**
 * A complete added or deleted file has no unchanged side, so its one unified
 * hunk describes the full extant endpoint. Do not generalize this to modified
 * files: their omitted context would make reconstruction unsound.
 */
const completeOneSidedPatchContent = (patchBody: string, side: OneSidedPatchSide) => {
  const lines = (patchBody.endsWith('\n') ? patchBody.slice(0, -1) : patchBody).split('\n');
  let hunk: { newCount: number; newStart: number; oldCount: number; oldStart: number } | undefined;
  let endsWithNewline = true;
  const content: Array<string> = [];

  for (const line of lines) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/);
    if (header) {
      if (hunk) {
        return undefined;
      }
      hunk = {
        newCount: Number(header[4] ?? '1'),
        newStart: Number(header[3]),
        oldCount: Number(header[2] ?? '1'),
        oldStart: Number(header[1]),
      };
      continue;
    }
    if (!hunk) {
      return undefined;
    }
    if (line === String.raw`\ No newline at end of file`) {
      endsWithNewline = false;
      continue;
    }
    const expectedPrefix = side === 'new' ? '+' : '-';
    if (!line.startsWith(expectedPrefix)) {
      return undefined;
    }
    content.push(line.slice(1));
  }

  if (!hunk) {
    return undefined;
  }
  const isComplete =
    side === 'new'
      ? hunk.oldStart === 0 &&
        hunk.oldCount === 0 &&
        hunk.newStart === 1 &&
        hunk.newCount === content.length
      : hunk.newStart === 0 &&
        hunk.newCount === 0 &&
        hunk.oldStart === 1 &&
        hunk.oldCount === content.length;
  if (!isComplete) {
    return undefined;
  }
  return `${content.join('\n')}${endsWithNewline ? '\n' : ''}`;
};

const oneSidedArtifactContent = (file: ReplayPatchFile | null, side: OneSidedPatchSide) => {
  if (
    file?.coverage !== 'complete' ||
    (side === 'new' ? file.status !== 'added' : file.status !== 'deleted')
  ) {
    return undefined;
  }
  return completeOneSidedPatchContent(file.patchBody, side);
};

const regionalArtifactContents = (
  fromFile: ReplayPatchFile | null,
  toFile: ReplayPatchFile | null,
) => ({
  earlierBase: oneSidedArtifactContent(fromFile, 'old'),
  earlierHead: oneSidedArtifactContent(fromFile, 'new'),
  laterBase: oneSidedArtifactContent(toFile, 'old'),
  laterHead: oneSidedArtifactContent(toFile, 'new'),
});

const isReadableArtifactObjectId = (objectId: string | undefined) =>
  objectId != null && objectId.length > 0 && !/^0+$/.test(objectId);

/**
 * A complete artifact can also prove that a modified file has no
 * reviewer-visible final-content change without materializing either blob.
 * Git object IDs identify the full file bytes, so equal H0/H1 IDs are exact
 * evidence; unlike a patch hunk, they do not rely on omitted context. Keep
 * this deliberately narrow: one-sided files use their separately verified
 * patch reconstruction, while incomplete artifacts still request evidence.
 */
const hasArtifactOnlyUnchangedFinalContent = (pair: ReplayPathPair) => {
  const from = pair.from;
  const to = pair.to;
  return (
    from?.coverage === 'complete' &&
    to?.coverage === 'complete' &&
    (from.status === 'modified' || from.status === 'renamed') &&
    (to.status === 'modified' || to.status === 'renamed') &&
    isReadableArtifactObjectId(from.newObjectId) &&
    from.newObjectId === to.newObjectId
  );
};

const collectReplayBlobRequests = ({
  from,
  pairs,
  to,
}: {
  from: ReplayCompareEndpoint;
  pairs: ReadonlyArray<ReplayPathPair>;
  to: ReplayCompareEndpoint;
}) => {
  const requests = new Map<string, ReplayBlobRequest>();
  const add = (path: string, ref: string, knownAbsent: boolean, knownContent?: string) => {
    if (knownAbsent || knownContent !== undefined) {
      return;
    }
    const request = { path, ref };
    requests.set(replayBlobRequestKey(request), request);
  };

  for (const pair of pairs) {
    const endpointPaths = regionalEndpointPaths(pair.from, pair.path, pair.to);
    const artifactContents = regionalArtifactContents(pair.from, pair.to);
    add(
      endpointPaths.earlierBasePath,
      from.baseSha,
      pair.from?.status === 'added',
      artifactContents.earlierBase,
    );
    add(
      endpointPaths.earlierHeadPath,
      from.headSha,
      pair.from?.status === 'deleted',
      artifactContents.earlierHead,
    );
    add(
      endpointPaths.laterBasePath,
      to.baseSha,
      pair.to?.status === 'added',
      artifactContents.laterBase,
    );
    add(
      endpointPaths.laterHeadPath,
      to.headSha,
      pair.to?.status === 'deleted',
      artifactContents.laterHead,
    );
  }
  return [...requests.values()];
};

/**
 * Resolve one proof-triggered replay evidence batch. Hosts with an Artifact
 * Source provide `readBlobs`; the compatibility path still preserves the
 * batch boundary by deduplicating and bounding its individual reads here.
 * Missing or failed entries remain unavailable evidence rather than causing a
 * per-projection fallback later in the render pipeline.
 */
const readReplayBlobBatch = async ({
  readBlob,
  readBlobs,
  requests,
  signal,
}: {
  readBlob: BlobLookup;
  readBlobs?: ReplayBlobBatchLookup;
  requests: ReadonlyArray<ReplayBlobRequest>;
  signal?: AbortSignal;
}): Promise<ReadonlyMap<string, string | null>> => {
  signal?.throwIfAborted();
  if (requests.length === 0) {
    return new Map();
  }
  if (readBlobs) {
    try {
      const blobs = await readBlobs(requests);
      signal?.throwIfAborted();
      return blobs;
    } catch {
      signal?.throwIfAborted();
      // A batch failure is endpoint evidence that remains unavailable, not a
      // reason to substitute the legacy direct-head comparison.
      return new Map();
    }
  }

  const results = new Map<string, string | null>();
  await poolMap(
    requests,
    replayBlobReadConcurrency,
    async (request) => {
      signal?.throwIfAborted();
      const key = replayBlobRequestKey(request);
      try {
        results.set(key, (await readBlob(request.path, request.ref)) ?? null);
      } catch {
        signal?.throwIfAborted();
        results.set(key, null);
      }
    },
    signal,
  );
  signal?.throwIfAborted();
  return results;
};

const offsetHunkStart = (start: string, count: string | undefined, offset: number) => {
  const parsedStart = Number(start);
  return parsedStart === 0 && Number(count ?? 1) === 0 ? offset : parsedStart + offset;
};

const offsetUnifiedHunks = (patchBody: string, oldOffset: number, newOffset: number) =>
  patchBody.replaceAll(
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/gm,
    (_header, oldStart, oldCount, newStart, newCount, suffix) => {
      return `@@ -${offsetHunkStart(oldStart, oldCount, oldOffset)}${
        oldCount == null ? '' : `,${oldCount}`
      } +${offsetHunkStart(newStart, newCount, newOffset)}${
        newCount == null ? '' : `,${newCount}`
      } @@${suffix}`;
    },
  );

/** Render an unchanged projection region without inventing a code change. */
const regionalContextHunk = (left: RegionReplayText, right: RegionReplayText) => {
  if (left.content !== right.content || left.content.length === 0) {
    return '';
  }
  const endsWithNewline = left.content.endsWith('\n');
  const lines = (endsWithNewline ? left.content.slice(0, -1) : left.content).split('\n');
  if (lines.length === 0) {
    return '';
  }
  const output = [
    `@@ -${left.range.start + 1},${lines.length} +${right.range.start + 1},${lines.length} @@`,
    ...lines.map((line) => ` ${line}`),
  ];
  if (!endsWithNewline) {
    output.push(String.raw`\ No newline at end of file`);
  }
  return `${output.join('\n')}\n`;
};

const regionalPatchBody = (projection: RegionReplayFileProjection) => {
  const patches: Array<string> = [];
  let hasConflict = false;
  let incomplete = false;
  let intentional = false;
  for (const region of projection.regions) {
    if (region.kind === 'incomplete') {
      incomplete = true;
      continue;
    }
    const left = region.kind === 'replay-clean' ? region.expectedReplay : region.laterBase;
    const right = region.laterHead;
    const diff = computeLineDiff(left.content, right.content);
    if (diff.incomplete) {
      incomplete = true;
      continue;
    }
    if (region.kind === 'replay-conflict') {
      hasConflict = true;
    }
    if (diff.patchBody) {
      intentional = true;
      patches.push(offsetUnifiedHunks(diff.patchBody, left.range.start, right.range.start));
    } else {
      // A region with equal endpoints is still part of the direct projection.
      // Retaining it as a context hunk keeps the rendered file in source order
      // and gives every visible region its own source/provenance label without
      // treating target-base movement as an authored change.
      const contextHunk = regionalContextHunk(left, right);
      if (contextHunk) {
        patches.push(contextHunk);
      }
    }
  }
  // A file-level annotation still needs a visible Pierre diff item. An empty
  // hunk preserves the absence of synthetic code while giving an incomplete
  // regional projection its required line-zero slot.
  const patchBody = patches.length > 0 ? patches.join('') : incomplete ? '@@ -0,0 +0,0 @@\n' : '';
  return { hasConflict, incomplete, intentional, patchBody };
};

const regionalFileStatus = (
  fromFile: ReplayPatchFile | null,
  toFile: ReplayPatchFile | null,
): ReplayCompareFile['status'] => {
  if (toFile) {
    return toFile.status;
  }
  if (fromFile?.status === 'added') {
    return 'deleted';
  }
  return fromFile?.status ?? 'modified';
};

const regionalOldPath = (
  path: string,
  fromFile: ReplayPatchFile | null,
  toFile: ReplayPatchFile | null,
) => {
  const oldPath = fromFile?.oldPath ?? toFile?.oldPath;
  return oldPath && oldPath !== path ? oldPath : undefined;
};

const regionalFileFromProjection = ({
  comments,
  from,
  fromFile,
  projection,
  relatedPaths,
  to,
  toFile,
}: {
  comments: ReadonlyArray<ReplayCommentAnchor>;
  from: ReplayCompareEndpoint;
  fromFile: ReplayPatchFile | null;
  projection: RegionReplayFileProjection;
  relatedPaths: ReadonlyArray<string>;
  to: ReplayCompareEndpoint;
  toFile: ReplayPatchFile | null;
}): ReplayCompareFile | null => {
  const rendered = regionalPatchBody(projection);
  if (!rendered.intentional && !rendered.hasConflict && !rendered.incomplete) {
    return null;
  }
  const oldPath = regionalOldPath(projection.path, fromFile, toFile);
  const status = regionalFileStatus(fromFile, toFile);
  const changedFileStatus = status === 'unchanged-noise' ? 'modified' : status;
  const classes: Array<ReplayCompareHunkClass> = [];
  if (rendered.incomplete) {
    classes.push('incomplete');
  }
  if (rendered.hasConflict) {
    classes.push('conflict-resolution');
  }
  if (rendered.intentional) {
    classes.push('intentional');
  }
  return {
    classes,
    file: {
      ...createChangedFile(
        projection.path,
        oldPath,
        changedFileStatus,
        rendered.patchBody,
        to.headSha,
        comparisonDiffRange(from, to),
        rendered.hasConflict || rendered.incomplete ? 'conflict' : 'version-compare',
      ),
      regionalReplay: projection,
    },
    ...(oldPath ? { oldPath } : {}),
    path: projection.path,
    projection,
    relatedCommentIds: comments
      .filter((comment) => relatedPaths.includes(comment.filePath))
      .map((comment) => comment.commentId),
    status,
  };
};

const endpointContent = async ({
  artifactContent,
  knownAbsent,
  path,
  readBlob,
  ref,
}: {
  artifactContent?: string;
  knownAbsent: boolean;
  path: string;
  readBlob: BlobLookup;
  ref: string;
}): Promise<string | null | undefined> => {
  if (knownAbsent) {
    return null;
  }
  if (artifactContent !== undefined) {
    return artifactContent;
  }
  try {
    const content = await readBlob(path, ref);
    return content == null ? undefined : content;
  } catch {
    return undefined;
  }
};

const projectRegionalPath = async ({
  from,
  fromFile,
  path,
  readBlob,
  signal,
  to,
  toFile,
}: {
  from: ReplayCompareEndpoint;
  fromFile: ReplayPatchFile | null;
  path: string;
  readBlob: BlobLookup;
  signal?: AbortSignal;
  to: ReplayCompareEndpoint;
  toFile: ReplayPatchFile | null;
}) => {
  signal?.throwIfAborted();
  const { earlierBasePath, earlierHeadPath, laterBasePath, laterHeadPath } = regionalEndpointPaths(
    fromFile,
    path,
    toFile,
  );
  const artifactContents = regionalArtifactContents(fromFile, toFile);
  const [earlierBase, earlierHead, laterBase, laterHead] = await Promise.all([
    endpointContent({
      artifactContent: artifactContents.earlierBase,
      knownAbsent: fromFile?.status === 'added',
      path: earlierBasePath,
      readBlob,
      ref: from.baseSha,
    }),
    endpointContent({
      artifactContent: artifactContents.earlierHead,
      knownAbsent: fromFile?.status === 'deleted',
      path: earlierHeadPath,
      readBlob,
      ref: from.headSha,
    }),
    endpointContent({
      artifactContent: artifactContents.laterBase,
      knownAbsent: toFile?.status === 'added',
      path: laterBasePath,
      readBlob,
      ref: to.baseSha,
    }),
    endpointContent({
      artifactContent: artifactContents.laterHead,
      knownAbsent: toFile?.status === 'deleted',
      path: laterHeadPath,
      readBlob,
      ref: to.headSha,
    }),
  ]);
  signal?.throwIfAborted();
  return projectRegionAwareReplay(
    {
      earlierBase,
      earlierBasePath,
      earlierHead,
      earlierHeadPath,
      laterBase,
      laterBasePath,
      laterHead,
      laterHeadPath,
      oldPath: regionalOldPath(path, fromFile, toFile),
      path,
    },
    { signal },
  );
};

const computeRegionAwareVersionCompare = async ({
  comments = [],
  from,
  fromFiles,
  now = () => globalThis.performance.now(),
  onDiagnostics,
  paths,
  readBlob,
  readBlobs,
  signal,
  to,
  toFiles,
}: {
  comments?: ReadonlyArray<ReplayCommentAnchor>;
  from: ReplayCompareEndpoint;
  fromFiles: ReadonlyArray<ReplayPatchFile>;
  /** Injectable only for deterministic diagnostics tests. */
  now?: () => number;
  /** Non-fatal host telemetry for the exact replay work performed. */
  onDiagnostics?: (diagnostics: ReplayCompareDiagnostics) => void;
  paths?: ReadonlyArray<string>;
  readBlob: BlobLookup;
  /**
   * Optional proof-triggered endpoint batch. When present, Core never falls
   * back to serial `readBlob` calls for this projection attempt.
   */
  readBlobs?: ReplayBlobBatchLookup;
  /** Superseding a comparison stops evidence and projection work. */
  signal?: AbortSignal;
  to: ReplayCompareEndpoint;
  toFiles: ReadonlyArray<ReplayPatchFile>;
}): Promise<ReplayCompareResult> => {
  signal?.throwIfAborted();
  const startedAt = now();
  const pairs = selectReplayPathPairs({ comments, fromFiles, paths, toFiles });
  // Equal complete final object IDs are a stronger proof than a patch hunk:
  // they identify all H0/H1 bytes, including any context absent from the
  // artifact patches. These pairs have no reviewer-visible final-content
  // difference, so exclude them before planning the one bounded evidence
  // batch instead of reading blobs merely to rediscover that fact.
  const unresolvedPairs = pairs.filter((pair) => !hasArtifactOnlyUnchangedFinalContent(pair));
  const requestedBlobs = collectReplayBlobRequests({
    from,
    pairs: unresolvedPairs,
    to,
  });
  const evidenceStartedAt = now();
  const suppliedBlobs = await readReplayBlobBatch({
    readBlob,
    readBlobs,
    requests: requestedBlobs,
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  const evidenceElapsedMs = Math.max(0, now() - evidenceStartedAt);
  const replayBlob: BlobLookup = (path, ref) =>
    suppliedBlobs.get(replayBlobRequestKey({ path, ref })) ?? null;
  const projections = new Map<ReplayPathPair, RegionReplayFileProjection>();
  const projectionStartedAt = now();
  // Four endpoints are read per file, so this limits raw blob reads to eight
  // concurrent operations while remaining independent of provider behavior.
  await poolMap(
    unresolvedPairs,
    2,
    async (pair) => {
      projections.set(
        pair,
        await projectRegionalPath({
          from,
          fromFile: pair.from,
          path: pair.path,
          readBlob: replayBlob,
          ...(signal ? { signal } : {}),
          to,
          toFile: pair.to,
        }),
      );
    },
    signal,
  );
  signal?.throwIfAborted();
  const renderedPairs = unresolvedPairs.flatMap((pair) => {
    signal?.throwIfAborted();
    const projection = projections.get(pair);
    if (!projection) {
      return [];
    }
    const file = regionalFileFromProjection({
      comments,
      from,
      fromFile: pair.from,
      projection,
      relatedPaths: pair.aliases,
      to,
      toFile: pair.to,
    });
    return file ? [{ aliases: pair.aliases, file }] : [];
  });
  const files = renderedPairs.map(({ file }) => file);
  const reviewablePaths = new Set(renderedPairs.flatMap(({ aliases }) => aliases));
  const commentAssociations = classifyCommentAssociations(comments, reviewablePaths, from, to);
  const incompleteWarnings = unresolvedPairs.flatMap((pair) => {
    const projection = projections.get(pair);
    if (!projection) {
      return [`Exact regional replay did not produce a projection for ${pair.path}.`];
    }
    return projection.regions.flatMap((region) =>
      region.kind === 'incomplete'
        ? [
            `Exact regional replay is incomplete for ${pair.path}: ${region.missingEvidence.join(
              ' ',
            )}`,
          ]
        : [],
    );
  });
  const result = {
    algorithm: 'region-aware-replay',
    commentAssociations,
    files,
    range: {
      from,
      ...(paths?.length ? { paths } : {}),
      to,
    },
    summary: {
      ...getVersionCompareLineStats(files),
      baseMoved: from.baseSha !== to.baseSha,
      commentsAffected: commentAssociations.filter((item) => item.status !== 'still-valid').length,
      conflictFiles: files.filter((file) => file.classes.includes('conflict-resolution')).length,
      empty: files.length === 0,
      filesChanged: files.length,
      intentionalFiles: files.filter((file) => file.classes.includes('intentional')).length,
      noiseFiles: 0,
    },
    ...(incompleteWarnings.length ? { warnings: incompleteWarnings } : {}),
  } satisfies ReplayCompareResult;
  const regionCounts = { conflict: 0, incomplete: 0, replayClean: 0 };
  for (const projection of projections.values()) {
    signal?.throwIfAborted();
    for (const region of projection.regions) {
      signal?.throwIfAborted();
      if (region.kind === 'replay-clean') {
        regionCounts.replayClean += 1;
      } else if (region.kind === 'replay-conflict') {
        regionCounts.conflict += 1;
      } else {
        regionCounts.incomplete += 1;
      }
    }
  }
  const resolvedEvidence = requestedBlobs.filter(
    (request) => suppliedBlobs.get(replayBlobRequestKey(request)) != null,
  ).length;
  try {
    onDiagnostics?.({
      artifactOnlyPairCount: pairs.length - unresolvedPairs.length,
      elapsedMs: Math.max(0, now() - startedAt),
      evidence: {
        elapsedMs: evidenceElapsedMs,
        requested: requestedBlobs.length,
        resolved: resolvedEvidence,
        unavailable: requestedBlobs.length - resolvedEvidence,
      },
      projection: {
        attemptedPairs: unresolvedPairs.length,
        conflictRegions: regionCounts.conflict,
        elapsedMs: Math.max(0, now() - projectionStartedAt),
        incompleteRegions: regionCounts.incomplete,
        renderedFiles: result.files.length,
        replayCleanRegions: regionCounts.replayClean,
      },
    });
  } catch {
    // Diagnostics must not interfere with the exact comparison result.
  }
  return result;
};

/**
 * Produce the reviewer-visible version comparison from exact four-endpoint
 * regional replay. Missing or non-textual evidence stays explicit in the
 * projection; this boundary never substitutes a direct-head or patch-text
 * comparison for it.
 */
export const computeVersionComparePreferringReplay = async ({
  comments = [],
  from,
  fromFiles,
  now,
  onDiagnostics,
  paths,
  readBlob,
  readBlobs,
  signal,
  to,
  toFiles,
}: {
  comments?: ReadonlyArray<ReplayCommentAnchor>;
  from: ReplayCompareEndpoint;
  fromFiles: ReadonlyArray<ReplayPatchFile>;
  now?: () => number;
  onDiagnostics?: (diagnostics: ReplayCompareDiagnostics) => void;
  paths?: ReadonlyArray<string>;
  readBlob: BlobLookup;
  readBlobs?: ReplayBlobBatchLookup;
  signal?: AbortSignal;
  to: ReplayCompareEndpoint;
  toFiles: ReadonlyArray<ReplayPatchFile>;
}): Promise<ReplayCompareResult> =>
  computeRegionAwareVersionCompare({
    comments,
    from,
    fromFiles,
    ...(now ? { now } : {}),
    ...(onDiagnostics ? { onDiagnostics } : {}),
    paths,
    readBlob,
    readBlobs,
    ...(signal ? { signal } : {}),
    to,
    toFiles,
  });

export const isReplayCompareEndpoint = (value: unknown): value is ReplayCompareEndpoint => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.versionId === 'string' &&
    typeof value.baseSha === 'string' &&
    typeof value.headSha === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.label === 'string'
  );
};
