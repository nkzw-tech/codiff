import type { GitFileStatus, GitSha, ReviewCommitSummary } from '../types.ts';
import { validateReviewCommitStack } from './review-commit-stack.ts';

export const reviewArtifactSchemaVersion = 'review-artifact-v1';

export type ArtifactCoverage = 'complete' | 'opaque' | 'truncated';

export type ReviewArtifactProject = {
  host: string;
  project: string;
  provider: 'git' | 'github' | 'gitlab';
};

export type ReviewArtifactProvenance = {
  kind: 'github-api' | 'gitlab-api' | 'native-git';
  project: ReviewArtifactProject;
};

export type StackSnapshot = {
  baseSha: GitSha;
  commits: ReadonlyArray<ReviewCommitSummary>;
  coverage: ArtifactCoverage;
  headSha: GitSha;
  provenance: ReviewArtifactProvenance;
};

export type ArtifactFile = {
  coverage: ArtifactCoverage;
  newMode?: string;
  newObjectId?: string;
  oldMode?: string;
  oldObjectId?: string;
  oldPath?: string;
  /** Complete normalized patch when textual patch data is available. */
  patch?: string;
  path: string;
  status: GitFileStatus;
};

export type CommitArtifact = {
  commitSha: GitSha;
  coverage: ArtifactCoverage;
  files: ReadonlyArray<ArtifactFile>;
  /** The selected parent whose change this artifact represents; null for a root commit. */
  parentSha: GitSha | null;
  provenance: ReviewArtifactProvenance;
};

export type CommitArtifactRequest = {
  commitSha: GitSha;
  parentSha: GitSha | null;
};

export type CommitArtifactRequestKey = string & {
  readonly __commitArtifactRequestKey: unique symbol;
};

export type ReviewArtifactRangeRequest = {
  /** Immutable requested review head; providers must not substitute this coordinate. */
  headSha: GitSha;
  /** Immutable provider selector. The returned artifact base may differ after resolution. */
  requestedBaseSha: GitSha;
};

export type ReviewArtifactRangeResult = {
  range: RangeArtifact;
  stack: StackSnapshot;
};

export type RangeArtifact = {
  baseSha: GitSha;
  coverage: ArtifactCoverage;
  files: ReadonlyArray<ArtifactFile>;
  headSha: GitSha;
  /** Human-readable reason when the whole range is incomplete. */
  incompleteReason?: string;
  provenance: ReviewArtifactProvenance;
};

export type BlobArtifact = {
  bytes: Uint8Array;
  objectId: string;
  provenance: ReviewArtifactProvenance;
};

/** Immutable endpoint coordinate used to resolve a path to its Git blob. */
export type FileBlobArtifactRequest = {
  /** Per-file retained-byte limit for on-demand context or image rendering. */
  maxBytes?: number;
  path: string;
  ref: GitSha;
};

