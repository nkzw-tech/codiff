// @ts-check

const { spawn } = require('node:child_process');
const {
  IMAGE_FILE_LIMIT,
  bufferToImageRevision,
  createSummary,
  formatBytes,
  getFingerprint,
  getImageMimeType,
  git,
  gitOrEmpty,
  readGitFile,
  summarizeContent,
  validateRepositoryPath,
} = require('./common.cjs');

/**
 * @typedef {import('../../src/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../src/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../../src/types.ts').PullRequestReviewComment} PullRequestReviewComment
 * @typedef {import('../../src/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../../src/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../../src/types.ts').SubmitPullRequestCommentRequest} SubmitPullRequestCommentRequest
 * @typedef {import('../../src/types.ts').SubmitPullRequestReviewRequest} SubmitPullRequestReviewRequest
 * @typedef {{owner: string; repo: string}} GitHubRepositoryReference
 * @typedef {{full_name?: string; name?: string; owner?: {login?: string}}} GitHubRepositoryMetadata
 * @typedef {{number: number; owner: string; repo: string; url: string}} PullRequestReference
 * @typedef {{direction: 'fetch' | 'push'; name: string; owner: string; repo: string}} GitHubRemote
 * @typedef {{filename: string; patch?: string; previous_filename?: string; status: string}} GitHubPullRequestFile
 * @typedef {{base?: {ref?: string; repo?: GitHubRepositoryMetadata | null; sha?: string}; head?: {ref?: string; repo?: GitHubRepositoryMetadata | null; sha?: string}; title?: string}} GitHubPullRequestMetadata
 * @typedef {{author?: {avatar_url?: string}; commit?: {author?: {date?: string; email?: string; name?: string}; message?: string}; parents?: ReadonlyArray<{sha?: string}>; sha?: string}} GitHubCommit
 * @typedef {{[key: string]: any}} GitHubReviewComment
 * @typedef {{comments?: {nodes?: ReadonlyArray<{databaseId?: number | null}>} | null; isResolved?: boolean}} GitHubReviewThread
 */

/** @param {string} value @returns {PullRequestReference} */
const parseGitHubPullRequestUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Codiff expected a GitHub pull request URL.');
  }

  if (url.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Codiff only supports GitHub pull request URLs.');
  }

  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
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

/** @param {string} value @returns {GitHubRemote | null} */
const parseGitHubRemoteUrl = (value) => {
  const trimmed = value.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
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

/** @param {string} repoRoot @returns {Promise<Array<GitHubRemote>>} */
const readLocalGitHubRemotes = async (repoRoot) => {
  const raw = await gitOrEmpty(repoRoot, ['remote', '-v']);
  const remotes = [];
  for (const line of raw.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    const remote = match ? parseGitHubRemoteUrl(match[2]) : null;
    if (remote) {
      remotes.push({
        direction: /** @type {'fetch' | 'push'} */ (match[3]),
        name: match[1],
        ...remote,
      });
    }
  }
  return remotes;
};

/** @param {GitHubRemote} remote */
const getRemotePriority = (remote) =>
  remote.name === 'origin'
    ? remote.direction === 'fetch'
      ? 0
      : 1
    : remote.direction === 'fetch'
      ? 2
      : 3;

/** @param {string} repoRoot @param {PullRequestReference} pullRequest @returns {Promise<GitHubRemote>} */
const selectPullRequestRemote = async (repoRoot, pullRequest) => {
  const remotes = await readLocalGitHubRemotes(repoRoot);
  const remote = remotes
    .filter(
      (remote) =>
        remote.owner.toLowerCase() === pullRequest.owner.toLowerCase() &&
        remote.repo.toLowerCase() === pullRequest.repo.toLowerCase(),
    )
    .sort((left, right) => getRemotePriority(left) - getRemotePriority(right))[0];

  if (!remote) {
    throw new Error(
      `Pull request ${pullRequest.owner}/${pullRequest.repo} does not match a GitHub remote in this repository.`,
    );
  }

  return remote;
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

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} args
 * @param {unknown} [input]
 * @returns {Promise<string>}
 */
const ghApi = (repoRoot, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn('gh', ['api', ...args], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** @type {Array<Buffer>} */
    const stdout = [];
    /** @type {Array<Buffer>} */
    const stderr = [];

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      if (code === 0) {
        resolve(output);
        return;
      }

      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
      reject(new Error(errorOutput || `gh api exited with code ${code}.`));
    });

    if (input == null) {
      child.stdin.end();
    } else {
      child.stdin.end(JSON.stringify(input));
    }
  });

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} args
 * @returns {Promise<Buffer | undefined>}
 */
