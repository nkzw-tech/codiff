// @ts-check

const {
  IMAGE_FILE_LIMIT,
  bufferToImageRevision,
  formatBytes,
  getImageMimeType,
  git,
  gitOrEmpty,
  getCurrentCommandSignal,
  validateRepositoryPath,
} = require('./common.cjs');
const { readGitFiles } = require('./git-files.cjs');
const {
  canHydrateArtifactFile,
  createPullRequestSection,
  isBinaryDiffPatch,
  rangeArtifactToPullRequestFiles,
} = require('./review-range-sections.cjs');
const {
  createGhGitHubTransport,
  runGhApi,
  runGhApiBuffer,
} = require('./github-history/gh-github-transport.cjs');
const { loadGitHubHistory } = require('../github-history-bridge.cjs');
const { parseReviewUrl } = require('../review-source.cjs');

/**
 * @typedef {import('../../core/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../../core/types.ts').GitSha} GitSha
 * @typedef {import('../../core/types.ts').HistoryEntry} HistoryEntry
 * @typedef {import('../../core/types.ts').PullRequestReviewComment} PullRequestReviewComment
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../../core/types.ts').SubmitPullRequestCommentRequest} SubmitPullRequestCommentRequest
 * @typedef {import('../../core/types.ts').SubmitPullRequestReviewRequest} SubmitPullRequestReviewRequest
 * @typedef {import('../../core/lib/review-artifacts.ts').ArtifactFile} ArtifactFile
 * @typedef {{owner: string; repo: string}} GitHubRepositoryReference
 * @typedef {{name: string; url: string}} LocalGitRemote
 * @typedef {{full_name?: string; name?: string; owner?: {login?: string}}} GitHubRepositoryMetadata
 * @typedef {{number: number; owner: string; repo: string; url: string}} PullRequestReference
 * @typedef {{direction: 'fetch' | 'push'; name: string; owner: string; repo: string}} GitHubRemote
 * @typedef {{base?: {ref?: string; repo?: GitHubRepositoryMetadata | null; sha?: string}; body?: string | null; head?: {ref?: string; repo?: GitHubRepositoryMetadata | null; sha?: string}; title?: string; user?: {avatar_url?: string; html_url?: string; login?: string}}} GitHubPullRequestMetadata
 * @typedef {{author?: {avatar_url?: string}; commit?: {author?: {date?: string; email?: string; name?: string}; message?: string}; parents?: ReadonlyArray<{sha?: string}>; sha?: string}} GitHubCommit
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

/** @type {Map<string, Promise<import('../../core/types.ts').DiffSectionsContentResult>>} */
const pullRequestBulkHydrations = new Map();
const MAX_PULL_REQUEST_BULK_HYDRATIONS = 8;

