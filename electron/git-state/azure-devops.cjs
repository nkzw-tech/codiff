// @ts-check

const { spawn } = require('node:child_process');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { findExecutableOnPath, isExecutableFile } = require('../agent-shared.cjs');
const { getCommandEnvironment } = require('../login-shell-environment.cjs');
const {
  getFingerprint,
  git,
  gitOrEmpty,
  readGitImageFile,
  validateRepositoryPath,
} = require('./common.cjs');
const { readGitFiles } = require('./git-files.cjs');
const {
  createPatchFromPullRequestFile,
  createPullRequestSection,
  normalizeGitHubCommit,
} = require('./pull-request.cjs');
const { parseReviewUrl, readReviewRemotes } = require('../review-source.cjs');

/**
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').PullRequestReviewComment} PullRequestReviewComment
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 */

const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const AZURE_DEVOPS_API_VERSION = '7.1';
const AZ_NOT_FOUND_CODE = 'AZ_NOT_FOUND';
const AZ_NOT_FOUND_MESSAGE =
  'Azure DevOps support requires az. Install the Azure CLI, run `az login`, and verify `az --version` works in Terminal. Codiff searches PATH, ~/.local/bin/az, /opt/homebrew/bin/az, and /usr/local/bin/az. If az is installed somewhere else, launch Codiff with `CODIFF_AZ_PATH=/absolute/path/to/az codiff`.';

const CLOSED_THREAD_STATUSES = new Set([
  'bydesign',
  'closed',
  'fixed',
  'wontfix',
  2,
  3,
  4,
  5,
  '2',
  '3',
  '4',
  '5',
]);

/** @param {string} [detail] */
const createAzNotFoundError = (detail) =>
  Object.assign(new Error(detail ? `${AZ_NOT_FOUND_MESSAGE} ${detail}` : AZ_NOT_FOUND_MESSAGE), {
    code: AZ_NOT_FOUND_CODE,
  });

const getAzCommand = () => {
  const azPath = process.env.CODIFF_AZ_PATH?.trim();
  if (azPath) {
    if (isExecutableFile(azPath)) {
      return azPath;
    }

    throw createAzNotFoundError(
      `CODIFF_AZ_PATH is set to ${JSON.stringify(azPath)}, but that file is not executable.`,
    );
  }

  const pathCommand = findExecutableOnPath('az');
  if (pathCommand) {
    return pathCommand;
  }

  for (const path of [
    join(homedir(), '.local/bin/az'),
    '/opt/homebrew/bin/az',
    '/usr/local/bin/az',
  ]) {
    if (isExecutableFile(path)) {
      return path;
    }
  }

  throw createAzNotFoundError();
};

/** @param {string} value */
const parseAzureDevOpsPullRequestUrl = (value) => {
  const parsed = parseReviewUrl(value);
  if (!parsed || parsed.provider !== 'azure-devops') {
    throw new Error('Codiff expected an Azure DevOps pull request URL.');
  }
  return parsed;
};

/**
 * @param {ReturnType<typeof parseAzureDevOpsPullRequestUrl>} pullRequest
 * @param {string} [suffix]
 * @param {string} [query]
 */
const pullRequestEndpoint = (pullRequest, suffix = '', query = '') => {
  const extra = query ? `&${query}` : '';
  return `${pullRequest.apiBase}/_apis/git/repositories/${encodeURIComponent(
    pullRequest.repo,
  )}/pullRequests/${pullRequest.number}${suffix}?api-version=${AZURE_DEVOPS_API_VERSION}${extra}`;
};

/** @param {string} value */
const stripLeadingSlash = (value) => value.replace(/^\/+/, '');

/** @param {string} repoRoot @param {ReturnType<typeof parseAzureDevOpsPullRequestUrl>} pullRequest */
const selectAzureDevOpsRemote = (repoRoot, pullRequest) => {
  const remote = readReviewRemotes(repoRoot)
    .filter(
      (candidate) =>
        candidate.provider === 'azure-devops' &&
        candidate.organization?.toLowerCase() === pullRequest.organization.toLowerCase() &&
        candidate.project?.toLowerCase() === pullRequest.project.toLowerCase() &&
        candidate.repo?.toLowerCase() === pullRequest.repo.toLowerCase(),
    )
    .sort((left, right) =>
      left.name === right.name
        ? left.direction === 'fetch'
          ? -1
          : 1
        : left.name === 'origin'
          ? -1
          : 1,
    )[0];
  if (!remote) {
    throw new Error(
      `Pull request ${pullRequest.projectPath}#${pullRequest.number} does not match an Azure DevOps remote in this repository.`,
    );
  }
  return remote;
};

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} args
 */
