// @ts-check

// Canonical Electron GitHub review boundary.

const { getCommandActionSignal } = require('../command-log.cjs');

const {
  IMAGE_FILE_LIMIT,
  bufferToImageRevision,
  formatBytes,
  getImageMimeType,
  git,
  gitOrEmpty,
  validateRepositoryPath,
} = require('./common.cjs');
const { readGitFiles } = require('./git-files.cjs');
const {
  createPullRequestSection,
  isBinaryDiffPatch,
  rangeArtifactToPullRequestFiles,
} = require('./review-range-sections.cjs');
const { createGhGitHubTransport } = require('./github-history/gh-github-transport.cjs');
const {
  getGitHubProviderArtifactRun,
  githubArtifactProject,
  readGitHubFileBlobArtifact,
  readGitHubFileBlobArtifacts,
} = require('./provider-artifact-sources.cjs');
const {
  PENDING_REVIEW_COMMENT_ERROR,
  createGitHubReviewMutations,
  normalizePullRequestComment,
} = require('./github-review-mutations.cjs');
const { loadGitHubHistory } = require('../github-history-bridge.cjs');
const { decodeHtmlEntities } = require('../html-entities.cjs');

/**
 * @typedef {import('../../core/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../../core/lib/review-artifacts.ts').ArtifactFile} ArtifactFile
 * @typedef {{owner: string; repo: string}} GitHubRepositoryReference
 * @typedef {{name: string; url: string}} LocalGitRemote
 * @typedef {{full_name?: string; name?: string; owner?: {login?: string}}} GitHubRepositoryMetadata
 * @typedef {{number: number; owner: string; repo: string; url: string}} PullRequestReference
 * @typedef {{direction: 'fetch' | 'push'; name: string; owner: string; repo: string}} GitHubRemote
 * @typedef {{filename: string; patch?: string; previous_filename?: string; status: string}} GitHubPullRequestFile
 * @typedef {{base?: {ref?: string; repo?: GitHubRepositoryMetadata | null; sha?: string}; body?: string | null; head?: {ref?: string; repo?: GitHubRepositoryMetadata | null; sha?: string}; title?: string; user?: {avatar_url?: string; html_url?: string; login?: string}}} GitHubPullRequestMetadata
 * @typedef {{[key: string]: any}} GitHubReviewComment
 * @typedef {{comments?: {nodes?: ReadonlyArray<{databaseId?: number | null}>} | null; isResolved?: boolean}} GitHubReviewThread
 */

/**
 * The first usable state already has the exact provider metadata and patches
 * needed to hydrate a section. Keep only the latest immutable-head snapshot
 * for a small number of open review roots so the first deferred file does not
 * repeat those provider reads.
 * @type {Map<string, {headSha?: string, metadata: GitHubPullRequestMetadata, range: import('../../core/lib/review-artifacts.ts').RangeArtifact}>}
 */
const pullRequestHydrationSnapshots = new Map();
const MAX_PULL_REQUEST_HYDRATION_SNAPSHOTS = 8;
const MAX_RESOLVED_REVIEW_THREADS_BYTES = 2 * 1024 * 1024;
const MAX_RESOLVED_REVIEW_THREAD_PAGES = 4;
const MAX_RESOLVED_REVIEW_COMMENT_IDS = 40_000;
const MAX_REVIEW_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_REVIEW_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_REVIEW_COMMENTS_BYTES = 8 * 1024 * 1024;

/** @param {string} value @returns {PullRequestReference} */
const parseGitHubPullRequestUrl = (value) => {
  const trimmed = value.trim();
  const normalized = /^github\.com\//i.test(trimmed) ? `https://${trimmed}` : trimmed;
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('Codiff expected a GitHub pull request URL.');
  }

  if (url.hostname.toLowerCase().replace(/^www\./, '') !== 'github.com') {
    throw new Error('Codiff only supports GitHub pull request URLs.');
  }

  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/);
  if (!match) {
    throw new Error('Codiff expected a GitHub pull request URL.');
  }

  const [, owner, repo, number] = match;
  return {
    number: Number(number),
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
};

/** @param {string} value @returns {GitHubRepositoryReference | null} */
const parseGitHubRemoteUrl = (value) => {
  const trimmed = value.trim();
  const sshMatch = trimmed.match(/^(?:git|org-\d+)@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2].replace(/\.git$/i, ''),
    };
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== 'github.com') {
      return null;
    }

    const match = url.pathname.match(/^\/([^/]+)\/(.+?)(?:\.git)?$/);
    return match
      ? {
          owner: match[1],
          repo: match[2].replace(/\.git$/i, ''),
        }
      : null;
  } catch {
    return null;
  }
};

