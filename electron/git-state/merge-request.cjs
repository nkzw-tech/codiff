// @ts-check

const {
  getCurrentCommandSignal,
  git,
  gitOrEmpty,
  readGitImageFile,
  validateRepositoryPath,
} = require('./common.cjs');
const { readGitFiles } = require('./git-files.cjs');
const {
  createGitLabPosition,
  createGitLabReviewMutations,
  resolveGitLabCommentTarget,
} = require('./gitlab-review-mutations.cjs');
const { createGlabGitLabTransport } = require('./glab-gitlab-transport.cjs');
const { loadGitLabHistory } = require('../gitlab-history-bridge.cjs');
const { normalizeGitHubCommit } = require('./pull-request.cjs');
const {
  canHydrateArtifactFile,
  createPullRequestSection,
  isBinaryDiffPatch,
  rangeArtifactToPullRequestFiles,
} = require('./review-range-sections.cjs');
const { parseReviewUrl, readReviewRemotes } = require('../review-source.cjs');

/**
 * @typedef {import('../../core/types.ts').PullRequestReviewComment} PullRequestReviewComment
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../../core/lib/review-artifacts.ts').ArtifactFile} ArtifactFile
 */

/**
 * Latest initial provider snapshots, keyed by local root and MR URL.
 * @type {Map<string, {headSha?: string, metadata: any, range: import('../../core/lib/review-artifacts.ts').RangeArtifact}>}
 */
const mergeRequestHydrationSnapshots = new Map();
const MAX_MERGE_REQUEST_HYDRATION_SNAPSHOTS = 8;

/** @type {Map<string, Promise<import('../../core/types.ts').DiffSectionsContentResult>>} */
const mergeRequestBulkHydrations = new Map();
const MAX_MERGE_REQUEST_BULK_HYDRATIONS = 8;

/** @param {string} value */
const parseGitLabMergeRequestUrl = (value) => {
  const parsed = parseReviewUrl(value);
  if (!parsed || parsed.provider !== 'gitlab') {
    throw new Error('Codiff expected a GitLab merge request URL.');
  }
  return parsed;
};

/** @param {string} projectPath */
const encodeProjectPath = (projectPath) => encodeURIComponent(projectPath);

/** @param {{number: number; projectPath: string}} mergeRequest */
const mergeRequestEndpoint = (mergeRequest, suffix = '') =>
  `projects/${encodeProjectPath(mergeRequest.projectPath)}/merge_requests/${
    mergeRequest.number
  }${suffix}`;

/** @param {{number: number; projectPath: string}} mergeRequest @param {string} threadId */
const getGitLabDiscussionReplyEndpoint = (mergeRequest, threadId) =>
  mergeRequestEndpoint(mergeRequest, `/discussions/${encodeURIComponent(threadId)}/notes`);

/** @param {string} repoRoot @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest */
const selectMergeRequestRemote = (repoRoot, mergeRequest) => {
  const remote = readReviewRemotes(repoRoot)
    .filter(
      (candidate) =>
        candidate.host === mergeRequest.host &&
        candidate.projectPath.toLowerCase() === mergeRequest.projectPath.toLowerCase(),
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
      `Merge request ${mergeRequest.projectPath}!${mergeRequest.number} does not match a GitLab remote in this repository.`,
    );
  }
  return remote;
};

/** Provider transport backed by the authenticated `glab` process owned by Electron. */
const createMergeRequestTransport = (repoRoot, mergeRequest) =>
  createGlabGitLabTransport({ hostname: mergeRequest.host, repoRoot });

/**
 * @param {string} repoRoot
 * @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest
 * @param {{request: (request: any) => Promise<any>}} [transport]
 */
const readMergeRequestMetadata = (repoRoot, mergeRequest, transport) =>
  (transport || createMergeRequestTransport(repoRoot, mergeRequest)).request({
    path: mergeRequestEndpoint(mergeRequest),
  });

/**
 * @param {string} repoRoot
 * @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const readMergeRequestDiffs = (repoRoot, mergeRequest, transport) =>
  (transport || createMergeRequestTransport(repoRoot, mergeRequest)).requestPages({
    path: mergeRequestEndpoint(mergeRequest, '/diffs'),
    query: { per_page: 100 },
  });

/** @param {string} repoRoot @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest */
const mergeRequestHydrationSnapshotKey = (repoRoot, mergeRequest) =>
  `${repoRoot}:${mergeRequest.url}`;

/**
 * @param {string} repoRoot
 * @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest
 * @param {{headSha?: string, metadata: any, range: import('../../core/lib/review-artifacts.ts').RangeArtifact}} snapshot
 */