const azRest = async (repoRoot, args) => {
  const environment = await getCommandEnvironment();
  return new Promise((resolve, reject) => {
    let command;
    try {
      command = getAzCommand();
    } catch (error) {
      reject(error);
      return;
    }

    const child = spawn(command, args, {
      cwd: repoRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      reject(error.code === 'ENOENT' ? createAzNotFoundError() : error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
      } else {
        reject(
          new Error(
            Buffer.concat(stderr).toString('utf8').trim() || `az rest exited with code ${code}.`,
          ),
        );
      }
    });
  });
};

/**
 * @param {string} repoRoot
 * @param {ReturnType<typeof parseAzureDevOpsPullRequestUrl>} pullRequest
 * @param {string} uri
 * @param {string} [method]
 * @param {unknown} [body]
 */
const azureApi = async (repoRoot, pullRequest, uri, method = 'GET', body) => {
  const args = [
    'rest',
    '--method',
    method,
    '--uri',
    uri,
    '--resource',
    AZURE_DEVOPS_RESOURCE,
    ...(body == null
      ? []
      : ['--headers', 'Content-Type=application/json', '--body', JSON.stringify(body)]),
  ];
  const output = await azRest(repoRoot, args);
  const trimmed = output.trim();
  return trimmed ? JSON.parse(trimmed) : null;
};

/** @param {string} repoRoot @param {ReturnType<typeof parseAzureDevOpsPullRequestUrl>} pullRequest */
const readPullRequestMetadata = (repoRoot, pullRequest) =>
  azureApi(repoRoot, pullRequest, pullRequestEndpoint(pullRequest));

/** @param {string} repoRoot @param {ReturnType<typeof parseAzureDevOpsPullRequestUrl>} pullRequest */
const readPullRequestThreads = async (repoRoot, pullRequest) => {
  const payload = await azureApi(
    repoRoot,
    pullRequest,
    pullRequestEndpoint(pullRequest, '/threads', '$top=200'),
  );
  return Array.isArray(payload?.value) ? payload.value : [];
};

/** @param {string} repoRoot @param {ReturnType<typeof parseAzureDevOpsPullRequestUrl>} pullRequest */
const readPullRequestCommits = async (repoRoot, pullRequest) => {
  const payload = await azureApi(
    repoRoot,
    pullRequest,
    pullRequestEndpoint(pullRequest, '/commits', '$top=200'),
  );
  return Array.isArray(payload?.value) ? payload.value : [];
};

/** @param {any} author */
const normalizeAzureAuthor = (author) => ({
  avatarUrl: author?.imageUrl,
  login: author?.uniqueName || author?.displayName || 'Azure DevOps user',
  url: author?._links?.web?.href || author?.url,
});

/** @param {any} threadContext @param {string} [filePath] */
const getAzureThreadLocation = (threadContext, filePath) => {
  if (!filePath) {
    return null;
  }
  const rightStart = threadContext?.rightFileStart?.line;
  const rightEnd = threadContext?.rightFileEnd?.line;
  const leftStart = threadContext?.leftFileStart?.line;
  const leftEnd = threadContext?.leftFileEnd?.line;
  const hasRight = typeof rightEnd === 'number' || typeof rightStart === 'number';
  const hasLeft = typeof leftEnd === 'number' || typeof leftStart === 'number';
  if (!hasRight && !hasLeft) {
    return { anchor: /** @type {const} */ ('file'), filePath };
  }

  const side = hasRight ? /** @type {const} */ ('additions') : /** @type {const} */ ('deletions');
  const start = hasRight ? rightStart : leftStart;
  const end = hasRight ? (rightEnd ?? rightStart) : (leftEnd ?? leftStart);
  return {
    filePath,
    lineNumber: end,
    side,
    ...(typeof start === 'number' && start !== end
      ? { startLineNumber: start, startSide: side }
      : {}),
  };
};

/** @param {any} comment @param {any} thread @param {string} url */
const normalizeAzureDevOpsReviewComment = (comment, thread, url) => {
  if (!comment?.content || comment.commentType === 'system' || comment.commentType === 3) {
    return null;
  }
  const filePath = thread.threadContext?.filePath
    ? stripLeadingSlash(thread.threadContext.filePath)
    : '';
  const location = getAzureThreadLocation(thread.threadContext, filePath);
  if (!location) {
    return null;
  }
  return {
    author: normalizeAzureAuthor(comment.author),
    body: comment.content,
    ...location,
    id: `azure-devops:${thread.id}:${comment.id}`,
    submittedAt: comment.publishedDate || comment.lastContentUpdatedDate,
    threadId: String(thread.id),
    url: `${url}?discussionId=${thread.id}`,
  };
};