const ghApiBuffer = (repoRoot, args) =>
  new Promise((resolve, reject) => {
    const child = spawn('gh', ['api', ...args], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    /** @type {Array<Buffer>} */
    const stdout = [];
    /** @type {Array<Buffer>} */
    const stderr = [];

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }

      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code === 1 && /not found|404/i.test(errorOutput)) {
        resolve(undefined);
        return;
      }

      reject(new Error(errorOutput.trim() || `gh api exited with code ${code}.`));
    });
  });

/** @param {string} repoRoot @param {PullRequestReference} pullRequest @returns {Promise<GitHubPullRequestMetadata>} */
const readPullRequestMetadata = async (repoRoot, pullRequest) =>
  JSON.parse(
    await ghApi(repoRoot, [
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}`,
    ]),
  );

/** @param {string} repoRoot @param {PullRequestReference} pullRequest @returns {Promise<Array<GitHubPullRequestFile>>} */
const readPullRequestFiles = async (repoRoot, pullRequest) => {
  const pages = JSON.parse(
    await ghApi(repoRoot, [
      '--paginate',
      '--slurp',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/files?per_page=100`,
    ]),
  );
  return pages.flat();
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

/** @param {string} repoRoot @param {PullRequestReference} pullRequest */
const readPullRequestDiff = async (repoRoot, pullRequest) =>
  ghApi(repoRoot, [
    '-H',
    'Accept: application/vnd.github.v3.diff',
    `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}`,
  ]);

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

/** @param {GitHubCommit} commit @param {'base' | 'pull-request'} [scope] */
const normalizeGitHubCommit = (commit, scope) => {
  const ref = commit.sha;
  const committedAt = Date.parse(commit.commit?.author?.date || '');
  const message = commit.commit?.message || '';
  if (!ref || !message || !Number.isFinite(committedAt)) {
    return null;
  }

  return {
    author: commit.commit?.author?.name || '',
    committedAt,
    gravatarUrl: commit.author?.avatar_url,
    parents: commit.parents?.map((parent) => parent.sha).filter(Boolean) || [],
    ref,
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
  const remote = await selectPullRequestRemote(repoRoot, pullRequest);
  const [metadata, commits] = await Promise.all([
    readPullRequestMetadata(repoRoot, pullRequest),
    readPullRequestCommits(repoRoot, pullRequest),
  ]);
  await fetchPullRequestHistoryRefs(repoRoot, remote, pullRequest, metadata);
  const baseCommits = metadata.base?.sha
    ? await readRepositoryCommits(repoRoot, pullRequest, metadata.base.sha, limit)
    : [];
  return {
    entries: [
      ...commits.map(normalizeGitHubPullRequestCommit).filter(Boolean).reverse(),
      ...baseCommits.map((commit) => normalizeGitHubCommit(commit, 'base')).filter(Boolean),
    ],
    root: repoRoot,
  };
};

/** @param {string} diff @returns {Map<string, string>} */
const splitPullRequestDiff = (diff) => {
  const chunks = diff
    .split(/(?=^diff --git )/m)
    .map((chunk) => chunk.trimEnd())
    .filter((chunk) => chunk.startsWith('diff --git '));
  const map = new Map();

  for (const chunk of chunks) {
    const newPath = chunk.match(/^\+\+\+\s+b\/(.+)$/m)?.[1];
    const oldPath = chunk.match(/^---\s+a\/(.+)$/m)?.[1];
    const renamePath = chunk.match(/^rename to (.+)$/m)?.[1];
    const path = newPath && newPath !== '/dev/null' ? newPath : renamePath || oldPath;
    if (path) {
      map.set(path, `${chunk}\n`);
    }
  }

  return map;
};

/** @param {string} path */
const quotePatchPath = (path) => path.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

/** @param {GitHubPullRequestFile} file */
const createPatchFromPullRequestFile = (file) => {
  if (!file.patch) {
    return '';
  }

  const oldPath = file.previous_filename || file.filename;
  const header = [
    `diff --git a/${quotePatchPath(oldPath)} b/${quotePatchPath(file.filename)}`,
    file.status === 'added' ? '--- /dev/null' : `--- a/${quotePatchPath(oldPath)}`,
    file.status === 'removed' ? '+++ /dev/null' : `+++ b/${quotePatchPath(file.filename)}`,
  ];

  return `${header.join('\n')}\n${file.patch}\n`;
};

/** @param {string} status @returns {GitFileStatus} */
const normalizePullRequestFileStatus = (status) =>
  status === 'added'
    ? 'added'
    : status === 'removed'
      ? 'deleted'
      : status === 'renamed'
        ? 'renamed'
        : 'modified';

/** @param {PullRequestReference} pullRequest @param {GitHubPullRequestMetadata} metadata @returns {Extract<ReviewSource, {type: 'pull-request'}>} */
const createPullRequestSource = (pullRequest, metadata) => ({
  headSha: metadata.head?.sha,
  number: pullRequest.number,
  owner: pullRequest.owner,
  repo: pullRequest.repo,
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
      const remote = await selectPullRequestRemote(repoRoot, pullRequest);
      await fetchPullRequestHistoryRefs(repoRoot, remote, pullRequest, metadata);
    } catch {
      return null;
    }
  }

  const mergeBase = (await gitOrEmpty(repoRoot, ['merge-base', baseRef, headRef])).trim();
  return mergeBase ? { base: mergeBase, head: headRef } : null;
};