/** @param {string} value @returns {PullRequestReference} */
const parseGitHubPullRequestUrl = (value) => {
  const parsed = parseReviewUrl(value);
  if (!parsed) {
    throw new Error('Codiff expected a GitHub pull request URL.');
  }

  if (parsed.provider !== 'github') {
    throw new Error('Codiff only supports GitHub pull request URLs.');
  }

  return {
    number: parsed.number,
    owner: parsed.owner,
    repo: parsed.repo,
    url: parsed.url,
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

/** @param {string} repoRoot @param {PullRequestReference} pullRequest */
const assertPullRequestMatchesRepository = async (repoRoot, pullRequest) => {
  const matchesRepository = (await readLocalGitRemotes(repoRoot)).some(({ url }) => {
    const repository = parseGitHubRemoteUrl(url) ?? parseRemoteRepositoryPath(url);
    return (
      repository?.owner.toLowerCase() === pullRequest.owner.toLowerCase() &&
      repository.repo.toLowerCase() === pullRequest.repo.toLowerCase()
    );
  });
  if (!matchesRepository) {
    throw new Error(
      `Pull request ${pullRequest.owner}/${pullRequest.repo} does not match a GitHub remote in this repository.`,
    );
  }
};

/** @param {LocalGitRemote} remote */
const getRemotePriority = (remote) => (remote.name === 'origin' ? 0 : 1);

/**
 * Let Git resolve SSH aliases, credential helpers, and URL rewrites, then make
 * sure the candidate remote exposes this exact GitHub pull request head.
 *
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

/** @param {string} repoRoot @param {PullRequestReference} pullRequest @param {string | undefined} expectedHeadSha @returns {Promise<GitHubRemote>} */
const selectPullRequestRemote = async (repoRoot, pullRequest, expectedHeadSha) => {
  const remotes = (await readLocalGitRemotes(repoRoot)).sort(
    (left, right) => getRemotePriority(left) - getRemotePriority(right),
  );
  const remote = remotes
    .map((remote) => ({ remote, repository: parseGitHubRemoteUrl(remote.url) }))
    .filter(
      ({ repository }) =>
        repository?.owner.toLowerCase() === pullRequest.owner.toLowerCase() &&
        repository.repo.toLowerCase() === pullRequest.repo.toLowerCase(),
    )[0]?.remote;

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

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} args
 * @param {unknown} [input]
 * @returns {Promise<string>}
 */
const ghApi = (repoRoot, args, input) => runGhApi(repoRoot, args, input);

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} args
 * @returns {Promise<Buffer | undefined>}
 */
const ghApiBuffer = async (repoRoot, args) => {
  try {
    return await runGhApiBuffer(repoRoot, args, undefined, { maxBytes: IMAGE_FILE_LIMIT });
  } catch (error) {
    if (error instanceof Error && /not found|404/i.test(error.message)) {
      return undefined;
    }
    throw error;
  }
};

/** Provider transport backed by the authenticated `gh` process owned by Electron. */
const createPullRequestTransport = (repoRoot) => createGhGitHubTransport({ repoRoot });

/**
 * @param {string} repoRoot
 * @param {PullRequestReference} pullRequest
 * @param {{request: (request: any) => Promise<any>}} [transport]
 * @returns {Promise<GitHubPullRequestMetadata>}
 */
const readPullRequestMetadata = (repoRoot, pullRequest, transport) =>
  (transport || createPullRequestTransport(repoRoot)).request({
    path: `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}`,
  });

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
 * @param {{expectedHeadSha?: string, forceRefresh?: boolean, signal?: AbortSignal}} [options]
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
  const project = {
    host: 'github.com',
    project: `${pullRequest.owner}/${pullRequest.repo}`,
    provider: /** @type {'github'} */ ('github'),
  };
  const artifactSource = github.createGitHubArtifactSource({
    project,
    pull: pullRequest,
    transport,
  });
  const { range } = await artifactSource.readStackAndRange(
    {
      requestedBaseSha: /** @type {GitSha} */ (baseSha),
      headSha: /** @type {GitSha} */ (headSha),
    },
    options.signal ?? getCurrentCommandSignal() ?? new AbortController().signal,
  );
  const snapshot = { headSha, metadata, range };
  rememberPullRequestHydrationSnapshot(repoRoot, pullRequest, snapshot);
  return snapshot;
};

/** @param {string} path */
const encodeGitHubContentPath = (path) => path.split('/').map(encodeURIComponent).join('/');

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
 */