/** @param {any} comment @param {PullRequestReviewComment} submittedComment @param {any} thread @param {string} url */
const normalizeSubmittedAzureDevOpsReviewComment = (comment, submittedComment, thread, url) => {
  const normalized = normalizeAzureDevOpsReviewComment(comment, thread, url);
  if (normalized) {
    return normalized;
  }
  if (!comment?.content || comment.id == null) {
    return null;
  }
  return {
    ...submittedComment,
    author: normalizeAzureAuthor(comment.author),
    body: comment.content,
    id: `azure-devops:${thread.id}:${comment.id}`,
    submittedAt: comment.publishedDate || comment.lastContentUpdatedDate,
    threadId: String(thread.id),
    url: `${url}?discussionId=${thread.id}`,
  };
};

/** @param {string} repoRoot @param {ReturnType<typeof parseAzureDevOpsPullRequestUrl>} pullRequest */
const readAzureDevOpsComments = async (repoRoot, pullRequest) => {
  const threads = await readPullRequestThreads(repoRoot, pullRequest);
  return threads
    .filter((thread) => !CLOSED_THREAD_STATUSES.has(thread.status) && !thread.isDeleted)
    .flatMap((thread) =>
      (thread.comments || [])
        .filter((comment) => !comment.isDeleted)
        .map((comment) => normalizeAzureDevOpsReviewComment(comment, thread, pullRequest.url)),
    )
    .filter(Boolean);
};

/** @param {ReturnType<typeof parseAzureDevOpsPullRequestUrl>} pullRequest @param {any} metadata @returns {Extract<ReviewSource, {type: 'pull-request'}>} */
const createAzureDevOpsSource = (pullRequest, metadata) => ({
  ...(metadata.createdBy?.displayName || metadata.createdBy?.uniqueName
    ? { author: normalizeAzureAuthor(metadata.createdBy) }
    : {}),
  ...(typeof metadata.description === 'string' && metadata.description.trim()
    ? { description: metadata.description.trim() }
    : {}),
  headSha: metadata.lastMergeSourceCommit?.commitId || metadata.lastMergeCommit?.commitId,
  host: pullRequest.host,
  number: pullRequest.number,
  owner: pullRequest.organization,
  projectPath: pullRequest.projectPath,
  provider: 'azure-devops',
  repo: pullRequest.repo,
  title: metadata.title,
  type: 'pull-request',
  url: pullRequest.url,
});

/** @param {ReturnType<typeof parseAzureDevOpsPullRequestUrl>} pullRequest @param {any} metadata */
const createAzureDevOpsFetchRefspecs = (pullRequest, metadata) => [
  `+refs/pull/${pullRequest.number}/head:refs/codiff/pull-requests/${pullRequest.number}/head`,
  ...(metadata.targetRefName
    ? [`+${metadata.targetRefName}:refs/codiff/pull-requests/${pullRequest.number}/base`]
    : []),
];

/** @param {string} repoRoot @param {any} remote @param {any} pullRequest @param {any} metadata */
const fetchAzureDevOpsRefs = (repoRoot, remote, pullRequest, metadata) =>
  git(repoRoot, [
    'fetch',
    '--no-tags',
    remote.name,
    ...createAzureDevOpsFetchRefspecs(pullRequest, metadata),
  ]);