const rememberMergeRequestHydrationSnapshot = (repoRoot, mergeRequest, snapshot) => {
  const key = mergeRequestHydrationSnapshotKey(repoRoot, mergeRequest);
  mergeRequestHydrationSnapshots.delete(key);
  mergeRequestHydrationSnapshots.set(key, snapshot);
  while (mergeRequestHydrationSnapshots.size > MAX_MERGE_REQUEST_HYDRATION_SNAPSHOTS) {
    mergeRequestHydrationSnapshots.delete(mergeRequestHydrationSnapshots.keys().next().value);
  }
};

/**
 * @param {string} repoRoot
 * @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest
 * @param {{expectedHeadSha?: string, forceRefresh?: boolean, signal?: AbortSignal}} [options]
 */
const readMergeRequestHydrationSnapshot = async (repoRoot, mergeRequest, options = {}) => {
  const key = mergeRequestHydrationSnapshotKey(repoRoot, mergeRequest);
  const cached = mergeRequestHydrationSnapshots.get(key);
  if (
    !options.forceRefresh &&
    options.expectedHeadSha &&
    cached?.headSha === options.expectedHeadSha
  ) {
    return cached;
  }
  const transport = createMergeRequestTransport(repoRoot, mergeRequest);
  const [gitlab, metadata] = await Promise.all([
    loadGitLabHistory(),
    readMergeRequestMetadata(repoRoot, mergeRequest, transport),
  ]);
  const baseSha = metadata.diff_refs?.base_sha;
  const headSha = metadata.diff_refs?.head_sha || metadata.sha;
  if (!baseSha || !headSha) {
    throw new Error('GitLab did not return complete merge request range coordinates.');
  }
  if (options.expectedHeadSha && headSha !== options.expectedHeadSha) {
    throw new Error('The merge request head changed. Refresh before loading exact file contents.');
  }
  const project = {
    host: mergeRequest.host,
    project: mergeRequest.projectPath,
    provider: /** @type {'gitlab'} */ ('gitlab'),
  };
  const artifactSource = gitlab.createGitLabArtifactSource({
    project,
    projectPath: mergeRequest.projectPath,
    transport,
  });
  const { range } = await artifactSource.readStackAndRange(
    { requestedBaseSha: baseSha, headSha },
    options.signal ?? getCurrentCommandSignal() ?? new AbortController().signal,
  );
  const snapshot = { headSha, metadata, range };
  rememberMergeRequestHydrationSnapshot(repoRoot, mergeRequest, snapshot);
  return snapshot;
};

/** @param {any} note @param {string} url @param {string} [threadId] */
const normalizeGitLabReviewComment = (note, url, threadId) => {
  const position = note.position || note.original_position;
  const isFilePosition = position?.position_type === 'file';
  const lineNumber = position?.new_line ?? position?.old_line;
  const filePath = position?.new_path || position?.old_path;
  if (!note.body || !filePath || (!isFilePosition && typeof lineNumber !== 'number')) {
    return null;
  }
  const side = position?.new_line != null ? 'additions' : 'deletions';
  const range = position.line_range;
  const start = range?.start;
  const end = range?.end;
  return {
    author: {
      avatarUrl: note.author?.avatar_url,
      login: note.author?.username || note.author?.name || 'GitLab user',
      url: note.author?.web_url,
    },
    body: note.body,
    filePath,
    id: `gitlab:${note.id}`,
    ...(!note.position ? { isOutdated: true } : {}),
    ...(isFilePosition
      ? { anchor: 'file' }
      : {
          lineNumber: end?.new_line ?? end?.old_line ?? lineNumber,
          side: end?.type === 'old' ? 'deletions' : side,
        }),
    ...(start && (start.new_line ?? start.old_line) !== (end?.new_line ?? end?.old_line)
      ? {
          startLineNumber: start.new_line ?? start.old_line,
          startSide: start.type === 'old' ? 'deletions' : 'additions',
        }
      : {}),
    ...(threadId ? { threadId } : {}),
    submittedAt: note.created_at,
    url: `${url}#note_${note.id}`,
  };
};

/** @param {any} note @param {PullRequestReviewComment} submittedComment @param {string} url @param {string} [threadId] */
const normalizeSubmittedGitLabReviewComment = (note, submittedComment, url, threadId) => {
  const normalized = normalizeGitLabReviewComment(note, url, threadId || submittedComment.threadId);
  if (normalized) {
    return normalized;
  }
  if (!note?.body || typeof note.id !== 'number') {
    return null;
  }
  return {
    ...submittedComment,
    author: {
      avatarUrl: note.author?.avatar_url,
      login: note.author?.username || note.author?.name || 'GitLab user',
      url: note.author?.web_url,
    },
    body: note.body,
    id: `gitlab:${note.id}`,
    submittedAt: note.created_at,
    url: `${url}#note_${note.id}`,
  };
};

