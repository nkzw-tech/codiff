import {
  commitRevisionLabel,
  createFileBlobArtifactRequestKey,
  createCommitArtifactRequestKey,
  diffComparison,
  diffComparisonView,
  diffRange,
  orderReviewCommitStack,
  projectCommitEvolution,
  resolveReviewPlan,
  reviewVersionOption,
  revisionRef,
  validateRangeArtifact,
  validateStackSnapshot,
  versionRevisionLabel,
  type BlobArtifact,
  type CommitStackMatchDiagnostics,
  type CommitArtifactRequest,
  type FileBlobArtifactRequest,
  type RangeArtifact,
  type ReplayCompareDiagnostics,
  type ReviewArtifactSource,
  type StackSnapshot,
} from '@nkzw/codiff-core';
/**
 * Read-side GitLab review-history adapter over {@link GitLabTransport}.
 */
import type {
  ChangedFile,
  DiffComparisonAnalysis,
  DiffComparisonView,
  DiffRange,
  EvolutionUnitId,
  GitSha,
  ReviewCommitEvolution,
  ReviewCommitSummary,
  ReviewPlan,
  ReviewVersionActivityReason,
  ReviewVersionId,
  ReviewVersionOption,
  VersionComparisonReviewStructure,
} from '@nkzw/codiff-core/types';
import type { GitLabTransport } from './transport.ts';
import {
  attributeRebaseOverlaps,
  createCommitFingerprint,
  matchVersionCommitStacks,
  toCommitArtifact,
  versionCommitEvidenceConcurrency,
  versionCommitStackLimit,
  type ArtifactFile,
  type CommitArtifact,
  type CommitFingerprint,
  type CommitStackEvolution,
  type ReviewArtifactProject,
  type VersionCommitEvolutionUnit,
  type VersionRebaseOverlapCommit,
} from './version-commit-evolution.ts';
import {
  computeVersionComparePreferringReplay,
  type CommentAnchor,
  type MergeRequestVersionCompare,
  type MergeRequestVersionRef,
  type ReplayBlobBatchLookup,
  type VersionBaseMovement,
  type VersionCompareEndpoint,
  type VersionPatchFile,
} from './version-compare.ts';

export type { GitLabTransport } from './transport.ts';
export type {
  CommentAnchor,
  MergeRequestVersionCompare,
  MergeRequestVersionRef,
  VersionCompareEndpoint,
  VersionPatchFile,
} from './version-compare.ts';
export type {
  ArtifactFile,
  CommitAssignmentDiagnostics,
  CommitArtifact,
  CommitFingerprint,
  CommitStackEvolution,
  VersionCommitEvolutionUnit,
  VersionCommitMatchKind,
  VersionCommitSummary,
  VersionRebaseOverlapCommit,
  ReviewArtifactProject,
  ReviewArtifactProvenance,
} from './version-commit-evolution.ts';
export type { CommitStackMatchDiagnostics } from './version-commit-evolution.ts';
export {
  attributeRebaseOverlaps,
  createCommitFingerprint,
  matchVersionCommitStacks,
  recommendVersionWalkthroughStructure,
  toCommitArtifact,
  toVersionCommitSummary,
  versionCommitEvidenceConcurrency,
  versionCommitEvolutionAlgorithmVersion,
  versionCommitFingerprintAlgorithmVersion,
  versionCommitStackLimit,
} from './version-commit-evolution.ts';
export {
  computeLineDiff,
  computeVersionComparePreferringReplay,
  isMergeRequestVersionRef,
  versionCompareAlgorithmVersion,
} from './version-compare.ts';
const maxPages = 20;
/** Immutable Commit and Range Artifact JSON must never retain arbitrary provider output. */
const MAX_ARTIFACT_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_OPTIONAL_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

export type GitLabDiffIdentity = {
  baseSha: GitSha;
  headSha: GitSha;
  startSha: GitSha;
};

/**
 * Host-owned Range Artifact evidence for aggregate replay. Retaining the
 * range-level coverage matters because a bounded native read can contain only
 * complete early files while still omit an unobserved tail.
 */
export type GitLabHostRangeFiles = {
  coverage: RangeArtifact['coverage'];
  files: ReadonlyArray<VersionPatchFile>;
};

type GitLabRangeFiles = ReadonlyArray<VersionPatchFile> | GitLabHostRangeFiles;

const isGitLabHostRangeFiles = (value: GitLabRangeFiles): value is GitLabHostRangeFiles =>
  !Array.isArray(value);

export type GitLabMergeRequestCommit = {
  authoredDate: string;
  authorEmail: string;
  authorName: string;
  committedDate: string;
  committerName: string;
  message: string;
  parentShas: ReadonlyArray<GitSha>;
  sha: GitSha;
  shortSha: string;
  title: string;
  webUrl: string;
};

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const asRecord = (value: unknown): JsonRecord => (isRecord(value) ? value : {});
const asArray = (value: unknown): Array<unknown> => (Array.isArray(value) ? value : []);
const asString = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const gitShaPattern = /^(?:[\da-f]{40}|[\da-f]{64})$/i;
const asGitSha = (value: unknown): GitSha | null => {
  const candidate = asString(value).trim();
  return gitShaPattern.test(candidate) ? (candidate as GitSha) : null;
};
const reviewVersionId = (value: string) => value as ReviewVersionId;
const asNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const trimmedString = (value: unknown) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const normalizeBlobArtifactMaxBytes = (value: number | undefined) => {
  const maxBytes = value ?? MAX_BLOB_ARTIFACT_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new RangeError('Blob Artifact byte limit must be a finite non-negative number.');
  }
  return Math.floor(maxBytes);
};

export const validateProjectPath = (projectPath: string) => {
  const normalized = projectPath.trim().replaceAll(/^\/+|\/+$/g, '');
  if (
    !normalized ||
    normalized.length > 500 ||
    !normalized.includes('/') ||
    normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid GitLab project path.');
  }
  return normalized;
};

const mergeRequestEndpoint = (projectPath: string, iid: number, suffix = '') =>
  `/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}${suffix}`;

const mergeRequestCommitsEndpoint = (projectPath: string, iid: number) =>
  mergeRequestEndpoint(projectPath, iid, '/commits');

const mergeRequestVersionsEndpoint = (projectPath: string, iid: number) =>
  mergeRequestEndpoint(projectPath, iid, '/versions');

const mergeRequestVersionEndpoint = (projectPath: string, iid: number, versionId: string) =>
  mergeRequestEndpoint(projectPath, iid, `/versions/${encodeURIComponent(versionId)}`);

const repositoryCompareEndpoint = (projectPath: string, from: string, to: string) => {
  const query = new URLSearchParams({ from, straight: 'true', to });
  return `/api/v4/projects/${encodeURIComponent(projectPath)}/repository/compare?${query}`;
};

const repositoryFileRawEndpoint = (projectPath: string, filePath: string, ref: string) => {
  const query = new URLSearchParams({ ref });
  return `/api/v4/projects/${encodeURIComponent(projectPath)}/repository/files/${encodeURIComponent(filePath)}/raw?${query}`;
};

const repositoryFileEndpoint = (projectPath: string, filePath: string) =>
  `/api/v4/projects/${encodeURIComponent(projectPath)}/repository/files/${encodeURIComponent(filePath)}`;

const repositoryCommitDiffEndpoint = (projectPath: string, sha: string) =>
  `/api/v4/projects/${encodeURIComponent(projectPath)}/repository/commits/${encodeURIComponent(sha)}/diff`;

const repositoryCommitEndpoint = (projectPath: string, sha: string) =>
  `/api/v4/projects/${encodeURIComponent(projectPath)}/repository/commits/${encodeURIComponent(sha)}`;

const repositoryBlobRawEndpoint = (projectPath: string, objectId: string) =>
  `/api/v4/projects/${encodeURIComponent(projectPath)}/repository/blobs/${encodeURIComponent(objectId)}/raw`;

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

type GitLabTransportRequest = Parameters<GitLabTransport['request']>[0];

const createRequest = (
  pathOrUrl: string,
  init: {
    body?: unknown;
    headers?: HeadersInit;
    method?: GitLabTransportRequest['method'];
    signal?: AbortSignal;
  } = {},
): GitLabTransportRequest => {
  // Accept absolute URLs from legacy helpers and reduce to path+query.
  let path = pathOrUrl;
  let query: Record<string, string> | undefined;
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    const url = new URL(pathOrUrl);
    path = url.pathname;
    if (url.searchParams.toString()) {
      query = Object.fromEntries(url.searchParams.entries());
    }
  } else if (pathOrUrl.includes('?')) {
    const url = new URL(pathOrUrl, 'https://gitlab.local');
    path = url.pathname;
    query = Object.fromEntries(url.searchParams.entries());
  }
  return { body: init.body, method: init.method ?? 'GET', path, query, signal: init.signal };
};

const readJson = async (
  transport: GitLabTransport,
  request: GitLabTransportRequest,
  _unavailableMessage: string,
  maxBytes = MAX_ARTIFACT_RESPONSE_BYTES,
) =>
  transport.request({
    body: request.body,
    maxBytes,
    method: request.method,
    path: request.path,
    query: request.query,
    signal: request.signal,
  });

/** Read a bounded raw blob rather than buffering an unbounded text response. */
const readBlobText = async (
  transport: GitLabTransport,
  request: Pick<GitLabTransportRequest, 'path' | 'query'>,
  signal?: AbortSignal,
) => {
  if (!transport.requestBuffer) {
    throw new Error('GitLabTransport.requestBuffer is required for raw blob reads.');
  }
  const bytes = await transport.requestBuffer({
    maxBytes: MAX_BLOB_ARTIFACT_BYTES,
    path: request.path,
    query: request.query,
    signal,
  });
  if (bytes.byteLength > MAX_BLOB_ARTIFACT_BYTES) {
    throw new Error('GitLab raw blob exceeded the Blob Artifact safety limit.');
  }
  return new TextDecoder().decode(bytes);
};