/** @param {string} repoRoot @param {any} pullRequest @param {any} metadata */
const resolveAzureDevOpsContentRefs = async (repoRoot, pullRequest, metadata) => {
  const head = `refs/codiff/pull-requests/${pullRequest.number}/head`;
  const base = `refs/codiff/pull-requests/${pullRequest.number}/base`;
  const localHead = (await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', head])).trim();
  const localBase = (await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', base])).trim();
  const headSha = metadata.lastMergeSourceCommit?.commitId;
  if (!localHead || !localBase || (headSha && localHead !== headSha)) {
    await fetchAzureDevOpsRefs(
      repoRoot,
      selectAzureDevOpsRemote(repoRoot, pullRequest),
      pullRequest,
      metadata,
    );
  }
  const metadataBase = metadata.lastMergeTargetCommit?.commitId;
  if (
    metadataBase &&
    (await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${metadataBase}^{commit}`]))
  ) {
    return { base: metadataBase, head };
  }
  const mergeBase = (await gitOrEmpty(repoRoot, ['merge-base', base, head])).trim();
  return mergeBase ? { base: mergeBase, head } : null;
};

/**
 * @param {string} raw
 * @returns {Array<{filename: string; previous_filename?: string; status: string}>}
 */
const parseNameStatusFiles = (raw) => {
  const parts = raw.split('\0').filter(Boolean);
  const files = [];
  for (let index = 0; index < parts.length;) {
    const statusCode = parts[index++];
    const statusType = statusCode[0];
    if (statusType === 'R' || statusType === 'C') {
      const oldPath = parts[index++];
      const path = parts[index++];
      files.push({
        filename: path,
        previous_filename: oldPath,
        status: 'renamed',
      });
    } else {
      const path = parts[index++];
      files.push({
        filename: path,
        status: statusType === 'A' ? 'added' : statusType === 'D' ? 'removed' : 'modified',
      });
    }
  }
  return files;
};

/**
 * @param {string} repoRoot
 * @param {string} oldRef
 * @param {string} newRef
 * @param {ReadonlyArray<string>} paths
 */
const readAzureDevOpsPatches = async (repoRoot, oldRef, newRef, paths) => {
  /** @type {Map<string, string>} */
  const patches = new Map();
  if (paths.length === 0) {
    return patches;
  }

  const raw = await git(repoRoot, [
    'diff',
    '--patch',
    '--no-ext-diff',
    '--find-renames',
    oldRef,
    newRef,
    '--',
    ...paths,
  ]);
  const chunks = raw
    .split(/(?=^diff --git )/m)
    .map((chunk) => chunk.trimEnd())
    .filter((chunk) => chunk.startsWith('diff --git '));
  for (const chunk of chunks) {
    const newPath = chunk.match(/^\+\+\+\s+b\/(.+)$/m)?.[1];
    const oldPath = chunk.match(/^---\s+a\/(.+)$/m)?.[1];
    const renamePath = chunk.match(/^rename to (.+)$/m)?.[1];
    const path = newPath && newPath !== '/dev/null' ? newPath : renamePath || oldPath;
    if (path) {
      patches.set(path, `${chunk}\n`);
    }
  }
  return patches;
};

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source */
const readAzureDevOpsPullRequestState = async (launchPath, source) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseAzureDevOpsPullRequestUrl(source.url);
  selectAzureDevOpsRemote(repoRoot, pullRequest);
  const [metadata, reviewComments] = await Promise.all([
    readPullRequestMetadata(repoRoot, pullRequest),
    readAzureDevOpsComments(repoRoot, pullRequest),
  ]);
  const refs = await resolveAzureDevOpsContentRefs(repoRoot, pullRequest, metadata);
  if (!refs) {
    throw new Error(
      `Could not fetch Azure DevOps pull request #${pullRequest.number} refs. Check that this repository's remote can access the pull request.`,
    );
  }
  const files = parseNameStatusFiles(
    await git(repoRoot, ['diff', '--name-status', '-r', '-z', '-M', refs.base, refs.head]),
  );
  const patches = await readAzureDevOpsPatches(
    repoRoot,
    refs.base,
    refs.head,
    files.map((file) => file.filename),
  );
  const reviewFiles = files.map((file) => ({
    file,
    oldPath: file.previous_filename || file.filename,
    patch: patches.get(file.filename) || createPatchFromPullRequestFile(file),
  }));
  const [oldFiles, newFiles] = await Promise.all([
    readGitFiles(
      repoRoot,
      refs.base,
      reviewFiles.map(({ oldPath }) => oldPath),
      { refScopedEmptyCacheKey: true },
    ),
    readGitFiles(
      repoRoot,
      refs.head,
      reviewFiles.map(({ file }) => file.filename),
      { refScopedEmptyCacheKey: true },
    ),
  ]);
  /** @type {Array<ChangedFile>} */
  const changedFiles = reviewFiles.map(({ file, oldPath, patch }) => {
    const oldFile = oldFiles.get(oldPath);
    const newFile = newFiles.get(file.filename);
    const section = createPullRequestSection(pullRequest, file, patch, oldFile, newFile);
    return {
      fingerprint: getFingerprint(
        [
          metadata.lastMergeSourceCommit?.commitId || '',
          file.status,
          file.previous_filename || '',
          file.filename,
          patch,
        ].join('\n'),
      ),
      oldPath: file.previous_filename,
      path: file.filename,
      sections: [section],
      status:
        file.status === 'added'
          ? 'added'
          : file.status === 'removed'
            ? 'deleted'
            : file.status === 'renamed'
              ? 'renamed'
              : 'modified',
    };
  });
  return {
    files: changedFiles.sort((left, right) => left.path.localeCompare(right.path)),
    generatedAt: Date.now(),
    launchPath,
    reviewComments,
    root: repoRoot,
    source: createAzureDevOpsSource(pullRequest, metadata),
  };
};

/** @param {any} commit @param {'base' | 'pull-request'} scope */
const normalizeAzureDevOpsCommit = (commit, scope) =>
  normalizeGitHubCommit(
    {
      author: { avatar_url: undefined },
      commit: {
        author: {
          date: commit.author?.date || commit.committer?.date,
          name: commit.author?.name || commit.committer?.name,
        },
        message: commit.comment || commit.commentTruncated,
      },
      parents: (commit.parents || []).map((parent) => ({
        sha: typeof parent === 'string' ? parent : parent.commitId || parent.sha,
      })),
      sha: commit.commitId || commit.sha,
    },
    scope,
  );

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source @param {number} [limit] */
const listAzureDevOpsHistory = async (launchPath, source, limit = 200) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseAzureDevOpsPullRequestUrl(source.url);
  const metadata = await readPullRequestMetadata(repoRoot, pullRequest);
  const commits = await readPullRequestCommits(repoRoot, pullRequest);
  let baseCommits = [];
  const refs = await resolveAzureDevOpsContentRefs(repoRoot, pullRequest, metadata).catch(
    () => null,
  );
  if (refs?.base) {
    const raw = await gitOrEmpty(repoRoot, [
      'log',
      `--max-count=${limit}`,
      '--format=%H%x00%an%x00%aI%x00%s%x00%P',
      refs.base,
    ]);
    baseCommits = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, name, date, subject, parents] = line.split('\0');
        return normalizeGitHubCommit(
          {
            commit: { author: { date, name }, message: subject },
            parents: (parents || '')
              .split(' ')
              .filter(Boolean)
              .map((parent) => ({ sha: parent })),
            sha,
          },
          'base',
        );
      })
      .filter(Boolean);
  }
  return {
    entries: [
      ...commits
        .map((commit) => normalizeAzureDevOpsCommit(commit, 'pull-request'))
        .filter(Boolean)
        .reverse(),
      ...baseCommits,
    ],
    root: repoRoot,
  };
};