/** @param {string} value @returns {GitHubRepositoryReference | null} */
const parseRemoteRepositoryPath = (value) => {
  const trimmed = value.trim();
  const sshMatch = trimmed.match(/^(?:[^@\s/:]+@)?[^/\s:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2].replace(/\.git$/i, ''),
    };
  }

  try {
    const url = new URL(trimmed);
    if (!['git:', 'http:', 'https:', 'ssh:'].includes(url.protocol)) {
      return null;
    }
    const match = url.pathname.match(/^\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
    return match
      ? {
          owner: match[1],
          repo: match[2].replace(/\.git$/i, '').replace(/\/$/, ''),
        }
      : null;
  } catch {
    return null;
  }
};

/** @param {string} repoRoot @returns {Promise<Array<LocalGitRemote>>} */
const readLocalGitRemotes = async (repoRoot) => {
  const names = (await gitOrEmpty(repoRoot, ['remote']))
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);
  const remotes = await Promise.all(
    names.map(async (name) => {
      // Read the configured URL instead of `git remote -v`, which applies
      // `insteadOf` rewrites and can hide the original github.com host.
      const url = (await gitOrEmpty(repoRoot, ['config', '--get', `remote.${name}.url`]))
        .split('\n')[0]
        .trim();
      return url ? { name, url } : null;
    }),
  );
  return remotes.filter((remote) => remote != null);
};

/** @param {LocalGitRemote} remote */
const getRemotePriority = (remote) => (remote.name === 'origin' ? 0 : 1);

/**
 * @param {string} repoRoot
 * @param {LocalGitRemote} remote
 * @param {PullRequestReference} pullRequest
 * @param {string} expectedHeadSha
 */
const remoteHasPullRequestHead = async (repoRoot, remote, pullRequest, expectedHeadSha) => {
  const headRef = `refs/pull/${pullRequest.number}/head`;
  const output = await gitOrEmpty(repoRoot, ['ls-remote', '--refs', remote.name, headRef]);
  return output.split('\n').some((line) => {
    const [sha, ref] = line.trim().split(/\s+/);
    return ref === headRef && sha?.toLowerCase() === expectedHeadSha.toLowerCase();
  });
};

/** @param {string} repoRoot @param {PullRequestReference} pullRequest @param {string | undefined} [expectedHeadSha] @returns {Promise<GitHubRemote>} */
const selectPullRequestRemote = async (repoRoot, pullRequest, expectedHeadSha) => {
  const remotes = (await readLocalGitRemotes(repoRoot)).sort(
    (left, right) => getRemotePriority(left) - getRemotePriority(right),
  );
  const remote = remotes
    .map((candidate) => ({ candidate, repository: parseGitHubRemoteUrl(candidate.url) }))
    .find(
      ({ repository }) =>
        repository?.owner.toLowerCase() === pullRequest.owner.toLowerCase() &&
        repository.repo.toLowerCase() === pullRequest.repo.toLowerCase(),
    )?.candidate;

  if (remote) {
    return {
      direction: 'fetch',
      name: remote.name,
      owner: pullRequest.owner,
      repo: pullRequest.repo,
    };
  }

  if (expectedHeadSha) {
    const candidates = remotes.filter(({ url }) => {
      const repository = parseRemoteRepositoryPath(url);
      return (
        repository?.owner.toLowerCase() === pullRequest.owner.toLowerCase() &&
        repository.repo.toLowerCase() === pullRequest.repo.toLowerCase()
      );
    });
    for (const candidate of candidates) {
      if (await remoteHasPullRequestHead(repoRoot, candidate, pullRequest, expectedHeadSha)) {
        return {
          direction: 'fetch',
          name: candidate.name,
          owner: pullRequest.owner,
          repo: pullRequest.repo,
        };
      }
    }
  }

  throw new Error(
    `Pull request ${pullRequest.owner}/${pullRequest.repo} does not match a GitHub remote in this repository.`,
  );
};

/** @param {string} repoRoot @param {PullRequestReference} pullRequest */
const assertPullRequestMatchesRepository = async (repoRoot, pullRequest) => {
  await selectPullRequestRemote(repoRoot, pullRequest);
};

