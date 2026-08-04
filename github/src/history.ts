import {
  commitRevisionLabel,
  computeVersionComparePreferringReplay,
  createCommitFingerprint,
  createCommitArtifactRequestKey,
  createFileBlobArtifactRequestKey,
  diffComparison,
  diffComparisonView,
  diffRange,
  matchVersionCommitStacks,
  orderReviewCommitStack,
  projectCommitEvolution,
  reviewVersionOption,
  revisionRef,
  shaForRevision,
  validateCommitArtifact,
  validateRangeArtifact,
  validateStackSnapshot,
  versionCommitEvidenceConcurrency,
  versionCommitStackLimit,
  versionRevisionLabel,
  type ArtifactCoverage,
  type ArtifactFile,
  type BlobArtifact,
  type CommitStackMatchDiagnostics,
  type CommitArtifact,
  type CommitArtifactRequest,
  type FileBlobArtifactRequest,
  type CommitFingerprint,
  type DiffEndpointRef,
  type RangeArtifact,
  type ReplayBlobBatchLookup,
  type ReplayCompareDiagnostics,
  type ReplayPatchFile,
  type ReviewArtifactProject,
  type ReviewArtifactSource,
  type StackSnapshot,
} from '@nkzw/codiff-core';
/**
 * Read-side GitHub review-history adapter over {@link GitHubTransport}.
 *
 * GitHub has no MR version list. Local parity uses force-push head snapshots as
 * the revision timeline. Compare/evolution materialization is host-supplied
 * (local git) so this package stays free of process spawning.
 */
import type {
  ChangedFile,
  DiffComparisonBaseMovement,
  DiffComparisonView,
  GitSha,
  ReviewCommitEvolution,
  ReviewCommitSummary,
  ReviewEvolutionUnit,
  ReviewVersionActivityReason,
  ReviewVersionId,
  ReviewVersionOption,
} from '@nkzw/codiff-core/types';
import type { GitHubTransport } from './transport.ts';

export { orderReviewCommitStack };

export type { GitHubTransport } from './transport.ts';

export type ForcePushEvent = {
  actorLogin?: string;
  after: GitSha;
  before: GitSha;
  createdAt: string;
};

export type GitHubPullRequestRef = {
  baseOwner?: string | null;
  baseRepo?: string | null;
  createdAt?: string | null;
  headOwner?: string | null;
  headRef?: string | null;
  headRepo?: string | null;
  /** Optional known head from the local source; PR metadata overrides when available. */
  headSha?: GitSha | null;
  number: number;
  owner: string;
  repo: string;
  updatedAt?: string | null;
};

export type GitHubCommitLike = {
  authoredAt: string;
  authorName: string;
  message?: string;
  parentShas: ReadonlyArray<GitSha>;
  sha: GitSha;
  shortSha: string;
  subject: string;
  title?: string;
  webUrl?: string;
};

/**
 * Host-owned Range Artifact evidence for aggregate replay. A bounded native
 * read can retain complete early files while omitting a later tail, so its
 * range-level coverage must not be discarded during adaptation.
 */
export type GitHubHostRangePatchFiles = {
  coverage: ArtifactCoverage;
  files: ReadonlyArray<ReplayPatchFile>;
};

type GitHubRangePatchFiles = ReadonlyArray<ReplayPatchFile> | GitHubHostRangePatchFiles;

export type PushEvent = {
  after: GitSha;
  before: GitSha;
  createdAt: string;
  label: string;
};