const readPages = async (
  transport: GitLabTransport,
  url: string,
  signal?: AbortSignal,
  maxBytes = MAX_ARTIFACT_RESPONSE_BYTES,
): Promise<Array<unknown>> => {
  const first = createRequest(url);
  if (transport.requestPages) {
    return transport.requestPages({
      maxBytes,
      path: first.path,
      query: first.query,
      signal,
    });
  }
  const values: Array<unknown> = [];
  let page = 1;
  while (page <= maxPages) {
    signal?.throwIfAborted();
    const result = await transport.request<unknown>({
      maxBytes,
      path: first.path,
      query: { ...(first.query ?? {}), page, per_page: 100 },
      signal,
    });
    const pageValues = asArray(result);
    values.push(...pageValues);
    if (pageValues.length < 100) {
      break;
    }
    page += 1;
  }
  if (page > maxPages) {
    throw new Error('GitLab merge request data exceeded the pagination limit.');
  }
  return values;
};

const createPatch = (diff: JsonRecord) => {
  const oldPath = asString(diff.old_path);
  const newPath = asString(diff.new_path);
  const body = asString(diff.diff);
  const oldHeader = diff.new_file === true ? '/dev/null' : `a/${oldPath}`;
  const newHeader = diff.deleted_file === true ? '/dev/null' : `b/${newPath}`;
  return `diff --git a/${oldPath} b/${newPath}\n--- ${oldHeader}\n+++ ${newHeader}\n${body}${
    body.endsWith('\n') ? '' : '\n'
  }`;
};

const normalizeDiff = (
  diffValue: unknown,
  iid: number,
  headSha: string,
  index: number,
  sectionKind: 'commit' | 'pull-request' = 'pull-request',
  sectionScope: string = String(iid),
): ChangedFile | null => {
  const diff = asRecord(diffValue);
  const oldPath = asString(diff.old_path);
  const newPath = asString(diff.new_path);
  if (!oldPath || !newPath) {
    return null;
  }
  const status = diff.new_file
    ? 'added'
    : diff.deleted_file
      ? 'deleted'
      : diff.renamed_file
        ? 'renamed'
        : 'modified';
  const rawPatch = asString(diff.diff);
  const unavailable = !rawPatch.trim();
  const sectionId = `${newPath}:${sectionKind}:${sectionScope}`;
  return {
    fingerprint: `${headSha}:${index}:${status}:${oldPath}:${newPath}:${rawPatch.length}`,
    ...(oldPath !== newPath ? { oldPath } : {}),
    path: newPath,
    sections: [
      {
        binary: false,
        id: sectionId,
        kind: sectionKind,
        loadState: unavailable ? 'too-large' : 'ready',
        patch: unavailable ? '' : createPatch(diff),
        ...(unavailable
          ? {
              summary: {
                canLoad: false,
                reason:
                  diff.too_large === true
                    ? 'GitLab marked this diff as too large to display.'
                    : 'GitLab did not return a text patch for this file.',
              },
            }
          : {}),
      },
    ],
    status,
  };
};

const normalizeMergeRequestCommit = (
  value: unknown,
  projectPath: string,
): GitLabMergeRequestCommit | null => {
  const commit = asRecord(value);
  const sha = asGitSha(commit.id ?? commit.sha);
  if (!sha) {
    return null;
  }
  const title = asString(commit.title, asString(commit.message).split('\n')[0] || sha.slice(0, 8));
  const message = asString(commit.message, title);
  const shortSha = asString(commit.short_id, sha.slice(0, 8));
  const parentShas = asArray(commit.parent_ids)
    .map(asGitSha)
    .filter((parent): parent is GitSha => parent != null);
  const authorName =
    trimmedString(commit.author_name) ?? trimmedString(asRecord(commit.author).name) ?? 'Unknown';
  const authorEmail =
    trimmedString(commit.author_email) ?? trimmedString(asRecord(commit.author).email) ?? '';
  const authoredDate =
    asString(commit.authored_date) ||
    asString(commit.created_at) ||
    asString(commit.committed_date) ||
    new Date(0).toISOString();
  const committerName = trimmedString(commit.committer_name) ?? authorName;
  const committedDate = asString(commit.committed_date) || authoredDate;
  return {
    authoredDate,
    authorEmail,
    authorName,
    committedDate,
    committerName,
    message,
    parentShas,
    sha,
    shortSha,
    title,
    webUrl: asString(commit.web_url) || `/${projectPath}/-/commit/${encodeURIComponent(sha)}`,
  };
};

const normalizeVersionPatchFile = (value: unknown): VersionPatchFile | null => {
  const diff = asRecord(value);
  const oldPath = asString(diff.old_path);
  const newPath = asString(diff.new_path);
  if (!oldPath || !newPath) {
    return null;
  }
  const status = diff.new_file
    ? 'added'
    : diff.deleted_file
      ? 'deleted'
      : diff.renamed_file
        ? 'renamed'
        : 'modified';
  const patchBody = asString(diff.diff);
  const oldObjectId = asString(diff.old_id) || undefined;
  const newObjectId = asString(diff.new_id) || undefined;
  const coverage =
    diff.too_large === true || diff.collapsed === true
      ? 'truncated'
      : patchBody.trim() || oldObjectId || newObjectId
        ? 'complete'
        : 'opaque';
  return {
    coverage,
    ...(newObjectId ? { newObjectId } : {}),
    newPath,
    ...(oldObjectId ? { oldObjectId } : {}),
    oldPath,
    patchBody,
    status,
  };
};

const normalizeMergeRequestVersion = (
  value: unknown,
  index: number,
): MergeRequestVersionRef | null => {
  const version = asRecord(value);
  const rawId = version.id;
  const versionId = reviewVersionId(
    (typeof rawId === 'string' && rawId) ||
      (typeof rawId === 'number' && Number.isFinite(rawId) ? String(rawId) : String(index + 1)),
  );
  const baseSha = asGitSha(version.base_commit_sha);
  const startSha = asGitSha(version.start_commit_sha) ?? baseSha;
  const headSha = asGitSha(version.head_commit_sha);
  if (!baseSha || !headSha) {
    return null;
  }
  const createdAt = asString(version.created_at, new Date(0).toISOString());
  const shortHead = headSha.slice(0, 7);
  return {
    baseSha,
    createdAt,
    headSha,
    label: `v${versionId} · ${shortHead}`,
    startSha: startSha ?? baseSha,
    versionId,
  };
};

// --- Commit / version / version-comparison GitLab surface (Fate root queries call these) ---
// Commits list → client commits mode. Commit diff → lazy onLoadCommitDiff.
// Versions + version comparison → version picker + version-comparison view (algorithm in version-compare.ts).
export const fetchGitLabMergeRequestCommits = async ({
  iid,
  projectPath: rawProjectPath,
  transport,
}: {
  iid: number;
  projectPath: string;
  transport: GitLabTransport;
}): Promise<Array<GitLabMergeRequestCommit>> => {
  const projectPath = validateProjectPath(rawProjectPath);
  if (!Number.isInteger(iid) || iid <= 0) {
    throw new Error('Invalid GitLab merge request IID.');
  }
  const values = await readPages(transport, mergeRequestCommitsEndpoint(projectPath, iid));
  return [
    ...orderReviewCommitStack(
      values
        .map((value) => normalizeMergeRequestCommit(value, projectPath))
        .filter((commit): commit is GitLabMergeRequestCommit => commit != null),
    ),
  ];
};

export const fetchGitLabCommitDiff = async ({
  projectPath: rawProjectPath,
  sha,
  transport,
}: {
  projectPath: string;
  sha: GitSha;
  transport: GitLabTransport;
}): Promise<Array<ChangedFile>> => {
  const projectPath = validateProjectPath(rawProjectPath);
  const normalizedSha = sha;
  const diffs = await readPages(
    transport,
    repositoryCommitDiffEndpoint(projectPath, normalizedSha),
  );
  return diffs
    .map((diff, index) =>
      normalizeDiff(diff, 0, normalizedSha, index, 'commit', normalizedSha.slice(0, 12)),
    )
    .filter((file): file is ChangedFile => file != null)
    .toSorted((first, second) => first.path.localeCompare(second.path));
};

const normalizeCommitArtifactFile = (value: unknown): ArtifactFile | null => {
  const diff = asRecord(value);
  const oldPath = asString(diff.old_path);
  const path = asString(diff.new_path);
  if (!oldPath || !path) {
    return null;
  }
  const patch = asString(diff.diff);
  const oldMode = asString(diff.a_mode) || undefined;
  const newMode = asString(diff.b_mode) || undefined;
  const oldObjectId = asString(diff.old_id) || undefined;
  const newObjectId = asString(diff.new_id) || undefined;
  const status = diff.new_file
    ? 'added'
    : diff.deleted_file
      ? 'deleted'
      : diff.renamed_file
        ? 'renamed'
        : 'modified';
  const coverage =
    diff.too_large === true || diff.collapsed === true
      ? 'truncated'
      : patch.trim() || oldObjectId || newObjectId || (oldMode && newMode && oldMode !== newMode)
        ? 'complete'
        : 'opaque';
  return {
    coverage,
    ...(newMode ? { newMode } : {}),
    ...(newObjectId ? { newObjectId } : {}),
    ...(oldMode ? { oldMode } : {}),
    ...(oldObjectId ? { oldObjectId } : {}),
    ...(oldPath !== path ? { oldPath } : {}),
    ...(patch.trim() ? { patch: createPatch(diff) } : {}),
    path,
    status,
  };
};

const toGitLabCommitArtifact = (
  commit: { parentSha: GitSha | null; sha: GitSha },
  project: ReviewArtifactProject,
  values: ReadonlyArray<unknown>,
): CommitArtifact => {
  const files = values
    .map(normalizeCommitArtifactFile)
    .filter((file): file is ArtifactFile => file != null);
  const coverage =
    files.length !== values.length || files.some((file) => file.coverage === 'truncated')
      ? 'truncated'
      : files.some((file) => file.coverage === 'opaque')
        ? 'opaque'
        : 'complete';
  return {
    commitSha: commit.sha,
    coverage,
    files,
    parentSha: commit.parentSha,
    provenance: { kind: 'gitlab-api', project },
  };
};