/** @param {PullRequestReference} pullRequest @param {GitHubPullRequestMetadata} metadata */
const createPullRequestHistoryFetchRefspecs = (pullRequest, metadata) => [
  `+refs/pull/${pullRequest.number}/head:refs/codiff/pull-requests/${pullRequest.number}/head`,
  ...(metadata.base?.ref
    ? [`+refs/heads/${metadata.base.ref}:refs/codiff/pull-requests/${pullRequest.number}/base`]
    : []),
];

/** @param {string} repoRoot @param {GitHubRemote} remote @param {PullRequestReference} pullRequest @param {GitHubPullRequestMetadata} metadata */
const fetchPullRequestHistoryRefs = (repoRoot, remote, pullRequest, metadata) =>
  git(repoRoot, [
    'fetch',
    '--no-tags',
    remote.name,
    ...createPullRequestHistoryFetchRefspecs(pullRequest, metadata),
  ]);

/** @param {string} repoRoot */
const createPullRequestTransport = (repoRoot) => createGhGitHubTransport({ repoRoot });

/**
 * @param {string} repoRoot
 * @param {PullRequestReference} pullRequest
 * @param {ReturnType<typeof createGhGitHubTransport>} [transport]
 * @returns {Promise<GitHubPullRequestMetadata>}
 */
const readPullRequestMetadata = async (repoRoot, pullRequest, transport) => {
  try {
    return await (transport || createPullRequestTransport(repoRoot)).request({
      maxBytes: MAX_REVIEW_METADATA_BYTES,
      path: `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}`,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'ProviderOutputLimitError') {
      throw new Error(
        `GitHub pull request metadata exceeds the ${formatBytes(MAX_REVIEW_METADATA_BYTES)} limit, so Codiff cannot open this review.`,
      );
    }
    throw error;
  }
};

/**
 * Resolve the provider's current immutable review target immediately before a
 * mutation. Keep this fresh read separate from render hydration snapshots so
 * a stale open review can never authorize a comment against moved lines.
 *
 * @param {string} repoRoot
 * @param {PullRequestReference} pullRequest
 * @param {ReturnType<typeof createGhGitHubTransport>} transport
 */
const readCurrentPullRequestTarget = async (repoRoot, pullRequest, transport) => {
  const metadata = await readPullRequestMetadata(repoRoot, pullRequest, transport);
  const baseTipSha = metadata.base?.sha;
  const headSha = metadata.head?.sha;
  if (!baseTipSha || !headSha) {
    throw new Error('GitHub did not return complete current pull request coordinates.');
  }
  const [files, comparison] = await Promise.all([
    transport.request({
      maxBytes: MAX_REVIEW_RANGE_BYTES,
      paginate: true,
      path: `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/files`,
      query: { per_page: 100 },
    }),
    transport.request({
      maxBytes: MAX_REVIEW_RANGE_BYTES,
      path: `repos/${pullRequest.owner}/${pullRequest.repo}/compare/${baseTipSha}...${headSha}`,
    }),
  ]);
  const baseSha = comparison?.merge_base_commit?.sha;
  if (typeof baseSha !== 'string' || !baseSha) {
    throw new Error('GitHub did not return the current pull request merge base.');
  }
  return {
    baseSha,
    files: files.map((file) => ({
      newPath: file.filename,
      ...(file.previous_filename ? { oldPath: file.previous_filename } : {}),
      ...(file.patch ? { patch: file.patch } : {}),
    })),
    headSha,
  };
};

/** @param {string} repoRoot @param {PullRequestReference} pullRequest */
const pullRequestHydrationSnapshotKey = (repoRoot, pullRequest) => `${repoRoot}:${pullRequest.url}`;

/**
 * @param {string} repoRoot
 * @param {PullRequestReference} pullRequest
 * @param {{headSha?: string, metadata: GitHubPullRequestMetadata, range: import('../../core/lib/review-artifacts.ts').RangeArtifact}} snapshot
 */
const rememberPullRequestHydrationSnapshot = (repoRoot, pullRequest, snapshot) => {
  const key = pullRequestHydrationSnapshotKey(repoRoot, pullRequest);
  pullRequestHydrationSnapshots.delete(key);
  pullRequestHydrationSnapshots.set(key, snapshot);
  while (pullRequestHydrationSnapshots.size > MAX_PULL_REQUEST_HYDRATION_SNAPSHOTS) {
    pullRequestHydrationSnapshots.delete(pullRequestHydrationSnapshots.keys().next().value);
  }
};

/**
 * Read the provider data required to create or hydrate the current PR range.
 * A deferred section accepts an in-process snapshot only when its immutable
 * head is exactly the source's head; a fresh state read always refreshes it.
 *
 * @param {string} repoRoot
 * @param {PullRequestReference} pullRequest
 * @param {{expectedHeadSha?: string, forceRefresh?: boolean}} [options]
 */
const readPullRequestHydrationSnapshot = async (repoRoot, pullRequest, options = {}) => {
  const key = pullRequestHydrationSnapshotKey(repoRoot, pullRequest);
  const cached = pullRequestHydrationSnapshots.get(key);
  if (
    !options.forceRefresh &&
    options.expectedHeadSha &&
    cached?.headSha === options.expectedHeadSha
  ) {
    return cached;
  }
  const transport = createPullRequestTransport(repoRoot);
  const [github, metadata] = await Promise.all([
    loadGitHubHistory(),
    readPullRequestMetadata(repoRoot, pullRequest, transport),
  ]);
  const baseSha = metadata.base?.sha;
  const headSha = metadata.head?.sha;
  if (!baseSha || !headSha) {
    throw new Error('GitHub did not return complete pull request range coordinates.');
  }
  if (options.expectedHeadSha && headSha !== options.expectedHeadSha) {
    throw new Error('The pull request head changed. Refresh before loading exact file contents.');
  }
  const project = githubArtifactProject(pullRequest);
  const signal = getCommandActionSignal() || new AbortController().signal;
  const artifactRun = await getGitHubProviderArtifactRun(
    repoRoot,
    pullRequest,
    { signal },
    transport,
  );
  let range;
  try {
    ({ range } = await artifactRun.readStackAndRange(
      {
        headSha: /** @type {GitSha} */ (headSha),
        requestedBaseSha: /** @type {GitSha} */ (baseSha),
      },
      signal,
    ));
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ProviderOutputLimitError') {
      throw error;
    }
    range = github.createGitHubRangeArtifact({
      baseSha: /** @type {GitSha} */ (baseSha),
      files: [],
      headSha: /** @type {GitSha} */ (headSha),
      incompleteReason: `GitHub repository comparison exceeds the ${formatBytes(MAX_REVIEW_RANGE_BYTES)} limit, so Codiff could not load a complete review diff.`,
      project,
      truncated: true,
    });
  }
  const snapshot = { headSha, metadata, range };
  rememberPullRequestHydrationSnapshot(repoRoot, pullRequest, snapshot);
  return snapshot;
};