/**
 * git/GitHub emit `Binary files a/x and b/x differ` as a diff metadata line.
 * Anchor to the start of a line so the same text appearing inside a patch's
 * added/removed/context lines (which are prefixed with `+`/`-`/space) does not
 * misclassify a text file as binary.
 */
const BINARY_DIFF_MARKER = /^Binary files .* differ/m;

/**
 * Build a diff section for a pull request file. When the full base and head
 * contents are available the section carries `oldFile`/`newFile` so Codiff
 * renders a recomputed diff with expandable unmodified context (matching commits
 * and the working tree). Otherwise it falls back to the GitHub patch.
 *
 * @param {PullRequestReference} pullRequest
 * @param {GitHubPullRequestFile} file
 * @param {string} patch
 * @param {import('./common.cjs').FileContentResult} [oldFile]
 * @param {import('./common.cjs').FileContentResult} [newFile]
 * @returns {import('../../src/types.ts').DiffSection}
 */
const createPullRequestSection = (pullRequest, file, patch, oldFile, newFile) => {
  const id = `${file.filename}:pull-request:${pullRequest.number}`;
  const patchBinary = !patch || BINARY_DIFF_MARKER.test(patch);
  // Expandable context can only be rendered when both sides' contents are present.
  const attemptedContent = oldFile != null && newFile != null;

  if (attemptedContent && !patchBinary) {
    const summary = summarizeContent(oldFile, newFile);
    const status = normalizePullRequestFileStatus(file.status);
    const oldContents = oldFile.file?.contents ?? '';
    const newContents = newFile.file?.contents ?? '';
    // A modification that reads empty on both sides means the content failed to
    // load; keep the patch instead of rendering it as an empty (no-op) diff.
    const contentMissing =
      (status === 'modified' || status === 'renamed') && oldContents === '' && newContents === '';

    if (!summary.binary && summary.loadState === 'ready' && !contentMissing) {
      return {
        binary: false,
        id,
        kind: 'pull-request',
        loadState: 'ready',
        newFile: newFile.file,
        oldFile: oldFile.file,
        patch,
      };
    }
  }

  // Pull request contents are loaded up front, so a file that falls back to its
  // patch (binary, oversized, or refs unavailable) cannot be loaded on demand.
  return {
    binary: patchBinary,
    id,
    kind: 'pull-request',
    loadState: patchBinary ? 'binary' : 'ready',
    patch,
    summary: createSummary(
      patchBinary ? 'Binary file changed.' : 'Showing the pull request patch for this file.',
      { canLoad: false },
    ),
  };
};

const PULL_REQUEST_CONTENT_CONCURRENCY = 16;

/**
 * Run an async mapper over `items` with a bounded number of concurrent calls so
 * loading every file's contents does not spawn one git process per file at once.
 *
 * @template T, R
 * @param {ReadonlyArray<T>} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} mapper
 * @returns {Promise<Array<R>>}
 */
