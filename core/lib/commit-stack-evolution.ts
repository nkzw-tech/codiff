/**
 * Forge-neutral commit-stack evolution: completeness-aware fingerprints + matching.
 *
 * Used by GitLab MR versions and GitHub force-push head comparisons so both
 * forges share one pairing algorithm.
 */
import type {
  ChangedFile,
  EvolutionUnitId,
  GitSha,
  ReviewCommitEvolution,
  ReviewCommitSummary,
  ReviewEvolutionUnit,
  ReviewVersionId,
  VersionComparisonReviewStructure,
} from '../types.ts';
import { sha256 } from './crypto.ts';
import type {
  ArtifactCoverage,
  ArtifactFile,
  CommitArtifact,
  ReviewArtifactProvenance,
} from './review-artifacts.ts';
import { validateReviewCommitStack } from './review-commit-stack.ts';

export const versionCommitFingerprintAlgorithmVersion = 'commit-fingerprint-v4';
/**
 * The matcher is a clean-room dense shortest-augmenting-path implementation
 * of the Jonker-Volgenant linear-assignment shape used by Git range-diff.
 *
 * It deliberately has its own version from the compact fingerprint. Changing
 * either the canonical patch material or the ambiguity policy invalidates only
 * derived Evolution Results, never immutable Commit Artifacts.
 */
export const versionCommitEvolutionAlgorithmVersion = 'range-diff-lap-jv-v2';
export const versionCommitStackLimit = 40;
export const versionCommitEvidenceConcurrency = 8;

export type VersionCommitMatchKind =
  | 'retained'
  | 'rewritten-same-patch'
  | 'likely-revised'
  | 'absorbed-into-base'
  | 'added'
  | 'removed'
  | 'ambiguous';

export type VersionCommitSummary = {
  authoredAt: string;
  authorName: string;
  diffStat?: {
    additions: number;
    deletions: number;
    filesChanged: number;
  };
  parentShas: ReadonlyArray<GitSha>;
  sha: GitSha;
  shortSha: string;
  subject: string;
  webUrl: string;
};

/** Compact provider-neutral input consumed by the pure matcher. */
export type CommitFingerprint = {
  additions: number;
  changedPaths: ReadonlyArray<string>;
  changeTokenSketch: ReadonlyArray<string>;
  commitSha: GitSha;
  coverage: ArtifactCoverage;
  deletions: number;
  /** Present only when all changed files have sufficient exact evidence. */
  exactChangeId?: string;
  filesChanged: number;
  /**
   * Complete, provider-neutral patch material retained from the immutable
   * Commit Artifact. The global matcher combines this with commit metadata and
   * computes its cost from a three-context-line diff-of-diffs. Older synthetic
   * callers may omit it; production Artifact Sources always populate it.
   */
  patchMaterial?: string;
  subjectKey: string;
};

export type VersionRebaseOverlapCommit = {
  authoredAt: string;
  authorName: string;
  /** Paths this base commit shares with the revised MR commit interdiff. */
  overlappingPaths: ReadonlyArray<string>;
  sha: GitSha;
  shortSha: string;
  subject: string;
  webUrl: string;
};

export type VersionCommitEvolutionUnit = {
  after?: VersionCommitSummary;
  baseCommit?: VersionCommitSummary;
  before?: VersionCommitSummary;
  confidence: 'exact' | 'high' | 'unmatched';
  kind: VersionCommitMatchKind;
  matchReasons?: ReadonlyArray<string>;
  matchScore?: number;
  order: number;
  /**
   * Base-branch commits that likely forced this commit rewrite during rebase.
   * Present only for revised units when base movement can be attributed.
   */
  rebaseOverlaps?: ReadonlyArray<VersionRebaseOverlapCommit>;
  reviewable: boolean;
  unitId: EvolutionUnitId;
};

/** Minimal endpoint identity needed for evolution range bookkeeping. */
export type DiffEndpointRef = {
  baseSha: GitSha;
  createdAt?: string;
  headSha: GitSha;
  label?: string;
  startSha?: GitSha;
  versionId?: ReviewVersionId;
};

export type CommitStackEvolutionRange = {
  from: DiffEndpointRef;
  paths?: ReadonlyArray<string>;
  to: DiffEndpointRef;
};

export type CommitStackEvolution = {
  range: CommitStackEvolutionRange;
  recommendation: {
    reason: string;
    structure: VersionComparisonReviewStructure;
  };
  summary: {
    absorbedIntoBase: number;
    added: number;
    ambiguous: number;
    completeCoverage: boolean;
    pairingCoverage: number;
    removed: number;
    retained: number;
    reviewable: number;
    revised: number;
    rewrittenSamePatch: number;
    unreviewableAmbiguous: number;
  };
  units: ReadonlyArray<VersionCommitEvolutionUnit>;
  warnings?: ReadonlyArray<string>;
};

/**
 * Host-observable work performed by one global commit-stack match. This is a
 * diagnostic side channel: it never enters an Evolution Result or its cache
 * identity, and it cannot affect the selected assignment.
 */
export type CommitAssignmentDiagnostics = {
  ambiguityCount: number;
  ambiguityElapsedMs: number;
  assignmentCost: number;
  candidatePairCount: number;
  costMatrixElapsedMs: number;
  matrixColumns: number;
  matrixRows: number;
  solveElapsedMs: number;
};

export type CommitStackMatchDiagnostics = {
  ambiguousUnitCount: number;
  elapsedMs: number;
  primaryAssignment: CommitAssignmentDiagnostics | null;
  targetBaseAssignment: CommitAssignmentDiagnostics | null;
};

/** @deprecated Prefer CommitStackEvolution. */
export type MergeRequestVersionCommitEvolution = CommitStackEvolution;

type CommitLike = {
  authoredDate: string;
  authorName: string;
  message: string;
  parentShas: ReadonlyArray<GitSha>;
  sha: GitSha;
  shortSha: string;
  title: string;
  webUrl: string;
};

const normalizedSubject = (value: string) =>
  value
    .toLowerCase()
    .replaceAll(/^(?:fixup!|squash!|amend!)\s*/g, '')
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim();

const throwIfAborted = (signal?: AbortSignal) => signal?.throwIfAborted();

const changedLines = (patch: string) =>
  patch
    .split('\n')
    .filter(
      (line) =>
        (line.startsWith('+') || line.startsWith('-')) &&
        !line.startsWith('+++') &&
        !line.startsWith('---'),
    );

const lineCount = (files: ReadonlyArray<ArtifactFile>) => {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const line of changedLines(file.patch ?? '')) {
      if (line.startsWith('+')) {
        additions += 1;
      } else {
        deletions += 1;
      }
    }
  }
  return { additions, deletions };
};

const hasExactFileEvidence = (file: ArtifactFile) =>
  file.coverage === 'complete' &&
  (file.patch != null ||
    file.oldObjectId != null ||
    file.newObjectId != null ||
    (file.oldMode != null && file.newMode != null && file.oldMode !== file.newMode));

type CanonicalPatchChange = {
  lines: Array<string>;
  newCount: number;
  newStart: number;
  oldCount: number;
  oldStart: number;
};

const patchHunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Provider APIs may omit the native `index` line and use a different amount
 * of surrounding context. Convert each textual hunk into its changed-line
 * runs with exact endpoint coordinates, so equivalent complete changes feed
 * one matcher input regardless of which Artifact Source acquired them.
 */
const canonicalPatchChanges = (patch: string): ReadonlyArray<string> => {
  const result: Array<string> = [];
  const state: { current: CanonicalPatchChange | null } = { current: null };
  let inHunk = false;
  let newLine = 0;
  let oldLine = 0;
  const flush = () => {
    const current = state.current;
    if (!current) {
      return;
    }
    result.push(
      `@@ -${current.oldStart},${current.oldCount} +${current.newStart},${current.newCount} @@`,
      ...current.lines,
    );
    state.current = null;
  };
  const beginChange = () => {
    if (state.current) {
      return state.current;
    }
    const current = {
      lines: [],
      newCount: 0,
      newStart: newLine,
      oldCount: 0,
      oldStart: oldLine,
    };
    state.current = current;
    return current;
  };

  for (const line of patch.replaceAll('\r\n', '\n').split('\n')) {
    const header = patchHunkHeader.exec(line);
    if (header) {
      flush();
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith(' ')) {
      flush();
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (line.startsWith('-')) {
      const change = beginChange();
      change.lines.push(line);
      change.oldCount += 1;
      oldLine += 1;
      continue;
    }
    if (line.startsWith('+')) {
      const change = beginChange();
      change.lines.push(line);
      change.newCount += 1;
      newLine += 1;
      continue;
    }
    const current = state.current;
    if (line.startsWith(String.raw`\ No newline at end of file`) && current) {
      current.lines.push(String.raw`\ No newline at end of file`);
    }
  }
  flush();
  return result;
};

const hasTextualPatch = (file: ArtifactFile) => canonicalPatchChanges(file.patch ?? '').length > 0;

const canonicalFileIdentity = (file: ArtifactFile) => [
  `old-path ${file.oldPath ?? file.path}`,
  `path ${file.path}`,
  `status ${file.status}`,
];

const modeChange = (file: ArtifactFile) =>
  file.oldMode != null && file.newMode != null && file.oldMode !== file.newMode
    ? [`old-mode ${file.oldMode}`, `new-mode ${file.newMode}`]
    : [];

const normalizeArtifact = (files: ReadonlyArray<ArtifactFile>) =>
  files
    .map((file) => {
      const text = hasTextualPatch(file);
      return [
        ...canonicalFileIdentity(file),
        ...modeChange(file),
        ...(text
          ? changedLines(file.patch ?? '').map(
              (line) => `${line[0]}${line.slice(1).trim().replaceAll(/\s+/g, ' ')}`,
            )
          : [
              `old-object ${file.oldObjectId ?? ''}`,
              `new-object ${file.newObjectId ?? ''}`,
              ...(file.oldMode == null || file.newMode == null
                ? [`old-mode ${file.oldMode ?? ''}`, `new-mode ${file.newMode ?? ''}`]
                : []),
            ]),
      ].join('\n');
    })
    .toSorted()
    .join('\n--file--\n');

/**
 * Preserve the complete diff material separately from the compact fingerprint.
 * The former is the matching oracle; the latter remains useful for display,
 * cache summaries, and conservative base-overlap hints. Object/mode-only
 * changes have no textual patch, so make their exact artifact evidence
 * explicit rather than pretending that an empty patch describes them.
 */
const patchMaterialFromArtifact = (files: ReadonlyArray<ArtifactFile>) =>
  files
    .map((file) => {
      const text = canonicalPatchChanges(file.patch ?? '');
      return [
        ...canonicalFileIdentity(file),
        ...modeChange(file),
        ...(text.length > 0
          ? text
          : [`old-object ${file.oldObjectId ?? ''}`, `new-object ${file.newObjectId ?? ''}`]),
      ].join('\n');
    })
    .toSorted()
    .join('\n--file--\n');

const sketchHash = (value: string) => {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const toCommitArtifact = ({
  commitSha,
  files,
  parentSha,
  provenance,
}: {
  commitSha: GitSha;
  files: ReadonlyArray<ChangedFile>;
  parentSha: GitSha | null;
  provenance: ReviewArtifactProvenance;
}): CommitArtifact => ({
  commitSha,
  coverage: 'complete',
  files: files.map((file) => ({
    coverage: 'complete',
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    patch: file.sections.map((section) => section.patch).join('\n'),
    path: file.path,
    status: file.status,
  })),
  parentSha,
  provenance,
});

export const createCommitFingerprint = async (
  commit: Pick<CommitLike, 'sha' | 'title'>,
  artifact: CommitArtifact,
): Promise<CommitFingerprint> => {
  if (artifact.commitSha !== commit.sha) {
    throw new Error(
      `Commit Artifact ${artifact.commitSha} cannot fingerprint commit ${commit.sha}.`,
    );
  }
  const { additions, deletions } = lineCount(artifact.files);
  const tokens = artifact.files
    .flatMap((file) => changedLines(file.patch ?? ''))
    .flatMap(
      (line) =>
        line
          .slice(1)
          .toLowerCase()
          .match(/[a-z_][a-z0-9_]*|\d+|[^\s\w]/g) ?? [],
    )
    .map(sketchHash);
  const coverage =
    artifact.coverage === 'truncated' ||
    artifact.files.some((file) => file.coverage === 'truncated')
      ? 'truncated'
      : artifact.coverage === 'opaque' || artifact.files.some((file) => file.coverage === 'opaque')
        ? 'opaque'
        : 'complete';
  const hasExactEvidence =
    coverage === 'complete' &&
    artifact.files.length > 0 &&
    artifact.files.every(hasExactFileEvidence);
  return {
    additions,
    changedPaths: [
      ...new Set(artifact.files.flatMap((file) => [file.oldPath, file.path]).filter(Boolean)),
    ].toSorted() as Array<string>,
    changeTokenSketch: [...new Set(tokens)].toSorted().slice(0, 128),
    commitSha: commit.sha,
    coverage,
    deletions,
    ...(hasExactEvidence ? { exactChangeId: await sha256(normalizeArtifact(artifact.files)) } : {}),
    filesChanged: artifact.files.length,
    ...(coverage === 'complete'
      ? { patchMaterial: patchMaterialFromArtifact(artifact.files) }
      : {}),
    subjectKey: normalizedSubject(commit.title),
  };
};

export const toVersionCommitSummary = (
  commit: CommitLike,
  fingerprint?: CommitFingerprint,
): VersionCommitSummary =>
  ({
    authoredAt: commit.authoredDate,
    authorName: commit.authorName,
    ...(fingerprint
      ? {
          diffStat: {
            additions: fingerprint.additions,
            deletions: fingerprint.deletions,
            filesChanged: fingerprint.filesChanged,
          },
        }
      : {}),
    parentShas: commit.parentShas,
    sha: commit.sha,
    shortSha: commit.shortSha || commit.sha.slice(0, 8),
    subject: commit.title || commit.message.split('\n')[0] || 'Commit',
    webUrl: commit.webUrl,
  }) as VersionCommitSummary;

const jaccard = (first: ReadonlyArray<string>, second: ReadonlyArray<string>) => {
  const left = new Set(first);
  const right = new Set(second);
  const union = new Set([...left, ...right]);
  if (union.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }
  return intersection / union.size;
};

// Git's range-diff uses a three-context-line diff of canonical commit patches
// as its assignment cost. This clean-room implementation deliberately keeps
// that work in Core: it uses no repository, Git executable, or forge detail.
const RANGE_DIFF_CONTEXT_LINES = 3;
const MAX_CANONICAL_PATCH_EDIT_DISTANCE = 4096;
const RANGE_DIFF_CREATION_FACTOR = 0.6;
const RANGE_DIFF_AMBIGUITY_MARGIN = 1;
const RANGE_DIFF_BASE_AMBIGUITY_MARGIN = 0;
const FORBIDDEN_ASSIGNMENT_COST = 1_000_000_000_000;

type CanonicalPatchEdit = {
  kind: 'delete' | 'equal' | 'insert';
};

type AssignmentCandidate = {
  commit: CommitLike;
  fingerprint: CommitFingerprint;
  material: string;
  patchLines: number;
};

type AssignmentSolution = {
  assignment: ReadonlyArray<number>;
  cost: number;
};

type CommitAssignment = {
  creationCosts: ReadonlyArray<number>;
  deletionCosts: ReadonlyArray<number>;
  left: ReadonlyArray<AssignmentCandidate>;
  matrix: ReadonlyArray<ReadonlyArray<number>>;
  pairCosts: ReadonlyArray<ReadonlyArray<number | null>>;
  right: ReadonlyArray<AssignmentCandidate>;
  solution: AssignmentSolution;
  timing: {
    costMatrixElapsedMs: number;
    solveElapsedMs: number;
  };
};

type AssignmentAmbiguityAudit = {
  ambiguous: ReadonlySet<string>;
  elapsedMs: number;
};

const canonicalPatchLines = (value: string) => value.replaceAll('\r\n', '\n').split('\n');

/**
 * Return the shortest line edit script or null when a pathological diff would
 * violate the matching budget. A null pair is deliberately more expensive
 * than create+delete, so complete-but-unbounded material never becomes a
 * confident fuzzy identity by accident.
 */
const canonicalPatchEditScript = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): ReadonlyArray<CanonicalPatchEdit> | null => {
  if (left.length === 0 && right.length === 0) {
    return [];
  }
  if (left.length === 0) {
    return right.map(() => ({ kind: 'insert' as const }));
  }
  if (right.length === 0) {
    return left.map(() => ({ kind: 'delete' as const }));
  }
  if (Math.abs(left.length - right.length) > MAX_CANONICAL_PATCH_EDIT_DISTANCE) {
    return null;
  }

  const maximum = Math.min(left.length + right.length, MAX_CANONICAL_PATCH_EDIT_DISTANCE);
  const offset = maximum;
  const frontier = new Int32Array(maximum * 2 + 1);
  const trace: Array<Int32Array> = [];
  let solved = false;

  for (let distance = 0; distance <= maximum; distance += 1) {
    trace.push(frontier.slice());
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
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
  const edits: Array<CanonicalPatchEdit> = [];
  for (let distance = trace.length - 1; distance > 0; distance -= 1) {
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
      edits.push({ kind: 'equal' });
    }
    edits.push({ kind: previousDiagonal === diagonal + 1 ? 'insert' : 'delete' });
    leftIndex = previousLeft;
    rightIndex = previousRight;
  }
  while (leftIndex > 0) {
    leftIndex -= 1;
    rightIndex -= 1;
    edits.push({ kind: 'equal' });
  }
  edits.reverse();
  return edits;
};

const diffOfDiffsLineCost = (first: string, second: string): number | null => {
  if (first === second) {
    return 0;
  }
  const edits = canonicalPatchEditScript(canonicalPatchLines(first), canonicalPatchLines(second));
  if (edits == null) {
    return null;
  }
  const changePositions = edits.flatMap((edit, index) => (edit.kind === 'equal' ? [] : [index]));
  if (changePositions.length === 0) {
    return 0;
  }

  let cost = 0;
  let hunkStart = Math.max(0, changePositions[0]! - RANGE_DIFF_CONTEXT_LINES);
  let hunkEnd = changePositions[0]! + 1;
  for (let index = 1; index < changePositions.length; index += 1) {
    const position = changePositions[index]!;
    if (position <= hunkEnd + RANGE_DIFF_CONTEXT_LINES * 2) {
      hunkEnd = position + 1;
      continue;
    }
    cost += 1 + Math.min(edits.length, hunkEnd + RANGE_DIFF_CONTEXT_LINES) - hunkStart;
    hunkStart = Math.max(0, position - RANGE_DIFF_CONTEXT_LINES);
    hunkEnd = position + 1;
  }
  return cost + 1 + Math.min(edits.length, hunkEnd + RANGE_DIFF_CONTEXT_LINES) - hunkStart;
};

const syntheticPatchMaterial = (fingerprint: CommitFingerprint) =>
  [
    'diff --codiff-synthetic',
    ...fingerprint.changedPaths.map((path) => `path ${path}`),
    ...fingerprint.changeTokenSketch.map((token) => `token ${token}`),
    `additions ${fingerprint.additions}`,
    `deletions ${fingerprint.deletions}`,
  ].join('\n');

const canonicalCommitPatchMaterial = (commit: CommitLike, fingerprint: CommitFingerprint) =>
  [
    `Author: ${commit.authorName}`,
    '',
    commit.message || commit.title,
    '',
    fingerprint.patchMaterial ?? syntheticPatchMaterial(fingerprint),
  ].join('\n');

const assignmentCandidate = (
  commit: CommitLike,
  fingerprint: CommitFingerprint | undefined,
): AssignmentCandidate | null => {
  if (!fingerprint || fingerprint.coverage !== 'complete' || commit.parentShas.length > 1) {
    return null;
  }
  const material = canonicalCommitPatchMaterial(commit, fingerprint);
  return {
    commit,
    fingerprint,
    material,
    patchLines: Math.max(1, canonicalPatchLines(material).length),
  };
};

/**
 * Clean-room dense shortest-augmenting-path linear assignment solver.
 *
 * This is the Jonker-Volgenant problem shape used by Git range-diff, expressed
 * directly with row/column potentials rather than borrowed Git code. Stable
 * row/column iteration gives deterministic output for exact ties; the caller
 * separately audits those ties instead of accepting that incidental ordering.
 */
const solveJonkerVolgenant = (
  matrix: ReadonlyArray<ReadonlyArray<number>>,
  signal?: AbortSignal,
): AssignmentSolution => {
  throwIfAborted(signal);
  const size = matrix.length;
  if (size === 0) {
    return { assignment: [], cost: 0 };
  }
  if (matrix.some((row) => row.length !== size)) {
    throw new Error('Linear assignment requires a square cost matrix.');
  }

  const rowPotential = new Float64Array(size + 1);
  const columnPotential = new Float64Array(size + 1);
  const matchedRowByColumn = new Int32Array(size + 1);
  const predecessor = new Int32Array(size + 1);

  for (let row = 1; row <= size; row += 1) {
    throwIfAborted(signal);
    matchedRowByColumn[0] = row;
    let column = 0;
    const minDistance = new Float64Array(size + 1);
    minDistance.fill(Number.POSITIVE_INFINITY);
    const used = new Uint8Array(size + 1);
    do {
      throwIfAborted(signal);
      used[column] = 1;
      const activeRow = matchedRowByColumn[column]!;
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;
      for (let candidateColumn = 1; candidateColumn <= size; candidateColumn += 1) {
        throwIfAborted(signal);
        if (used[candidateColumn]) {
          continue;
        }
        const reducedCost =
          matrix[activeRow - 1]![candidateColumn - 1]! -
          rowPotential[activeRow]! -
          columnPotential[candidateColumn]!;
        if (reducedCost < minDistance[candidateColumn]!) {
          minDistance[candidateColumn] = reducedCost;
          predecessor[candidateColumn] = column;
        }
        if (
          minDistance[candidateColumn]! < delta ||
          (minDistance[candidateColumn] === delta && candidateColumn < nextColumn)
        ) {
          delta = minDistance[candidateColumn]!;
          nextColumn = candidateColumn;
        }
      }
      if (!Number.isFinite(delta)) {
        throw new Error('Linear assignment has no finite augmenting path.');
      }
      for (let candidateColumn = 0; candidateColumn <= size; candidateColumn += 1) {
        throwIfAborted(signal);
        if (used[candidateColumn]) {
          rowPotential[matchedRowByColumn[candidateColumn]!] += delta;
          columnPotential[candidateColumn] -= delta;
        } else {
          minDistance[candidateColumn] -= delta;
        }
      }
      column = nextColumn;
    } while (matchedRowByColumn[column] !== 0);

    do {
      const previousColumn = predecessor[column]!;
      matchedRowByColumn[column] = matchedRowByColumn[previousColumn]!;
      column = previousColumn;
    } while (column !== 0);
  }

  const assignment = Array<number>(size).fill(-1);
  for (let column = 1; column <= size; column += 1) {
    throwIfAborted(signal);
    const row = matchedRowByColumn[column]!;
    if (row > 0) {
      assignment[row - 1] = column - 1;
    }
  }
  const cost = assignment.reduce((total, column, row) => total + matrix[row]![column]!, 0);
  return { assignment, cost };
};

const createCommitAssignment = (
  left: ReadonlyArray<AssignmentCandidate>,
  right: ReadonlyArray<AssignmentCandidate>,
  now?: () => number,
  signal?: AbortSignal,
): CommitAssignment => {
  throwIfAborted(signal);
  const matrixStartedAt = now?.();
  const leftCount = left.length;
  const rightCount = right.length;
  const size = leftCount + rightCount;
  const deletionCosts = left.map((candidate) => {
    throwIfAborted(signal);
    return candidate.patchLines * RANGE_DIFF_CREATION_FACTOR;
  });
  const creationCosts = right.map((candidate) => {
    throwIfAborted(signal);
    return candidate.patchLines * RANGE_DIFF_CREATION_FACTOR;
  });
  const pairCosts = left.map((before, beforeIndex) => {
    throwIfAborted(signal);
    return right.map((after, afterIndex) => {
      throwIfAborted(signal);
      const cost = diffOfDiffsLineCost(before.material, after.material);
      return cost == null ? deletionCosts[beforeIndex]! + creationCosts[afterIndex]! + 1 : cost;
    });
  });
  const matrix = Array.from({ length: size }, (_, row) => {
    throwIfAborted(signal);
    return Array.from({ length: size }, (_, column) => {
      throwIfAborted(signal);
      if (row < leftCount && column < rightCount) {
        return pairCosts[row]![column]!;
      }
      if (row < leftCount) {
        return deletionCosts[row]!;
      }
      if (column < rightCount) {
        return creationCosts[column]!;
      }
      return 0;
    });
  });
  const costMatrixElapsedMs = matrixStartedAt == null ? 0 : Math.max(0, now!() - matrixStartedAt);
  const solveStartedAt = now?.();
  const solution = solveJonkerVolgenant(matrix, signal);
  return {
    creationCosts,
    deletionCosts,
    left,
    matrix,
    pairCosts,
    right,
    solution,
    timing: {
      costMatrixElapsedMs,
      solveElapsedMs: solveStartedAt == null ? 0 : Math.max(0, now!() - solveStartedAt),
    },
  };
};

const selectedAssignmentPairs = (assignment: CommitAssignment) =>
  assignment.solution.assignment.flatMap((column, row) =>
    row < assignment.left.length && column >= 0 && column < assignment.right.length
      ? [
          {
            column,
            cost: assignment.pairCosts[row]![column]!,
            row,
          },
        ]
      : [],
  );

const assignmentPairKey = (row: number, column: number) => `${row}:${column}`;

const auditAssignmentAmbiguity = (
  assignment: CommitAssignment,
  margin: number,
  now?: () => number,
  signal?: AbortSignal,
): AssignmentAmbiguityAudit => {
  throwIfAborted(signal);
  const startedAt = now?.();
  const ambiguous = new Set<string>();
  for (const pair of selectedAssignmentPairs(assignment)) {
    throwIfAborted(signal);
    const matrix = assignment.matrix.map((row) => [...row]);
    matrix[pair.row]![pair.column] = FORBIDDEN_ASSIGNMENT_COST;
    const alternative = solveJonkerVolgenant(matrix, signal);
    if (alternative.cost > assignment.solution.cost + margin) {
      continue;
    }
    for (let row = 0; row < assignment.left.length; row += 1) {
      throwIfAborted(signal);
      const selectedColumn = assignment.solution.assignment[row]!;
      const alternativeColumn = alternative.assignment[row]!;
      if (
        selectedColumn < assignment.right.length &&
        selectedColumn >= 0 &&
        selectedColumn !== alternativeColumn
      ) {
        ambiguous.add(assignmentPairKey(row, selectedColumn));
      }
    }
  }
  return {
    ambiguous,
    elapsedMs: startedAt == null ? 0 : Math.max(0, now!() - startedAt),
  };
};

const assignmentDiagnostics = (
  assignment: CommitAssignment,
  audit: AssignmentAmbiguityAudit,
): CommitAssignmentDiagnostics => ({
  ambiguityCount: audit.ambiguous.size,
  ambiguityElapsedMs: audit.elapsedMs,
  assignmentCost: assignment.solution.cost,
  candidatePairCount: assignment.left.length * assignment.right.length,
  costMatrixElapsedMs: assignment.timing.costMatrixElapsedMs,
  matrixColumns: assignment.matrix.length,
  matrixRows: assignment.matrix.length,
  solveElapsedMs: assignment.timing.solveElapsedMs,
});

const matchScoreFromAssignment = (assignment: CommitAssignment, row: number, column: number) => {
  const alternativeCost = assignment.deletionCosts[row]! + assignment.creationCosts[column]!;
  if (alternativeCost === 0) {
    return 0;
  }
  return Number(Math.max(0, 1 - assignment.pairCosts[row]![column]! / alternativeCost).toFixed(3));
};

/**
 * Incomplete evidence cannot enter the global cost matrix. It may still retain
 * a single, clearly related old/new pair as an explicitly ambiguous unit so a
 * missing provider patch does not become two false added/removed claims.
 */
const isPlausibleIncompletePair = (
  before: CommitLike,
  after: CommitLike,
  beforeFingerprint: CommitFingerprint | undefined,
  afterFingerprint: CommitFingerprint | undefined,
) => {
  if (!beforeFingerprint || !afterFingerprint) {
    return false;
  }
  if (
    beforeFingerprint.exactChangeId != null &&
    beforeFingerprint.exactChangeId === afterFingerprint.exactChangeId
  ) {
    return true;
  }
  const paths = jaccard(beforeFingerprint.changedPaths, afterFingerprint.changedPaths);
  const tokens = jaccard(beforeFingerprint.changeTokenSketch, afterFingerprint.changeTokenSketch);
  const subjects = jaccard(
    beforeFingerprint.subjectKey.split(' '),
    afterFingerprint.subjectKey.split(' '),
  );
  return paths >= 0.5 && (tokens > 0 || subjects >= 0.7) && before.authorName === after.authorName;
};

/**
 * Deterministic identity for one Evolution Unit in an exact comparison.
 *
 * Classification, order, confidence, scores, and match reasons are excluded so
 * analysis improvements cannot change the identity of the same participating
 * commits.
 */
export const createEvolutionUnitId = async (
  range: CommitStackEvolutionRange,
  {
    afterSha,
    baseCommitSha,
    beforeSha,
  }: {
    afterSha?: GitSha;
    baseCommitSha?: GitSha;
    beforeSha?: GitSha;
  },
): Promise<EvolutionUnitId> =>
  `vcu-${(
    await sha256(
      [
        `from-base:${range.from.baseSha}`,
        `from-head:${range.from.headSha}`,
        `to-base:${range.to.baseSha}`,
        `to-head:${range.to.headSha}`,
        `before:${beforeSha ?? ''}`,
        `after:${afterSha ?? ''}`,
        `base-commit:${baseCommitSha ?? ''}`,
      ].join(':'),
    )
  ).slice(0, 20)}` as EvolutionUnitId;

export const recommendVersionWalkthroughStructure = ({
  ambiguous,
  failedUnitDiffs = 0,
  pairingCoverage,
  reviewable,
  tinyUnits = 0,
  unreviewableAmbiguous = 0,
}: {
  ambiguous: number;
  failedUnitDiffs?: number;
  pairingCoverage: number;
  reviewable: number;
  tinyUnits?: number;
  unreviewableAmbiguous?: number;
}): CommitStackEvolution['recommendation'] => {
  if (reviewable <= 1) {
    return {
      reason: 'A Complete Comparison is clearer for zero or one changed commit.',
      structure: 'complete-comparison',
    };
  }
  if (failedUnitDiffs > 0) {
    return {
      reason: 'Some Evolution Unit diffs could not be materialized.',
      structure: 'complete-comparison',
    };
  }
  if (unreviewableAmbiguous > 0) {
    return {
      reason: 'Some stack changes cannot be safely attributed to one commit.',
      structure: 'complete-comparison',
    };
  }
  if (pairingCoverage < 0.8) {
    return { reason: 'Commit pairing confidence is below 80%.', structure: 'complete-comparison' };
  }
  if (ambiguous > Math.max(1, Math.floor(reviewable * 0.2))) {
    return { reason: 'Too many stack changes are ambiguous.', structure: 'complete-comparison' };
  }
  if (tinyUnits > reviewable / 2) {
    return {
      reason: 'The stack is dominated by tiny mechanical changes.',
      structure: 'complete-comparison',
    };
  }
  return {
    reason: `Review ${reviewable} Evolution Units in stack order.`,
    structure: 'commit-evolution',
  };
};

type CommitMatchRecord = {
  after?: CommitLike;
  baseCommit?: CommitLike;
  before?: CommitLike;
  confidence: VersionCommitEvolutionUnit['confidence'];
  kind: VersionCommitMatchKind;
  reasons?: ReadonlyArray<string>;
  score?: number;
};

/**
 * Pair complete old/new stacks with one global range-diff-compatible linear
 * assignment. Target-base absorption deliberately happens only afterwards so
 * a base commit cannot steal a candidate from the actual review stack.
 */
const matchVersionCommitStacksGlobally = async ({
  baseCommits = [],
  baseStackComplete = true,
  fingerprints,
  from,
  newCommits,
  now,
  oldCommits,
  onDiagnostics,
  signal,
  stackCompleteness = { new: true, old: true },
  to,
  warnings = [],
}: {
  baseCommits?: ReadonlyArray<CommitLike>;
  baseStackComplete?: boolean;
  fingerprints: ReadonlyMap<string, CommitFingerprint>;
  from: DiffEndpointRef;
  newCommits: ReadonlyArray<CommitLike>;
  /** Injectable only for deterministic diagnostics tests. */
  now?: () => number;
  oldCommits: ReadonlyArray<CommitLike>;
  /** Non-fatal host telemetry for matching work. */
  onDiagnostics?: (diagnostics: CommitStackMatchDiagnostics) => void;
  /** Superseding a comparison stops matrix work before it can produce a result. */
  signal?: AbortSignal;
  stackCompleteness?: { new: boolean; old: boolean };
  to: DiffEndpointRef;
  warnings?: ReadonlyArray<string>;
}): Promise<CommitStackEvolution> => {
  throwIfAborted(signal);
  const diagnosticsNow = onDiagnostics ? (now ?? (() => globalThis.performance.now())) : null;
  const diagnosticsStartedAt = diagnosticsNow?.();
  let primaryAssignmentDiagnostics: CommitAssignmentDiagnostics | null = null;
  let targetBaseAssignmentDiagnostics: CommitAssignmentDiagnostics | null = null;
  validateReviewCommitStack(oldCommits);
  validateReviewCommitStack(newCommits);
  validateReviewCommitStack(baseCommits);

  const range = { from, to };
  const matches: Array<CommitMatchRecord> = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const usedBase = new Set<string>();
  const ambiguousOld = new Map<string, string>();
  const ambiguousNew = new Map<string, string>();
  const newBySha = new Map(newCommits.map((commit) => [commit.sha, commit]));

  // A matching SHA with no complete patch material is still the same immutable
  // commit. Complete SHA matches remain in the matrix so a duplicate zero-cost
  // patch edge can participate in the ambiguity audit rather than being hidden
  // by an unconditional prelock.
  for (const before of oldCommits) {
    throwIfAborted(signal);
    const after = newBySha.get(before.sha);
    if (!after) {
      continue;
    }
    if (
      assignmentCandidate(before, fingerprints.get(before.sha)) &&
      assignmentCandidate(after, fingerprints.get(after.sha))
    ) {
      continue;
    }
    usedOld.add(before.sha);
    usedNew.add(after.sha);
    matches.push({ after, before, confidence: 'exact', kind: 'retained' });
  }

  const primaryLeft = oldCommits.flatMap((commit) => {
    if (usedOld.has(commit.sha)) {
      return [];
    }
    const candidate = assignmentCandidate(commit, fingerprints.get(commit.sha));
    return candidate ? [candidate] : [];
  });
  const primaryRight = newCommits.flatMap((commit) => {
    if (usedNew.has(commit.sha)) {
      return [];
    }
    const candidate = assignmentCandidate(commit, fingerprints.get(commit.sha));
    return candidate ? [candidate] : [];
  });

  if (primaryLeft.length > 0 && primaryRight.length > 0) {
    const assignment = createCommitAssignment(
      primaryLeft,
      primaryRight,
      diagnosticsNow ?? undefined,
      signal,
    );
    const ambiguityAudit = auditAssignmentAmbiguity(
      assignment,
      RANGE_DIFF_AMBIGUITY_MARGIN,
      diagnosticsNow ?? undefined,
      signal,
    );
    primaryAssignmentDiagnostics = assignmentDiagnostics(assignment, ambiguityAudit);
    const ambiguousPairs = ambiguityAudit.ambiguous;
    for (const pair of selectedAssignmentPairs(assignment)) {
      throwIfAborted(signal);
      const before = primaryLeft[pair.row]!;
      const after = primaryRight[pair.column]!;
      const alternativeCost =
        assignment.deletionCosts[pair.row]! + assignment.creationCosts[pair.column]!;
      const ambiguous = ambiguousPairs.has(assignmentPairKey(pair.row, pair.column));
      const reasons = [
        `Global range-diff assignment cost ${pair.cost}.`,
        ...(ambiguous ? ['A near-optimal alternative assignment is also possible.'] : []),
      ];

      if (before.commit.sha === after.commit.sha) {
        usedOld.add(before.commit.sha);
        usedNew.add(after.commit.sha);
        matches.push({
          after: after.commit,
          before: before.commit,
          confidence: 'exact',
          kind: 'retained',
          reasons: ['Identical immutable commit SHA.'],
          score: matchScoreFromAssignment(assignment, pair.row, pair.column),
        });
        continue;
      }

      if (pair.cost >= alternativeCost || ambiguous) {
        usedOld.add(before.commit.sha);
        usedNew.add(after.commit.sha);
        matches.push({
          after: after.commit,
          before: before.commit,
          confidence: 'unmatched',
          kind: 'ambiguous',
          reasons,
          score: matchScoreFromAssignment(assignment, pair.row, pair.column),
        });
        continue;
      }

      const samePatch =
        before.fingerprint.exactChangeId != null &&
        before.fingerprint.exactChangeId === after.fingerprint.exactChangeId;
      usedOld.add(before.commit.sha);
      usedNew.add(after.commit.sha);
      matches.push({
        after: after.commit,
        before: before.commit,
        confidence: samePatch ? 'exact' : 'high',
        kind: samePatch ? 'rewritten-same-patch' : 'likely-revised',
        reasons,
        score: matchScoreFromAssignment(assignment, pair.row, pair.column),
      });
    }
  }

  const unresolvedOld = oldCommits.filter((commit) => !usedOld.has(commit.sha));
  const unresolvedNew = newCommits.filter((commit) => !usedNew.has(commit.sha));
  if (
    unresolvedOld.length === 1 &&
    unresolvedNew.length === 1 &&
    isPlausibleIncompletePair(
      unresolvedOld[0]!,
      unresolvedNew[0]!,
      fingerprints.get(unresolvedOld[0]!.sha),
      fingerprints.get(unresolvedNew[0]!.sha),
    )
  ) {
    const before = unresolvedOld[0]!;
    const after = unresolvedNew[0]!;
    usedOld.add(before.sha);
    usedNew.add(after.sha);
    matches.push({
      after,
      before,
      confidence: 'unmatched',
      kind: 'ambiguous',
      reasons: ['The only plausible pairing has incomplete change evidence.'],
    });
  }

  // Identical base SHA is another immutable identity claim. It is only
  // considered after the old/new matrix above has consumed review-stack pairs.
  const baseBySha = new Map(baseCommits.map((commit) => [commit.sha, commit]));
  for (const before of oldCommits) {
    throwIfAborted(signal);
    if (usedOld.has(before.sha)) {
      continue;
    }
    const baseCommit = baseBySha.get(before.sha);
    if (!baseCommit || usedBase.has(baseCommit.sha)) {
      continue;
    }
    usedOld.add(before.sha);
    usedBase.add(baseCommit.sha);
    matches.push({
      baseCommit,
      before,
      confidence: 'exact',
      kind: 'absorbed-into-base',
      reasons: ['Commit is now present in the later target base.'],
    });
  }

  const baseLeft = oldCommits.flatMap((commit) => {
    if (usedOld.has(commit.sha)) {
      return [];
    }
    const candidate = assignmentCandidate(commit, fingerprints.get(commit.sha));
    return candidate ? [candidate] : [];
  });
  const baseRight = baseCommits.flatMap((commit) => {
    if (usedBase.has(commit.sha)) {
      return [];
    }
    const candidate = assignmentCandidate(commit, fingerprints.get(commit.sha));
    return candidate ? [candidate] : [];
  });
  if (baseLeft.length > 0 && baseRight.length > 0) {
    const assignment = createCommitAssignment(
      baseLeft,
      baseRight,
      diagnosticsNow ?? undefined,
      signal,
    );
    const ambiguityAudit = auditAssignmentAmbiguity(
      assignment,
      RANGE_DIFF_BASE_AMBIGUITY_MARGIN,
      diagnosticsNow ?? undefined,
      signal,
    );
    targetBaseAssignmentDiagnostics = assignmentDiagnostics(assignment, ambiguityAudit);
    const ambiguousPairs = ambiguityAudit.ambiguous;
    for (const pair of selectedAssignmentPairs(assignment)) {
      throwIfAborted(signal);
      const before = baseLeft[pair.row]!;
      const baseCommit = baseRight[pair.column]!;
      const alternativeCost =
        assignment.deletionCosts[pair.row]! + assignment.creationCosts[pair.column]!;
      const samePatch =
        before.fingerprint.exactChangeId != null &&
        before.fingerprint.exactChangeId === baseCommit.fingerprint.exactChangeId;
      if (
        pair.cost >= alternativeCost ||
        ambiguousPairs.has(assignmentPairKey(pair.row, pair.column))
      ) {
        ambiguousOld.set(
          before.commit.sha,
          'A potential target-base absorption does not have a unique strict assignment.',
        );
        continue;
      }
      usedOld.add(before.commit.sha);
      usedBase.add(baseCommit.commit.sha);
      matches.push({
        baseCommit: baseCommit.commit,
        before: before.commit,
        confidence: samePatch ? 'exact' : 'high',
        kind: 'absorbed-into-base',
        reasons: [
          samePatch
            ? 'Equivalent patch is now present in the later target base.'
            : `Unique target-base range-diff assignment cost ${pair.cost}.`,
        ],
        score: matchScoreFromAssignment(assignment, pair.row, pair.column),
      });
    }
  }

  const canClassifyUnpaired = stackCompleteness.old && stackCompleteness.new;
  const canClassifyRemoved = canClassifyUnpaired && baseStackComplete;
  for (const before of oldCommits) {
    throwIfAborted(signal);
    if (usedOld.has(before.sha)) {
      continue;
    }
    const fingerprint = fingerprints.get(before.sha);
    const incomplete =
      !canClassifyRemoved ||
      fingerprint?.coverage !== 'complete' ||
      before.parentShas.length > 1 ||
      ambiguousOld.has(before.sha);
    matches.push({
      before,
      confidence: 'unmatched',
      kind: incomplete ? 'ambiguous' : 'removed',
      ...(incomplete
        ? {
            reasons: [
              ambiguousOld.get(before.sha) ??
                'Insufficient evidence to classify this commit as removed',
            ],
          }
        : {}),
    });
  }
  for (const after of newCommits) {
    throwIfAborted(signal);
    if (usedNew.has(after.sha)) {
      continue;
    }
    const fingerprint = fingerprints.get(after.sha);
    const incomplete =
      !canClassifyUnpaired ||
      fingerprint?.coverage !== 'complete' ||
      after.parentShas.length > 1 ||
      ambiguousNew.has(after.sha);
    matches.push({
      after,
      confidence: 'unmatched',
      kind: incomplete ? 'ambiguous' : 'added',
      ...(incomplete
        ? {
            reasons: [
              ambiguousNew.get(after.sha) ?? 'Insufficient evidence to classify this commit as new',
            ],
          }
        : {}),
    });
  }

  const oldOrder = new Map(oldCommits.map((commit, index) => [commit.sha, index]));
  const newOrder = new Map(newCommits.map((commit, index) => [commit.sha, index]));
  const units = await Promise.all(
    matches.map(async (match) => {
      throwIfAborted(signal);
      const beforeFingerprint = match.before ? fingerprints.get(match.before.sha) : undefined;
      const afterFingerprint = match.after ? fingerprints.get(match.after.sha) : undefined;
      const baseFingerprint = match.baseCommit ? fingerprints.get(match.baseCommit.sha) : undefined;
      const oldIndex = match.before
        ? (oldOrder.get(match.before.sha) ?? oldCommits.length)
        : oldCommits.length;
      const nextMatched = match.baseCommit
        ? matches
            .filter(
              (candidate) =>
                candidate.before &&
                candidate.after &&
                (oldOrder.get(candidate.before.sha) ?? oldCommits.length) > oldIndex,
            )
            .toSorted(
              (first, second) =>
                (oldOrder.get(first.before!.sha) ?? oldCommits.length) -
                (oldOrder.get(second.before!.sha) ?? oldCommits.length),
            )[0]
        : undefined;
      const order = match.after
        ? (newOrder.get(match.after.sha) ?? newCommits.length)
        : match.baseCommit && nextMatched?.after
          ? (newOrder.get(nextMatched.after.sha) ?? 0) -
            (oldOrder.get(nextMatched.before!.sha)! - oldIndex) / (oldCommits.length + 1)
          : newCommits.length + oldIndex / (oldCommits.length + 1);
      const unit = {
        ...(match.after ? { after: toVersionCommitSummary(match.after, afterFingerprint) } : {}),
        ...(match.baseCommit
          ? { baseCommit: toVersionCommitSummary(match.baseCommit, baseFingerprint) }
          : {}),
        ...(match.before
          ? { before: toVersionCommitSummary(match.before, beforeFingerprint) }
          : {}),
        confidence: match.confidence,
        kind: match.kind,
        unitId: await createEvolutionUnitId(range, {
          afterSha: match.after?.sha,
          baseCommitSha: match.baseCommit?.sha,
          beforeSha: match.before?.sha,
        }),
        ...(match.reasons ? { matchReasons: match.reasons } : {}),
        ...(match.score != null ? { matchScore: match.score } : {}),
        order,
        reviewable:
          (match.kind === 'likely-revised' ||
            match.kind === 'added' ||
            match.kind === 'removed' ||
            (match.kind === 'ambiguous' && match.before != null && match.after != null)) &&
          (match.before?.parentShas.length ?? 0) <= 1 &&
          (match.after?.parentShas.length ?? 0) <= 1,
      } satisfies VersionCommitEvolutionUnit;
      throwIfAborted(signal);
      return unit;
    }),
  );
  throwIfAborted(signal);
  const orderedUnits: Array<VersionCommitEvolutionUnit> = units
    .toSorted(
      (first, second) => first.order - second.order || first.unitId.localeCompare(second.unitId),
    )
    .map((unit, order) => ({ ...unit, order }));
  const count = (kind: VersionCommitMatchKind) =>
    orderedUnits.filter((unit) => unit.kind === kind).length;
  const revised = count('likely-revised');
  const absorbedIntoBase = count('absorbed-into-base');
  const removed = count('removed');
  const added = count('added');
  const ambiguous = count('ambiguous');
  const unreviewableAmbiguous = orderedUnits.filter(
    (unit) => unit.kind === 'ambiguous' && !unit.reviewable,
  ).length;
  const pairingDenominator = revised + Math.min(removed, added);
  const pairingCoverage = pairingDenominator === 0 ? 1 : revised / pairingDenominator;
  const reviewable = orderedUnits.filter((unit) => unit.reviewable).length;
  const completeCoverage =
    stackCompleteness.old &&
    stackCompleteness.new &&
    baseStackComplete &&
    unreviewableAmbiguous === 0;
  const evolution = {
    range,
    recommendation: recommendVersionWalkthroughStructure({
      ambiguous,
      pairingCoverage,
      reviewable,
      unreviewableAmbiguous,
    }),
    summary: {
      absorbedIntoBase,
      added,
      ambiguous,
      completeCoverage,
      pairingCoverage,
      removed,
      retained: count('retained'),
      reviewable,
      revised,
      rewrittenSamePatch: count('rewritten-same-patch'),
      unreviewableAmbiguous,
    },
    units: orderedUnits,
    ...(warnings.length ? { warnings } : {}),
  } satisfies CommitStackEvolution;
  if (onDiagnostics && diagnosticsNow && diagnosticsStartedAt != null) {
    try {
      onDiagnostics({
        ambiguousUnitCount: ambiguous,
        elapsedMs: Math.max(0, diagnosticsNow() - diagnosticsStartedAt),
        primaryAssignment: primaryAssignmentDiagnostics,
        targetBaseAssignment: targetBaseAssignmentDiagnostics,
      });
    } catch {
      // Diagnostics must not interfere with matching or evolution projection.
    }
  }
  return evolution;
};

export const matchVersionCommitStacks = async ({
  baseCommits = [],
  baseStackComplete = true,
  fingerprints,
  from,
  newCommits,
  now,
  oldCommits,
  onDiagnostics,
  signal,
  stackCompleteness = { new: true, old: true },
  to,
  warnings = [],
}: {
  baseCommits?: ReadonlyArray<CommitLike>;
  baseStackComplete?: boolean;
  fingerprints: ReadonlyMap<string, CommitFingerprint>;
  from: DiffEndpointRef;
  newCommits: ReadonlyArray<CommitLike>;
  now?: () => number;
  oldCommits: ReadonlyArray<CommitLike>;
  onDiagnostics?: (diagnostics: CommitStackMatchDiagnostics) => void;
  signal?: AbortSignal;
  stackCompleteness?: { new: boolean; old: boolean };
  to: DiffEndpointRef;
  warnings?: ReadonlyArray<string>;
}): Promise<CommitStackEvolution> => {
  throwIfAborted(signal);
  validateReviewCommitStack(oldCommits);
  validateReviewCommitStack(newCommits);
  validateReviewCommitStack(baseCommits);

  return matchVersionCommitStacksGlobally({
    baseCommits,
    baseStackComplete,
    fingerprints,
    from,
    newCommits,
    ...(now ? { now } : {}),
    ...(onDiagnostics ? { onDiagnostics } : {}),
    oldCommits,
    ...(signal ? { signal } : {}),
    stackCompleteness,
    to,
    warnings,
  });
};

const pathTokens = (paths: ReadonlyArray<string>) =>
  paths
    .flatMap((path) => path.toLowerCase().split(/[^a-z0-9]+/g))
    .filter((token) => token.length > 2);

export const scoreBaseCommitAsRebaseOverlap = ({
  baseFingerprint,
  unitFingerprint,
}: {
  baseFingerprint: Pick<
    CommitFingerprint,
    'changedPaths' | 'changeTokenSketch' | 'additions' | 'deletions'
  >;
  unitFingerprint: Pick<
    CommitFingerprint,
    'changedPaths' | 'changeTokenSketch' | 'additions' | 'deletions'
  >;
}) => {
  const overlappingPaths = unitFingerprint.changedPaths.filter((path) =>
    baseFingerprint.changedPaths.includes(path),
  );
  const pathOverlap =
    unitFingerprint.changedPaths.length === 0
      ? 0
      : overlappingPaths.length / unitFingerprint.changedPaths.length;
  const tokens = jaccard(unitFingerprint.changeTokenSketch, baseFingerprint.changeTokenSketch);
  const pathNameTokens = jaccard(
    pathTokens(unitFingerprint.changedPaths),
    pathTokens(baseFingerprint.changedPaths),
  );
  const left = unitFingerprint.additions + unitFingerprint.deletions;
  const right = baseFingerprint.additions + baseFingerprint.deletions;
  const size = Math.max(left, right) === 0 ? 1 : Math.min(left, right) / Math.max(left, right);
  // Prefer path overlap heavily: a base commit that touches the same files is the
  // strongest signal that the MR commit was revised due to rebase conflict fallout.
  const score = pathOverlap * 0.62 + tokens * 0.28 + pathNameTokens * 0.06 + size * 0.04;
  return {
    overlappingPaths,
    score: Number(score.toFixed(3)),
  };
};

export const attributeRebaseOverlaps = ({
  baseCommits,
  baseFingerprints,
  limit = 3,
  unitFingerprint,
}: {
  baseCommits: ReadonlyArray<{
    authoredAt: string;
    authorName: string;
    sha: GitSha;
    shortSha: string;
    subject: string;
    webUrl: string;
  }>;
  baseFingerprints: ReadonlyMap<string, CommitFingerprint>;
  limit?: number;
  unitFingerprint: CommitFingerprint | null | undefined;
}): Array<VersionRebaseOverlapCommit> => {
  if (!unitFingerprint || unitFingerprint.changedPaths.length === 0 || baseCommits.length === 0) {
    return [];
  }
  return baseCommits
    .map((commit) => {
      const fingerprint = baseFingerprints.get(commit.sha);
      if (!fingerprint) {
        return null;
      }
      const { overlappingPaths, score } = scoreBaseCommitAsRebaseOverlap({
        baseFingerprint: fingerprint,
        unitFingerprint,
      });
      if (score < 0.22 || overlappingPaths.length === 0) {
        return null;
      }
      return {
        authoredAt: commit.authoredAt,
        authorName: commit.authorName,
        overlappingPaths,
        score,
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        webUrl: commit.webUrl,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry != null)
    .toSorted((first, second) => second.score - first.score || first.sha.localeCompare(second.sha))
    .slice(0, limit)
    .map(({ score: _score, ...commit }) => commit);
};

type ProjectableCommit = {
  authoredAt: string;
  authorName: string;
  diffStat?: { additions: number; deletions: number; filesChanged: number };
  parentShas?: ReadonlyArray<GitSha>;
  sha: GitSha;
  shortSha: string;
  subject: string;
  webUrl?: string;
};

const projectCommitSummary = (
  commit: ProjectableCommit | undefined,
): ReviewCommitSummary | undefined =>
  commit
    ? {
        authoredAt: commit.authoredAt,
        authorName: commit.authorName,
        parentShas: commit.parentShas ?? [],
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        webUrl: commit.webUrl,
        ...(commit.diffStat ? { diffStat: commit.diffStat } : {}),
      }
    : undefined;

/** Project one matching unit onto Core's provider-neutral Evolution Unit. */
export const projectEvolutionUnit = (unit: {
  after?: ProjectableCommit;
  baseCommit?: ProjectableCommit;
  before?: ProjectableCommit;
  confidence: 'exact' | 'high' | 'unmatched';
  kind: VersionCommitMatchKind | 'introduced' | 'revised';
  matchReasons?: ReadonlyArray<string>;
  matchScore?: number;
  order: number;
  rebaseOverlaps?: ReadonlyArray<VersionRebaseOverlapCommit>;
  reviewable: boolean;
  unitId: EvolutionUnitId;
}): ReviewEvolutionUnit => {
  const common = {
    confidence: unit.confidence,
    order: unit.order,
    unitId: unit.unitId,
    ...(unit.matchReasons ? { matchReasons: unit.matchReasons } : {}),
    ...(unit.matchScore != null ? { matchScore: unit.matchScore } : {}),
  } as const;
  if (unit.kind === 'added' || unit.kind === 'introduced') {
    return {
      ...common,
      after: projectCommitSummary(unit.after)!,
      kind: 'introduced',
      reviewable: true,
    };
  }
  if (unit.kind === 'removed') {
    return {
      ...common,
      before: projectCommitSummary(unit.before)!,
      kind: 'removed',
      reviewable: true,
    };
  }
  if (unit.kind === 'likely-revised' || unit.kind === 'revised') {
    return {
      ...common,
      after: projectCommitSummary(unit.after)!,
      before: projectCommitSummary(unit.before)!,
      kind: 'revised',
      reviewable: true,
      ...(unit.rebaseOverlaps ? { rebaseOverlaps: unit.rebaseOverlaps } : {}),
    };
  }
  if (unit.kind === 'ambiguous') {
    const after = projectCommitSummary(unit.after);
    const before = projectCommitSummary(unit.before);
    return unit.reviewable && after && before
      ? { ...common, after, before, kind: 'ambiguous', reviewable: true }
      : {
          ...common,
          kind: 'ambiguous',
          reviewable: false,
          ...(after ? { after } : {}),
          ...(before ? { before } : {}),
        };
  }
  if (unit.kind === 'absorbed-into-base') {
    const after = projectCommitSummary(unit.after);
    const baseCommit = projectCommitSummary(unit.baseCommit);
    const before = projectCommitSummary(unit.before);
    return {
      ...common,
      kind: 'absorbed-into-base',
      reviewable: false,
      ...(after ? { after } : {}),
      ...(baseCommit ? { baseCommit } : {}),
      ...(before ? { before } : {}),
    };
  }
  const after = projectCommitSummary(unit.after);
  const before = projectCommitSummary(unit.before);
  return {
    ...common,
    kind: unit.kind,
    reviewable: false,
    ...(after ? { after } : {}),
    ...(before ? { before } : {}),
  };
};

/** Project matching output onto the Core review-history model. */
export const projectCommitEvolution = (evolution: CommitStackEvolution): ReviewCommitEvolution => ({
  recommendation: {
    rationale: evolution.recommendation.reason,
    suggestedStructure: evolution.recommendation.structure,
  },
  summary: evolution.summary,
  units: evolution.units.map(projectEvolutionUnit),
  ...(evolution.warnings ? { warnings: evolution.warnings } : {}),
});