/** Read immutable Commit Artifacts with one bounded scheduler per comparison run. */
export const fetchGitLabCommitArtifacts = async ({
  commits,
  project,
  projectPath: rawProjectPath,
  signal,
  transport,
}: {
  commits: ReadonlyArray<{ parentSha: GitSha | null; sha: GitSha }>;
  project: ReviewArtifactProject;
  projectPath: string;
  signal?: AbortSignal;
  transport: GitLabTransport;
}): Promise<ReadonlyMap<GitSha, CommitArtifact>> => {
  const projectPath = validateProjectPath(rawProjectPath);
  const pending = [...new Map(commits.map((commit) => [commit.sha, commit])).values()];
  const artifacts = new Map<GitSha, CommitArtifact>();
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < pending.length) {
      signal?.throwIfAborted();
      const commit = pending[nextIndex++]!;
      try {
        const values = await readPages(
          transport,
          repositoryCommitDiffEndpoint(projectPath, commit.sha),
          signal,
        );
        artifacts.set(commit.sha, toGitLabCommitArtifact(commit, project, values));
      } catch {
        signal?.throwIfAborted();
        // Preserve partial acquisition; the matcher will keep this commit ambiguous.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(versionCommitEvidenceConcurrency, pending.length) }, worker),
  );
  return artifacts;
};

export type MergeRequestVersionDiffStat = {
  additions: number;
  deletions: number;
  filesChanged: number;
};

/**
 * MR-local version history. GitLab's identifier is normalized as a typed
 * review-version identity; URLs use `number` (0 is the MR base).
 */
export type MergeRequestVersionHistoryEntry = {
  createdAt: string | null;
  diffStat: MergeRequestVersionDiffStat;
  headSha: GitSha;
  isHead: boolean;
  number: number;
  previousCreatedAt?: string;
  previousNumber?: number;
  versionId: ReviewVersionId | null;
};

type VersionStatCache = {
  read?: (range: {
    next: MergeRequestVersionRef;
    previous: MergeRequestVersionRef;
  }) => Promise<MergeRequestVersionDiffStat | null> | MergeRequestVersionDiffStat | null;
  write?: (
    range: { next: MergeRequestVersionRef; previous: MergeRequestVersionRef },
    diffStat: MergeRequestVersionDiffStat,
  ) => Promise<void> | void;
};

const readGitLabMergeRequestVersions = async ({
  iid,
  projectPath: rawProjectPath,
  signal,
  transport,
}: {
  iid: number;
  projectPath: string;
  signal?: AbortSignal;
  transport: GitLabTransport;
}): Promise<Array<MergeRequestVersionRef>> => {
  signal?.throwIfAborted();
  const projectPath = validateProjectPath(rawProjectPath);
  if (!Number.isInteger(iid) || iid <= 0) {
    throw new Error('Invalid GitLab merge request IID.');
  }
  const values = await readPages(transport, mergeRequestVersionsEndpoint(projectPath, iid), signal);
  signal?.throwIfAborted();
  return values
    .map((value, index) => normalizeMergeRequestVersion(value, index))
    .filter((version): version is MergeRequestVersionRef => version != null)
    .toSorted((first, second) => {
      const timeDifference = Date.parse(first.createdAt) - Date.parse(second.createdAt);
      return timeDifference || first.versionId.localeCompare(second.versionId);
    });
};

/** Canonical immutable review-version timeline ordered earliest → latest. */
export const fetchGitLabReviewVersionTimeline = async (args: {
  iid: number;
  projectPath: string;
  signal?: AbortSignal;
  transport: GitLabTransport;
}): Promise<Array<MergeRequestVersionRef>> => {
  const versions = await readGitLabMergeRequestVersions(args);
  return versions.map((version, index) => ({
    ...version,
    label: `v${index + 1} · ${version.headSha.slice(0, 7)}`,
  }));
};

/** Compatibility API ordered newest → oldest. Canonical consumers use the timeline above. */
export const fetchGitLabMergeRequestVersions = async (args: {
  iid: number;
  projectPath: string;
  signal?: AbortSignal;
  transport: GitLabTransport;
}): Promise<Array<MergeRequestVersionRef>> => {
  const timeline = await fetchGitLabReviewVersionTimeline(args);
  return timeline.toReversed();
};

const gitLabActivityVersion = (
  note: JsonRecord,
  versions: ReadonlyArray<MergeRequestVersionRef>,
) => {
  const position = asRecord(note.position ?? note.original_position);
  const positionedHead = asGitSha(position.head_sha);
  if (positionedHead) {
    const positioned = versions.find((version) => version.headSha === positionedHead);
    if (positioned) {
      return positioned;
    }
  }
  const occurredAt = Date.parse(asString(note.created_at));
  return [...versions]
    .filter((version) => Date.parse(version.createdAt) <= occurredAt)
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
};

/** Derive authenticated-reviewer comment and approval activity by immutable version. */
export const fetchGitLabMergeRequestReviewerActivity = async ({
  iid,
  projectPath: rawProjectPath,
  transport,
  versions: suppliedVersions,
}: {
  iid: number;
  projectPath: string;
  transport: GitLabTransport;
  versions?: ReadonlyArray<MergeRequestVersionRef>;
}): Promise<ReadonlyMap<ReviewVersionId, ReviewVersionOption['activity']>> => {
  const projectPath = validateProjectPath(rawProjectPath);
  const [viewerResult, versionsResult, discussionsResult, notesResult] = await Promise.allSettled([
    transport.request<unknown>({
      maxBytes: MAX_OPTIONAL_PROVIDER_RESPONSE_BYTES,
      path: '/api/v4/user',
    }),
    suppliedVersions
      ? Promise.resolve([...suppliedVersions])
      : fetchGitLabReviewVersionTimeline({ iid, projectPath, transport }),
    readPages(
      transport,
      mergeRequestEndpoint(projectPath, iid, '/discussions'),
      undefined,
      MAX_OPTIONAL_PROVIDER_RESPONSE_BYTES,
    ),
    readPages(
      transport,
      mergeRequestEndpoint(projectPath, iid, '/notes'),
      undefined,
      MAX_OPTIONAL_PROVIDER_RESPONSE_BYTES,
    ),
  ]);
  if (viewerResult.status !== 'fulfilled' || versionsResult.status !== 'fulfilled') {
    return new Map();
  }
  const viewer = asRecord(viewerResult.value);
  const versions = versionsResult.value;
  const discussions = discussionsResult.status === 'fulfilled' ? discussionsResult.value : [];
  const notes = notesResult.status === 'fulfilled' ? notesResult.value : [];
  const viewerId = asNumber(viewer.id);
  const viewerUsername = asString(viewer.username).toLowerCase();
  const belongsToViewer = (note: JsonRecord) => {
    const author = asRecord(note.author);
    return (
      (viewerId != null && asNumber(author.id) === viewerId) ||
      (viewerUsername && asString(author.username).toLowerCase() === viewerUsername)
    );
  };
  const seen = new Set<string>();
  const reasonsByVersion = new Map<ReviewVersionId, Array<ReviewVersionActivityReason>>();
  const allNotes = [
    ...discussions.flatMap((discussion) => asArray(asRecord(discussion).notes).map(asRecord)),
    ...notes.map(asRecord),
  ];
  for (const note of allNotes) {
    const noteId = asString(note.id, String(asNumber(note.id) ?? ''));
    if (!noteId || seen.has(noteId) || !belongsToViewer(note)) {
      continue;
    }
    seen.add(noteId);
    const occurredAt = asString(note.created_at);
    if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) {
      continue;
    }
    const approval =
      note.system === true && /\bapproved this merge request\b/i.test(asString(note.body));
    if (note.system === true && !approval) {
      continue;
    }
    const version = gitLabActivityVersion(note, versions);
    if (!version) {
      continue;
    }
    const reasons = reasonsByVersion.get(version.versionId) ?? [];
    reasons.push({ kind: approval ? 'approval' : 'comment', occurredAt });
    reasonsByVersion.set(version.versionId, reasons);
  }
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

export const fetchGitLabMergeRequestVersionHistory = async ({
  cache,
  iid,
  projectPath,
  transport,
}: {
  cache?: VersionStatCache;
  iid: number;
  projectPath: string;
  transport: GitLabTransport;
}): Promise<Array<MergeRequestVersionHistoryEntry>> => {
  const versions = await readGitLabMergeRequestVersions({
    iid,
    projectPath,
    transport,
  });
  if (versions.length === 0) {
    return [];
  }
  const stats = await Promise.all(
    versions.map(async (version, index) => {
      const previous =
        versions[index - 1] ??
        ({
          ...version,
          headSha: version.baseSha,
          label: 'MR base',
          startSha: version.baseSha,
          versionId: reviewVersionId('base'),
        } satisfies MergeRequestVersionRef);
      const cached = await cache?.read?.({ next: version, previous });
      if (cached) {
        return cached;
      }
      // GitLab's version endpoint returns the whole MR patch for that version,
      // not the delta from the preceding version. Compare the two endpoint
      // SHAs so this is genuinely v(N-1) → vN (and base → v1).
      const files = await readCompareFiles({
        from: previous.headSha,
        projectPath,
        to: version.headSha,
        transport,
      });
      const diffStat = {
        additions: files.reduce(
          (total, file) =>
            total +
            file.patchBody
              .split('\n')
              .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
          0,
        ),
        deletions: files.reduce(
          (total, file) =>
            total +
            file.patchBody
              .split('\n')
              .filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
          0,
        ),
        filesChanged: files.length,
      };
      await cache?.write?.({ next: version, previous }, diffStat);
      return diffStat;
    }),
  );
  const first = versions[0];
  return [
    {
      createdAt: null,
      diffStat: stats[0]!,
      headSha: first.baseSha,
      isHead: false,
      number: 0,
      versionId: null,
    },
    ...versions.map((version, index) => ({
      createdAt: version.createdAt,
      diffStat: stats[index]!,
      headSha: version.headSha,
      isHead: index === versions.length - 1,
      number: index + 1,
      versionId: version.versionId,
      ...(index > 0
        ? { previousCreatedAt: versions[index - 1]!.createdAt, previousNumber: index }
        : {}),
    })),
  ];
};

const readMergeRequestVersionFiles = async ({
  iid,
  projectPath,
  signal,
  transport,
  versionId,
}: {
  iid: number;
  projectPath: string;
  signal?: AbortSignal;
  transport: GitLabTransport;
  versionId: ReviewVersionId;
}): Promise<Array<VersionPatchFile>> => {
  signal?.throwIfAborted();
  const value = await readJson(
    transport,
    createRequest(mergeRequestVersionEndpoint(projectPath, iid, versionId), { signal }),
    'Unable to load the merge request version.',
  );
  signal?.throwIfAborted();
  const version = asRecord(value);
  return asArray(version.diffs ?? version.changes)
    .map(normalizeVersionPatchFile)
    .filter((file): file is VersionPatchFile => file != null);
};
const readRepositoryCompare = async ({
  from,
  projectPath,
  signal,
  to,
  transport,
}: {
  from: string;
  projectPath: string;
  signal?: AbortSignal;
  to: string;
  transport: GitLabTransport;
}): Promise<JsonRecord> =>
  asRecord(
    await readJson(
      transport,
      createRequest(repositoryCompareEndpoint(projectPath, from, to), { signal }),
      'Unable to compare GitLab revisions.',
    ),
  );