const mapWithConcurrency = async (items, limit, mapper) => {
  /** @type {Array<R>} */
  const results = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
  return results;
};

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source @returns {Promise<RepositoryState>} */
const readPullRequestState = async (launchPath, source) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseGitHubPullRequestUrl(source.url);
  await assertPullRequestMatchesRepository(repoRoot, pullRequest);

  const [metadata, apiFiles, diff, reviewComments] = await Promise.all([
    readPullRequestMetadata(repoRoot, pullRequest),
    readPullRequestFiles(repoRoot, pullRequest),
    readPullRequestDiff(repoRoot, pullRequest),
    readPullRequestComments(repoRoot, pullRequest),
  ]);
  const diffByPath = splitPullRequestDiff(diff);
  // Load every file's base and head contents up front from the local refs, so
  // each diff renders in its final collapsed layout immediately and never shifts
  // as expandable context becomes available. Files larger than the eager limit
  // stay patch-only.
  const contentRefs = await resolvePullRequestContentRefs(repoRoot, pullRequest, metadata).catch(
    () => null,
  );

  /** @type {Array<ChangedFile>} */
  const files = (
    await mapWithConcurrency([...apiFiles], PULL_REQUEST_CONTENT_CONCURRENCY, async (file) => {
      const patch = diffByPath.get(file.filename) || createPatchFromPullRequestFile(file);
      const oldPath = file.previous_filename || file.filename;
      const [oldFile, newFile] =
        contentRefs && !BINARY_DIFF_MARKER.test(patch)
          ? await Promise.all([
              readGitFile(repoRoot, contentRefs.base, oldPath),
              readGitFile(repoRoot, contentRefs.head, file.filename),
            ])
          : [undefined, undefined];
      const section = createPullRequestSection(pullRequest, file, patch, oldFile, newFile);

      return {
        fingerprint: getFingerprint(
          [
            metadata.head?.sha || '',
            file.status,
            file.previous_filename || '',
            file.filename,
            section.loadState || 'ready',
            section.oldFile?.cacheKey || '',
            section.newFile?.cacheKey || '',
            patch,
          ].join('\n'),
        ),
        oldPath: file.previous_filename,
        path: file.filename,
        sections: [section],
        status: normalizePullRequestFileStatus(file.status),
      };
    })
  ).sort((left, right) => left.path.localeCompare(right.path));

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    reviewComments,
    root: repoRoot,
    source: createPullRequestSource(pullRequest, metadata),
  };
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

    const [metadata, files] = await Promise.all([
      readPullRequestMetadata(repoRoot, pullRequest),
      readPullRequestFiles(repoRoot, pullRequest),
    ]);
    const file = files.find((candidate) => candidate.filename === path);
    if (!file) {
      throw new Error('File is not part of this pull request.');
    }

    const headImageSource = getPullRequestHeadImageSource(pullRequest, metadata);
    const [oldImage, newImage] = await Promise.all([
      metadata.base?.sha
        ? readGitHubImageFile(
            repoRoot,
            pullRequest,
            metadata.base.sha,
            file.previous_filename || file.filename,
          )
        : undefined,
      readGitHubImageFile(repoRoot, headImageSource, headImageSource.ref, file.filename),
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

/** @param {string} launchPath @param {SubmitPullRequestCommentRequest} request */
const submitPullRequestComment = async (launchPath, request) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseGitHubPullRequestUrl(request.source.url);
  await assertPullRequestMatchesRepository(repoRoot, pullRequest);

  const metadata = await readPullRequestMetadata(repoRoot, pullRequest);
  const payload = {
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
  );
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
  await assertPullRequestMatchesRepository(repoRoot, pullRequest);

  await ghApi(
    repoRoot,
    [
      '-X',
      'POST',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/reviews`,
      '--input',
      '-',
    ],
    {
      body:
        request.body ||
        (request.event === 'REQUEST_CHANGES' && request.comments.length === 0
          ? 'Requesting changes.'
          : ''),
      comments: request.comments.map(normalizePullRequestComment),
      event: request.event,
    },
  );
};

module.exports = {
  collectResolvedReviewCommentIds,
  createPatchFromPullRequestFile,
  createPullRequestHistoryFetchRefspecs,
  createPullRequestSection,
  createPullRequestSource,
  getPullRequestHeadImageSource,
  listPullRequestHistory,
  normalizeGitHubCommit,
  normalizeGitHubPullRequestCommit,
  normalizeGitHubReviewComment,
  normalizePullRequestComment,
  parseGitHubPullRequestUrl,
  readPullRequestImageContent,
  readPullRequestState,
  resolvePullRequestContentRefs,
  selectUnresolvedReviewComments,
  submitPullRequestComment,
  submitPullRequestReview,
};