/** @param {GitHubRepositoryMetadata | null | undefined} repository */
const normalizeGitHubRepositoryReference = (repository) => {
  const owner = repository?.owner?.login;
  const repo = repository?.name;
  if (owner && repo) {
    return { owner, repo };
  }

  const [fullNameOwner, fullNameRepo] = repository?.full_name?.split('/') ?? [];
  return fullNameOwner && fullNameRepo
    ? {
        owner: fullNameOwner,
        repo: fullNameRepo,
      }
    : null;
};

/** @param {PullRequestReference} pullRequest @param {GitHubPullRequestMetadata} metadata */
const getPullRequestHeadImageSource = (pullRequest, metadata) => {
  const repository = normalizeGitHubRepositoryReference(metadata.head?.repo);
  return {
    owner: repository?.owner ?? pullRequest.owner,
    ref: repository
      ? (metadata.head?.sha ?? metadata.head?.ref ?? 'HEAD')
      : `refs/pull/${pullRequest.number}/head`,
    repo: repository?.repo ?? pullRequest.repo,
  };
};

/**
 * @param {string} repoRoot
 * @param {GitHubRepositoryReference} repository
 * @param {string} ref
 * @param {string} path
 * @param {ReturnType<typeof createGhGitHubTransport>} [transport]
 */
const readGitHubImageFile = async (repoRoot, repository, ref, path, transport) => {
  if (!getImageMimeType(path)) {
    throw new Error('Unsupported image file type.');
  }

  const blob = await readGitHubFileBlobArtifact(
    repoRoot,
    repository,
    { maxBytes: IMAGE_FILE_LIMIT, path, ref },
    transport || createPullRequestTransport(repoRoot),
  );
  if (!blob) {
    return undefined;
  }
  if (blob.bytes.byteLength > IMAGE_FILE_LIMIT) {
    throw new Error(
      `Image is ${formatBytes(blob.bytes.byteLength)}, so Codiff skipped rendering it.`,
    );
  }
  return bufferToImageRevision(path, Buffer.from(blob.bytes));
};