export type GitHubHistoryGit = {
  /**
   * Ensure a commit object is available for reading. Hosts typically
   * `git fetch` missing SHAs. Throw when the object cannot be obtained.
   */
  ensureCommit(
    sha: GitSha,
    options?: {
      repositories?: ReadonlyArray<{ owner: string; repo: string }>;
      signal?: AbortSignal;
    },
  ): Promise<GitSha>;
  /** True when `ancestor` is an ancestor of `descendant` (inclusive). */
  isAncestor(ancestor: GitSha, descendant: GitSha): Promise<boolean>;
  /** Merge base used to recover the effective target base for each historical head. */
  mergeBase(left: GitSha, right: GitSha): Promise<GitSha>;
  /** Read an immutable text blob, or null when the path is absent or binary. */
  readBlob?(path: string, ref: GitSha): Promise<string | null>;
  /** Bulk immutable classification evidence for all requested local commits. */
  readCommitArtifacts(
    commits: ReadonlyArray<CommitArtifactRequest>,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<GitSha, CommitArtifact>>;
  /** Per-commit changed files used only for lazy Evolution Unit rendering. */
  readCommitDiff(sha: GitSha): Promise<ReadonlyArray<ChangedFile>>;
  /** Metadata for a single commit object. */
  readCommitMeta(sha: GitSha): Promise<GitHubCommitLike>;
  /** Provider-neutral commit patch files for replay materialization. */
  readCommitPatchFiles?(sha: GitSha): Promise<ReadonlyArray<ReplayPatchFile>>;
  /** Commits exclusive to `base..head`, oldest → newest. */
  readCommitStack(base: GitSha, head: GitSha): Promise<ReadonlyArray<GitHubCommitLike>>;
  /**
   * Materialize a changed-file list for `base...head` (or direct when
   * `symmetric` is false).
   */
  readRangeFiles(
    base: GitSha,
    head: GitSha,
    symmetric: boolean,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<ChangedFile>>;
  /** Provider-neutral range patch files for replay materialization. */
  readRangePatchFiles?(
    base: GitSha,
    head: GitSha,
    signal?: AbortSignal,
  ): Promise<GitHubRangePatchFiles>;
  /** One host-owned proof batch for every regional replay endpoint. */
  readReplayBlobs?: ReplayBlobBatchLookup;
};

const shortSha = (sha: GitSha) => sha.slice(0, 7);
/** Immutable Commit and Range Artifact JSON must never retain arbitrary provider output. */
const MAX_ARTIFACT_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_OPTIONAL_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const isNullSha = (sha: GitSha) => /^0+$/.test(sha);
const gitSha = (value: unknown): GitSha | null =>
  typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? (value as GitSha) : null;
const reviewVersionId = (value: GitSha): ReviewVersionId => value as string as ReviewVersionId;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const asString = (value: unknown) => (typeof value === 'string' ? value : '');
const asNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const asIdentity = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

const normalizeBlobArtifactMaxBytes = (value: number | undefined) => {
  const maxBytes = value ?? MAX_BLOB_ARTIFACT_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new RangeError('Blob Artifact byte limit must be a finite non-negative number.');
  }
  return Math.floor(maxBytes);
};

const githubRepositoryPath = ({ owner, repo }: GitHubPullRequestRef) =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

const githubComparePath = (pull: GitHubPullRequestRef, base: GitSha, head: GitSha) =>
  `${githubRepositoryPath(pull)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;

const githubCommitPath = (pull: GitHubPullRequestRef, sha: GitSha) =>
  `${githubRepositoryPath(pull)}/commits/${encodeURIComponent(sha)}`;

const githubBlobPath = (pull: GitHubPullRequestRef, objectId: string) =>
  `${githubRepositoryPath(pull)}/git/blobs/${encodeURIComponent(objectId)}`;

const githubContentsPath = (pull: GitHubPullRequestRef, path: string) =>
  `${githubRepositoryPath(pull)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

const decodeBase64File = (content: string, maxBytes: number) => {
  const normalized = content.replaceAll(/\s/g, '');
  if (normalized.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    return null;
  }
  try {
    const decoded = atob(normalized);
    if (decoded.length > maxBytes) {
      return null;
    }
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
};

/** @param {string} path */
const quotePatchPath = (path: string) =>
  path.replaceAll('\\', String.raw`\\`).replaceAll('\n', String.raw`\n`);

/**
 * GitHub's file-list endpoints return only a hunk body. Range and Commit
 * Artifacts are renderer-facing contracts, so normalize that body into a
 * complete unified patch at the provider boundary rather than making every
 * Electron consumer reconstruct it.
 */
const createGitHubPatch = ({
  oldPath,
  patchBody,
  path,
  status,
}: {
  oldPath: string;
  patchBody: string;
  path: string;
  status: ArtifactFile['status'];
}) => {
  if (!patchBody.trim()) {
    return '';
  }
  if (patchBody.startsWith('diff --git ')) {
    return patchBody.endsWith('\n') ? patchBody : `${patchBody}\n`;
  }
  const header = [
    `diff --git a/${quotePatchPath(oldPath)} b/${quotePatchPath(path)}`,
    status === 'added' ? '--- /dev/null' : `--- a/${quotePatchPath(oldPath)}`,
    status === 'deleted' ? '+++ /dev/null' : `+++ b/${quotePatchPath(path)}`,
  ];
  return `${header.join('\n')}\n${patchBody}${patchBody.endsWith('\n') ? '' : '\n'}`;
};

const normalizeGitHubArtifactFile = (value: unknown): ArtifactFile | null => {
  if (!isRecord(value)) {
    return null;
  }
  const path = asString(value.filename);
  if (!path) {
    return null;
  }
  const providerStatus = asString(value.status);
  const status =
    providerStatus === 'added'
      ? 'added'
      : providerStatus === 'removed'
        ? 'deleted'
        : providerStatus === 'renamed'
          ? 'renamed'
          : 'modified';
  const oldPath = asString(value.previous_filename);
  const patchBody = asString(value.patch);
  const objectId = asString(value.sha) || undefined;
  const oldObjectId = status === 'deleted' ? objectId : undefined;
  const newObjectId = status === 'deleted' ? undefined : objectId;
  const coverage: ArtifactCoverage =
    value.truncated === true
      ? 'truncated'
      : patchBody.trim() || oldObjectId || newObjectId
        ? 'complete'
        : 'opaque';
  return {
    coverage,
    ...(newObjectId ? { newObjectId } : {}),
    ...(oldObjectId ? { oldObjectId } : {}),
    ...(oldPath && oldPath !== path ? { oldPath } : {}),
    ...(patchBody.trim()
      ? { patch: createGitHubPatch({ oldPath: oldPath || path, patchBody, path, status }) }
      : {}),
    path,
    status,
  };
};

const artifactCoverage = (
  files: ReadonlyArray<ArtifactFile>,
  expectedCount: number,
  truncated = false,
): ArtifactCoverage =>
  truncated || files.length !== expectedCount || files.some((file) => file.coverage === 'truncated')
    ? 'truncated'
    : files.some((file) => file.coverage === 'opaque')
      ? 'opaque'
      : 'complete';

/** Normalize an already acquired GitHub file response into the shared Range Artifact contract. */
export const createGitHubRangeArtifact = ({
  baseSha,
  files: values,
  headSha,
  incompleteReason,
  project,
  truncated = false,
}: {
  baseSha: GitSha;
  files: ReadonlyArray<unknown>;
  headSha: GitSha;
  incompleteReason?: string;
  project: ReviewArtifactProject;
  truncated?: boolean;
}): RangeArtifact => {
  const files = values
    .map(normalizeGitHubArtifactFile)
    .filter((file): file is ArtifactFile => file != null);
  return validateRangeArtifact({
    baseSha,
    coverage: artifactCoverage(files, values.length, truncated || incompleteReason != null),
    files,
    headSha,
    ...(incompleteReason != null ? { incompleteReason } : {}),
    provenance: { kind: 'github-api', project },
  });
};

const normalizeGitHubArtifactCommit = (value: unknown): ReviewCommitSummary | null => {
  if (!isRecord(value)) {
    return null;
  }
  const sha = gitSha(value.sha);
  const commit = isRecord(value.commit) ? value.commit : {};
  const author = isRecord(commit.author) ? commit.author : {};
  const topLevelAuthor = isRecord(value.author) ? value.author : {};
  const message = asString(commit.message);
  if (!sha) {
    return null;
  }
  const webUrl = asString(value.html_url);
  return {
    authoredAt: asString(author.date) || new Date(0).toISOString(),
    authorName: asString(author.name) || asString(topLevelAuthor.login),
    parentShas: asArray(value.parents)
      .map((parent) => (isRecord(parent) ? gitSha(parent.sha) : null))
      .filter((parent): parent is GitSha => parent != null),
    sha,
    shortSha: shortSha(sha),
    subject: message.split('\n')[0] || shortSha(sha),
    ...(webUrl ? { webUrl } : {}),
  };
};

const readGitHubCommitArtifact = async ({
  commit,
  project,
  pull,
  signal,
  transport,
}: {
  commit: CommitArtifactRequest;
  project: ReviewArtifactProject;
  pull: GitHubPullRequestRef;
  signal: AbortSignal;
  transport: GitHubTransport;
}) => {
  const rawFiles: Array<unknown> = [];
  let parentMismatch = false;
  let truncated = false;
  for (let page = 1; page <= 30; page += 1) {
    signal.throwIfAborted();
    const value = await transport.request<unknown>({
      maxBytes: MAX_ARTIFACT_RESPONSE_BYTES,
      path: githubCommitPath(pull, commit.commitSha),
      query: { page, per_page: 100 },
      signal,
    });
    if (!isRecord(value)) {
      truncated = true;
      break;
    }
    if (page === 1) {
      const firstParent = asArray(value.parents)
        .map((parent) => (isRecord(parent) ? gitSha(parent.sha) : null))
        .find((parent): parent is GitSha => parent != null);
      parentMismatch = (firstParent ?? null) !== commit.parentSha;
    }
    const pageFiles = asArray(value.files);
    rawFiles.push(...pageFiles);
    if (pageFiles.length < 100) {
      break;
    }
    if (page === 30) {
      truncated = true;
    }
  }
  const files = rawFiles
    .map(normalizeGitHubArtifactFile)
    .filter((file): file is ArtifactFile => file != null);
  return validateCommitArtifact({
    commitSha: commit.commitSha,
    coverage: artifactCoverage(files, rawFiles.length, truncated || parentMismatch),
    files,
    parentSha: commit.parentSha,
    provenance: { kind: 'github-api' as const, project },
  });
};

/** Resolve one immutable GitHub ref+path coordinate to a normalized Blob Artifact. */
export const readGitHubFileBlobArtifact = async ({
  maxBytes,
  path,
  project,
  pull,
  ref,
  signal,
  transport,
}: FileBlobArtifactRequest & {
  maxBytes: number;
  project: ReviewArtifactProject;
  pull: GitHubPullRequestRef;
  signal?: AbortSignal;
  transport: GitHubTransport;
}): Promise<BlobArtifact | null> => {
  const limit = normalizeBlobArtifactMaxBytes(maxBytes);
  signal?.throwIfAborted();
  const value = await transport.request<unknown>({
    maxBytes: Math.ceil(limit / 3) * 4 + 64 * 1024,
    path: githubContentsPath(pull, path),
    query: { ref },
    signal,
  });
  signal?.throwIfAborted();
  if (!isRecord(value)) {
    return null;
  }
  const objectId = gitSha(value.sha);
  if (!objectId) {
    return null;
  }
  const content = asString(value.content);
  const bytes =
    asString(value.encoding).toLowerCase() === 'base64' && content
      ? decodeBase64File(content, limit)
      : null;
  if (bytes) {
    return { bytes, objectId, provenance: { kind: 'github-api', project } };
  }
  if (!transport.requestBuffer) {
    return null;
  }
  const raw = await transport.requestBuffer({
    accept: 'application/vnd.github.raw+json',
    maxBytes: limit,
    path: githubBlobPath(pull, objectId),
    signal,
  });
  signal?.throwIfAborted();
  return raw.byteLength <= limit
    ? { bytes: raw, objectId, provenance: { kind: 'github-api', project } }
    : null;
};

/** Create the bounded GitHub API backend for one repository. */
export const createGitHubArtifactSource = ({
  maxBlobArtifactBytes,
  project,
  pull,
  transport,
}: {
  maxBlobArtifactBytes?: number;
  project: ReviewArtifactProject;
  pull: GitHubPullRequestRef;
  transport: GitHubTransport;
}): ReviewArtifactSource => {
  const blobArtifactMaxBytes = normalizeBlobArtifactMaxBytes(maxBlobArtifactBytes);
  const provenance = { kind: 'github-api' as const, project };
  return {
    async readBlobs(objectIds, signal) {
      if (!transport.requestBuffer) {
        return new Map();
      }
      const pending = [...new Set(objectIds)];
      const blobs = new Map<string, BlobArtifact>();
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < pending.length) {
          signal.throwIfAborted();
          const objectId = pending[nextIndex++]!;
          try {
            const bytes = await transport.requestBuffer!({
              accept: 'application/vnd.github.raw+json',
              maxBytes: blobArtifactMaxBytes,
              path: githubBlobPath(pull, objectId),
              signal,
            });
            if (bytes.byteLength > blobArtifactMaxBytes) {
              continue;
            }
            blobs.set(objectId, { bytes, objectId, provenance });
          } catch {
            signal.throwIfAborted();
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(versionCommitEvidenceConcurrency, pending.length) }, worker),
      );
      return blobs;
    },
    async readCommitArtifacts(commits, signal) {
      const pending = [
        ...new Map(
          commits.map((commit) => [createCommitArtifactRequestKey(commit), commit]),
        ).values(),
      ];
      const artifacts = new Map();
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < pending.length) {
          signal.throwIfAborted();
          const commit = pending[nextIndex++]!;
          try {
            artifacts.set(
              createCommitArtifactRequestKey(commit),
              await readGitHubCommitArtifact({
                commit,
                project,
                pull,
                signal,
                transport,
              }),
            );
          } catch {
            signal.throwIfAborted();
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(versionCommitEvidenceConcurrency, pending.length) }, worker),
      );
      return artifacts;
    },
    async readFileBlobs(requests, signal) {
      const pending = [
        ...new Map(
          requests.map((request) => [createFileBlobArtifactRequestKey(request), request]),
        ).values(),
      ];
      const blobs = new Map<string, BlobArtifact>();
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < pending.length) {
          signal.throwIfAborted();
          const request = pending[nextIndex++]!;
          try {
            const blob = await readGitHubFileBlobArtifact({
              ...request,
              maxBytes: Math.min(request.maxBytes ?? blobArtifactMaxBytes, blobArtifactMaxBytes),
              project,
              pull,
              signal,
              transport,
            });
            if (blob) {
              blobs.set(createFileBlobArtifactRequestKey(request), blob);
            }
          } catch {
            signal.throwIfAborted();
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(versionCommitEvidenceConcurrency, pending.length) }, worker),
      );
      return blobs;
    },
    async readStackAndRange({ headSha: head, requestedBaseSha: base }, signal) {
      if (base === head) {
        return {
          range: validateRangeArtifact({
            baseSha: base,
            coverage: 'complete',
            files: [],
            headSha: head,
            provenance,
          }),
          stack: validateStackSnapshot({
            baseSha: base,
            commits: [],
            coverage: 'complete',
            headSha: head,
            provenance,
          }),
        };
      }
      const path = githubComparePath(pull, base, head);
      const first = await transport.request<unknown>({
        maxBytes: MAX_ARTIFACT_RESPONSE_BYTES,
        path,
        query: { page: 1, per_page: 100 },
        signal,
      });
      if (!isRecord(first)) {
        throw new Error('GitHub returned an invalid repository comparison.');
      }
      const effectiveBase =
        isRecord(first.merge_base_commit) && typeof first.merge_base_commit.sha === 'string'
          ? (gitSha(first.merge_base_commit.sha) ?? base)
          : base;
      const totalCommits = asNumber(first.total_commits);
      let rawCommits = [...asArray(first.commits)];
      let stackTruncated = totalCommits == null || totalCommits !== rawCommits.length;
      if (totalCommits != null && totalCommits > rawCommits.length) {
        const lastPage = Math.ceil(totalCommits / 100);
        const last = await transport.request<unknown>({
          maxBytes: MAX_ARTIFACT_RESPONSE_BYTES,
          path,
          query: { page: lastPage, per_page: 100 },
          signal,
        });
        if (!isRecord(last)) {
          throw new Error('GitHub returned an invalid final comparison page.');
        }
        rawCommits = [...asArray(last.commits)];
      }
      if (rawCommits.length > versionCommitStackLimit) {
        rawCommits = rawCommits.slice(-versionCommitStackLimit);
        stackTruncated = true;
      }
      const commits = orderReviewCommitStack(
        rawCommits
          .map(normalizeGitHubArtifactCommit)
          .filter((commit): commit is ReviewCommitSummary => commit != null),
      );
      const rawFiles = asArray(first.files);
      const range = createGitHubRangeArtifact({
        baseSha: effectiveBase,
        files: rawFiles,
        headSha: head,
        project,
        truncated: rawFiles.length >= 300,
      });
      const stack: StackSnapshot = {
        baseSha: effectiveBase,
        commits,
        coverage: stackTruncated || commits.length !== rawCommits.length ? 'truncated' : 'complete',
        headSha: head,
        provenance,
      };
      return {
        range,
        stack: validateStackSnapshot(stack),
      };
    },
  };
};