const readGitHubImageFile = async (repoRoot, repository, ref, path) => {
  if (!getImageMimeType(path)) {
    throw new Error('Unsupported image file type.');
  }

  const buffer = await ghApiBuffer(repoRoot, [
    '-H',
    'Accept: application/vnd.github.raw',
    `repos/${repository.owner}/${repository.repo}/contents/${encodeGitHubContentPath(
      path,
    )}?ref=${encodeURIComponent(ref)}`,
  ]);

  if (!buffer) {
    return undefined;
  }

  if (buffer.length > IMAGE_FILE_LIMIT) {
    throw new Error(`Image is ${formatBytes(buffer.length)}, so Codiff skipped rendering it.`);
  }

  return bufferToImageRevision(path, buffer);
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
  if (lineNumber == null || !comment.path || !comment.body) {
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
    body: comment.body,
    filePath: comment.path,
    id: `github:${comment.id}`,
    ...(typeof comment.line !== 'number' ? { isOutdated: true } : {}),
    lineNumber,
    side,
    ...(hasRange ? { startLineNumber } : {}),
    ...(hasRange && startSide != null && startSide !== side ? { startSide } : {}),
    threadId: String(comment.in_reply_to_id || comment.id),
    submittedAt: comment.created_at,
    url: comment.html_url,
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

/** @param {string} repoRoot @param {PullRequestReference} pullRequest @returns {Promise<Set<number>>} */
const readResolvedReviewCommentIds = async (repoRoot, pullRequest) => {
  try {
    /** @type {Array<GitHubReviewThread>} */
    const threads = [];
    /** @type {string | undefined} */
    let cursor;
    let hasNextPage = true;
    while (hasNextPage) {
      const response = JSON.parse(
        await ghApi(repoRoot, [
          'graphql',
          '-f',
          `query=${RESOLVED_REVIEW_THREADS_QUERY}`,
          '-f',
          `owner=${pullRequest.owner}`,
          '-f',
          `repo=${pullRequest.repo}`,
          '-F',
          `number=${pullRequest.number}`,
          ...(cursor ? ['-f', `cursor=${cursor}`] : []),
        ]),
      );
      const reviewThreads = response?.data?.repository?.pullRequest?.reviewThreads;
      if (!reviewThreads) {
        break;
      }
      if (Array.isArray(reviewThreads.nodes)) {
        threads.push(...reviewThreads.nodes);
      }
      cursor = reviewThreads.pageInfo?.endCursor ?? undefined;
      hasNextPage = Boolean(reviewThreads.pageInfo?.hasNextPage && cursor);
    }
    return collectResolvedReviewCommentIds(threads);
  } catch {
    return new Set();
  }
};

/** @param {string} repoRoot @param {PullRequestReference} pullRequest */
const readPullRequestComments = async (repoRoot, pullRequest) => {
  const [pages, resolvedCommentIds] = await Promise.all([
    ghApi(repoRoot, [
      '--paginate',
      '--slurp',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/comments?per_page=100`,
    ]).then((output) => JSON.parse(output)),
    readResolvedReviewCommentIds(repoRoot, pullRequest),
  ]);
  return selectUnresolvedReviewComments(pages.flat(), resolvedCommentIds);
};

/** @param {string} repoRoot @param {PullRequestReference} pullRequest @returns {Promise<Array<GitHubCommit>>} */
const readPullRequestCommits = async (repoRoot, pullRequest) => {
  const pages = JSON.parse(
    await ghApi(repoRoot, [
      '--paginate',
      '--slurp',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/commits?per_page=100`,
    ]),
  );
  return pages.flat();
};

/** @param {string} repoRoot @param {PullRequestReference} pullRequest @param {string} sha @param {number} limit @returns {Promise<Array<GitHubCommit>>} */
const readRepositoryCommits = async (repoRoot, pullRequest, sha, limit) => {
  /** @type {Array<GitHubCommit>} */
  const commits = [];
  for (let page = 1; commits.length < limit; page += 1) {
    const pageCommits = JSON.parse(
      await ghApi(repoRoot, [
        `repos/${pullRequest.owner}/${pullRequest.repo}/commits?sha=${encodeURIComponent(
          sha,
        )}&per_page=${Math.min(limit - commits.length, 100)}&page=${page}`,
      ]),
    );
    if (!Array.isArray(pageCommits) || pageCommits.length === 0) {
      break;
    }
    commits.push(...pageCommits);
  }
  return commits;
};

/** @param {GitHubCommit} commit @param {'base' | 'pull-request'} [scope] @returns {HistoryEntry | null} */
const normalizeGitHubCommit = (commit, scope) => {
  const sha = commit.sha;
  const committedAt = Date.parse(commit.commit?.author?.date || '');
  const message = commit.commit?.message || '';
  if (!sha || !message || !Number.isFinite(committedAt)) {
    return null;
  }

  return {
    author: commit.commit?.author?.name || '',
    committedAt,
    gravatarUrl: commit.author?.avatar_url,
    parentShas:
      commit.parents?.flatMap((parent) =>
        parent.sha ? [/** @type {GitSha} */ (parent.sha)] : [],
      ) || [],
    sha: /** @type {GitSha} */ (sha),
    ...(scope ? { scope } : {}),
    subject: message.split('\n')[0],
  };
};

/** @param {GitHubCommit} commit */
const normalizeGitHubPullRequestCommit = (commit) => normalizeGitHubCommit(commit, 'pull-request');

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source @param {number} [limit] */
const listPullRequestHistory = async (launchPath, source, limit = 200) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseGitHubPullRequestUrl(source.url);
  const [metadata, commits] = await Promise.all([
    readPullRequestMetadata(repoRoot, pullRequest),
    readPullRequestCommits(repoRoot, pullRequest),
  ]);
  const remote = await selectPullRequestRemote(repoRoot, pullRequest, metadata.head?.sha);
  await fetchPullRequestHistoryRefs(repoRoot, remote, pullRequest, metadata);
  const baseCommits = metadata.base?.sha
    ? await readRepositoryCommits(repoRoot, pullRequest, metadata.base.sha, limit)
    : [];
  return {
    entries: [
      ...commits
        .map(normalizeGitHubPullRequestCommit)
        .filter((entry) => entry != null)
        .reverse(),
      ...baseCommits
        .map((commit) => normalizeGitHubCommit(commit, 'base'))
        .filter((entry) => entry != null),
    ],
    root: repoRoot,
  };
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
 * @param {string} expectedBaseSha
 * @param {GitHubRemote} [selectedRemote]
 * @returns {Promise<{base: string; head: string} | null>}
 */
const resolvePullRequestContentRefs = async (
  repoRoot,
  pullRequest,
  metadata,
  expectedBaseSha,
  selectedRemote,
) => {
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
      const remote =
        selectedRemote ??
        (await selectPullRequestRemote(repoRoot, pullRequest, metadata.head?.sha));
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

  const resolvedEffectiveBase = (
    await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${expectedBaseSha}^{commit}`])
  ).trim();
  return resolvedEffectiveBase === expectedBaseSha
    ? { base: expectedBaseSha, head: headRef }
    : null;
};

/**
 * Hydrate eligible files from one immutable PR range. Ref resolution and Git
 * object reads are shared across the complete file set.
 *
 * @param {string} repoRoot
 * @param {PullRequestReference} pullRequest
 * @param {GitHubPullRequestMetadata} metadata
 * @param {import('../../core/lib/review-artifacts.ts').RangeArtifact} range
 * @param {ReadonlyArray<ArtifactFile>} files
 * @param {{force?: boolean}} [options]
 */
const hydratePullRequestSections = async (
  repoRoot,
  pullRequest,
  metadata,
  range,
  files,
  options = {},
) => {
  const candidates = files.filter(
    (file) => canHydrateArtifactFile(file) && !isBinaryDiffPatch(file.patch || ''),
  );
  const refs = await resolvePullRequestContentRefs(
    repoRoot,
    pullRequest,
    metadata,
    range.baseSha,
  ).catch(() => null);
  if (!refs) {
    return candidates.map((file) => ({
      path: file.path,
      section: createPullRequestSection(pullRequest, file, undefined, undefined, {
        base: range.baseSha,
        contentAttempted: true,
        contentError:
          'Codiff could not resolve the immutable pull request range. Retry exact content loading.',
        head: range.headSha,
      }),
    }));
  }

  const oldPaths = candidates.map((file) => file.oldPath || file.path);
  const newPaths = candidates.map((file) => file.path);
  const [oldFiles, newFiles] = await Promise.all([
    readGitFiles(repoRoot, refs.base, oldPaths, {
      force: options.force,
      refScopedEmptyCacheKey: true,
    }),
    readGitFiles(repoRoot, refs.head, newPaths, {
      force: options.force,
      refScopedEmptyCacheKey: true,
    }),
  ]);
  return candidates.map((file) => {
    const oldPath = file.oldPath || file.path;
    return {
      path: file.path,
      section: createPullRequestSection(
        pullRequest,
        file,
        oldFiles.get(oldPath),
        newFiles.get(file.path),
        { base: range.baseSha, contentAttempted: true, head: range.headSha },
      ),
    };
  });
};

/**
 * Hydrate one explicitly requested file. This force path remains available for
 * large-file retries after normal bulk hydration has completed.
 *
 * @param {string} repoRoot
 * @param {PullRequestReference} pullRequest
 * @param {GitHubPullRequestMetadata} metadata
 * @param {import('../../core/lib/review-artifacts.ts').RangeArtifact} range
 * @param {ArtifactFile} file
 * @param {{force?: boolean}} [options]
 */
const hydratePullRequestSection = async (
  repoRoot,
  pullRequest,
  metadata,
  range,
  file,
  options = {},
) => {
  const [result] = await hydratePullRequestSections(
    repoRoot,
    pullRequest,
    metadata,
    range,
    [file],
    options,
  );
  return (
    result?.section ??
    createPullRequestSection(pullRequest, file, undefined, undefined, {
      base: range.baseSha,
      head: range.headSha,
    })
  );
};

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source */
const readPullRequestSectionsContent = async (launchPath, source) => {
  const pullRequest = parseGitHubPullRequestUrl(source.url);
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  await assertPullRequestMatchesRepository(repoRoot, pullRequest);
  const { metadata, range } = await readPullRequestHydrationSnapshot(repoRoot, pullRequest, {
    expectedHeadSha: source.headSha,
  });
  const key = `${repoRoot}:${pullRequest.url}:${range.headSha}`;
  const existing = pullRequestBulkHydrations.get(key);
  if (existing) {
    return existing;
  }

  const hydration = hydratePullRequestSections(repoRoot, pullRequest, metadata, range, range.files)
    .then((sections) => ({ headSha: range.headSha, sections }))
    .catch((error) => {
      pullRequestBulkHydrations.delete(key);
      throw error;
    });
  pullRequestBulkHydrations.set(key, hydration);
  while (pullRequestBulkHydrations.size > MAX_PULL_REQUEST_BULK_HYDRATIONS) {
    pullRequestBulkHydrations.delete(pullRequestBulkHydrations.keys().next().value);
  }
  return hydration;
};

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source @returns {Promise<RepositoryState>} */
const readPullRequestState = async (launchPath, source) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseGitHubPullRequestUrl(source.url);
  await assertPullRequestMatchesRepository(repoRoot, pullRequest);
  const { metadata, range } = await readPullRequestHydrationSnapshot(repoRoot, pullRequest, {
    forceRefresh: true,
  });
  const files = rangeArtifactToPullRequestFiles(range, pullRequest.number, {
    deferContents: true,
  }).toSorted((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    reviewCommentsLoadState: 'not-loaded',
    root: repoRoot,
    source: createPullRequestSource(pullRequest, metadata),
  };
};

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source */
const readPullRequestReviewComments = async (launchPath, source) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseGitHubPullRequestUrl(source.url);
  await assertPullRequestMatchesRepository(repoRoot, pullRequest);
  return readPullRequestComments(repoRoot, pullRequest);
};

/**
 * Load exact local contents for one pull-request file when explicitly retried.
 * @param {string} launchPath
 * @param {Extract<ReviewSource, {type: 'pull-request'}>} source
 * @param {string} requestedPath
 * @param {{force?: boolean}} [options]
 */
const readPullRequestSectionContent = async (launchPath, source, requestedPath, options = {}) => {
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
  return hydratePullRequestSection(repoRoot, pullRequest, metadata, range, file, options);
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
    const [oldImage, newImage] = await Promise.all([
      readGitHubImageFile(repoRoot, pullRequest, range.baseSha, file.oldPath || file.path),
      readGitHubImageFile(repoRoot, headImageSource, headImageSource.ref, file.path),
    ]);

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

/** @param {PullRequestReviewComment['side']} side */
const toGitHubReviewSide = (side) => (side === 'deletions' ? 'LEFT' : 'RIGHT');

/** @param {PullRequestReviewComment} comment */
const normalizePullRequestComment = (comment) => {
  /** @type {{body: string; line: number; path: string; side: string; start_line?: number; start_side?: string}} */
  const payload = {
    body: comment.body,
    line: comment.lineNumber,
    path: comment.filePath,
    side: toGitHubReviewSide(comment.side),
  };
  const startSide = comment.startSide ?? comment.side;
  if (
    typeof comment.startLineNumber === 'number' &&
    comment.startLineNumber !== comment.lineNumber
  ) {
    payload.start_line = comment.startLineNumber;
    payload.start_side = toGitHubReviewSide(startSide);
  }
  return payload;
};

const PENDING_REVIEW_COMMENT_ERROR =
  'You already have a pending GitHub review on this pull request. Submit or discard it on GitHub, then retry. Your comment draft is still here.';

/** @param {unknown} error */
const isGitHubValidationError = (error) =>
  error instanceof Error && /(?:validation failed|http 422)/i.test(error.message);

/** @param {string} repoRoot @param {PullRequestReference} pullRequest */
const hasPendingPullRequestReview = async (repoRoot, pullRequest) => {
  const pages = JSON.parse(
    await ghApi(repoRoot, [
      '--paginate',
      '--slurp',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/reviews?per_page=100`,
    ]),
  );
  return Array.isArray(pages) && pages.flat().some((review) => review?.state === 'PENDING');
};

/** @param {string} launchPath @param {SubmitPullRequestCommentRequest} request */
const submitPullRequestComment = async (launchPath, request) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseGitHubPullRequestUrl(request.source.url);
  const metadata = await readPullRequestMetadata(repoRoot, pullRequest);
  await selectPullRequestRemote(repoRoot, pullRequest, metadata.head?.sha);
  const replyTo = request.comment.threadId ? Number(request.comment.threadId) : null;
  if (request.comment.threadId && (!Number.isInteger(replyTo) || replyTo <= 0)) {
    throw new Error('GitHub review replies require a numeric provider thread ID.');
  }
  const payload = replyTo
    ? { body: request.comment.body, in_reply_to: replyTo }
    : {
        ...normalizePullRequestComment(request.comment),
        commit_id: metadata.head?.sha,
      };

  const rawComment = await ghApi(
    repoRoot,
    [
      '-X',
      'POST',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/comments`,
      '--input',
      '-',
    ],
    payload,
  ).catch(async (error) => {
    if (isGitHubValidationError(error)) {
      const hasPendingReview = await hasPendingPullRequestReview(repoRoot, pullRequest).catch(
        () => false,
      );
      if (hasPendingReview) {
        throw new Error(PENDING_REVIEW_COMMENT_ERROR);
      }
    }
    throw error;
  });
  const comment = normalizeGitHubReviewComment(JSON.parse(rawComment));
  if (!comment) {
    throw new Error('GitHub accepted the comment but did not return line metadata.');
  }
  return comment;
};

/** @param {string} launchPath @param {SubmitPullRequestReviewRequest} request */
const submitPullRequestReview = async (launchPath, request) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseGitHubPullRequestUrl(request.source.url);
  const metadata = await readPullRequestMetadata(repoRoot, pullRequest);
  await selectPullRequestRemote(repoRoot, pullRequest, metadata.head?.sha);

  await ghApi(
    repoRoot,
    [
      '-X',
      'POST',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/reviews`,
      '--input',
      '-',
    ],
    createPullRequestReviewPayload(request),
  );
};