/**
 * @param {string} repoRoot
 * @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const readMergeRequestComments = async (repoRoot, mergeRequest, transport) => {
  const discussions = await (
    transport || createMergeRequestTransport(repoRoot, mergeRequest)
  ).requestPages({
    path: mergeRequestEndpoint(mergeRequest, '/discussions'),
    query: { per_page: 100 },
  });
  return discussions
    .flatMap((discussion) =>
      (discussion.notes || []).map((note) => ({ note, threadId: discussion.id })),
    )
    .filter(({ note }) => !note.system && !note.resolved)
    .map(({ note, threadId }) => normalizeGitLabReviewComment(note, mergeRequest.url, threadId))
    .filter(Boolean);
};

/** @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest @param {any} metadata @returns {Extract<ReviewSource, {type: 'pull-request'}>} */
const createMergeRequestSource = (mergeRequest, metadata) => ({
  ...(metadata.author?.username || metadata.author?.name
    ? {
        author: {
          avatarUrl: metadata.author.avatar_url,
          login: metadata.author.username || metadata.author.name,
          url: metadata.author.web_url,
        },
      }
    : {}),
  ...(typeof metadata.description === 'string' && metadata.description.trim()
    ? { description: metadata.description.trim() }
    : {}),
  headSha: metadata.diff_refs?.head_sha || metadata.sha,
  host: mergeRequest.host,
  number: mergeRequest.number,
  projectPath: mergeRequest.projectPath,
  provider: 'gitlab',
  ...(metadata.target_branch ? { targetBranch: metadata.target_branch } : {}),
  title: metadata.title,
  type: 'pull-request',
  url: metadata.web_url || mergeRequest.url,
});

/** @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest @param {any} metadata */
const createMergeRequestFetchRefspecs = (mergeRequest, metadata) => [
  `+refs/merge-requests/${mergeRequest.number}/head:refs/codiff/merge-requests/${mergeRequest.number}/head`,
  ...(metadata.target_branch
    ? [
        `+refs/heads/${metadata.target_branch}:refs/codiff/merge-requests/${mergeRequest.number}/base`,
      ]
    : []),
];

/** @param {string} repoRoot @param {any} remote @param {any} mergeRequest @param {any} metadata */
const fetchMergeRequestRefs = (repoRoot, remote, mergeRequest, metadata) =>
  git(repoRoot, [
    'fetch',
    '--no-tags',
    remote.name,
    ...createMergeRequestFetchRefspecs(mergeRequest, metadata),
  ]);