const artifactCoverage = (files: ReadonlyArray<ArtifactFile>, expectedCount: number) =>
  files.length !== expectedCount || files.some((file) => file.coverage === 'truncated')
    ? 'truncated'
    : files.some((file) => file.coverage === 'opaque')
      ? 'opaque'
      : 'complete';

/** Normalize an already acquired GitLab diff response into the shared Range Artifact contract. */
export const createGitLabRangeArtifact = ({
  baseSha,
  diffs,
  headSha,
  incompleteReason,
  project,
  truncated = false,
}: {
  baseSha: GitSha;
  diffs: ReadonlyArray<unknown>;
  headSha: GitSha;
  incompleteReason?: string;
  project: ReviewArtifactProject;
  truncated?: boolean;
}): RangeArtifact => {
  const files = diffs
    .map(normalizeCommitArtifactFile)
    .filter((file): file is ArtifactFile => file != null);
  return validateRangeArtifact({
    baseSha,
    coverage:
      truncated || incompleteReason != null ? 'truncated' : artifactCoverage(files, diffs.length),
    files,
    headSha,
    ...(incompleteReason != null ? { incompleteReason } : {}),
    provenance: { kind: 'gitlab-api', project },
  });
};

/** Resolve one immutable GitLab ref+path coordinate to a normalized Blob Artifact. */
export const readGitLabFileBlobArtifact = async ({
  maxBytes,
  path,
  project,
  projectPath: rawProjectPath,
  ref,
  signal,
  transport,
}: FileBlobArtifactRequest & {
  maxBytes: number;
  project: ReviewArtifactProject;
  projectPath: string;
  signal?: AbortSignal;
  transport: GitLabTransport;
}): Promise<BlobArtifact | null> => {
  const projectPath = validateProjectPath(rawProjectPath);
  const limit = normalizeBlobArtifactMaxBytes(maxBytes);
  signal?.throwIfAborted();
  const value = asRecord(
    await transport.request<unknown>({
      maxBytes: Math.ceil(limit / 3) * 4 + 64 * 1024,
      path: repositoryFileEndpoint(projectPath, path),
      query: { ref },
      signal,
    }),
  );
  signal?.throwIfAborted();
  const objectId = asGitSha(value.blob_id);
  if (!objectId) {
    return null;
  }
  const content = asString(value.content);
  const bytes =
    asString(value.encoding).toLowerCase() === 'base64' && content
      ? decodeBase64File(content, limit)
      : null;
  if (bytes) {
    return { bytes, objectId, provenance: { kind: 'gitlab-api', project } };
  }
  if (!transport.requestBuffer) {
    return null;
  }
  const raw = await transport.requestBuffer({
    maxBytes: limit,
    path: repositoryBlobRawEndpoint(projectPath, objectId),
    signal,
  });
  signal?.throwIfAborted();
  return raw.byteLength <= limit
    ? { bytes: raw, objectId, provenance: { kind: 'gitlab-api', project } }
    : null;
};

/** Create the bounded GitLab API backend for one project. */
export const createGitLabArtifactSource = ({
  maxBlobArtifactBytes,
  project,
  projectPath: rawProjectPath,
  transport,
}: {
  maxBlobArtifactBytes?: number;
  project: ReviewArtifactProject;
  projectPath: string;
  transport: GitLabTransport;
}): ReviewArtifactSource => {
  const blobArtifactMaxBytes = normalizeBlobArtifactMaxBytes(maxBlobArtifactBytes);
  const projectPath = validateProjectPath(rawProjectPath);
  const provenance = { kind: 'gitlab-api' as const, project };
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
              maxBytes: blobArtifactMaxBytes,
              path: repositoryBlobRawEndpoint(projectPath, objectId),
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
      const requests = [
        ...new Map(
          commits.map((request) => [createCommitArtifactRequestKey(request), request]),
        ).values(),
      ];
      const artifacts = new Map();
      for (const request of requests) {
        signal.throwIfAborted();
        const result = await fetchGitLabCommitArtifacts({
          commits: [{ parentSha: request.parentSha, sha: request.commitSha }],
          project,
          projectPath,
          signal,
          transport,
        });
        const artifact = result.get(request.commitSha);
        if (artifact) {
          artifacts.set(createCommitArtifactRequestKey(request), artifact);
        }
      }
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
            const blob = await readGitLabFileBlobArtifact({
              ...request,
              maxBytes: Math.min(request.maxBytes ?? blobArtifactMaxBytes, blobArtifactMaxBytes),
              project,
              projectPath,
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
      const value = await readRepositoryCompare({
        from: base,
        projectPath,
        signal,
        to: head,
        transport,
      });
      const rawCommits = asArray(value.commits);
      const commits = orderReviewCommitStack(
        rawCommits
          .map((entry) => normalizeMergeRequestCommit(entry, projectPath))
          .filter((commit): commit is GitLabMergeRequestCommit => commit != null)
          .map((commit) => ({
            authoredAt: commit.authoredDate,
            authorName: commit.authorName,
            parentShas: commit.parentShas,
            sha: commit.sha,
            shortSha: commit.shortSha,
            subject: commit.title,
            webUrl: commit.webUrl,
          })),
      );
      const truncated = value.compare_timeout === true || value.overflow === true;
      const range = createGitLabRangeArtifact({
        baseSha: base,
        diffs: asArray(value.diffs),
        headSha: head,
        project,
        truncated,
      });
      const stack: StackSnapshot = {
        baseSha: base,
        commits,
        coverage: truncated || commits.length !== rawCommits.length ? 'truncated' : 'complete',
        headSha: head,
        provenance,
      };
      return { range, stack: validateStackSnapshot(stack) };
    },
  };
};

const readCompareFiles = async (args: {
  from: string;
  projectPath: string;
  signal?: AbortSignal;
  to: string;
  transport: GitLabTransport;
}): Promise<Array<VersionPatchFile>> => {
  const value = await readRepositoryCompare(args);
  return asArray(value.diffs)
    .map(normalizeVersionPatchFile)
    .filter((file): file is VersionPatchFile => file != null);
};

const getPatchDiffStat = (files: ReadonlyArray<VersionPatchFile>) => ({
  additions: files.reduce(
    (total, file) =>
      total +
      file.patchBody.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'))
        .length,
    0,
  ),
  deletions: files.reduce(
    (total, file) =>
      total +
      file.patchBody.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'))
        .length,
    0,
  ),
  filesChanged: files.length,
});

const commitGraphReaches = (
  targetSha: GitSha,
  ancestorSha: GitSha,
  candidates: ReadonlyArray<GitLabMergeRequestCommit>,
) => {
  const bySha = new Map(candidates.map((commit) => [commit.sha, commit]));
  const visit = (sha: GitSha, visited = new Set<GitSha>()): boolean => {
    if (sha === ancestorSha) {
      return true;
    }
    if (visited.has(sha)) {
      return false;
    }
    visited.add(sha);
    return (bySha.get(sha)?.parentShas ?? []).some((parent) => visit(parent, visited));
  };
  return visit(targetSha);
};

const toBaseMovementCommit = (commit: GitLabMergeRequestCommit) => ({
  authoredAt: commit.authoredDate,
  authorName: commit.authorName,
  sha: commit.sha,
  shortSha: commit.shortSha,
  subject: commit.title,
  webUrl: commit.webUrl,
});

const readBaseMovement = async ({
  fromSha,
  projectPath,
  signal,
  toSha,
  transport,
}: {
  fromSha: GitSha;
  projectPath: string;
  signal?: AbortSignal;
  toSha: GitSha;
  transport: GitLabTransport;
}): Promise<VersionBaseMovement> => {
  signal?.throwIfAborted();
  const baseRef = (sha: GitSha, value?: unknown) => {
    const commit = asRecord(value);
    return {
      committedAt: trimmedString(commit.committed_date) ?? null,
      sha,
      shortSha: trimmedString(commit.short_id) ?? sha.slice(0, 7),
      webUrl:
        trimmedString(commit.web_url) ?? `/${projectPath}/-/commit/${encodeURIComponent(sha)}`,
    };
  };
  if (fromSha === toSha) {
    return {
      changed: false,
      commits: [],
      commitsBetween: 0,
      commitTimestampDeltaMs: null,
      diffStat: { additions: 0, deletions: 0, filesChanged: 0 },
      from: baseRef(fromSha),
      relationship: 'forward',
      to: baseRef(toSha),
      truncated: false,
    };
  }
  try {
    const [fromValue, toValue, compare] = await Promise.all([
      readJson(
        transport,
        createRequest(repositoryCommitEndpoint(projectPath, fromSha), { signal }),
        'Unable to load the old base commit.',
      ),
      readJson(
        transport,
        createRequest(repositoryCommitEndpoint(projectPath, toSha), { signal }),
        'Unable to load the new base commit.',
      ),
      readRepositoryCompare({ from: fromSha, projectPath, signal, to: toSha, transport }),
    ]);
    signal?.throwIfAborted();
    const from = baseRef(fromSha, fromValue);
    const to = baseRef(toSha, toValue);
    const commits = asArray(compare.commits)
      .map((value) => normalizeMergeRequestCommit(value, projectPath))
      .filter((commit): commit is GitLabMergeRequestCommit => commit != null);
    const forwardTruncated = compare.compare_timeout === true || compare.overflow === true;
    let relationship: VersionBaseMovement['relationship'] = commitGraphReaches(
      toSha,
      fromSha,
      commits,
    )
      ? 'forward'
      : 'unknown';
    // Prefer the new-base-facing commit list for UI expansion. For a pure
    // backward base move, fall back to the reverse compare list.
    let movementCommits = commits.map(toBaseMovementCommit);
    let commitsBetween = relationship === 'forward' && !forwardTruncated ? commits.length : null;
    let truncated = forwardTruncated;
    if (relationship === 'unknown' && !forwardTruncated) {
      try {
        const reverse = await readRepositoryCompare({
          from: toSha,
          projectPath,
          signal,
          to: fromSha,
          transport,
        });
        signal?.throwIfAborted();
        const reverseCommits = asArray(reverse.commits)
          .map((value) => normalizeMergeRequestCommit(value, projectPath))
          .filter((commit): commit is GitLabMergeRequestCommit => commit != null);
        const reverseTruncated = reverse.compare_timeout === true || reverse.overflow === true;
        truncated = reverseTruncated;
        if (commitGraphReaches(fromSha, toSha, reverseCommits)) {
          relationship = 'backward';
          movementCommits = reverseCommits.map(toBaseMovementCommit);
          commitsBetween = reverseTruncated ? null : reverseCommits.length;
        } else if (!reverseTruncated) {
          relationship = 'divergent';
          // From→to still describes the new base tip relative to the old one.
          // Count those commits even when the histories diverged, so the UI can
          // show base-diff stats and an expandable commit list.
          commitsBetween = commits.length;
        }
      } catch {
        signal?.throwIfAborted();
        relationship = 'unknown';
      }
    } else if (relationship === 'unknown' && forwardTruncated && commits.length > 0) {
      // GitLab may still return a partial commit list when compare overflows.
      commitsBetween = commits.length;
    }
    const files = asArray(compare.diffs)
      .map(normalizeVersionPatchFile)
      .filter((file): file is VersionPatchFile => file != null);
    const fromTimestamp = from.committedAt ? Date.parse(from.committedAt) : Number.NaN;
    const toTimestamp = to.committedAt ? Date.parse(to.committedAt) : Number.NaN;
    return {
      changed: true,
      commits: movementCommits,
      commitsBetween,
      commitTimestampDeltaMs:
        Number.isFinite(fromTimestamp) && Number.isFinite(toTimestamp)
          ? toTimestamp - fromTimestamp
          : null,
      diffStat: getPatchDiffStat(files),
      from,
      relationship,
      to,
      truncated,
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      changed: true,
      commits: [],
      commitsBetween: null,
      commitTimestampDeltaMs: null,
      diffStat: null,
      from: baseRef(fromSha),
      relationship: 'unknown',
      to: baseRef(toSha),
      truncated: false,
      warning: error instanceof Error ? error.message : 'Base movement details are unavailable.',
    };
  }
};