/** @param {unknown} side */
const fromGitHubReviewSide = (side) => (side === 'LEFT' ? 'deletions' : 'additions');
/** @param {unknown} side */
const isGitHubReviewSide = (side) => side === 'LEFT' || side === 'RIGHT';

/** @param {...unknown} values */
const firstNumber = (...values) => values.find((value) => typeof value === 'number');

/** @param {GitHubReviewComment} comment */
const normalizeGitHubReviewComment = (comment) => {
  const lineNumber = firstNumber(comment.line, comment.original_line);
  const versionHeadSha =
    typeof comment.original_commit_id === 'string'
      ? comment.original_commit_id
      : typeof comment.commit_id === 'string'
        ? comment.commit_id
        : undefined;
  if (!comment.path || !comment.body) {
    return null;
  }
  const threadId = String(comment.in_reply_to_id ?? comment.id);
  if (lineNumber == null && comment.subject_type === 'file') {
    return {
      anchor: 'file',
      author: {
        avatarUrl: comment.user?.avatar_url,
        login: comment.user?.login || 'GitHub user',
        url: comment.user?.html_url,
      },
      body: decodeHtmlEntities(comment.body),
      filePath: comment.path,
      id: `github:${comment.id}`,
      submittedAt: comment.created_at,
      threadId,
      url: comment.html_url,
      ...(versionHeadSha ? { versionHeadSha } : {}),
    };
  }
  if (lineNumber == null) {
    return null;
  }

  const side = fromGitHubReviewSide(comment.side);
  const startLineNumber = firstNumber(comment.start_line, comment.original_start_line);
  const startSide = isGitHubReviewSide(comment.start_side)
    ? fromGitHubReviewSide(comment.start_side)
    : undefined;
  const hasRange =
    startLineNumber != null && (startLineNumber !== lineNumber || (startSide ?? side) !== side);

  return {
    author: {
      avatarUrl: comment.user?.avatar_url,
      login: comment.user?.login || 'GitHub user',
      url: comment.user?.html_url,
    },
    body: decodeHtmlEntities(comment.body),
    filePath: comment.path,
    id: `github:${comment.id}`,
    ...(typeof comment.line !== 'number' ? { isOutdated: true } : {}),
    lineNumber,
    side,
    ...(hasRange ? { startLineNumber } : {}),
    ...(hasRange && startSide != null && startSide !== side ? { startSide } : {}),
    submittedAt: comment.created_at,
    threadId,
    url: comment.html_url,
    ...(versionHeadSha ? { versionHeadSha } : {}),
  };
};

/** @param {ReadonlyArray<GitHubReviewThread>} threads @returns {Set<number>} */
const collectResolvedReviewCommentIds = (threads) => {
  /** @type {Set<number>} */
  const ids = new Set();
  for (const thread of threads) {
    if (!thread?.isResolved) {
      continue;
    }
    for (const comment of thread.comments?.nodes ?? []) {
      if (typeof comment?.databaseId === 'number') {
        ids.add(comment.databaseId);
      }
    }
  }
  return ids;
};

/** @param {ReadonlyArray<GitHubReviewComment>} comments @param {ReadonlySet<number>} resolvedCommentIds */
const selectUnresolvedReviewComments = (comments, resolvedCommentIds) =>
  comments
    .filter((comment) => !resolvedCommentIds.has(comment.id))
    .map(normalizeGitHubReviewComment)
    .filter(Boolean);