/** @param {string} repoRoot @param {any} mergeRequest @param {any} metadata */
const resolveMergeRequestContentRefs = async (repoRoot, mergeRequest, metadata) => {
  const head = `refs/codiff/merge-requests/${mergeRequest.number}/head`;
  const base = `refs/codiff/merge-requests/${mergeRequest.number}/base`;
  const localHead = (await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', head])).trim();
  const localBase = (await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', base])).trim();
  if (!localHead || !localBase || (metadata.sha && localHead !== metadata.sha)) {
    await fetchMergeRequestRefs(
      repoRoot,
      selectMergeRequestRemote(repoRoot, mergeRequest),
      mergeRequest,
      metadata,
    );
  }
  const expectedHead = metadata.diff_refs?.head_sha || metadata.sha;
  const resolvedHead = (
    await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', head])
  ).trim();
  const resolvedBase = (
    await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', base])
  ).trim();
  if (!resolvedHead || !resolvedBase || (expectedHead && resolvedHead !== expectedHead)) {
    return null;
  }
  const metadataBase = metadata.diff_refs?.base_sha;
  if (
    metadataBase &&
    (await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${metadataBase}^{commit}`]))
  ) {
    return { base: metadataBase, head: resolvedHead };
  }
  const mergeBase = (await gitOrEmpty(repoRoot, ['merge-base', base, head])).trim();
  return mergeBase ? { base: mergeBase, head: resolvedHead } : null;
};

/**
 * Hydrate eligible files from one immutable MR range with one pair of batched
 * Git object reads.
 *
 * @param {string} repoRoot
 * @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest
 * @param {any} metadata
 * @param {import('../../core/lib/review-artifacts.ts').RangeArtifact} range
 * @param {ReadonlyArray<ArtifactFile>} files
 * @param {{force?: boolean}} [options]
 */
const hydrateMergeRequestSections = async (
  repoRoot,
  mergeRequest,
  metadata,
  range,
  files,
  options = {},
) => {
  const candidates = files.filter(
    (file) => canHydrateArtifactFile(file) && !isBinaryDiffPatch(file.patch || ''),
  );
  const refs = await resolveMergeRequestContentRefs(repoRoot, mergeRequest, metadata).catch(
    () => null,
  );
  if (!refs) {
    return candidates.map((file) => ({
      path: file.path,
      section: createPullRequestSection(mergeRequest, file, undefined, undefined, {
        base: range.baseSha,
        contentAttempted: true,
        contentError:
          'Codiff could not resolve the immutable merge request range. Retry exact content loading.',
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
        mergeRequest,
        file,
        oldFiles.get(oldPath),
        newFiles.get(file.path),
        { base: range.baseSha, head: range.headSha },
      ),
    };
  });
};

/**
 * @param {string} repoRoot
 * @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest
 * @param {any} metadata
 * @param {import('../../core/lib/review-artifacts.ts').RangeArtifact} range
 * @param {ArtifactFile} file
 * @param {{force?: boolean}} [options]
 */
const hydrateMergeRequestSection = async (
  repoRoot,
  mergeRequest,
  metadata,
  range,
  file,
  options = {},
) => {
  const [result] = await hydrateMergeRequestSections(
    repoRoot,
    mergeRequest,
    metadata,
    range,
    [file],
    options,
  );
  return (
    result?.section ??
    createPullRequestSection(mergeRequest, file, undefined, undefined, {
      base: range.baseSha,
      head: range.headSha,
    })
  );
};

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source */
const readMergeRequestSectionsContent = async (launchPath, source) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const mergeRequest = parseGitLabMergeRequestUrl(source.url);
  selectMergeRequestRemote(repoRoot, mergeRequest);
  const { metadata, range } = await readMergeRequestHydrationSnapshot(repoRoot, mergeRequest, {
    expectedHeadSha: source.headSha,
  });
  const key = `${repoRoot}:${mergeRequest.url}:${range.headSha}`;
  const existing = mergeRequestBulkHydrations.get(key);
  if (existing) {
    return existing;
  }

  const hydration = hydrateMergeRequestSections(
    repoRoot,
    mergeRequest,
    metadata,
    range,
    range.files,
  )
    .then((sections) => ({ headSha: range.headSha, sections }))
    .catch((error) => {
      mergeRequestBulkHydrations.delete(key);
      throw error;
    });
  mergeRequestBulkHydrations.set(key, hydration);
  while (mergeRequestBulkHydrations.size > MAX_MERGE_REQUEST_BULK_HYDRATIONS) {
    mergeRequestBulkHydrations.delete(mergeRequestBulkHydrations.keys().next().value);
  }
  return hydration;
};

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source */
const readMergeRequestState = async (launchPath, source) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const mergeRequest = parseGitLabMergeRequestUrl(source.url);
  selectMergeRequestRemote(repoRoot, mergeRequest);
  const { metadata, range } = await readMergeRequestHydrationSnapshot(repoRoot, mergeRequest, {
    forceRefresh: true,
  });
  const files = rangeArtifactToPullRequestFiles(range, mergeRequest.number, {
    deferContents: true,
  });
  return {
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    generatedAt: Date.now(),
    launchPath,
    reviewCommentsLoadState: 'not-loaded',
    root: repoRoot,
    source: createMergeRequestSource(mergeRequest, metadata),
  };
};

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source */
const readMergeRequestReviewComments = async (launchPath, source) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const mergeRequest = parseGitLabMergeRequestUrl(source.url);
  selectMergeRequestRemote(repoRoot, mergeRequest);
  const transport = createMergeRequestTransport(repoRoot, mergeRequest);
  const comments = await readMergeRequestComments(repoRoot, mergeRequest, transport);
  const metadata = await readMergeRequestMetadata(repoRoot, mergeRequest, transport);
  const headSha = metadata.diff_refs?.head_sha || metadata.sha;
  if (source.headSha && headSha !== source.headSha) {
    throw new Error('The merge request head changed. Refresh before loading review comments.');
  }
  return comments;
};

/**
 * Load exact local contents for one merge-request file when explicitly retried.
 * @param {string} launchPath
 * @param {Extract<ReviewSource, {type: 'pull-request'}>} source
 * @param {string} requestedPath
 */
const readMergeRequestSectionContent = async (launchPath, source, requestedPath, options = {}) => {
  const path = validateRepositoryPath(requestedPath);
  const mergeRequest = parseGitLabMergeRequestUrl(source.url);
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  selectMergeRequestRemote(repoRoot, mergeRequest);
  const { metadata, range } = await readMergeRequestHydrationSnapshot(repoRoot, mergeRequest, {
    expectedHeadSha: source.headSha,
  });
  const file = range.files.find((candidate) => candidate.path === path);
  if (!file) {
    throw new Error('File is not part of this merge request.');
  }
  return hydrateMergeRequestSection(repoRoot, mergeRequest, metadata, range, file, options);
};

/** @param {any} commit @param {'base' | 'pull-request'} scope */
const normalizeGitLabCommit = (commit, scope) =>
  normalizeGitHubCommit(
    {
      commit: {
        author: {
          date: commit.committed_date || commit.authored_date,
          name: commit.author_name,
        },
        message: commit.message || commit.title,
      },
      parents: (commit.parent_ids || []).map((sha) => ({ sha })),
      sha: commit.id,
    },
    scope,
  );

/**
 * @param {string} repoRoot
 * @param {any} mergeRequest
 * @param {string} ref
 * @param {number} limit
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const readRepositoryCommits = async (repoRoot, mergeRequest, ref, limit, transport) => {
  const client = transport || createMergeRequestTransport(repoRoot, mergeRequest);
  const commits = [];
  for (let page = 1; commits.length < limit; page += 1) {
    const perPage = Math.min(limit - commits.length, 100);
    const pageCommits = await client.request({
      path: `projects/${encodeProjectPath(mergeRequest.projectPath)}/repository/commits`,
      query: { page, per_page: perPage, ref_name: ref },
    });
    if (!Array.isArray(pageCommits) || pageCommits.length === 0) {
      break;
    }
    commits.push(...pageCommits);
    if (pageCommits.length < perPage) {
      break;
    }
  }
  return commits;
};

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source @param {number} [limit] */
const listMergeRequestHistory = async (launchPath, source, limit = 200) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const mergeRequest = parseGitLabMergeRequestUrl(source.url);
  const transport = createMergeRequestTransport(repoRoot, mergeRequest);
  const metadata = await readMergeRequestMetadata(repoRoot, mergeRequest, transport);
  const commits = await transport.requestPages({
    path: mergeRequestEndpoint(mergeRequest, '/commits'),
    query: { per_page: 100 },
  });
  const baseCommits = metadata.target_branch
    ? await readRepositoryCommits(repoRoot, mergeRequest, metadata.target_branch, limit, transport)
    : [];
  return {
    entries: [
      ...commits
        .map((commit) => normalizeGitLabCommit(commit, 'pull-request'))
        .filter(Boolean)
        .reverse(),
      ...baseCommits.map((commit) => normalizeGitLabCommit(commit, 'base')).filter(Boolean),
    ],
    root: repoRoot,
  };
};

const { submitMergeRequestComment, submitMergeRequestReview } = createGitLabReviewMutations({
  createTransport: createMergeRequestTransport,
  getDiscussionReplyEndpoint: getGitLabDiscussionReplyEndpoint,
  mergeRequestEndpoint,
  normalizeSubmittedGitLabReviewComment,
  parseGitLabMergeRequestUrl,
  readMergeRequestDiffs,
  readMergeRequestMetadata,
  selectMergeRequestRemote,
});

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source @param {string} requestedPath */
const readMergeRequestImageContent = async (launchPath, source, requestedPath) => {
  try {
    const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
    const path = validateRepositoryPath(requestedPath);
    const mergeRequest = parseGitLabMergeRequestUrl(source.url);
    const { metadata, range } = await readMergeRequestHydrationSnapshot(repoRoot, mergeRequest, {
      expectedHeadSha: source.headSha,
    });
    const file = range.files.find((candidate) => candidate.path === path);
    if (!file) {
      throw new Error('File is not part of this merge request.');
    }
    const refs = await resolveMergeRequestContentRefs(repoRoot, mergeRequest, metadata);
    const [oldImage, newImage] = await Promise.all([
      refs ? readGitImageFile(repoRoot, refs.base, file.oldPath || file.path) : undefined,
      refs ? readGitImageFile(repoRoot, refs.head, file.path) : undefined,
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
  createGitLabPosition,
  createMergeRequestFetchRefspecs,
  createMergeRequestSource,
  listMergeRequestHistory,
  normalizeGitLabReviewComment,
  parseGitLabMergeRequestUrl,
  resolveGitLabCommentTarget,
  readMergeRequestImageContent,
  readMergeRequestReviewComments,
  readMergeRequestSectionContent,
  readMergeRequestSectionsContent,
  readMergeRequestState,
  submitMergeRequestComment,
  submitMergeRequestReview,
};