const resolveVersionCompareEndpoint = ({
  comments,
  endpoint,
  lastReviewed,
  versions,
}: {
  comments?: ReadonlyArray<CommentAnchor>;
  endpoint: VersionCompareEndpoint;
  lastReviewed?: MergeRequestVersionRef | null;
  versions: ReadonlyArray<MergeRequestVersionRef>;
}): MergeRequestVersionRef => {
  if (endpoint.kind === 'mr-base') {
    const oldest = versions[0];
    if (!oldest) {
      throw new Error('No merge request base is available.');
    }
    return {
      ...oldest,
      headSha: oldest.baseSha,
      label: 'MR base',
      startSha: oldest.baseSha,
      versionId: reviewVersionId('base'),
    };
  }
  if (endpoint.kind === 'mr-version') {
    const match = versions.find((version) => version.versionId === endpoint.versionId);
    if (!match) {
      throw new Error(`Unknown merge request version: ${endpoint.versionId}`);
    }
    return match;
  }
  if (endpoint.kind === 'diff-identity') {
    return {
      baseSha: endpoint.baseSha,
      createdAt: new Date(0).toISOString(),
      headSha: endpoint.headSha,
      label: endpoint.headSha.slice(0, 7),
      startSha: endpoint.startSha,
      versionId: reviewVersionId(`identity:${endpoint.headSha}`),
    };
  }
  if (endpoint.kind === 'head-sha') {
    const match = versions.find((version) => version.headSha === endpoint.headSha);
    if (match) {
      return match;
    }
    return {
      baseSha: versions[0]?.baseSha ?? endpoint.headSha,
      createdAt: new Date(0).toISOString(),
      headSha: endpoint.headSha,
      label: endpoint.headSha.slice(0, 7),
      startSha: versions[0]?.startSha ?? versions[0]?.baseSha ?? endpoint.headSha,
      versionId: reviewVersionId(`head:${endpoint.headSha}`),
    };
  }
  if (endpoint.kind === 'last-reviewed') {
    if (!lastReviewed) {
      throw new Error('No last-reviewed identity is available for this merge request.');
    }
    return lastReviewed;
  }
  if (endpoint.kind === 'comment-position') {
    const match = (comments ?? []).find((comment) => comment.commentId === endpoint.commentId);
    if (!match) {
      throw new Error(`Unknown comment position for version comparison: ${endpoint.commentId}`);
    }
    const byHead = versions.find((version) => version.headSha === match.position.headSha);
    if (byHead) {
      return byHead;
    }
    return {
      baseSha: match.position.baseSha,
      createdAt: new Date(0).toISOString(),
      headSha: match.position.headSha,
      label: `comment ${endpoint.commentId} · ${match.position.headSha.slice(0, 7)}`,
      startSha: match.position.startSha,
      versionId: reviewVersionId(`comment:${endpoint.commentId}`),
    };
  }
  throw new Error('Unsupported version-comparison endpoint.');
};

const collectCommentAnchorsFromDiscussions = (
  discussions: ReadonlyArray<unknown>,
): Array<CommentAnchor> =>
  discussions.flatMap((discussionValue) => {
    const discussion = asRecord(discussionValue);
    const notes = asArray(discussion.notes).map(asRecord);
    const readPosition = (note: JsonRecord) => {
      for (const value of [note.position, note.original_position]) {
        const position = asRecord(value);
        if (
          asString(position.new_path ?? position.old_path) &&
          asGitSha(position.base_sha) &&
          asGitSha(position.start_sha) &&
          asGitSha(position.head_sha)
        ) {
          return position;
        }
      }
      return null;
    };
    const discussionPosition = notes.map(readPosition).find((position) => position != null) ?? null;
    return notes.flatMap((note) => {
      if (note.system === true) {
        return [];
      }
      const position = readPosition(note) ?? discussionPosition;
      if (!position) {
        return [];
      }
      const filePath = asString(position.new_path ?? position.old_path);
      const baseSha = asGitSha(position.base_sha);
      const startSha = asGitSha(position.start_sha);
      const headSha = asGitSha(position.head_sha);
      const id = asNumber(note.id);
      if (!filePath || !baseSha || !startSha || !headSha || id == null || !Number.isInteger(id)) {
        return [];
      }
      const rawLine = asNumber(position.new_line ?? position.old_line);
      const anchor: CommentAnchor = {
        commentId: `gitlab:${id}`,
        filePath,
        position: { baseSha, headSha, startSha },
      };
      if (rawLine != null && Number.isInteger(rawLine) && rawLine > 0) {
        anchor.lineNumber = rawLine;
      }
      return [anchor];
    });
  });