/**
 * Parse force-push records from the PR timeline / issue events API.
 */
export const normalizeForcePushEvent = (value: unknown): ForcePushEvent | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const event = value as {
    actor?: { login?: unknown };
    after?: unknown;
    after_commit_oid?: unknown;
    afterCommit?: { oid?: unknown };
    before?: unknown;
    before_commit_oid?: unknown;
    beforeCommit?: { oid?: unknown };
    commit_id?: unknown;
    commit_oid?: unknown;
    created_at?: unknown;
    createdAt?: unknown;
    event?: unknown;
    payload?: { after?: unknown; before?: unknown };
    type?: unknown;
    user?: { login?: unknown };
  };
  const eventName = String(event.event || event.type || '');
  const hasNestedCommitPair =
    typeof event.beforeCommit?.oid === 'string' && typeof event.afterCommit?.oid === 'string';
  if (
    eventName !== 'head_ref_force_pushed' &&
    eventName !== 'HeadRefForcePushedEvent' &&
    !(event.commit_id && event.commit_oid) &&
    !hasNestedCommitPair
  ) {
    if (eventName !== 'force-push' && event.event !== 'force-pushed') {
      if (!(typeof event.before === 'string' && typeof event.after === 'string')) {
        return null;
      }
    }
  }

  const before = gitSha(
    (typeof event.before === 'string' && event.before) ||
      (typeof event.beforeCommit?.oid === 'string' && event.beforeCommit.oid) ||
      (typeof event.before_commit_oid === 'string' && event.before_commit_oid) ||
      (typeof event.payload?.before === 'string' && event.payload.before) ||
      (typeof event.commit_id === 'string' && event.commit_id) ||
      '',
  );
  const after = gitSha(
    (typeof event.after === 'string' && event.after) ||
      (typeof event.afterCommit?.oid === 'string' && event.afterCommit.oid) ||
      (typeof event.after_commit_oid === 'string' && event.after_commit_oid) ||
      (typeof event.payload?.after === 'string' && event.payload.after) ||
      (typeof event.commit_oid === 'string' && event.commit_oid) ||
      '',
  );
  const createdAt =
    (typeof event.created_at === 'string' && event.created_at) ||
    (typeof event.createdAt === 'string' && event.createdAt) ||
    new Date(0).toISOString();

  if (!before || !after) {
    return null;
  }
  if (before === after) {
    return null;
  }

  return {
    after,
    before,
    createdAt,
    ...(typeof event.actor?.login === 'string'
      ? { actorLogin: event.actor.login }
      : typeof event.user?.login === 'string'
        ? { actorLogin: event.user.login }
        : {}),
  };
};

/** Parse ordinary branch pushes used to fill gaps between force-push events. */
export const normalizePushEvent = (value: unknown): PushEvent | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const event = value as {
    created_at?: unknown;
    payload?: { before?: unknown; head?: unknown; ref?: unknown };
    type?: unknown;
  };
  if (event.type !== 'PushEvent' || event.payload?.ref == null) {
    return null;
  }
  const before = gitSha(event.payload.before);
  const after = gitSha(event.payload.head);
  const createdAt = typeof event.created_at === 'string' ? event.created_at : '';
  return before && after && before !== after && createdAt
    ? { after, before, createdAt, label: 'Push' }
    : null;
};

type ForcePushGraphqlResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        timelineItems?: {
          nodes?: ReadonlyArray<unknown>;
          pageInfo?: { endCursor?: string | null; hasNextPage?: boolean };
        };
      };
    };
  };
};

