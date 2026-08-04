import {
  createCommitArtifactRequestKey,
  createFileBlobArtifactRequestKey,
  orderReviewCommitStack,
  validateCommitArtifact,
  validateRangeArtifact,
  validateStackSnapshot,
  type ArtifactFile,
  type BlobArtifact,
  type CommitArtifact,
  type CommitArtifactRequest,
  type CommitArtifactRequestKey,
  type FileBlobArtifactRequest,
  type RangeArtifact,
  type ReviewArtifactProject,
  type ReviewArtifactSource,
  type StackSnapshot,
} from '@nkzw/codiff-core';
import type { GitSha, ReviewCommitSummary } from '@nkzw/codiff-core/types';
import type { GitLabTransport } from './transport.ts';

const artifactReadConcurrency = 8;
const maxPages = 20;
const maxArtifactResponseBytes = 8 * 1024 * 1024;
const maxBlobArtifactBytes = 8 * 1024 * 1024;

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
const trimmedString = (value: unknown) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const normalizeBlobArtifactMaxBytes = (value: number | undefined) => {
  const maxBytes = value ?? maxBlobArtifactBytes;
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

const repositoryCompareEndpoint = (projectPath: string, from: string, to: string) => ({
  path: `/api/v4/projects/${encodeURIComponent(projectPath)}/repository/compare`,
  query: { from, straight: 'true', to },
});

const repositoryCommitDiffEndpoint = (projectPath: string, sha: string) =>
  `/api/v4/projects/${encodeURIComponent(projectPath)}/repository/commits/${encodeURIComponent(sha)}/diff`;

const repositoryBlobRawEndpoint = (projectPath: string, objectId: string) =>
  `/api/v4/projects/${encodeURIComponent(projectPath)}/repository/blobs/${encodeURIComponent(objectId)}/raw`;

const repositoryFileEndpoint = (projectPath: string, filePath: string) =>
  `/api/v4/projects/${encodeURIComponent(projectPath)}/repository/files/${encodeURIComponent(filePath)}`;

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

const readPages = async (
  transport: GitLabTransport,
  path: string,
  signal?: AbortSignal,
): Promise<Array<unknown>> => {
  if (transport.requestPages) {
    return transport.requestPages({ maxBytes: maxArtifactResponseBytes, path, signal });
  }
  const values: Array<unknown> = [];
  let page = 1;
  while (page <= maxPages) {
    signal?.throwIfAborted();
    const result = await transport.request<unknown>({
      maxBytes: maxArtifactResponseBytes,
      path,
      query: { page, per_page: 100 },
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

const countPatchLines = (patch: string) => {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions += 1;
    }
  }
  return { additions, deletions };
};

const normalizeMergeRequestCommit = (
  value: unknown,
  projectPath: string,
): ReviewCommitSummary | null => {
  const commit = asRecord(value);
  const sha = asGitSha(commit.id ?? commit.sha);
  if (!sha) {
    return null;
  }
  const title = asString(commit.title, asString(commit.message).split('\n')[0] || sha.slice(0, 8));
  const parentShas = asArray(commit.parent_ids)
    .map(asGitSha)
    .filter((parent): parent is GitSha => parent != null);
  const authorName =
    trimmedString(commit.author_name) ?? trimmedString(asRecord(commit.author).name) ?? 'Unknown';
  const authoredAt =
    asString(commit.authored_date) ||
    asString(commit.created_at) ||
    asString(commit.committed_date) ||
    new Date(0).toISOString();
  return {
    authoredAt,
    authorName,
    parentShas,
    sha,
    shortSha: asString(commit.short_id, sha.slice(0, 8)),
    subject: title,
    webUrl: asString(commit.web_url) || `/${projectPath}/-/commit/${encodeURIComponent(sha)}`,
  };
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
    ...(patch.trim() ? { lineCount: countPatchLines(patch) } : {}),
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
  commit: CommitArtifactRequest,
  project: ReviewArtifactProject,
  values: ReadonlyArray<unknown>,
  truncated = false,
): CommitArtifact => {
  const files = values
    .map(normalizeCommitArtifactFile)
    .filter((file): file is ArtifactFile => file != null);
  const coverage =
    truncated ||
    files.length !== values.length ||
    files.some((file) => file.coverage === 'truncated')
      ? 'truncated'
      : files.some((file) => file.coverage === 'opaque')
        ? 'opaque'
        : 'complete';
  return validateCommitArtifact({
    commitSha: commit.commitSha,
    coverage,
    files,
    parentSha: commit.parentSha,
    provenance: { kind: 'gitlab-api', project },
  });
};

/** Read immutable current-review Commit Artifacts with one bounded scheduler. */
export const fetchGitLabCommitArtifacts = async ({
  commits,
  project,
  projectPath: rawProjectPath,
  signal,
  transport,
}: {
  commits: ReadonlyArray<CommitArtifactRequest>;
  project: ReviewArtifactProject;
  projectPath: string;
  signal?: AbortSignal;
  transport: GitLabTransport;
}): Promise<ReadonlyMap<CommitArtifactRequestKey, CommitArtifact>> => {
  const projectPath = validateProjectPath(rawProjectPath);
  const pending = [
    ...new Map(commits.map((commit) => [createCommitArtifactRequestKey(commit), commit])).values(),
  ];
  const artifacts = new Map<CommitArtifactRequestKey, CommitArtifact>();
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < pending.length) {
      signal?.throwIfAborted();
      const commit = pending[nextIndex++]!;
      try {
        let values: ReadonlyArray<unknown>;
        let truncated = false;
        if (commit.parentSha) {
          const endpoint = repositoryCompareEndpoint(
            projectPath,
            commit.parentSha,
            commit.commitSha,
          );
          const comparison = asRecord(
            await transport.request<unknown>({
              maxBytes: maxArtifactResponseBytes,
              path: endpoint.path,
              query: endpoint.query,
              signal,
            }),
          );
          values = asArray(comparison.diffs);
          truncated = comparison.compare_timeout === true || comparison.overflow === true;
        } else {
          values = await readPages(
            transport,
            repositoryCommitDiffEndpoint(projectPath, commit.commitSha),
            signal,
          );
        }
        artifacts.set(
          createCommitArtifactRequestKey(commit),
          toGitLabCommitArtifact(commit, project, values, truncated),
        );
      } catch {
        signal?.throwIfAborted();
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(artifactReadConcurrency, pending.length) }, worker),
  );
  return artifacts;
};

const artifactCoverage = (files: ReadonlyArray<ArtifactFile>, expectedCount: number) =>
  files.length !== expectedCount || files.some((file) => file.coverage === 'truncated')
    ? 'truncated'
    : files.some((file) => file.coverage === 'opaque')
      ? 'opaque'
      : 'complete';

/** Normalize an acquired GitLab diff response into the shared Range Artifact contract. */
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

/** Create the bounded GitLab API source for one current merge request. */
export const createGitLabArtifactSource = ({
  maxBlobArtifactBytes: requestedMaxBlobArtifactBytes,
  project,
  projectPath: rawProjectPath,
  transport,
}: {
  maxBlobArtifactBytes?: number;
  project: ReviewArtifactProject;
  projectPath: string;
  transport: GitLabTransport;
}): ReviewArtifactSource => {
  const blobArtifactMaxBytes = normalizeBlobArtifactMaxBytes(requestedMaxBlobArtifactBytes);
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
            if (bytes.byteLength <= blobArtifactMaxBytes) {
              blobs.set(objectId, { bytes, objectId, provenance });
            }
          } catch {
            signal.throwIfAborted();
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(artifactReadConcurrency, pending.length) }, worker),
      );
      return blobs;
    },
    readCommitArtifacts: (commits: ReadonlyArray<CommitArtifactRequest>, signal) =>
      fetchGitLabCommitArtifacts({
        commits,
        project,
        projectPath,
        signal,
        transport,
      }),
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
        Array.from({ length: Math.min(artifactReadConcurrency, pending.length) }, worker),
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
      const endpoint = repositoryCompareEndpoint(projectPath, base, head);
      const value = asRecord(
        await transport.request<unknown>({
          maxBytes: maxArtifactResponseBytes,
          path: endpoint.path,
          query: endpoint.query,
          signal,
        }),
      );
      const rawCommits = asArray(value.commits);
      const commits = orderReviewCommitStack(
        rawCommits
          .map((entry) => normalizeMergeRequestCommit(entry, projectPath))
          .filter((commit): commit is ReviewCommitSummary => commit != null),
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