export const fetchGitLabMergeRequestVersionCompare = async ({
  comments = [],
  from: fromEndpoint,
  iid,
  lastReviewed = null,
  onReplayDiagnostics,
  paths,
  projectPath: rawProjectPath,
  readBaseMovement: suppliedReadBaseMovement,
  readBlob: suppliedReadBlob,
  readBlobs: suppliedReadBlobs,
  readCached,
  readRangeFiles,
  signal,
  to: toEndpoint,
  transport,
  versions: suppliedVersions,
  writeCached,
}: {
  comments?: ReadonlyArray<CommentAnchor>;
  from: VersionCompareEndpoint;
  iid: number;
  lastReviewed?: MergeRequestVersionRef | null;
  /** Host-only metrics for the exact aggregate regional replay. */
  onReplayDiagnostics?: (diagnostics: ReplayCompareDiagnostics) => void;
  paths?: ReadonlyArray<string>;
  projectPath: string;
  /** Host Artifact Source projection for target-base movement. */
  readBaseMovement?: (fromSha: GitSha, toSha: GitSha) => Promise<VersionBaseMovement>;
  /** Host Artifact Source blob lookup. When supplied, provider raw-file fallback is disabled. */
  readBlob?: (filePath: string, ref: GitSha) => Promise<string | null>;
  /** One host-owned proof batch for every regional replay endpoint. */
  readBlobs?: ReplayBlobBatchLookup;
  readCached?: (range: {
    from: MergeRequestVersionRef;
    to: MergeRequestVersionRef;
  }) => Promise<MergeRequestVersionCompare | null> | MergeRequestVersionCompare | null;
  /**
   * Authoritative host Range Artifact lookup. The host owns every backend
   * fallback; incomplete evidence remains incomplete instead of being retried
   * through a second provider path here.
   */
  readRangeFiles?: (baseSha: GitSha, headSha: GitSha) => Promise<GitLabRangeFiles>;
  /** Superseding a comparison stops aggregate replay before it is cached. */
  signal?: AbortSignal;
  to: VersionCompareEndpoint;
  transport: GitLabTransport;
  /** Reuse the immutable version list already loaded by the host. */
  versions?: ReadonlyArray<MergeRequestVersionRef>;
  writeCached?: (versionCompare: MergeRequestVersionCompare) => Promise<void> | void;
}): Promise<MergeRequestVersionCompare> => {
  signal?.throwIfAborted();
  const projectPath = validateProjectPath(rawProjectPath);
  if (!Number.isInteger(iid) || iid <= 0) {
    throw new Error('Invalid GitLab merge request IID.');
  }
  const needsCommentAnchors =
    comments.length === 0 ||
    fromEndpoint.kind === 'comment-position' ||
    toEndpoint.kind === 'comment-position';
  const [versions, discussionAnchors] = await Promise.all([
    suppliedVersions
      ? Promise.resolve([...suppliedVersions])
      : fetchGitLabReviewVersionTimeline({
          iid,
          projectPath,
          signal,
          transport,
        }),
    needsCommentAnchors
      ? readPages(transport, mergeRequestEndpoint(projectPath, iid, '/discussions'), signal).then(
          collectCommentAnchorsFromDiscussions,
        )
      : Promise.resolve([] as Array<CommentAnchor>),
  ]);
  signal?.throwIfAborted();
  if (versions.length === 0) {
    throw new Error('GitLab did not return merge request versions for version comparison.');
  }
  const resolvedComments = [...comments, ...discussionAnchors];
  const from = resolveVersionCompareEndpoint({
    comments: resolvedComments,
    endpoint: fromEndpoint,
    lastReviewed,
    versions,
  });
  const to = resolveVersionCompareEndpoint({
    comments: resolvedComments,
    endpoint: toEndpoint,
    lastReviewed,
    versions,
  });
  if (from.headSha === to.headSha && from.baseSha === to.baseSha) {
    throw new Error('Version comparison requires distinct from and to endpoints.');
  }
  if (readCached) {
    const cached = await readCached({ from, to });
    signal?.throwIfAborted();
    if (cached) {
      return cached;
    }
  }

  const baseMovementPromise = suppliedReadBaseMovement
    ? suppliedReadBaseMovement(from.baseSha, to.baseSha)
    : readBaseMovement({
        fromSha: from.baseSha,
        projectPath,
        signal,
        toSha: to.baseSha,
        transport,
      });
  // Aggregate replay can be superseded before this ancillary metadata read
  // settles. Keep its rejection observed while the caller exits promptly.
  void baseMovementPromise.catch(() => {});

  const loadVersionFiles = async (version: MergeRequestVersionRef) => {
    signal?.throwIfAborted();
    if (readRangeFiles) {
      const value = await readRangeFiles(version.baseSha, version.headSha);
      signal?.throwIfAborted();
      const files = isGitLabHostRangeFiles(value) ? [...value.files] : [...value];
      const coverage = isGitLabHostRangeFiles(value)
        ? value.coverage
        : files.some((file) => file.coverage === 'truncated')
          ? 'truncated'
          : files.some((file) => file.coverage === 'opaque')
            ? 'opaque'
            : 'complete';
      return coverage === 'complete'
        ? files
        : files.map<VersionPatchFile>((file) =>
            file.coverage === 'complete' || file.coverage == null
              ? {
                  ...file,
                  coverage: coverage === 'opaque' ? ('opaque' as const) : ('truncated' as const),
                }
              : file,
          );
    }
    const listed = versions.find((candidate) => candidate.versionId === version.versionId);
    if (listed) {
      try {
        return await readMergeRequestVersionFiles({
          iid,
          projectPath,
          signal,
          transport,
          versionId: version.versionId,
        });
      } catch {
        signal?.throwIfAborted();
        // Fall through to repository compare.
      }
    }
    return readCompareFiles({
      from: version.baseSha,
      projectPath,
      signal,
      to: version.headSha,
      transport,
    });
  };

  const [fromFiles, toFiles] = await Promise.all([loadVersionFiles(from), loadVersionFiles(to)]);
  signal?.throwIfAborted();
  const blobCache = new Map<string, string | null>();
  const readBlob = async (filePath: string, ref: string) => {
    signal?.throwIfAborted();
    if (suppliedReadBlob) {
      const content = await suppliedReadBlob(filePath, ref as GitSha);
      signal?.throwIfAborted();
      return content;
    }
    const key = `${ref}:${filePath}`;
    if (blobCache.has(key)) {
      return blobCache.get(key) ?? null;
    }
    try {
      const content = await readBlobText(
        transport,
        createRequest(repositoryFileRawEndpoint(projectPath, filePath, ref), {
          headers: { accept: 'text/plain' },
        }),
      );
      signal?.throwIfAborted();
      blobCache.set(key, content);
      return content;
    } catch {
      signal?.throwIfAborted();
      blobCache.set(key, null);
      return null;
    }
  };
  const computedVersionCompare = await computeVersionComparePreferringReplay({
    comments: resolvedComments,
    from,
    fromFiles,
    paths,
    readBlob,
    readBlobs: suppliedReadBlobs,
    ...(onReplayDiagnostics ? { onDiagnostics: onReplayDiagnostics } : {}),
    ...(signal ? { signal } : {}),
    to,
    toFiles,
  });
  signal?.throwIfAborted();
  const versionCompare: MergeRequestVersionCompare = {
    ...computedVersionCompare,
    baseMovement: await baseMovementPromise,
  };
  signal?.throwIfAborted();
  if (writeCached) {
    try {
      await writeCached(versionCompare);
    } catch {
      // Cache writes are best-effort.
    }
  }
  return versionCompare;
};

const resolveVersionCommitRange = async ({
  from,
  iid,
  projectPath,
  to,
  transport,
  versions: suppliedVersions,
}: {
  from: VersionCompareEndpoint;
  iid: number;
  projectPath: string;
  to: VersionCompareEndpoint;
  transport: GitLabTransport;
  versions?: ReadonlyArray<MergeRequestVersionRef>;
}) => {
  const versions =
    suppliedVersions ??
    (from.kind === 'diff-identity' && to.kind === 'diff-identity'
      ? []
      : await fetchGitLabReviewVersionTimeline({
          iid,
          projectPath,
          transport,
        }));
  if (versions.length === 0 && (from.kind !== 'diff-identity' || to.kind !== 'diff-identity')) {
    throw new Error('GitLab did not return merge request versions.');
  }
  return {
    from: resolveVersionCompareEndpoint({ endpoint: from, versions }),
    to: resolveVersionCompareEndpoint({ endpoint: to, versions }),
  };
};

export const fetchGitLabHistoricalCommitStack = async ({
  baseSha,
  headSha,
  projectPath: rawProjectPath,
  signal,
  transport,
}: {
  baseSha: GitSha;
  headSha: GitSha;
  projectPath: string;
  signal?: AbortSignal;
  transport: GitLabTransport;
}): Promise<Array<GitLabMergeRequestCommit>> => {
  if (baseSha === headSha) {
    return [];
  }
  const projectPath = validateProjectPath(rawProjectPath);
  const compare = await readRepositoryCompare({
    from: baseSha,
    projectPath,
    signal,
    to: headSha,
    transport,
  });
  if (compare.compare_timeout === true || compare.overflow === true) {
    throw new Error('GitLab truncated the historical commit stack.');
  }
  const commits = asArray(compare.commits)
    .map((value) => normalizeMergeRequestCommit(value, projectPath))
    .filter(
      (commit): commit is GitLabMergeRequestCommit => commit != null && commit.sha !== baseSha,
    );
  return [...orderReviewCommitStack(commits)];
};

const readCommitPatchFiles = async ({
  projectPath,
  sha,
  transport,
}: {
  projectPath: string;
  sha: GitSha;
  transport: GitLabTransport;
}) => {
  const values = await readPages(transport, repositoryCommitDiffEndpoint(projectPath, sha));
  return values
    .map(normalizeVersionPatchFile)
    .filter((file): file is VersionPatchFile => file != null);
};

const scopeVersionCommitFiles = (
  files: ReadonlyArray<ChangedFile>,
  unitId: EvolutionUnitId,
  targetRange?: DiffRange,
): Array<ChangedFile> =>
  files.map((file, fileIndex) => ({
    ...file,
    fingerprint: `${unitId}:${fileIndex}:${file.fingerprint}`,
    sections: file.sections.map((section, sectionIndex) => ({
      ...section,
      id: `${file.path}:version-commit:${unitId}:${sectionIndex}`,
      ...(targetRange ? { range: targetRange } : {}),
    })),
  }));

type VersionCommitFingerprintCache = {
  read?(shas: ReadonlyArray<GitSha>): Promise<ReadonlyMap<GitSha, CommitFingerprint>>;
  write?(fingerprints: ReadonlyArray<CommitFingerprint>): Promise<void>;
};