export interface ReviewArtifactSource {
  readBlobs(
    objectIds: ReadonlyArray<string>,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, BlobArtifact>>;
  readCommitArtifacts(
    commits: ReadonlyArray<CommitArtifactRequest>,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<CommitArtifactRequestKey, CommitArtifact>>;
  /**
   * Optional path resolver for sources whose caller does not yet know the Git
   * object ID. Results are still Blob Artifacts keyed by immutable ref+path.
   */
  readFileBlobs?(
    requests: ReadonlyArray<FileBlobArtifactRequest>,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, BlobArtifact>>;
  readStackAndRange(
    request: ReviewArtifactRangeRequest,
    signal: AbortSignal,
  ): Promise<ReviewArtifactRangeResult>;
}

export type ReviewArtifactRunDiagnostics = {
  acquired: {
    blobs: Readonly<Record<string, number>>;
    commits: Readonly<Record<string, number>>;
    stackAndRanges: Readonly<Record<string, number>>;
  };
  cacheHits: {
    blobs: number;
    commits: number;
    stackAndRanges: number;
  };
  sourceCalls: {
    blobs: number;
    commits: number;
    stackAndRanges: number;
  };
};

export type ReviewArtifactRun = ReviewArtifactSource & {
  abort(reason?: unknown): void;
  diagnostics(): ReviewArtifactRunDiagnostics;
  readFileBlobs(
    requests: ReadonlyArray<FileBlobArtifactRequest>,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, BlobArtifact>>;
  readonly signal: AbortSignal;
};

export const createFileBlobArtifactRequestKey = ({ path, ref }: FileBlobArtifactRequest) =>
  `${ref}:${path}`;

export const createCommitArtifactRequestKey = ({
  commitSha,
  parentSha,
}: CommitArtifactRequest): CommitArtifactRequestKey =>
  `${commitSha}:${parentSha ?? 'root'}` as CommitArtifactRequestKey;

const validateCoverage = (
  artifact: {
    coverage: ArtifactCoverage;
    files: ReadonlyArray<ArtifactFile>;
    incompleteReason?: string;
  },
  label: string,
) => {
  if (
    artifact.coverage === 'complete' &&
    artifact.files.some((file) => file.coverage !== 'complete')
  ) {
    throw new Error(`${label} cannot be complete when one or more files are incomplete.`);
  }
  if (artifact.incompleteReason != null) {
    if (!artifact.incompleteReason.trim()) {
      throw new Error(`${label} has an empty incomplete-evidence reason.`);
    }
    if (artifact.coverage === 'complete') {
      throw new Error(`${label} cannot be complete when it has an incomplete-evidence reason.`);
    }
  }
  for (const file of artifact.files) {
    if (!file.path) {
      throw new Error(`${label} contains a file without a path.`);
    }
    if (file.coverage === 'complete' && file.patch == null) {
      const hasExactMetadata =
        file.oldObjectId != null ||
        file.newObjectId != null ||
        (file.oldMode != null && file.newMode != null && file.oldMode !== file.newMode);
      if (!hasExactMetadata) {
        throw new Error(
          `${label} marks ${file.path} complete without a patch or exact object/mode metadata.`,
        );
      }
    }
  }
};

export const validateCommitArtifact = <Artifact extends CommitArtifact>(artifact: Artifact) => {
  validateCoverage(artifact, `Commit Artifact ${artifact.commitSha}`);
  if (artifact.parentSha === artifact.commitSha) {
    throw new Error(`Commit Artifact ${artifact.commitSha} cannot select itself as its parent.`);
  }
  return artifact;
};

export const validateRangeArtifact = <Artifact extends RangeArtifact>(artifact: Artifact) => {
  validateCoverage(artifact, `Range Artifact ${artifact.baseSha}..${artifact.headSha}`);
  return artifact;
};

export const validateStackSnapshot = <Snapshot extends StackSnapshot>(snapshot: Snapshot) => {
  const commits = validateReviewCommitStack(snapshot.commits);
  if (commits.length > 0 && commits.at(-1)?.sha !== snapshot.headSha) {
    throw new Error('A non-empty Stack Snapshot must end at its declared head SHA.');
  }
  if (commits.length === 0 && snapshot.baseSha !== snapshot.headSha) {
    throw new Error('An empty Stack Snapshot must have identical base and head SHAs.');
  }
  return snapshot;
};

const projectsMatch = (left: ReviewArtifactProject, right: ReviewArtifactProject) =>
  left.provider === right.provider && left.host === right.host && left.project === right.project;

/**
 * Validate one provider-resolved artifact range. `requestedBaseSha` is a
 * provider selector; `RangeArtifact.baseSha` and `StackSnapshot.baseSha` are
 * the authoritative effective comparison base.
 */
export const validateReviewArtifactRangeResult = <Result extends ReviewArtifactRangeResult>(
  request: ReviewArtifactRangeRequest,
  result: Result,
) => {
  const range = validateRangeArtifact(result.range);
  const stack = result.stack;
  if (range.baseSha !== stack.baseSha || range.headSha !== stack.headSha) {
    throw new Error(
      'Artifact Source returned a Range Artifact and Stack Snapshot for different endpoints.',
    );
  }
  if (range.headSha !== request.headSha) {
    throw new Error(
      'Artifact Source substituted a different head SHA for the requested artifact range.',
    );
  }
  if (!projectsMatch(range.provenance.project, stack.provenance.project)) {
    throw new Error(
      'Artifact Source returned range and stack artifacts for different provider projects.',
    );
  }
  if (
    request.requestedBaseSha === request.headSha &&
    (range.baseSha !== request.headSha || range.files.length !== 0 || stack.commits.length !== 0)
  ) {
    throw new Error('A same-commit artifact request must return an empty same-commit result.');
  }
  return { range, stack: validateStackSnapshot(stack) } as Result;
};

const increment = (counts: Map<string, number>, key: string) =>
  counts.set(key, (counts.get(key) ?? 0) + 1);

const countRecord = (counts: ReadonlyMap<string, number>) => Object.fromEntries(counts);

const fileBlobCacheKey = (key: string, request: FileBlobArtifactRequest) =>
  `${key}:${request.maxBytes ?? 'default'}`;

/**
 * Coordinate one comparison's immutable artifact reads. Completed values and
 * explicit source misses are reused only inside this run; cancelable in-flight
 * work is never shared with an unrelated run.
 */
export const createReviewArtifactRun = (
  source: ReviewArtifactSource,
  options: { controller?: AbortController; signal?: AbortSignal } = {},
): ReviewArtifactRun => {
  const controller = options.controller ?? new AbortController();
  const boundSignals = new WeakSet<AbortSignal>();
  const commitValues = new Map<CommitArtifactRequestKey, CommitArtifact | null>();
  const commitPending = new Map<CommitArtifactRequestKey, Promise<CommitArtifact | null>>();
  const blobValues = new Map<string, BlobArtifact | null>();
  const blobPending = new Map<string, Promise<BlobArtifact | null>>();
  const fileBlobValues = new Map<string, BlobArtifact | null>();
  const fileBlobPending = new Map<string, Promise<BlobArtifact | null>>();
  const stackAndRangeValues = new Map<string, ReviewArtifactRangeResult>();
  const stackAndRangePending = new Map<string, Promise<ReviewArtifactRangeResult>>();
  const acquired = {
    blobs: new Map<string, number>(),
    commits: new Map<string, number>(),
    stackAndRanges: new Map<string, number>(),
  };
  const cacheHits = { blobs: 0, commits: 0, stackAndRanges: 0 };
  const sourceCalls = { blobs: 0, commits: 0, stackAndRanges: 0 };

  const bindSignal = (signal?: AbortSignal) => {
    if (!signal || signal === controller.signal || boundSignals.has(signal)) {
      return;
    }
    boundSignals.add(signal);
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
  };
  bindSignal(options.signal);

  const readCommitArtifacts = async (
    commits: ReadonlyArray<CommitArtifactRequest>,
    signal: AbortSignal,
  ) => {
    bindSignal(signal);
    controller.signal.throwIfAborted();
    const requested = [
      ...new Map(
        commits.map((commit) => [createCommitArtifactRequestKey(commit), commit]),
      ).entries(),
    ];
    const misses = requested.filter(([key]) => {
      if (commitValues.has(key) || commitPending.has(key)) {
        cacheHits.commits += 1;
        return false;
      }
      return true;
    });
    if (misses.length > 0) {
      sourceCalls.commits += 1;
      for (const [key] of misses) {
        increment(acquired.commits, key);
      }
      const requestedBatchKeys = new Set(misses.map(([key]) => key));
      const batch = source
        .readCommitArtifacts(
          misses.map(([, commit]) => commit),
          controller.signal,
        )
        .then((artifacts) => {
          for (const [key, artifact] of artifacts) {
            if (!requestedBatchKeys.has(key)) {
              throw new Error(`Artifact Source returned unrequested commit coordinate ${key}.`);
            }
            if (createCommitArtifactRequestKey(artifact) !== key) {
              throw new Error(`Artifact Source returned different coordinates for ${key}.`);
            }
          }
          return artifacts;
        });
      for (const [key, commit] of misses) {
        const pending = batch
          .then((artifacts) => {
            const artifact = artifacts.get(key);
            if (!artifact) {
              return null;
            }
            if (
              artifact.commitSha !== commit.commitSha ||
              artifact.parentSha !== commit.parentSha
            ) {
              throw new Error(
                `Artifact Source returned different coordinates for commit ${commit.commitSha}.`,
              );
            }
            return validateCommitArtifact(artifact);
          })
          .then((artifact) => {
            commitValues.set(key, artifact);
            return artifact;
          })
          .finally(() => {
            if (commitPending.get(key) === pending) {
              commitPending.delete(key);
            }
          });
        commitPending.set(key, pending);
      }
    }
    await Promise.all(requested.map(([key]) => commitPending.get(key)).filter(Boolean));
    controller.signal.throwIfAborted();
    return new Map(
      requested
        .map(([key]) => [key, commitValues.get(key)] as const)
        .filter(
          (entry): entry is readonly [CommitArtifactRequestKey, CommitArtifact] => entry[1] != null,
        ),
    );
  };

  const readBlobs = async (objectIds: ReadonlyArray<string>, signal: AbortSignal) => {
    bindSignal(signal);
    controller.signal.throwIfAborted();
    const requested = [...new Set(objectIds)];
    const misses = requested.filter((objectId) => {
      if (blobValues.has(objectId) || blobPending.has(objectId)) {
        cacheHits.blobs += 1;
        return false;
      }
      return true;
    });
    if (misses.length > 0) {
      sourceCalls.blobs += 1;
      for (const objectId of misses) {
        increment(acquired.blobs, objectId);
      }
      const batch = source.readBlobs(misses, controller.signal);
      for (const objectId of misses) {
        const pending = batch
          .then((blobs) => {
            const blob = blobs.get(objectId);
            if (!blob) {
              return null;
            }
            if (blob.objectId !== objectId) {
              throw new Error(`Artifact Source returned ${blob.objectId} for blob ${objectId}.`);
            }
            return blob;
          })
          .then((blob) => {
            blobValues.set(objectId, blob);
            return blob;
          })
          .finally(() => {
            if (blobPending.get(objectId) === pending) {
              blobPending.delete(objectId);
            }
          });
        blobPending.set(objectId, pending);
      }
    }
    await Promise.all(requested.map((objectId) => blobPending.get(objectId)).filter(Boolean));
    controller.signal.throwIfAborted();
    return new Map(
      requested
        .map((objectId) => [objectId, blobValues.get(objectId)] as const)
        .filter((entry): entry is readonly [string, BlobArtifact] => entry[1] != null),
    );
  };

  const readFileBlobs = async (
    requests: ReadonlyArray<FileBlobArtifactRequest>,
    signal: AbortSignal,
  ) => {
    bindSignal(signal);
    controller.signal.throwIfAborted();
    const requested = [
      ...new Map(
        requests.map((request) => {
          if (
            request.maxBytes != null &&
            (!Number.isFinite(request.maxBytes) || request.maxBytes < 0)
          ) {
            throw new RangeError('File Blob Artifact byte limit must be non-negative and finite.');
          }
          const normalized = {
            ...request,
            ...(request.maxBytes == null ? {} : { maxBytes: Math.floor(request.maxBytes) }),
          };
          return [createFileBlobArtifactRequestKey(normalized), normalized] as const;
        }),
      ).entries(),
    ];
    const misses = requested.filter(([key, request]) => {
      const keyWithLimit = fileBlobCacheKey(key, request);
      if (fileBlobValues.has(keyWithLimit) || fileBlobPending.has(keyWithLimit)) {
        cacheHits.blobs += 1;
        return false;
      }
      return true;
    });
    if (misses.length > 0 && source.readFileBlobs) {
      sourceCalls.blobs += 1;
      for (const [key] of misses) {
        increment(acquired.blobs, `file:${key}`);
      }
      const batch = source.readFileBlobs!(
        misses.map(([, request]) => request),
        controller.signal,
      );
      for (const [key, request] of misses) {
        const keyWithLimit = fileBlobCacheKey(key, request);
        const pending = batch
          .then((blobs) => {
            const blob = blobs.get(key);
            if (!blob || (request.maxBytes != null && blob.bytes.byteLength > request.maxBytes)) {
              return null;
            }
            if (!blob.objectId) {
              throw new Error(
                `Artifact Source returned a file blob without an object ID for ${key}.`,
              );
            }
            return blob;
          })
          .then((blob) => {
            fileBlobValues.set(keyWithLimit, blob);
            if (blob) {
              blobValues.set(blob.objectId, blob);
            }
            return blob;
          })
          .finally(() => {
            if (fileBlobPending.get(keyWithLimit) === pending) {
              fileBlobPending.delete(keyWithLimit);
            }
          });
        fileBlobPending.set(keyWithLimit, pending);
      }
    } else if (misses.length > 0) {
      for (const [key, request] of misses) {
        fileBlobValues.set(fileBlobCacheKey(key, request), null);
      }
    }
    await Promise.all(
      requested
        .map(([key, request]) => fileBlobPending.get(fileBlobCacheKey(key, request)))
        .filter(Boolean),
    );
    controller.signal.throwIfAborted();
    return new Map(
      requested
        .map(([key, request]) => [key, fileBlobValues.get(fileBlobCacheKey(key, request))] as const)
        .filter((entry): entry is readonly [string, BlobArtifact] => entry[1] != null),
    );
  };

  const readStackAndRange = async (request: ReviewArtifactRangeRequest, signal: AbortSignal) => {
    bindSignal(signal);
    controller.signal.throwIfAborted();
    const key = `${request.requestedBaseSha}:${request.headSha}`;
    const cached = stackAndRangeValues.get(key);
    if (cached) {
      cacheHits.stackAndRanges += 1;
      return cached;
    }
    const active = stackAndRangePending.get(key);
    if (active) {
      cacheHits.stackAndRanges += 1;
      return active;
    }
    sourceCalls.stackAndRanges += 1;
    increment(acquired.stackAndRanges, key);
    const pending = source
      .readStackAndRange(request, controller.signal)
      .then((value) => {
        controller.signal.throwIfAborted();
        return validateReviewArtifactRangeResult(request, value);
      })
      .then((value) => {
        stackAndRangeValues.set(key, value);
        return value;
      })
      .finally(() => {
        if (stackAndRangePending.get(key) === pending) {
          stackAndRangePending.delete(key);
        }
      });
    stackAndRangePending.set(key, pending);
    return pending;
  };

  return {
    abort: (reason) => controller.abort(reason),
    diagnostics: () => ({
      acquired: {
        blobs: countRecord(acquired.blobs),
        commits: countRecord(acquired.commits),
        stackAndRanges: countRecord(acquired.stackAndRanges),
      },
      cacheHits: { ...cacheHits },
      sourceCalls: { ...sourceCalls },
    }),
    readBlobs,
    readCommitArtifacts,
    readFileBlobs,
    readStackAndRange,
    signal: controller.signal,
  };
};
