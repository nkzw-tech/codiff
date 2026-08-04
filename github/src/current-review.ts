import {
  createCommitArtifactRequestKey,
  orderReviewCommitStack,
  validateCommitArtifact,
  validateRangeArtifact,
  validateStackSnapshot,
  type ArtifactCoverage,
  type ArtifactFile,
  type BlobArtifact,
  type CommitArtifact,
  type CommitArtifactRequest,
  type CommitArtifactRequestKey,
  type RangeArtifact,
  type ReviewArtifactProject,
  type ReviewArtifactSource,
  type StackSnapshot,
} from '@nkzw/codiff-core';
import type { GitSha, ReviewCommitSummary } from '@nkzw/codiff-core/types';
import type { GitHubTransport } from './transport.ts';

export type GitHubPullRequestRef = {
  /** Optional known head from the local source; provider metadata wins when available. */
  headSha?: GitSha | null;
  number: number;
  owner: string;
  repo: string;
  updatedAt?: string | null;
};

const artifactReadConcurrency = 8;
const currentCommitStackLimit = 40;
const maxArtifactResponseBytes = 8 * 1024 * 1024;
const maxBlobArtifactBytes = 8 * 1024 * 1024;

const gitSha = (value: unknown): GitSha | null =>
  typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? (value as GitSha) : null;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const asString = (value: unknown) => (typeof value === 'string' ? value : '');
const asNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const normalizeBlobArtifactMaxBytes = (value: number | undefined) => {
  const maxBytes = value ?? maxBlobArtifactBytes;
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

const quotePatchPath = (path: string) =>
  path.replaceAll('\\', String.raw`\\`).replaceAll('\n', String.raw`\n`);

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

/** Normalize an acquired GitHub file response into the shared Range Artifact contract. */
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
  if (!sha) {
    return null;
  }
  const commit = isRecord(value.commit) ? value.commit : {};
  const author = isRecord(commit.author) ? commit.author : {};
  const topLevelAuthor = isRecord(value.author) ? value.author : {};
  const message = asString(commit.message);
  const webUrl = asString(value.html_url);
  return {
    authoredAt: asString(author.date) || new Date(0).toISOString(),
    authorName: asString(author.name) || asString(topLevelAuthor.login),
    parentShas: asArray(value.parents)
      .map((parent) => (isRecord(parent) ? gitSha(parent.sha) : null))
      .filter((parent): parent is GitSha => parent != null),
    sha,
    shortSha: sha.slice(0, 7),
    subject: message.split('\n')[0] || sha.slice(0, 7),
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
      maxBytes: maxArtifactResponseBytes,
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

/** Create the bounded GitHub API source for one current pull request. */
export const createGitHubArtifactSource = ({
  maxBlobArtifactBytes: requestedMaxBlobArtifactBytes,
  project,
  pull,
  transport,
}: {
  maxBlobArtifactBytes?: number;
  project: ReviewArtifactProject;
  pull: GitHubPullRequestRef;
  transport: GitHubTransport;
}): ReviewArtifactSource => {
  const blobArtifactMaxBytes = normalizeBlobArtifactMaxBytes(requestedMaxBlobArtifactBytes);
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
    async readCommitArtifacts(commits, signal) {
      const pending = [
        ...new Map(
          commits.map((commit) => [createCommitArtifactRequestKey(commit), commit]),
        ).values(),
      ];
      const artifacts = new Map<CommitArtifactRequestKey, CommitArtifact>();
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < pending.length) {
          signal.throwIfAborted();
          const commit = pending[nextIndex++]!;
          try {
            artifacts.set(
              createCommitArtifactRequestKey(commit),
              await readGitHubCommitArtifact({ commit, project, pull, signal, transport }),
            );
          } catch {
            signal.throwIfAborted();
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(artifactReadConcurrency, pending.length) }, worker),
      );
      return artifacts;
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
        maxBytes: maxArtifactResponseBytes,
        path,
        query: { page: 1, per_page: 100 },
        signal,
      });
      if (!isRecord(first)) {
        throw new Error('GitHub returned an invalid repository comparison.');
      }
      const mergeBaseCommit = isRecord(first.merge_base_commit) ? first.merge_base_commit : {};
      const effectiveBaseSha = gitSha(mergeBaseCommit.sha);
      if (!effectiveBaseSha) {
        throw new Error('GitHub returned an invalid merge base for the repository comparison.');
      }
      const totalCommits = asNumber(first.total_commits);
      let rawCommits = [...asArray(first.commits)];
      let stackTruncated = totalCommits == null || totalCommits !== rawCommits.length;
      if (totalCommits != null && totalCommits > rawCommits.length) {
        const firstTailPage =
          Math.floor(Math.max(0, totalCommits - currentCommitStackLimit) / 100) + 1;
        const lastPage = Math.ceil(totalCommits / 100);
        rawCommits = firstTailPage === 1 ? rawCommits : [];
        for (let page = Math.max(2, firstTailPage); page <= lastPage; page += 1) {
          signal.throwIfAborted();
          const tailPage = await transport.request<unknown>({
            maxBytes: maxArtifactResponseBytes,
            path,
            query: { page, per_page: 100 },
            signal,
          });
          if (!isRecord(tailPage)) {
            throw new Error(`GitHub returned an invalid comparison page ${page}.`);
          }
          rawCommits.push(...asArray(tailPage.commits));
        }
      }
      if (rawCommits.length > currentCommitStackLimit) {
        rawCommits = rawCommits.slice(-currentCommitStackLimit);
        stackTruncated = true;
      }
      const commits = orderReviewCommitStack(
        rawCommits
          .map(normalizeGitHubArtifactCommit)
          .filter((commit): commit is ReviewCommitSummary => commit != null),
      );
      const rawFiles = asArray(first.files);
      const range = createGitHubRangeArtifact({
        baseSha: effectiveBaseSha,
        files: rawFiles,
        headSha: head,
        project,
        truncated: rawFiles.length >= 300,
      });
      const stack: StackSnapshot = {
        baseSha: effectiveBaseSha,
        commits,
        coverage: stackTruncated || commits.length !== rawCommits.length ? 'truncated' : 'complete',
        headSha: head,
        provenance,
      };
      return { range, stack: validateStackSnapshot(stack) };
    },
  };
};