export type GitLabVersionCommitReaders = {
  /** Read an immutable text blob locally, or return null to use the provider fallback. */
  readBlob?(path: string, ref: GitSha): Promise<string | null>;
  /** Bulk immutable Commit Artifacts. Missing coordinates use the provider source. */
  readCommitArtifacts?(
    commits: ReadonlyArray<CommitArtifactRequest>,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<GitSha, CommitArtifact>>;
  /** Read a commit's changed files locally for render materialization. */
  readCommitDiff?(sha: GitSha): Promise<ReadonlyArray<ChangedFile>>;
  /** Read provider-neutral patch files locally for replay materialization. */
  readCommitPatchFiles?(sha: GitSha): Promise<ReadonlyArray<VersionPatchFile>>;
  /** Read commits in base..head order locally. */
  readCommitStack?(
    baseSha: GitSha,
    headSha: GitSha,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<GitLabMergeRequestCommit>>;
  /** Read a direct range locally, including reverse ranges for removed commits. */
  readRangeDiff?(fromSha: GitSha, toSha: GitSha): Promise<ReadonlyArray<ChangedFile>>;
  /** One host-owned proof batch for every revised-unit replay endpoint. */
  readReplayBlobs?: ReplayBlobBatchLookup;
};

const readHostOrProvider = <Value>(
  readHost: (() => Promise<Value>) | undefined,
  readProvider: () => Promise<Value>,
): Promise<Value> => (readHost ? readHost() : readProvider());

type ReviewVersionEvolutionProgress = {
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
};

export type GitLabVersionEvolutionControl = {
  /** Host-only metrics for global commit assignment. */
  onMatcherDiagnostics?: (diagnostics: CommitStackMatchDiagnostics) => void;
  onProgress?: (progress: ReviewVersionEvolutionProgress) => void;
  signal?: AbortSignal;
};

const loadCommitFingerprints = async ({
  cache,
  commits,
  fingerprints,
  project,
  projectPath,
  readers,
  signal,
  transport,
}: {
  cache?: VersionCommitFingerprintCache;
  commits: ReadonlyArray<GitLabMergeRequestCommit>;
  fingerprints: Map<GitSha, CommitFingerprint>;
  project: ReviewArtifactProject;
  projectPath: string;
  readers?: GitLabVersionCommitReaders;
  signal?: AbortSignal;
  transport: GitLabTransport;
}) => {
  const requestedShas = commits.map((commit) => commit.sha).filter((sha) => !fingerprints.has(sha));
  try {
    for (const [sha, fingerprint] of (await cache?.read?.(requestedShas)) ?? []) {
      fingerprints.set(sha, fingerprint);
    }
  } catch {
    // A missing or stale immutable cache must not prevent direct analysis.
  }
  const uncachedShas = requestedShas.filter((sha) => !fingerprints.has(sha));
  const uncachedCommits = commits
    .filter((commit) => uncachedShas.includes(commit.sha))
    .map((commit) => ({ commitSha: commit.sha, parentSha: commit.parentShas[0] ?? null }));
  let localArtifacts: ReadonlyMap<GitSha, CommitArtifact> = new Map();
  if (readers?.readCommitArtifacts && uncachedCommits.length > 0) {
    try {
      localArtifacts = await readers.readCommitArtifacts(uncachedCommits, signal);
    } catch {
      signal?.throwIfAborted();
      // Provider artifacts fill any locally unavailable historical objects.
    }
  }
  // A host reader is an authoritative Artifact Source, not a local-only probe.
  // It owns native/provider fallback and completeness, so retrying incomplete
  // values here would acquire the same immutable key outside its Comparison Run.
  const providerArtifacts = readers?.readCommitArtifacts
    ? new Map<GitSha, CommitArtifact>()
    : await fetchGitLabCommitArtifacts({
        commits: commits
          .filter(
            (commit) =>
              uncachedShas.includes(commit.sha) &&
              localArtifacts.get(commit.sha)?.coverage !== 'complete',
          )
          .map((commit) => ({ parentSha: commit.parentShas[0] ?? null, sha: commit.sha })),
        project,
        projectPath,
        signal,
        transport,
      });
  const newFingerprints: Array<CommitFingerprint> = [];
  for (const commit of commits) {
    if (fingerprints.has(commit.sha)) {
      continue;
    }
    const localArtifact = localArtifacts.get(commit.sha);
    const artifact =
      localArtifact?.coverage === 'complete'
        ? localArtifact
        : (providerArtifacts.get(commit.sha) ?? localArtifact);
    if (!artifact) {
      continue;
    }
    const fingerprint = await createCommitFingerprint(commit, artifact);
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

export const fetchGitLabMergeRequestVersionCommitEvolution = async ({
  cache,
  control = {},
  from: fromEndpoint,
  iid,
  project,
  projectPath: rawProjectPath,
  readers,
  to: toEndpoint,
  transport,
  versions,
}: {
  cache?: VersionCommitFingerprintCache;
  control?: GitLabVersionEvolutionControl;
  from: VersionCompareEndpoint;
  iid: number;
  project: ReviewArtifactProject;
  projectPath: string;
  readers?: GitLabVersionCommitReaders;
  to: VersionCompareEndpoint;
  transport: GitLabTransport;
  /** Reuse an already loaded immutable version list when aggregate loading ran first. */
  versions?: ReadonlyArray<MergeRequestVersionRef>;
}): Promise<CommitStackEvolution> => {
  const projectPath = validateProjectPath(rawProjectPath);
  const { signal } = control;
  control.onProgress?.({
    message: 'Reading previous and current commit stacks',
    phase: 'reading-stacks',
  });
  signal?.throwIfAborted();
  const range = await resolveVersionCommitRange({
    from: fromEndpoint,
    iid,
    projectPath,
    to: toEndpoint,
    transport,
    versions,
  });
  const warnings: Array<string> = [];
  const readStack = async (baseSha: GitSha, headSha: GitSha) =>
    orderReviewCommitStack(
      await readHostOrProvider(
        readers?.readCommitStack
          ? async () => [...(await readers.readCommitStack!(baseSha, headSha, signal))]
          : undefined,
        () =>
          fetchGitLabHistoricalCommitStack({
            baseSha,
            headSha,
            projectPath,
            signal,
            transport,
          }),
      ),
    );
  const [oldStackResult, newStackResult] = await Promise.allSettled([
    readStack(range.from.baseSha, range.from.headSha),
    readStack(range.to.baseSha, range.to.headSha),
  ]);
  signal?.throwIfAborted();
  const stackCompleteness = {
    new: newStackResult.status === 'fulfilled',
    old: oldStackResult.status === 'fulfilled',
  };
  let oldCommits = oldStackResult.status === 'fulfilled' ? oldStackResult.value : [];
  let newCommits = newStackResult.status === 'fulfilled' ? newStackResult.value : [];
  if (!stackCompleteness.old) {
    warnings.push(
      'The earlier commit stack is unavailable. Visible commits remain unclassified rather than being called new.',
    );
  }
  if (!stackCompleteness.new) {
    warnings.push(
      'The later commit stack is unavailable. Visible commits remain unclassified rather than being called removed.',
    );
  }
  if (oldCommits.length > versionCommitStackLimit) {
    oldCommits = oldCommits.slice(-versionCommitStackLimit);
    stackCompleteness.old = false;
    warnings.push(
      `Only the latest ${versionCommitStackLimit} commits from the earlier version were analyzed; unmatched commits remain unclassified.`,
    );
  }
  if (newCommits.length > versionCommitStackLimit) {
    newCommits = newCommits.slice(-versionCommitStackLimit);
    stackCompleteness.new = false;
    warnings.push(
      `Only the latest ${versionCommitStackLimit} commits from the later version were analyzed; unmatched commits remain unclassified.`,
    );
  }
  const sameShas = new Set(
    oldCommits
      .map((commit) => commit.sha)
      .filter((sha) => newCommits.some((commit) => commit.sha === sha)),
  );
  const commitsNeedingEvidence = [...oldCommits, ...newCommits].filter(
    (commit, index, commits) =>
      !sameShas.has(commit.sha) &&
      commits.findIndex((candidate) => candidate.sha === commit.sha) === index,
  );
  const progressContext = {
    commits: newCommits.map((commit) => ({
      authoredAt: commit.authoredDate,
      authorName: commit.authorName,
      parentShas: commit.parentShas,
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: commit.title,
      webUrl: commit.webUrl,
    })),
    exactMatchShas: [...sameShas],
  };
  const reportProgress = (
    progress: Omit<ReviewVersionEvolutionProgress, 'commits' | 'exactMatchShas'>,
  ) => control.onProgress?.({ ...progressContext, ...progress });
  reportProgress({
    completed: 0,
    message: `Reading MR commit evidence 0/${commitsNeedingEvidence.length}`,
    phase: 'reading-mr-evidence',
    total: commitsNeedingEvidence.length,
  });
  const fingerprints = new Map<GitSha, CommitFingerprint>();
  const missingEvidence = await loadCommitFingerprints({
    cache,
    commits: commitsNeedingEvidence,
    fingerprints,
    project,
    projectPath,
    readers,
    signal,
    transport,
  });
  reportProgress({
    completed: commitsNeedingEvidence.length,
    message: `Read MR commit evidence ${commitsNeedingEvidence.length}/${commitsNeedingEvidence.length}`,
    phase: 'reading-mr-evidence',
    total: commitsNeedingEvidence.length,
  });
  if (missingEvidence.length > 0) {
    warnings.push(
      `Change evidence was unavailable for ${missingEvidence.length} ${missingEvidence.length === 1 ? 'commit' : 'commits'}; they remain unclassified rather than being called new or removed.`,
    );
    stackCompleteness.old = false;
    stackCompleteness.new = false;
  }
  const compose = (
    baseCommits: ReadonlyArray<GitLabMergeRequestCommit>,
    baseStackComplete: boolean,
  ) => {
    signal?.throwIfAborted();
    reportProgress({ message: 'Composing Evolution Units', phase: 'composing-units' });
    return matchVersionCommitStacks({
      baseCommits,
      baseStackComplete,
      fingerprints,
      from: range.from,
      newCommits,
      ...(control.onMatcherDiagnostics ? { onDiagnostics: control.onMatcherDiagnostics } : {}),
      oldCommits,
      ...(signal ? { signal } : {}),
      stackCompleteness,
      to: range.to,
      warnings,
    });
  };
  if (range.from.baseSha === range.to.baseSha) {
    return compose([], true);
  }
  const preliminary = await matchVersionCommitStacks({
    baseStackComplete: false,
    fingerprints,
    from: range.from,
    newCommits,
    ...(control.onMatcherDiagnostics ? { onDiagnostics: control.onMatcherDiagnostics } : {}),
    oldCommits,
    ...(signal ? { signal } : {}),
    stackCompleteness,
    to: range.to,
  });
  const unmatchedOldShas = new Set(
    preliminary.units
      .filter((unit) => unit.before && !unit.after && !unit.baseCommit)
      .map((unit) => unit.before!.sha),
  );
  if (unmatchedOldShas.size === 0) {
    return compose([], true);
  }
  reportProgress({ message: 'Reading target-base commit stack', phase: 'reading-base-stack' });
  const baseResult = await readStack(range.from.baseSha, range.to.baseSha).then(
    (value) => ({ status: 'fulfilled' as const, value }),
    () => ({ status: 'rejected' as const }),
  );
  signal?.throwIfAborted();
  let baseStackComplete = baseResult.status === 'fulfilled';
  let baseCommits = baseResult.status === 'fulfilled' ? baseResult.value : [];
  if (!baseStackComplete) {
    warnings.push(
      'Target-base movement could not be analyzed. Earlier commits that moved into the base remain unclassified.',
    );
  }
  if (baseCommits.length > versionCommitStackLimit) {
    baseCommits = baseCommits.slice(-versionCommitStackLimit);
    baseStackComplete = false;
    warnings.push(
      `Only the latest ${versionCommitStackLimit} target-base commits were analyzed; earlier commits that moved into the base may remain unclassified.`,
    );
  }
  const directBaseShas = new Set(
    baseCommits.filter((commit) => unmatchedOldShas.has(commit.sha)).map((commit) => commit.sha),
  );
  const baseNeedingEvidence = baseCommits.filter((commit) => !directBaseShas.has(commit.sha));
  reportProgress({
    completed: 0,
    message: `Reading target-base evidence 0/${baseNeedingEvidence.length}`,
    phase: 'reading-base-evidence',
    total: baseNeedingEvidence.length,
  });
  const missingBaseEvidence = await loadCommitFingerprints({
    cache,
    commits: baseNeedingEvidence,
    fingerprints,
    project,
    projectPath,
    readers,
    signal,
    transport,
  });
  if (missingBaseEvidence.length > 0) {
    baseStackComplete = false;
    warnings.push(
      `Change evidence was unavailable for ${missingBaseEvidence.length} target-base ${missingBaseEvidence.length === 1 ? 'commit' : 'commits'}; earlier MR commits are only marked as removed when base evidence is complete.`,
    );
  }
  return compose(baseCommits, baseStackComplete);
};

export const attributeVersionCommitRebaseOverlaps = async ({
  baseCommits,
  project,
  projectPath,
  transport,
  unit,
  unitFiles,
}: {
  baseCommits: ReadonlyArray<{
    authoredAt: string;
    authorName: string;
    parentShas?: ReadonlyArray<GitSha>;
    sha: GitSha;
    shortSha: string;
    subject: string;
    webUrl: string;
  }>;
  project: ReviewArtifactProject;
  projectPath: string;
  transport: GitLabTransport;
  unit: VersionCommitEvolutionUnit;
  unitFiles: ReadonlyArray<ChangedFile>;
}): Promise<ReadonlyArray<VersionRebaseOverlapCommit>> => {
  if (unit.kind !== 'likely-revised' || baseCommits.length === 0 || unitFiles.length === 0) {
    return unit.rebaseOverlaps ?? [];
  }
  const unitSha = unit.after?.sha ?? unit.before?.sha;
  if (!unitSha) {
    return unit.rebaseOverlaps ?? [];
  }
  const unitFingerprint = await createCommitFingerprint(
    {
      sha: unitSha,
      title: unit.after?.subject ?? unit.before?.subject ?? unit.unitId,
    },
    toCommitArtifact({
      commitSha: unitSha,
      files: unitFiles,
      parentSha: unit.after?.parentShas[0] ?? unit.before?.parentShas[0] ?? null,
      provenance: { kind: 'gitlab-api', project },
    }),
  );
  const fingerprints = new Map<GitSha, CommitFingerprint>();
  // Cap base-commit evidence work; large base moves are common on revived MRs.
  const candidates = baseCommits.slice(0, 40);
  for (let index = 0; index < candidates.length; index += versionCommitEvidenceConcurrency) {
    const batch = candidates.slice(index, index + versionCommitEvidenceConcurrency);
    await Promise.all(
      batch.map(async (commit) => {
        try {
          const files = await fetchGitLabCommitDiff({
            projectPath,
            sha: commit.sha,
            transport,
          });
          fingerprints.set(
            commit.sha,
            await createCommitFingerprint(
              { sha: commit.sha, title: commit.subject },
              toCommitArtifact({
                commitSha: commit.sha,
                files,
                parentSha: commit.parentShas?.[0] ?? null,
                provenance: { kind: 'gitlab-api', project },
              }),
            ),
          );
        } catch {
          // Skip unreadable base commits rather than failing the unit walkthrough.
        }
      }),
    );
  }
  return attributeRebaseOverlaps({
    baseCommits: candidates,
    baseFingerprints: fingerprints,
    unitFingerprint,
  });
};

export const fetchGitLabVersionCommitUnitDiff = async ({
  projectPath: rawProjectPath,
  readers,
  targetRange,
  transport,
  unit,
}: {
  projectPath: string;
  readers?: GitLabVersionCommitReaders;
  targetRange?: DiffRange;
  transport: GitLabTransport;
  unit: VersionCommitEvolutionUnit;
}): Promise<Array<ChangedFile>> => {
  const projectPath = validateProjectPath(rawProjectPath);
  if (!unit.reviewable) {
    throw new Error('This commit evolution unit is not reviewable.');
  }
  const addressableRange = unit.kind === 'removed' ? undefined : targetRange;
  if (unit.kind === 'added' && unit.after) {
    return scopeVersionCommitFiles(
      await readHostOrProvider(
        readers?.readCommitDiff
          ? async () => [...(await readers.readCommitDiff!(unit.after!.sha))]
          : undefined,
        () => fetchGitLabCommitDiff({ projectPath, sha: unit.after!.sha, transport }),
      ),
      unit.unitId,
      addressableRange,
    );
  }
  if (unit.kind === 'removed' && unit.before) {
    const parent = unit.before.parentShas[0];
    if (!parent) {
      throw new Error('The removed commit parent is unavailable.');
    }
    const files = await readHostOrProvider(
      readers?.readRangeDiff
        ? async () => [...(await readers.readRangeDiff!(unit.before!.sha, parent))]
        : undefined,
      async () => {
        const compare = await readRepositoryCompare({
          from: unit.before!.sha,
          projectPath,
          to: parent,
          transport,
        });
        return asArray(compare.diffs)
          .map((diff, index) => normalizeDiff(diff, 0, parent, index, 'commit', unit.unitId))
          .filter((file): file is ChangedFile => file != null);
      },
    );
    return scopeVersionCommitFiles(files, unit.unitId, addressableRange);
  }
  if (unit.kind === 'likely-revised' && unit.before && unit.after) {
    const oldParent = unit.before.parentShas[0];
    const newParent = unit.after.parentShas[0];
    if (!oldParent || !newParent) {
      throw new Error('A revised commit parent is unavailable.');
    }
    const [fromFiles, toFiles] = await Promise.all([
      readHostOrProvider(
        readers?.readCommitPatchFiles
          ? async () => [...(await readers.readCommitPatchFiles!(unit.before!.sha))]
          : undefined,
        () => readCommitPatchFiles({ projectPath, sha: unit.before!.sha, transport }),
      ),
      readHostOrProvider(
        readers?.readCommitPatchFiles
          ? async () => [...(await readers.readCommitPatchFiles!(unit.after!.sha))]
          : undefined,
        () => readCommitPatchFiles({ projectPath, sha: unit.after!.sha, transport }),
      ),
    ]);
    const blobs = new Map<string, string | null>();
    const readBlob = async (filePath: string, ref: string) => {
      const key = `${ref}:${filePath}`;
      if (blobs.has(key)) {
        return blobs.get(key) ?? null;
      }
      if (readers?.readBlob) {
        try {
          const content = await readers.readBlob(filePath, ref as GitSha);
          if (content != null) {
            blobs.set(key, content);
            return content;
          }
        } catch {
          // Fall through when a historical object is not present locally.
        }
      }
      try {
        const content = await readBlobText(
          transport,
          createRequest(repositoryFileRawEndpoint(projectPath, filePath, ref), {
            headers: { accept: 'text/plain' },
          }),
        );
        blobs.set(key, content);
        return content;
      } catch {
        blobs.set(key, null);
        return null;
      }
    };
    const comparison = await computeVersionComparePreferringReplay({
      from: {
        baseSha: oldParent,
        createdAt: unit.before.authoredAt,
        headSha: unit.before.sha,
        label: unit.before.shortSha,
        startSha: oldParent,
        versionId: reviewVersionId(unit.before.sha),
      },
      fromFiles,
      readBlob,
      ...(readers?.readReplayBlobs ? { readBlobs: readers.readReplayBlobs } : {}),
      to: {
        baseSha: newParent,
        createdAt: unit.after.authoredAt,
        headSha: unit.after.sha,
        label: unit.after.shortSha,
        startSha: newParent,
        versionId: reviewVersionId(unit.after.sha),
      },
      toFiles,
    });
    return scopeVersionCommitFiles(
      comparison.files.map((file) => file.file),
      unit.unitId,
      addressableRange,
    );
  }
  throw new Error('Unsupported commit evolution unit.');
};

export const projectMergeRequestVersionRef = (
  version: MergeRequestVersionRef & {
    activity?: ReviewVersionOption['activity'];
    createdAt?: string;
    diffStat?: ReviewVersionOption['diffStat'];
    isHead?: boolean;
    number?: number;
    previousCreatedAt?: string;
    previousNumber?: number;
  },
): ReviewVersionOption =>
  reviewVersionOption({
    createdAt: version.createdAt,
    range: diffRange(
      revisionRef(version.baseSha, commitRevisionLabel(version.baseSha.slice(0, 7))),
      revisionRef(version.headSha, versionRevisionLabel(version.label, undefined)),
    ),
    ...(version.diffStat ? { diffStat: version.diffStat } : {}),
    ...(version.activity ? { activity: version.activity } : {}),
    ...(version.isHead != null ? { isHead: version.isHead } : {}),
    ...(version.number != null ? { number: version.number } : {}),
    ...(version.previousCreatedAt ? { previousCreatedAt: version.previousCreatedAt } : {}),
    ...(version.previousNumber != null ? { previousNumber: version.previousNumber } : {}),
    versionId: version.versionId,
  });

export { projectCommitEvolution, projectEvolutionUnit } from '@nkzw/codiff-core';

export const projectVersionCompare = (
  compare: MergeRequestVersionCompare,
  files: ReadonlyArray<ChangedFile> = compare.files.map((file) => file.file),
): DiffComparisonView => {
  const from = projectMergeRequestVersionRef(compare.range.from);
  const to = projectMergeRequestVersionRef(compare.range.to);
  const analysis: DiffComparisonAnalysis = {
    summary: compare.summary,
    ...(compare.baseMovement ? { baseMovement: compare.baseMovement } : {}),
    ...(compare.commentAssociations ? { commentAssociations: compare.commentAssociations } : {}),
    ...(compare.warnings ? { warnings: compare.warnings } : {}),
  };
  return diffComparisonView({
    analysis,
    comparison: diffComparison(from.range, to.range),
    files,
    from,
    to,
  });
};

export const projectReviewPlan = ({
  evolution,
  structure,
  versionCompare,
}: {
  evolution?: CommitStackEvolution | ReviewCommitEvolution | null;
  structure?: 'auto' | VersionComparisonReviewStructure;
  versionCompare?: MergeRequestVersionCompare | DiffComparisonView | null;
}): ReviewPlan => {
  const projectedEvolution =
    evolution &&
    'recommendation' in evolution &&
    'reason' in (evolution as CommitStackEvolution).recommendation
      ? projectCommitEvolution(evolution as CommitStackEvolution)
      : (evolution as ReviewCommitEvolution | undefined);
  const view =
    versionCompare && 'range' in versionCompare
      ? projectVersionCompare(versionCompare)
      : (versionCompare as DiffComparisonView | undefined);
  const analysis = view
    ? {
        ...view.analysis,
        ...(projectedEvolution ? { commitEvolution: projectedEvolution } : {}),
      }
    : projectedEvolution
      ? {
          commitEvolution: projectedEvolution,
          summary: {
            addedLines: 0,
            baseMoved: false,
            commentsAffected: 0,
            conflictFiles: 0,
            deletedLines: 0,
            empty: false,
            filesChanged: 0,
            intentionalFiles: 0,
            noiseFiles: 0,
          },
        }
      : undefined;
  return resolveReviewPlan({
    analysis,
    comparison: view?.comparison,
    recommendation: projectedEvolution?.recommendation,
    structure,
    units: projectedEvolution?.units,
  });
};

export const toGitLabDiffIdentity = (version: MergeRequestVersionRef): GitLabDiffIdentity => ({
  baseSha: version.baseSha,
  headSha: version.headSha,
  startSha: version.startSha,
});