export const readForcePushTimeline = async ({
  pull,
  transport,
}: {
  pull: GitHubPullRequestRef;
  transport: GitHubTransport;
}): Promise<{
  baseOwner: string;
  baseRepo: string;
  currentBase: GitSha | null;
  currentHead: GitSha | null;
  currentHeadCreatedAt: string;
  events: ReadonlyArray<ForcePushEvent>;
  headOwner: string | null;
  headRef: string | null;
  headRepo: string | null;
  pushEvents: ReadonlyArray<PushEvent>;
  warning: string | null;
}> => {
  const { number, owner, repo } = pull;
  let warning: string | null = null;
  let events: Array<ForcePushEvent> = [];
  let pushEvents: Array<PushEvent> = [];

  if (transport.graphql) {
    try {
      let cursor: string | null = null;
      do {
        const response: ForcePushGraphqlResponse =
          await transport.graphql<ForcePushGraphqlResponse>({
            maxBytes: MAX_OPTIONAL_PROVIDER_RESPONSE_BYTES,
            query: `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      timelineItems(first: 100, after: $cursor, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
        nodes {
          __typename
          ... on HeadRefForcePushedEvent {
            actor { login }
            afterCommit { oid }
            beforeCommit { oid }
            createdAt
          }
        }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
}`,
            variables: { cursor, number, owner, repo },
          });
        const timeline = response.data?.repository?.pullRequest?.timelineItems;
        events.push(
          ...(timeline?.nodes ?? [])
            .map(normalizeForcePushEvent)
            .filter((event): event is ForcePushEvent => event != null),
        );
        cursor = timeline?.pageInfo?.hasNextPage ? (timeline.pageInfo.endCursor ?? null) : null;
      } while (cursor);
    } catch (error) {
      warning =
        error instanceof Error
          ? `Force-push GraphQL history unavailable (${error.message}).`
          : 'Force-push GraphQL history unavailable.';
    }
  }

  if (events.length === 0) {
    try {
      const timeline = await transport.request<unknown>({
        maxBytes: MAX_OPTIONAL_PROVIDER_RESPONSE_BYTES,
        paginate: true,
        path: `/repos/${owner}/${repo}/issues/${number}/timeline`,
        query: { per_page: 100 },
      });
      events = (Array.isArray(timeline) ? timeline : [])
        .map(normalizeForcePushEvent)
        .filter((event): event is ForcePushEvent => event != null);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warning = [warning, `Force-push timeline unavailable (${detail}).`].filter(Boolean).join(' ');
    }
  }

  let currentHead: GitSha | null = pull.headSha ?? null;
  let currentBase: GitSha | null = null;
  let currentHeadCreatedAt = pull.updatedAt ?? new Date(0).toISOString();
  let createdAt = pull.createdAt ?? null;
  let baseOwner = pull.baseOwner ?? owner;
  let baseRepo = pull.baseRepo ?? repo;
  let headOwner = pull.headOwner ?? null;
  let headRepo = pull.headRepo ?? null;
  let headRef = pull.headRef ?? null;
  try {
    const pr = await transport.request<{
      base?: { repo?: { name?: unknown; owner?: { login?: unknown } }; sha?: unknown };
      created_at?: unknown;
      head?: {
        ref?: unknown;
        repo?: { name?: unknown; owner?: { login?: unknown } };
        sha?: unknown;
      };
      updated_at?: unknown;
    }>({
      path: `/repos/${owner}/${repo}/pulls/${number}`,
    });
    const parsedHead = gitSha(pr?.head?.sha);
    if (parsedHead) {
      currentHead = parsedHead;
    }
    const parsedBase = gitSha(pr?.base?.sha);
    if (parsedBase) {
      currentBase = parsedBase;
    }
    if (typeof pr?.updated_at === 'string') {
      currentHeadCreatedAt = pr.updated_at;
    } else if (typeof pr?.created_at === 'string') {
      currentHeadCreatedAt = pr.created_at;
    }
    if (typeof pr?.base?.repo?.owner?.login === 'string') {
      baseOwner = pr.base.repo.owner.login;
    }
    if (typeof pr?.base?.repo?.name === 'string') {
      baseRepo = pr.base.repo.name;
    }
    if (typeof pr?.created_at === 'string') {
      createdAt = pr.created_at;
    }
    if (typeof pr?.head?.ref === 'string') {
      headRef = pr.head.ref;
    }
    if (typeof pr?.head?.repo?.owner?.login === 'string') {
      headOwner = pr.head.repo.owner.login;
    }
    if (typeof pr?.head?.repo?.name === 'string') {
      headRepo = pr.head.repo.name;
    }
  } catch {
    // Keep source headSha if PR metadata fails.
  }

  if (headOwner && headRepo && headRef) {
    try {
      const repositoryEvents = await transport.request<unknown>({
        maxBytes: MAX_OPTIONAL_PROVIDER_RESPONSE_BYTES,
        paginate: true,
        path: `/repos/${headOwner}/${headRepo}/events`,
        query: { per_page: 100 },
      });
      const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NEGATIVE_INFINITY;
      pushEvents = (Array.isArray(repositoryEvents) ? repositoryEvents : []).flatMap((value) => {
        const event = normalizePushEvent(value);
        const ref =
          value && typeof value === 'object'
            ? (value as { payload?: { ref?: unknown } }).payload?.ref
            : null;
        return event &&
          ref === `refs/heads/${headRef}` &&
          Date.parse(event.createdAt) >= createdAtMs
          ? [event]
          : [];
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warning = [warning, `Normal push history is incomplete (${detail}).`]
        .filter(Boolean)
        .join(' ');
    }
  }

  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NEGATIVE_INFINITY;
  events = events.filter((event) => Date.parse(event.createdAt) >= createdAtMs);

  return {
    baseOwner,
    baseRepo,
    currentBase,
    currentHead,
    currentHeadCreatedAt,
    events,
    headOwner,
    headRef,
    headRepo,
    pushEvents,
    warning,
  };
};

/**
 * Build the minimum ordered version selector from force-push heads + the
 * current head. Reviewer activity is deliberately a separate enrichment.
 */
export const listGitHubReviewVersionTimeline = async ({
  git,
  pull,
  transport,
}: {
  git?: GitHubHistoryGit;
  pull: GitHubPullRequestRef;
  transport: GitHubTransport;
}): Promise<{
  versions: ReadonlyArray<ReviewVersionOption>;
  warning: string | null;
}> => {
  const {
    baseOwner,
    baseRepo,
    currentBase,
    currentHead,
    currentHeadCreatedAt,
    events,
    headOwner,
    headRepo,
    pushEvents,
    warning,
  } = await readForcePushTimeline({ pull, transport });
  if (!currentBase) {
    return {
      versions: [],
      warning: warning ?? 'The current pull request base is unavailable.',
    };
  }

  const heads: Array<{ createdAt: string; label: string; sha: GitSha }> = [];
  const headIndexBySha = new Map<GitSha, number>();
  const seen = new Set<GitSha>();
  const moveHeadToTail = (sha: GitSha, createdAt: string, label: string) => {
    const existingIndex = headIndexBySha.get(sha);
    if (existingIndex != null) {
      heads.splice(existingIndex, 1);
    } else {
      seen.add(sha);
    }
    heads.push({ createdAt, label, sha });
    headIndexBySha.clear();
    heads.forEach((head, index) => headIndexBySha.set(head.sha, index));
  };

  const chronological = [
    ...pushEvents,
    ...events.map((event) => ({ ...event, label: 'Force-push' })),
  ].toSorted((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  for (const event of chronological) {
    if (event.before !== currentBase && !isNullSha(event.before) && !seen.has(event.before)) {
      moveHeadToTail(event.before, event.createdAt, `Head · ${shortSha(event.before)}`);
    }
    moveHeadToTail(event.after, event.createdAt, `${event.label} · ${shortSha(event.after)}`);
  }

  if (currentHead && !seen.has(currentHead)) {
    moveHeadToTail(currentHead, currentHeadCreatedAt, 'Current head');
  } else if (currentHead) {
    const index = headIndexBySha.get(currentHead);
    if (index != null) {
      moveHeadToTail(currentHead, heads[index]!.createdAt, 'Current head');
    }
  }

  if (heads.length === 0) {
    return {
      versions: [],
      warning: warning ?? 'No force-push head history is available for this pull request.',
    };
  }

  const bases = await Promise.all(
    heads.map(async (head) => {
      if (!git) {
        return {
          baseSha: currentBase,
          unavailableReason:
            'Historical head materialization is unavailable in this local repository.',
        };
      }
      try {
        await Promise.all([
          git.ensureCommit(currentBase, {
            repositories: [{ owner: baseOwner, repo: baseRepo }],
          }),
          git.ensureCommit(head.sha, {
            repositories: [
              ...(headOwner && headRepo ? [{ owner: headOwner, repo: headRepo }] : []),
              { owner: baseOwner, repo: baseRepo },
            ],
          }),
        ]);
        return { baseSha: await git.mergeBase(currentBase, head.sha) };
      } catch (error) {
        return {
          baseSha: currentBase,
          unavailableReason:
            error instanceof Error
              ? `Historical head is unavailable: ${error.message}`
              : 'Historical head is unavailable in this local repository.',
        };
      }
    }),
  );

  const versions = heads.map((head, index) => {
    const { baseSha, unavailableReason } = bases[index]!;
    return reviewVersionOption({
      createdAt: head.createdAt,
      isHead: currentHead != null && head.sha === currentHead,
      number: index + 1,
      range: diffRange(
        revisionRef(baseSha, commitRevisionLabel(shortSha(baseSha))),
        revisionRef(head.sha, versionRevisionLabel(head.label)),
      ),
      versionId: reviewVersionId(head.sha),
      ...(index > 0
        ? {
            previousCreatedAt: heads[index - 1]!.createdAt,
            previousNumber: index,
          }
        : {}),
      ...(unavailableReason ? { unavailableReason } : {}),
    });
  });

  return {
    versions,
    warning,
  };
};

const activityVersion = (
  value: Record<string, unknown>,
  versions: ReadonlyArray<ReviewVersionOption>,
) => {
  const activitySha = gitSha(value.commit_id ?? value.original_commit_id);
  if (activitySha) {
    const exact = versions.find((version) => shaForRevision(version.range.head) === activitySha);
    if (exact) {
      return exact;
    }
  }
  const occurredAt = Date.parse(asString(value.submitted_at ?? value.created_at));
  return [...versions]
    .filter((version) => Date.parse(version.createdAt) <= occurredAt)
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
};

/** Derive authenticated-reviewer reviews and comments by immutable PR head. */
export const fetchGitHubPullRequestReviewerActivity = async ({
  pull,
  transport,
  versions,
}: {
  pull: GitHubPullRequestRef;
  transport: GitHubTransport;
  versions: ReadonlyArray<ReviewVersionOption>;
}): Promise<ReadonlyMap<ReviewVersionId, ReviewVersionOption['activity']>> => {
  let viewerLogin: string;
  try {
    const viewer = await transport.request<unknown>({
      maxBytes: MAX_OPTIONAL_PROVIDER_RESPONSE_BYTES,
      path: '/user',
    });
    viewerLogin = isRecord(viewer) ? asString(viewer.login).toLowerCase() : '';
  } catch {
    return new Map();
  }
  if (!viewerLogin) {
    return new Map();
  }
  const basePath = `/repos/${pull.owner}/${pull.repo}`;
  const results = await Promise.allSettled([
    transport.request<unknown>({
      maxBytes: MAX_OPTIONAL_PROVIDER_RESPONSE_BYTES,
      paginate: true,
      path: `${basePath}/pulls/${pull.number}/reviews`,
      query: { per_page: 100 },
    }),
    transport.request<unknown>({
      maxBytes: MAX_OPTIONAL_PROVIDER_RESPONSE_BYTES,
      paginate: true,
      path: `${basePath}/pulls/${pull.number}/comments`,
      query: { per_page: 100 },
    }),
    transport.request<unknown>({
      maxBytes: MAX_OPTIONAL_PROVIDER_RESPONSE_BYTES,
      paginate: true,
      path: `${basePath}/issues/${pull.number}/comments`,
      query: { per_page: 100 },
    }),
  ]);
  const reasonsByVersion = new Map<ReviewVersionId, Array<ReviewVersionActivityReason>>();
  const seen = new Set<string>();
  results.forEach((result, sourceIndex) => {
    if (result.status !== 'fulfilled') {
      return;
    }
    for (const item of asArray(result.value)) {
      if (!isRecord(item) || !isRecord(item.user)) {
        continue;
      }
      if (asString(item.user.login).toLowerCase() !== viewerLogin) {
        continue;
      }
      const itemId = asIdentity(item.id);
      const identity = `${sourceIndex}:${itemId}`;
      const occurredAt = asString(item.submitted_at ?? item.created_at);
      if (
        !itemId ||
        seen.has(identity) ||
        !occurredAt ||
        !Number.isFinite(Date.parse(occurredAt))
      ) {
        continue;
      }
      seen.add(identity);
      const version = activityVersion(item, versions);
      if (!version) {
        continue;
      }
      const reasons = reasonsByVersion.get(version.versionId) ?? [];
      reasons.push({
        kind:
          sourceIndex === 0
            ? asString(item.state).toUpperCase() === 'APPROVED'
              ? 'approval'
              : 'review'
            : 'comment',
        occurredAt,
      });
      reasonsByVersion.set(version.versionId, reasons);
    }
  });
  return new Map(
    [...reasonsByVersion].map(([versionId, reasons]) => [
      versionId,
      {
        latestAt: reasons
          .map((reason) => reason.occurredAt)
          .toSorted()
          .at(-1)!,
        reasons: reasons.toSorted((left, right) => left.occurredAt.localeCompare(right.occurredAt)),
      },
    ]),
  );
};

/**
 * Build version options with optional reviewer-activity decoration. Callers
 * that need the first usable selector can use
 * {@link listGitHubReviewVersionTimeline} and defer this richer projection.
 */
export const listGitHubReviewVersions = async ({
  git,
  pull,
  transport,
}: {
  git?: GitHubHistoryGit;
  pull: GitHubPullRequestRef;
  transport: GitHubTransport;
}): Promise<{
  versions: ReadonlyArray<ReviewVersionOption>;
  warning: string | null;
}> => {
  const { versions, warning } = await listGitHubReviewVersionTimeline({ git, pull, transport });
  const activity = await fetchGitHubPullRequestReviewerActivity({
    pull,
    transport,
    versions,
  });
  return {
    versions: versions.map((version) => {
      const versionActivity = activity.get(version.versionId);
      return versionActivity ? { ...version, activity: versionActivity } : version;
    }),
    warning,
  };
};

const toMatcherCommit = (commit: GitHubCommitLike) => ({
  authoredDate: commit.authoredAt,
  authorName: commit.authorName,
  message: commit.message ?? commit.subject,
  parentShas: commit.parentShas,
  sha: commit.sha,
  shortSha: commit.shortSha,
  title: commit.title ?? commit.subject,
  webUrl: commit.webUrl ?? '',
});

const patchBodyFromSection = (patch: string) => {
  const hunkStart = patch.search(/^@@\s/m);
  return hunkStart === -1 ? '' : patch.slice(hunkStart);
};

const isGitHubHostRangePatchFiles = (
  value: GitHubRangePatchFiles,
): value is GitHubHostRangePatchFiles => !Array.isArray(value);

const patchFileCoverage = (files: ReadonlyArray<ReplayPatchFile>): ArtifactCoverage =>
  files.some((file) => file.coverage === 'truncated')
    ? 'truncated'
    : files.some((file) => file.coverage === 'opaque')
      ? 'opaque'
      : 'complete';

const incompleteRangePatchFiles = (
  files: ReadonlyArray<ReplayPatchFile>,
  coverage: Exclude<ArtifactCoverage, 'complete'>,
) =>
  files.map((file) =>
    file.coverage === 'complete' || file.coverage == null ? { ...file, coverage } : file,
  );

const toReplayPatchFiles = (files: ReadonlyArray<ChangedFile>): ReadonlyArray<ReplayPatchFile> =>
  files.map((file) => ({
    newPath: file.path,
    oldPath: file.oldPath ?? file.path,
    patchBody: file.sections.map((section) => patchBodyFromSection(section.patch)).join('\n'),
    status:
      file.status === 'added' ||
      file.status === 'deleted' ||
      file.status === 'renamed' ||
      file.status === 'modified'
        ? file.status
        : 'modified',
  }));

const readRangePatchFiles = async (
  git: GitHubHistoryGit,
  base: GitSha,
  head: GitSha,
  signal?: AbortSignal,
): Promise<{ coverage: ArtifactCoverage; files: ReadonlyArray<ReplayPatchFile> }> => {
  signal?.throwIfAborted();
  const value = git.readRangePatchFiles
    ? await git.readRangePatchFiles(base, head, signal)
    : toReplayPatchFiles(await git.readRangeFiles(base, head, false, signal));
  signal?.throwIfAborted();
  const files = isGitHubHostRangePatchFiles(value) ? [...value.files] : [...value];
  const fileCoverage = patchFileCoverage(files);
  const coverage = isGitHubHostRangePatchFiles(value)
    ? value.coverage === 'truncated' || fileCoverage === 'truncated'
      ? 'truncated'
      : value.coverage === 'opaque' || fileCoverage === 'opaque'
        ? 'opaque'
        : 'complete'
    : fileCoverage;
  return {
    coverage,
    files: coverage === 'complete' ? files : incompleteRangePatchFiles(files, coverage),
  };
};

const readCommitPatchFiles = async (
  git: GitHubHistoryGit,
  sha: GitSha,
): Promise<ReadonlyArray<ReplayPatchFile>> =>
  git.readCommitPatchFiles
    ? git.readCommitPatchFiles(sha)
    : toReplayPatchFiles(await git.readCommitDiff(sha));

const readReplayBlob = (git: GitHubHistoryGit) => {
  if (!git.readBlob) {
    return async () => null;
  }
  return (path: string, ref: string) => git.readBlob!(path, ref as GitSha);
};

const countPatchLines = (files: ReadonlyArray<ChangedFile>) => {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const section of file.sections) {
      for (const line of section.patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          additions += 1;
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
          deletions += 1;
        }
      }
    }
  }
  return {
    additions,
    deletions,
    filesChanged: files.length,
  };
};

const BASE_MOVEMENT_COMMIT_LIMIT = 40;

/**
 * Classify target-base movement between two PR head snapshots using local git
 * ancestry + exclusive commit lists (GitLab parity fields).
 */
export const buildBaseMovement = async ({
  fromBase,
  git,
  toBase,
}: {
  fromBase: GitSha;
  git: GitHubHistoryGit;
  toBase: GitSha;
}): Promise<DiffComparisonBaseMovement> => {
  const baseRef = async (sha: GitSha) => {
    try {
      const meta = await git.readCommitMeta(sha);
      return {
        committedAt: meta.authoredAt,
        sha,
        shortSha: meta.shortSha || shortSha(sha),
        ...(meta.webUrl ? { webUrl: meta.webUrl } : {}),
      };
    } catch {
      return {
        committedAt: null,
        sha,
        shortSha: shortSha(sha),
      };
    }
  };

  if (fromBase === toBase) {
    const [from, to] = await Promise.all([baseRef(fromBase), baseRef(toBase)]);
    return {
      changed: false,
      commits: [],
      commitsBetween: 0,
      commitTimestampDeltaMs: null,
      diffStat: { additions: 0, deletions: 0, filesChanged: 0 },
      from,
      relationship: 'forward',
      to,
      truncated: false,
    };
  }

  try {
    await Promise.all([git.ensureCommit(fromBase), git.ensureCommit(toBase)]);
    const [from, to, forwardIsAncestor, backwardIsAncestor] = await Promise.all([
      baseRef(fromBase),
      baseRef(toBase),
      git.isAncestor(fromBase, toBase),
      git.isAncestor(toBase, fromBase),
    ]);

    let relationship: DiffComparisonBaseMovement['relationship'] = 'unknown';
    let movementCommits: ReadonlyArray<GitHubCommitLike> = [];
    let truncated = false;
    let commitsBetween: number | null = null;
    const readCanonicalStack = async (base: GitSha, head: GitSha) =>
      orderReviewCommitStack(await git.readCommitStack(base, head));

    if (forwardIsAncestor) {
      relationship = 'forward';
      const stack = await readCanonicalStack(fromBase, toBase);
      truncated = stack.length > BASE_MOVEMENT_COMMIT_LIMIT;
      movementCommits = truncated ? stack.slice(-BASE_MOVEMENT_COMMIT_LIMIT) : stack;
      commitsBetween = truncated ? null : stack.length;
    } else if (backwardIsAncestor) {
      relationship = 'backward';
      const stack = await readCanonicalStack(toBase, fromBase);
      truncated = stack.length > BASE_MOVEMENT_COMMIT_LIMIT;
      movementCommits = truncated ? stack.slice(-BASE_MOVEMENT_COMMIT_LIMIT) : stack;
      commitsBetween = truncated ? null : stack.length;
    } else {
      relationship = 'divergent';
      // Prefer new-base-facing exclusive commits for UI expansion.
      const stack = await readCanonicalStack(fromBase, toBase);
      truncated = stack.length > BASE_MOVEMENT_COMMIT_LIMIT;
      movementCommits = truncated ? stack.slice(-BASE_MOVEMENT_COMMIT_LIMIT) : stack;
      commitsBetween = stack.length;
    }

    let diffStat: DiffComparisonBaseMovement['diffStat'] = null;
    try {
      const files = await git.readRangeFiles(fromBase, toBase, false);
      diffStat = countPatchLines(files);
    } catch {
      // Diffstat is best-effort when objects are shallow.
    }

    const fromTimestamp = from.committedAt ? Date.parse(from.committedAt) : Number.NaN;
    const toTimestamp = to.committedAt ? Date.parse(to.committedAt) : Number.NaN;

    return {
      changed: true,
      commits: movementCommits.map((commit) => ({
        authoredAt: commit.authoredAt,
        authorName: commit.authorName,
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        ...(commit.webUrl ? { webUrl: commit.webUrl } : {}),
      })),
      commitsBetween,
      commitTimestampDeltaMs:
        Number.isFinite(fromTimestamp) && Number.isFinite(toTimestamp)
          ? toTimestamp - fromTimestamp
          : null,
      diffStat,
      from,
      relationship,
      to,
      truncated,
    };
  } catch (error) {
    const [from, to] = await Promise.all([baseRef(fromBase), baseRef(toBase)]);
    return {
      changed: true,
      commits: [],
      commitsBetween: null,
      commitTimestampDeltaMs: null,
      diffStat: null,
      from,
      relationship: 'unknown',
      to,
      truncated: false,
      warning: error instanceof Error ? error.message : 'Base movement details are unavailable.',
    };
  }
};

export type GitHubVersionCommitFingerprintCache = {
  read?(shas: ReadonlyArray<GitSha>): Promise<ReadonlyMap<GitSha, CommitFingerprint>>;
  write?(fingerprints: ReadonlyArray<CommitFingerprint>): Promise<void>;
};

type GitHubVersionEvolutionControl = {
  /** Host-only metrics for global commit assignment. */
  onMatcherDiagnostics?: (diagnostics: CommitStackMatchDiagnostics) => void;
  onProgress?: (progress: {
    commits?: ReadonlyArray<ReviewCommitSummary>;
    completed?: number;
    exactMatchShas?: ReadonlyArray<GitSha>;
    message: string;
    phase:
      | 'reading-stacks'
      | 'reading-mr-evidence'
      | 'reading-base-stack'
      | 'reading-base-evidence'
      | 'composing-units';
    total?: number;
  }) => void;
  signal?: AbortSignal;
};

const toProgressCommit = (commit: GitHubCommitLike): ReviewCommitSummary => ({
  authoredAt: commit.authoredAt,
  authorName: commit.authorName,
  parentShas: commit.parentShas,
  sha: commit.sha,
  shortSha: commit.shortSha,
  subject: commit.subject,
  ...(commit.webUrl ? { webUrl: commit.webUrl } : {}),
});

const loadGitHubFingerprints = async ({
  cache,
  commits,
  fingerprints,
  git,
  signal,
}: {
  cache?: GitHubVersionCommitFingerprintCache;
  commits: ReadonlyArray<GitHubCommitLike>;
  fingerprints: Map<GitSha, CommitFingerprint>;
  git: GitHubHistoryGit;
  signal?: AbortSignal;
}) => {
  const requestedShas = commits.map((commit) => commit.sha).filter((sha) => !fingerprints.has(sha));
  try {
    for (const [sha, fingerprint] of (await cache?.read?.(requestedShas)) ?? []) {
      fingerprints.set(sha, fingerprint);
    }
  } catch {
    // Cache reads are best-effort; compute directly after corruption or I/O failure.
  }
  const missingShas = requestedShas.filter((sha) => !fingerprints.has(sha));
  const missingCommits = commits
    .filter((commit) => missingShas.includes(commit.sha))
    .map((commit) => ({ commitSha: commit.sha, parentSha: commit.parentShas[0] ?? null }));
  let artifacts: ReadonlyMap<GitSha, CommitArtifact> = new Map();
  try {
    artifacts = await git.readCommitArtifacts(missingCommits, signal);
  } catch {
    signal?.throwIfAborted();
    // Missing historical objects remain ambiguous without failing the comparison.
  }
  const newFingerprints: Array<CommitFingerprint> = [];
  for (const commit of commits) {
    if (fingerprints.has(commit.sha)) {
      continue;
    }
    const artifact = artifacts.get(commit.sha);
    if (!artifact) {
      continue;
    }
    const fingerprint = await createCommitFingerprint(toMatcherCommit(commit), artifact);
    fingerprints.set(commit.sha, fingerprint);
    newFingerprints.push(fingerprint);
  }
  if (newFingerprints.length > 0) {
    try {
      await cache?.write?.(newFingerprints);
    } catch {
      // Immutable cache writes are best-effort.
    }
  }
  return commits.filter((commit) => !fingerprints.has(commit.sha));
};

const buildFingerprintEvolution = async ({
  baseMoved,
  cache,
  control = {},
  from,
  git,
  loadBaseCommits,
  newCommits,
  oldCommits,
  to,
}: {
  baseMoved: boolean;
  cache?: GitHubVersionCommitFingerprintCache;
  control?: GitHubVersionEvolutionControl;
  from: DiffEndpointRef;
  git: GitHubHistoryGit;
  loadBaseCommits: () => Promise<ReadonlyArray<GitHubCommitLike>>;
  newCommits: ReadonlyArray<GitHubCommitLike>;
  oldCommits: ReadonlyArray<GitHubCommitLike>;
  to: DiffEndpointRef;
}): Promise<ReviewCommitEvolution> => {
  let limitedOld = [...orderReviewCommitStack(oldCommits)];
  let limitedNew = [...orderReviewCommitStack(newCommits)];
  const warnings: Array<string> = [];
  const stackCompleteness = { new: true, old: true };
  const { signal } = control;

  if (limitedOld.length > versionCommitStackLimit) {
    limitedOld = limitedOld.slice(-versionCommitStackLimit);
    stackCompleteness.old = false;
    warnings.push(
      `Only the latest ${versionCommitStackLimit} commits from the earlier head were analyzed; unmatched commits remain unclassified.`,
    );
  }
  if (limitedNew.length > versionCommitStackLimit) {
    limitedNew = limitedNew.slice(-versionCommitStackLimit);
    stackCompleteness.new = false;
    warnings.push(
      `Only the latest ${versionCommitStackLimit} commits from the later head were analyzed; unmatched commits remain unclassified.`,
    );
  }
  const sameShas = new Set(
    limitedOld
      .map((commit) => commit.sha)
      .filter((sha) => limitedNew.some((commit) => commit.sha === sha)),
  );
  const needingEvidence = [...limitedOld, ...limitedNew].filter(
    (commit, index, commits) =>
      !sameShas.has(commit.sha) &&
      commits.findIndex((candidate) => candidate.sha === commit.sha) === index,
  );

  const fingerprints = new Map<GitSha, CommitFingerprint>();
  control.onProgress?.({
    commits: limitedNew.map(toProgressCommit),
    completed: 0,
    exactMatchShas: [...sameShas],
    message: `Reading MR commit evidence 0/${needingEvidence.length}`,
    phase: 'reading-mr-evidence',
    total: needingEvidence.length,
  });
  const missingEvidence = await loadGitHubFingerprints({
    cache,
    commits: needingEvidence,
    fingerprints,
    git,
    signal,
  });
  if (missingEvidence.length > 0) {
    warnings.push(
      `Change evidence was unavailable for ${missingEvidence.length} ${missingEvidence.length === 1 ? 'commit' : 'commits'}; they remain unclassified rather than being called new or removed.`,
    );
    stackCompleteness.old = false;
    stackCompleteness.new = false;
  }
  const match = (baseCommits: ReadonlyArray<GitHubCommitLike>, baseStackComplete: boolean) =>
    matchVersionCommitStacks({
      baseCommits: baseCommits.map(toMatcherCommit),
      baseStackComplete,
      fingerprints,
      from,
      newCommits: limitedNew.map(toMatcherCommit),
      ...(control.onMatcherDiagnostics ? { onDiagnostics: control.onMatcherDiagnostics } : {}),
      oldCommits: limitedOld.map(toMatcherCommit),
      ...(signal ? { signal } : {}),
      stackCompleteness,
      to,
      warnings,
    });
  const compose = async (
    baseCommits: ReadonlyArray<GitHubCommitLike>,
    baseStackComplete: boolean,
  ) => {
    signal?.throwIfAborted();
    control.onProgress?.({ message: 'Composing Evolution Units', phase: 'composing-units' });
    return projectCommitEvolution(await match(baseCommits, baseStackComplete));
  };
  if (!baseMoved) {
    return compose([], true);
  }
  const preliminary = await match([], false);
  const unmatchedOldShas = new Set(
    preliminary.units
      .filter((unit) => unit.before && !unit.after && !unit.baseCommit)
      .map((unit) => unit.before!.sha),
  );
  if (unmatchedOldShas.size === 0) {
    return compose([], true);
  }
  control.onProgress?.({
    message: 'Reading target-base commit stack',
    phase: 'reading-base-stack',
  });
  const baseResult = await loadBaseCommits().then(
    (value) => ({ status: 'fulfilled' as const, value: [...orderReviewCommitStack(value)] }),
    () => ({ status: 'rejected' as const }),
  );
  signal?.throwIfAborted();
  let baseStackComplete = baseResult.status === 'fulfilled';
  let limitedBase = baseResult.status === 'fulfilled' ? baseResult.value : [];
  if (!baseStackComplete) {
    warnings.push(
      'Target-base movement could not be analyzed. Earlier commits that moved into the base remain unclassified.',
    );
  }
  if (limitedBase.length > versionCommitStackLimit) {
    limitedBase = limitedBase.slice(-versionCommitStackLimit);
    baseStackComplete = false;
  }
  const directBaseShas = new Set(
    limitedBase.filter((commit) => unmatchedOldShas.has(commit.sha)).map((commit) => commit.sha),
  );
  const baseNeedingEvidence = limitedBase.filter((commit) => !directBaseShas.has(commit.sha));
  const missingBaseEvidence = await loadGitHubFingerprints({
    cache,
    commits: baseNeedingEvidence,
    fingerprints,
    git,
    signal,
  });
  if (missingBaseEvidence.length > 0) {
    baseStackComplete = false;
    warnings.push(
      `Change evidence was unavailable for ${missingBaseEvidence.length} target-base ${missingBaseEvidence.length === 1 ? 'commit' : 'commits'}; earlier commits are only marked as removed when base evidence is complete.`,
    );
  }
  return compose(limitedBase, baseStackComplete);
};

export type GitHubReviewVersionComparisonInput = {
  git: GitHubHistoryGit;
  /** Host-only metrics for the exact aggregate regional replay. */
  onReplayDiagnostics?: (diagnostics: ReplayCompareDiagnostics) => void;
  pull: GitHubPullRequestRef;
  range: { fromVersionId: ReviewVersionId; toVersionId: ReviewVersionId };
  /** Superseding a comparison stops aggregate replay before it is presented. */
  signal?: AbortSignal;
  versions: ReadonlyArray<ReviewVersionOption>;
};

const resolveGitHubVersionPair = ({
  range,
  versions,
}: Pick<GitHubReviewVersionComparisonInput, 'range' | 'versions'>) => {
  const from = versions.find((version) => version.versionId === range.fromVersionId);
  const to = versions.find((version) => version.versionId === range.toVersionId);
  if (!from || !to) {
    throw new Error('Unknown GitHub head revision for comparison.');
  }
  return { from, to };
};

/** Load the aggregate From→To comparison independently of commit classification. */
export const compareGitHubReviewVersionAggregate = async ({
  git,
  onReplayDiagnostics,
  range,
  signal,
  versions,
}: GitHubReviewVersionComparisonInput): Promise<DiffComparisonView> => {
  signal?.throwIfAborted();
  const { from, to } = resolveGitHubVersionPair({ range, versions });

  const fromHead = shaForRevision(from.range.head);
  const toHead = shaForRevision(to.range.head);
  const fromBase = shaForRevision(from.range.base);
  const toBase = shaForRevision(to.range.base);
  const warnings: Array<string> = [];

  await Promise.all([
    git.ensureCommit(fromBase, { signal }),
    git.ensureCommit(fromHead, { signal }),
    git.ensureCommit(toBase, { signal }),
    git.ensureCommit(toHead, { signal }),
  ]);
  signal?.throwIfAborted();

  const [fromRange, toRange] = await Promise.all([
    readRangePatchFiles(git, fromBase, fromHead, signal),
    readRangePatchFiles(git, toBase, toHead, signal),
  ]);
  signal?.throwIfAborted();
  const rangeWarnings =
    fromRange.coverage !== 'complete' || toRange.coverage !== 'complete'
      ? [
          'One or more GitHub Range Artifacts are incomplete; aggregate comparison may omit changes.',
        ]
      : [];
  const replay = await computeVersionComparePreferringReplay({
    from: {
      baseSha: fromBase,
      createdAt: from.createdAt,
      headSha: fromHead,
      label: from.range.head.label.text,
      versionId: from.versionId,
    },
    fromFiles: fromRange.files,
    readBlob: readReplayBlob(git),
    ...(git.readReplayBlobs ? { readBlobs: git.readReplayBlobs } : {}),
    ...(onReplayDiagnostics ? { onDiagnostics: onReplayDiagnostics } : {}),
    ...(signal ? { signal } : {}),
    to: {
      baseSha: toBase,
      createdAt: to.createdAt,
      headSha: toHead,
      label: to.range.head.label.text,
      versionId: to.versionId,
    },
    toFiles: toRange.files,
  });
  signal?.throwIfAborted();
  const files = replay.files.map((file) => file.file);

  const baseMoved = fromBase !== toBase;

  let baseMovement: DiffComparisonBaseMovement | undefined;
  if (baseMoved) {
    signal?.throwIfAborted();
    baseMovement = await buildBaseMovement({ fromBase, git, toBase });
    signal?.throwIfAborted();
    if (baseMovement.warning) {
      warnings.push(baseMovement.warning);
    }
  }

  return diffComparisonView({
    analysis: {
      summary: {
        addedLines: replay.summary.addedLines,
        baseMoved,
        commentsAffected: replay.summary.commentsAffected,
        conflictFiles: replay.summary.conflictFiles,
        deletedLines: replay.summary.deletedLines,
        empty: replay.summary.empty,
        filesChanged: replay.summary.filesChanged,
        intentionalFiles: replay.summary.intentionalFiles,
        noiseFiles: replay.summary.noiseFiles,
      },
      ...([...rangeWarnings, ...warnings, ...(replay.warnings ?? [])].length > 0
        ? { warnings: [...new Set([...rangeWarnings, ...warnings, ...(replay.warnings ?? [])])] }
        : {}),
      ...(baseMovement ? { baseMovement } : {}),
    },
    comparison: diffComparison(from.range, to.range),
    files,
    from,
    to,
  });
};

/** Classify commit evolution independently so aggregate rendering never waits for evidence. */
export const classifyGitHubReviewVersionEvolution = async ({
  cache,
  control = {},
  git,
  range,
  versions,
}: GitHubReviewVersionComparisonInput & {
  cache?: GitHubVersionCommitFingerprintCache;
  control?: GitHubVersionEvolutionControl;
}): Promise<ReviewCommitEvolution> => {
  const { from, to } = resolveGitHubVersionPair({ range, versions });
  const fromHead = shaForRevision(from.range.head);
  const toHead = shaForRevision(to.range.head);
  const fromBase = shaForRevision(from.range.base);
  const toBase = shaForRevision(to.range.base);
  control.onProgress?.({
    message: 'Reading previous and current commit stacks',
    phase: 'reading-stacks',
  });
  control.signal?.throwIfAborted();
  await Promise.all([git.ensureCommit(fromHead), git.ensureCommit(toHead)]);
  const [oldCommits, newCommits] = await Promise.all([
    git.readCommitStack(fromBase, fromHead),
    git.readCommitStack(toBase, toHead),
  ]);
  control.signal?.throwIfAborted();
  return buildFingerprintEvolution({
    baseMoved: fromBase !== toBase,
    cache,
    control,
    from: {
      baseSha: fromBase,
      createdAt: from.createdAt,
      headSha: fromHead,
      label: from.range.head.label.text,
      startSha: fromBase,
      versionId: from.versionId,
    },
    git,
    loadBaseCommits: () => git.readCommitStack(fromBase, toBase),
    newCommits,
    oldCommits,
    to: {
      baseSha: toBase,
      createdAt: to.createdAt,
      headSha: toHead,
      label: to.range.head.label.text,
      startSha: toBase,
      versionId: to.versionId,
    },
  });
};

/** Compatibility wrapper for callers that still request both results together. */
export const compareGitHubReviewVersions = async (
  input: GitHubReviewVersionComparisonInput,
): Promise<{
  versionCommitEvolution: ReviewCommitEvolution | null;
  versionCommitEvolutionError: string | null;
  versionCompare: DiffComparisonView;
}> => {
  const [versionCompare, evolutionResult] = await Promise.all([
    compareGitHubReviewVersionAggregate(input),
    classifyGitHubReviewVersionEvolution(input).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ reason: error, status: 'rejected' as const }),
    ),
  ]);

  return {
    versionCommitEvolution: evolutionResult.status === 'fulfilled' ? evolutionResult.value : null,
    versionCommitEvolutionError:
      evolutionResult.status === 'rejected'
        ? evolutionResult.reason instanceof Error
          ? evolutionResult.reason.message
          : String(evolutionResult.reason)
        : null,
    versionCompare,
  };
};