/** @param {PullRequestReviewComment} comment */
const createAzureDevOpsThreadContext = (comment) => {
  const filePath = `/${comment.filePath.replace(/^\/+/, '')}`;
  if (comment.anchor === 'file' || comment.lineNumber == null || comment.side == null) {
    return { filePath };
  }

  const end = { line: comment.lineNumber, offset: 1 };
  const start =
    typeof comment.startLineNumber === 'number'
      ? { line: comment.startLineNumber, offset: 1 }
      : end;
  return comment.side === 'deletions'
    ? { filePath, leftFileEnd: end, leftFileStart: start }
    : { filePath, rightFileEnd: end, rightFileStart: start };
};

/** @param {unknown} event */
const getAzureDevOpsVote = (event) => {
  if (event === 'APPROVE') {
    return 10;
  }
  if (event === 'REQUEST_CHANGES') {
    return -10;
  }
  if (event === 'COMMENT') {
    return 0;
  }
  throw new Error(`Azure DevOps pull request reviews do not support ${String(event)}.`);
};

/** @param {string} repoRoot @param {ReturnType<typeof parseAzureDevOpsPullRequestUrl>} pullRequest */
const readAuthenticatedUserId = async (repoRoot, pullRequest) => {
  const payload = await azureApi(
    repoRoot,
    pullRequest,
    `${pullRequest.organizationUrl}/_apis/connectionData?api-version=${AZURE_DEVOPS_API_VERSION}`,
  );
  const id = payload?.authenticatedUser?.id || payload?.authenticatedUser?.descriptor;
  if (!id) {
    throw new Error('Azure DevOps did not return the signed-in user needed to vote on a review.');
  }
  return id;
};