/** @param {SubmitPullRequestReviewRequest} request */
const createPullRequestReviewPayload = (request) => {
  const body = request.body?.trim() || '';
  if (request.event === 'COMMENT' && request.comments.length === 0 && !body) {
    throw new Error('A comment review requires an inline comment or a review comment.');
  }

  return {
    body:
      body ||
      (request.event === 'REQUEST_CHANGES' && request.comments.length === 0
        ? 'Requesting changes.'
        : ''),
    comments: request.comments.map(normalizePullRequestComment),
    event: request.event,
  };
};

module.exports = {
  PENDING_REVIEW_COMMENT_ERROR,
  collectResolvedReviewCommentIds,
  createPullRequestHistoryFetchRefspecs,
  createPullRequestSource,
  getPullRequestHeadImageSource,
  listPullRequestHistory,
  normalizeGitHubCommit,
  normalizeGitHubPullRequestCommit,
  normalizeGitHubReviewComment,
  normalizePullRequestComment,
  parseGitHubPullRequestUrl,
  readPullRequestImageContent,
  readPullRequestReviewComments,
  readPullRequestSectionContent,
  readPullRequestSectionsContent,
  readPullRequestState,
  resolvePullRequestContentRefs,
  selectPullRequestRemote,
  selectUnresolvedReviewComments,
  submitPullRequestComment,
  submitPullRequestReview,
};