/**
 * Load a single evolution unit as a commit range diff when possible.
 */
export const loadGitHubVersionCommitUnitDiff = async ({
  git,
  unit,
}: {
  git: GitHubHistoryGit;
  unit: ReviewEvolutionUnit;
}): Promise<ReadonlyArray<ChangedFile>> => {
  if (!unit.reviewable) {
    throw new Error('This commit evolution unit is not reviewable.');
  }
  if (unit.kind === 'introduced' && unit.after) {
    const parent = unit.after.parentShas[0];
    if (!parent) {
      throw new Error('The introduced commit parent is unavailable.');
    }
    return git.readRangeFiles(parent, unit.after.sha, false);
  }
  if (unit.kind === 'removed' && unit.before) {
    const parent = unit.before.parentShas[0];
    if (!parent) {
      throw new Error('The removed commit parent is unavailable.');
    }
    return git.readRangeFiles(unit.before.sha, parent, false);
  }
  if ((unit.kind === 'revised' || unit.kind === 'ambiguous') && unit.before && unit.after) {
    const oldParent = unit.before.parentShas[0];
    const newParent = unit.after.parentShas[0];
    if (!oldParent || !newParent) {
      throw new Error('A paired commit comparison requires both commit parents.');
    }
    await Promise.all([
      git.ensureCommit(oldParent),
      git.ensureCommit(unit.before.sha),
      git.ensureCommit(newParent),
      git.ensureCommit(unit.after.sha),
    ]);
    const comparison = await computeVersionComparePreferringReplay({
      from: {
        baseSha: oldParent,
        createdAt: unit.before.authoredAt,
        headSha: unit.before.sha,
        label: unit.before.shortSha,
        versionId: reviewVersionId(unit.before.sha),
      },
      fromFiles: await readCommitPatchFiles(git, unit.before.sha),
      readBlob: readReplayBlob(git),
      ...(git.readReplayBlobs ? { readBlobs: git.readReplayBlobs } : {}),
      to: {
        baseSha: newParent,
        createdAt: unit.after.authoredAt,
        headSha: unit.after.sha,
        label: unit.after.shortSha,
        versionId: reviewVersionId(unit.after.sha),
      },
      toFiles: await readCommitPatchFiles(git, unit.after.sha),
    });
    return comparison.files.map((file) => file.file);
  }
  throw new Error(`Unsupported evolution unit kind for diff loading: ${unit.kind}`);
};