/** @param {string} launchPath @param {any} request */
const submitAzureDevOpsComment = async (launchPath, request) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseAzureDevOpsPullRequestUrl(request.source.url);
  selectAzureDevOpsRemote(repoRoot, pullRequest);
  if (request.comment.threadId) {
    const comment = await azureApi(
      repoRoot,
      pullRequest,
      pullRequestEndpoint(
        pullRequest,
        `/threads/${encodeURIComponent(request.comment.threadId)}/comments`,
      ),
      'POST',
      { content: request.comment.body, parentCommentId: 0 },
    );
    const normalized = normalizeSubmittedAzureDevOpsReviewComment(
      comment,
      request.comment,
      { id: request.comment.threadId, threadContext: { filePath: `/${request.comment.filePath}` } },
      pullRequest.url,
    );
    if (!normalized) {
      throw new Error('Azure DevOps accepted the reply but did not return comment metadata.');
    }
    return normalized;
  }

  const thread = await azureApi(
    repoRoot,
    pullRequest,
    pullRequestEndpoint(pullRequest, '/threads'),
    'POST',
    {
      comments: [{ commentType: 1, content: request.comment.body, parentCommentId: 0 }],
      status: 1,
      threadContext: createAzureDevOpsThreadContext(request.comment),
    },
  );
  const normalized = normalizeSubmittedAzureDevOpsReviewComment(
    thread.comments?.[0],
    request.comment,
    thread,
    pullRequest.url,
  );
  if (!normalized) {
    throw new Error('Azure DevOps accepted the comment but did not return comment metadata.');
  }
  return normalized;
};

/** @param {string} launchPath @param {any} request */
const submitAzureDevOpsReview = async (launchPath, request) => {
  const vote = getAzureDevOpsVote(request.event);
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseAzureDevOpsPullRequestUrl(request.source.url);
  selectAzureDevOpsRemote(repoRoot, pullRequest);
  for (const comment of request.comments) {
    await azureApi(repoRoot, pullRequest, pullRequestEndpoint(pullRequest, '/threads'), 'POST', {
      comments: [{ commentType: 1, content: comment.body, parentCommentId: 0 }],
      status: 1,
      threadContext: createAzureDevOpsThreadContext(comment),
    });
  }
  if (typeof request.body === 'string' && request.body.trim()) {
    await azureApi(repoRoot, pullRequest, pullRequestEndpoint(pullRequest, '/threads'), 'POST', {
      comments: [{ commentType: 1, content: request.body.trim(), parentCommentId: 0 }],
      status: 1,
    });
  }
  if (vote === 0) {
    return;
  }
  const userId = await readAuthenticatedUserId(repoRoot, pullRequest);
  await azureApi(
    repoRoot,
    pullRequest,
    pullRequestEndpoint(pullRequest, `/reviewers/${encodeURIComponent(userId)}`),
    'PUT',
    { id: userId, vote },
  );
};

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source @param {string} requestedPath */
const readAzureDevOpsImageContent = async (launchPath, source, requestedPath) => {
  try {
    const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
    const path = validateRepositoryPath(requestedPath);
    const pullRequest = parseAzureDevOpsPullRequestUrl(source.url);
    const metadata = await readPullRequestMetadata(repoRoot, pullRequest);
    const refs = await resolveAzureDevOpsContentRefs(repoRoot, pullRequest, metadata);
    if (!refs) {
      throw new Error('File is not part of this pull request.');
    }
    const files = parseNameStatusFiles(
      await git(repoRoot, ['diff', '--name-status', '-r', '-z', '-M', refs.base, refs.head]),
    );
    const file = files.find((candidate) => candidate.filename === path);
    if (!file) {
      throw new Error('File is not part of this pull request.');
    }
    const [oldImage, newImage] = await Promise.all([
      readGitImageFile(repoRoot, refs.base, file.previous_filename || file.filename),
      readGitImageFile(repoRoot, refs.head, file.filename),
    ]);
    return oldImage || newImage
      ? { ...(newImage ? { newImage } : {}), ...(oldImage ? { oldImage } : {}), status: 'ready' }
      : { reason: 'Codiff could not load either side of this image.', status: 'unavailable' };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : 'Codiff could not load this image.',
      status: 'unavailable',
    };
  }
};

module.exports = {
  AZ_NOT_FOUND_CODE,
  createAzureDevOpsFetchRefspecs,
  createAzureDevOpsThreadContext,
  getAzCommand,
  listAzureDevOpsHistory,
  normalizeAzureDevOpsReviewComment,
  parseAzureDevOpsPullRequestUrl,
  readAzureDevOpsImageContent,
  readAzureDevOpsPullRequestState,
  submitAzureDevOpsComment,
  submitAzureDevOpsReview,
};