const RESOLVED_REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          comments(first: 100) {
            nodes {
              databaseId
            }
          }
          isResolved
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
  }
}`;

/**
 * @param {string} repoRoot
 * @param {PullRequestReference} pullRequest
 * @param {ReturnType<typeof createGhGitHubTransport>} [transport]
 * @returns {Promise<Set<number>>}
 */
const readResolvedReviewCommentIds = async (repoRoot, pullRequest, transport) => {
  try {
    const client = transport || createPullRequestTransport(repoRoot);
    if (!client.graphql) {
      return new Set();
    }
    /** @type {Set<number>} */
    const resolvedCommentIds = new Set();
    /** @type {Set<string>} */
    const seenCursors = new Set();
    /** @type {string | undefined} */
    let cursor;
    let hasNextPage = true;
    let pageCount = 0;
    while (hasNextPage) {
      // Resolved-state filtering is an optional enhancement. Bound the entire
      // discovery scan and fall back to showing all comments rather than
      // retaining a partial resolved-thread snapshot indefinitely.
      if (pageCount >= MAX_RESOLVED_REVIEW_THREAD_PAGES) {
        return new Set();
      }
      const response = await client.graphql({
        maxBytes: MAX_RESOLVED_REVIEW_THREADS_BYTES,
        query: RESOLVED_REVIEW_THREADS_QUERY,
        variables: {
          cursor: cursor ?? null,
          number: pullRequest.number,
          owner: pullRequest.owner,
          repo: pullRequest.repo,
        },
      });
      const reviewThreads = response?.data?.repository?.pullRequest?.reviewThreads;
      if (!reviewThreads) {
        return new Set();
      }
      pageCount += 1;
      if (Array.isArray(reviewThreads.nodes)) {
        for (const id of collectResolvedReviewCommentIds(reviewThreads.nodes)) {
          resolvedCommentIds.add(id);
          if (resolvedCommentIds.size > MAX_RESOLVED_REVIEW_COMMENT_IDS) {
            return new Set();
          }
        }
      }
      const nextCursor = reviewThreads.pageInfo?.endCursor;
      hasNextPage = Boolean(reviewThreads.pageInfo?.hasNextPage && nextCursor);
      if (hasNextPage) {
        if (typeof nextCursor !== 'string' || seenCursors.has(nextCursor)) {
          return new Set();
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
    }
    return resolvedCommentIds;
  } catch {
    return new Set();
  }
};

/**
 * @param {string} repoRoot
 * @param {PullRequestReference} pullRequest
 * @param {ReturnType<typeof createGhGitHubTransport>} [transport]
 */
const readPullRequestComments = async (repoRoot, pullRequest, transport) => {
  const client = transport || createPullRequestTransport(repoRoot);
  try {
    const [comments, resolvedCommentIds] = await Promise.all([
      client.request({
        maxBytes: MAX_REVIEW_COMMENTS_BYTES,
        paginate: true,
        path: `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/comments`,
        query: { per_page: 100 },
      }),
      readResolvedReviewCommentIds(repoRoot, pullRequest, client),
    ]);
    return selectUnresolvedReviewComments(comments, resolvedCommentIds);
  } catch (error) {
    if (error instanceof Error && error.name === 'ProviderOutputLimitError') {
      throw new Error(
        `GitHub pull request comments exceed the ${formatBytes(MAX_REVIEW_COMMENTS_BYTES)} limit, so Codiff could not load them.`,
      );
    }
    throw error;
  }
};

/** @param {PullRequestReference} pullRequest @param {GitHubPullRequestMetadata} metadata @returns {Extract<ReviewSource, {type: 'pull-request'}>} */
const createPullRequestSource = (pullRequest, metadata) => ({
  ...(metadata.user?.login
    ? {
        author: {
          avatarUrl: metadata.user.avatar_url,
          login: metadata.user.login,
          url: metadata.user.html_url,
        },
      }
    : {}),
  ...(metadata.body?.trim() ? { description: metadata.body.trim() } : {}),
  headSha: metadata.head?.sha,
  host: 'github.com',
  number: pullRequest.number,
  owner: pullRequest.owner,
  projectPath: `${pullRequest.owner}/${pullRequest.repo}`,
  provider: 'github',
  repo: pullRequest.repo,
  ...(metadata.base?.ref ? { targetBranch: metadata.base.ref } : {}),
  title: metadata.title,
  type: 'pull-request',
  url: pullRequest.url,
});

/**
 * Make sure the pull request head and base branch are available as local refs
 * and resolve the two commits to diff against. GitHub computes the pull request
 * diff against the merge base of the base branch and the head, so mirror that to
 * keep line numbers and changes aligned with the GitHub review.
 *
 * Returns `null` when the full file contents cannot be resolved, in which case
 * callers fall back to the GitHub-provided patch (which cannot expand
 * unmodified context).
 *
 * @param {string} repoRoot
 * @param {PullRequestReference} pullRequest
 * @param {GitHubPullRequestMetadata} metadata
 * @returns {Promise<{base: string; head: string} | null>}
 */
const resolvePullRequestContentRefs = async (repoRoot, pullRequest, metadata) => {
  if (!metadata.base?.ref) {
    return null;
  }

  const headRef = `refs/codiff/pull-requests/${pullRequest.number}/head`;
  const baseRef = `refs/codiff/pull-requests/${pullRequest.number}/base`;
  const headSha = metadata.head?.sha;
  const baseSha = metadata.base?.sha;
  const localHead = (
    await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', headRef])
  ).trim();
  const localBase = (
    await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', baseRef])
  ).trim();

  // Refetch when a ref is missing or has moved -- including when the base branch
  // advanced or the pull request was retargeted (localBase !== base sha) -- so
  // the merge base is always resolved against the current base and head rather
  // than stale contents.
  if (
    localBase === '' ||
    localHead === '' ||
    (headSha != null && localHead !== headSha) ||
    (baseSha != null && localBase !== baseSha)
  ) {
    try {
      const remote = await selectPullRequestRemote(repoRoot, pullRequest, metadata.head?.sha);
      await fetchPullRequestHistoryRefs(repoRoot, remote, pullRequest, metadata);
    } catch {
      return null;
    }
  }

  const resolvedHead = (
    await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', headRef])
  ).trim();
  const resolvedBase = (
    await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', baseRef])
  ).trim();
  if (
    !resolvedHead ||
    !resolvedBase ||
    (headSha != null && resolvedHead !== headSha) ||
    (baseSha != null && resolvedBase !== baseSha)
  ) {
    return null;
  }

  const mergeBase = (await gitOrEmpty(repoRoot, ['merge-base', baseRef, headRef])).trim();
  return mergeBase ? { base: mergeBase, head: headRef } : null;
};

/**
 * Hydrate one explicitly requested file. Off-screen files retain their
 * provider patch until the renderer asks for their exact local contents.
 *
 * @param {string} repoRoot
 * @param {PullRequestReference} pullRequest
 * @param {GitHubPullRequestMetadata} metadata
 * @param {ArtifactFile} file
 */
const hydratePullRequestSection = async (repoRoot, pullRequest, metadata, file) => {
  const refs = await resolvePullRequestContentRefs(repoRoot, pullRequest, metadata).catch(
    () => null,
  );
  const oldPath = file.oldPath || file.path;
  const canReadContents = Boolean(file.patch) && !isBinaryDiffPatch(file.patch);
  const [oldFiles, newFiles] =
    refs && canReadContents
      ? await Promise.all([
          readGitFiles(repoRoot, refs.base, [oldPath], { refScopedEmptyCacheKey: true }),
          readGitFiles(repoRoot, refs.head, [file.path], { refScopedEmptyCacheKey: true }),
        ])
      : [new Map(), new Map()];
  return createPullRequestSection(
    pullRequest,
    file,
    oldFiles.get(oldPath),
    newFiles.get(file.path),
    { base: metadata.base?.sha, head: metadata.head?.sha },
  );
};

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source @returns {Promise<RepositoryState>} */
const readPullRequestState = async (launchPath, source) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseGitHubPullRequestUrl(source.url);
  await assertPullRequestMatchesRepository(repoRoot, pullRequest);

  const { metadata, range } = await readPullRequestHydrationSnapshot(repoRoot, pullRequest, {
    forceRefresh: true,
  });
  // Initial review rendering needs the normalized immutable Range Artifact,
  // not local full-file hydration. The selected file uses
  // readPullRequestSectionContent after first usable render when expanded
  // context is actually needed.
  const files = rangeArtifactToPullRequestFiles(range, pullRequest.number, {
    deferContents: true,
  }).toSorted((left, right) => left.path.localeCompare(right.path));

  const reviewSource = createPullRequestSource(pullRequest, metadata);
  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    reviewCommentsLoadState: 'not-loaded',
    root: repoRoot,
    source: reviewSource,
  };
};

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source */
const readPullRequestReviewComments = async (launchPath, source) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseGitHubPullRequestUrl(source.url);
  await assertPullRequestMatchesRepository(repoRoot, pullRequest);
  return readPullRequestComments(repoRoot, pullRequest, createPullRequestTransport(repoRoot));
};

/**
 * Load exact local contents for one pull-request file when explicitly retried.
 * @param {string} launchPath
 * @param {Extract<ReviewSource, {type: 'pull-request'}>} source
 * @param {string} requestedPath
 */
const readPullRequestSectionContent = async (launchPath, source, requestedPath) => {
  const path = validateRepositoryPath(requestedPath);
  const pullRequest = parseGitHubPullRequestUrl(source.url);
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  await assertPullRequestMatchesRepository(repoRoot, pullRequest);
  const { metadata, range } = await readPullRequestHydrationSnapshot(repoRoot, pullRequest, {
    expectedHeadSha: source.headSha,
  });
  const file = range.files.find((candidate) => candidate.path === path);
  if (!file) {
    throw new Error('File is not part of this pull request.');
  }
  return hydratePullRequestSection(repoRoot, pullRequest, metadata, file);
};

/**
 * @param {string} launchPath
 * @param {Extract<ReviewSource, {type: 'pull-request'}>} source
 * @param {string} requestedPath
 * @returns {Promise<DiffImageContentResult>}
 */
const readPullRequestImageContent = async (launchPath, source, requestedPath) => {
  try {
    const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
    const path = validateRepositoryPath(requestedPath);
    const pullRequest = parseGitHubPullRequestUrl(source.url);
    await assertPullRequestMatchesRepository(repoRoot, pullRequest);
    const { metadata, range } = await readPullRequestHydrationSnapshot(repoRoot, pullRequest, {
      expectedHeadSha: source.headSha,
    });
    const file = range.files.find((candidate) => candidate.path === path);
    if (!file) {
      throw new Error('File is not part of this pull request.');
    }

    const headImageSource = getPullRequestHeadImageSource(pullRequest, metadata);
    const oldPath = file.oldPath || file.path;
    const sides = [
      ...(metadata.base?.sha
        ? [
            {
              path: oldPath,
              ref: metadata.base.sha,
              repository: { owner: pullRequest.owner, repo: pullRequest.repo },
              side: 'old',
            },
          ]
        : []),
      {
        path: file.path,
        ref: headImageSource.ref,
        repository: { owner: headImageSource.owner, repo: headImageSource.repo },
        side: 'new',
      },
    ];
    /** @type {Map<string, Array<(typeof sides)[number]>>} */
    const groups = new Map();
    for (const side of sides) {
      const key = `${side.repository.owner.toLowerCase()}/${side.repository.repo.toLowerCase()}`;
      groups.set(key, [...(groups.get(key) || []), side]);
    }
    /** @type {Map<string, ReturnType<typeof bufferToImageRevision>>} */
    const images = new Map();
    await Promise.all(
      [...groups.values()].map(async (group) => {
        const repository = group[0]?.repository;
        if (!repository) return;
        const blobs = await readGitHubFileBlobArtifacts(
          repoRoot,
          repository,
          group.map(({ path: imagePath, ref }) => ({
            maxBytes: IMAGE_FILE_LIMIT,
            path: imagePath,
            ref,
          })),
          createPullRequestTransport(repoRoot),
        );
        for (const side of group) {
          const blob = blobs.get(`${side.ref}:${side.path}`);
          if (blob) {
            images.set(side.side, bufferToImageRevision(side.path, Buffer.from(blob.bytes)));
          }
        }
      }),
    );
    const oldImage = images.get('old');
    const newImage = images.get('new');

    if (!oldImage && !newImage) {
      return {
        reason: 'Codiff could not load either side of this image.',
        status: 'unavailable',
      };
    }

    return {
      ...(newImage ? { newImage } : {}),
      ...(oldImage ? { oldImage } : {}),
      status: 'ready',
    };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : 'Codiff could not load this image.',
      status: 'unavailable',
    };
  }
};

const { submitPullRequestComment, submitPullRequestReview } = createGitHubReviewMutations({
  assertPullRequestMatchesRepository,
  createTransport: createPullRequestTransport,
  normalizeGitHubReviewComment,
  parseGitHubPullRequestUrl,
  readCurrentTarget: readCurrentPullRequestTarget,
});

module.exports = {
  PENDING_REVIEW_COMMENT_ERROR,
  collectResolvedReviewCommentIds,
  createPullRequestHistoryFetchRefspecs,
  createPullRequestSource,
  getPullRequestHeadImageSource,
  normalizeGitHubReviewComment,
  normalizePullRequestComment,
  parseGitHubPullRequestUrl,
  readGitHubImageFile,
  readPullRequestImageContent,
  readPullRequestReviewComments,
  readPullRequestSectionContent,
  readPullRequestState,
  resolvePullRequestContentRefs,
  selectPullRequestRemote,
  selectUnresolvedReviewComments,
  submitPullRequestComment,
  submitPullRequestReview,
};
