// @ts-check

// Canonical Electron GitLab review boundary.

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
const { createGlabGitLabTransport } = require('./glab-gitlab-transport.cjs');
const {
  getGitLabProviderArtifactRun,
  gitlabArtifactProject,
  readGitLabFileBlobArtifact,
  readGitLabFileBlobArtifacts,
} = require('./provider-artifact-sources.cjs');
const { decodeHtmlEntities } = require('../html-entities.cjs');
const {
  createGitLabPosition: createGitLabMutationPosition,
  createGitLabReviewMutations,
  recoverGitLabVersionId,
  resolveGitLabReviewTargets,
} = require('./gitlab-review-mutations.cjs');
const {
  loadGitLabHistory,
  loadGitLabReviewDiscussions,
  loadGitLabReviewVersionTimeline,
} = require('../gitlab-history-bridge.cjs');
const {
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
 * Latest initial provider snapshots, keyed by local root and MR URL. A
 * deferred hydration only reuses a snapshot whose immutable source head is
 * still the exact review source requested by the renderer.
 * @type {Map<string, {headSha?: string, metadata: any, range: import('../../core/lib/review-artifacts.ts').RangeArtifact}>}
 */
const mergeRequestHydrationSnapshots = new Map();
const MAX_MERGE_REQUEST_HYDRATION_SNAPSHOTS = 8;
const MAX_REVIEW_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_REVIEW_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_REVIEW_COMMENTS_BYTES = 8 * 1024 * 1024;
const MAX_REVIEW_VERSIONS_BYTES = 2 * 1024 * 1024;

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

/** @param {string} repoRoot @param {{host: string}} mergeRequest */
const createMergeRequestTransport = (repoRoot, mergeRequest) =>
  createGlabGitLabTransport({ hostname: mergeRequest.host, repoRoot });

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

/**
 * @param {string} repoRoot
 * @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const readMergeRequestMetadata = async (repoRoot, mergeRequest, transport) => {
  try {
    return await (transport || createMergeRequestTransport(repoRoot, mergeRequest)).request({
      maxBytes: MAX_REVIEW_METADATA_BYTES,
      path: mergeRequestEndpoint(mergeRequest),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'ProviderOutputLimitError') {
      throw new Error(
        `GitLab merge request metadata exceeds the ${formatBytes(MAX_REVIEW_METADATA_BYTES)} limit, so Codiff cannot open this review.`,
      );
    }
    throw error;
  }
};

/**
 * @param {string} repoRoot
 * @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest
 * @param {string} ref
 * @param {string} path
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const readGitLabImageFile = async (repoRoot, mergeRequest, ref, path, transport) => {
  if (!getImageMimeType(path)) {
    throw new Error('Unsupported image file type.');
  }

  const blob = await readGitLabFileBlobArtifact(
    repoRoot,
    mergeRequest,
    { maxBytes: IMAGE_FILE_LIMIT, path, ref },
    transport || createMergeRequestTransport(repoRoot, mergeRequest),
  );
  if (!blob) {
    return undefined;
  }
  const buffer = Buffer.from(blob.bytes);
  if (buffer.length > IMAGE_FILE_LIMIT) {
    throw new Error(`Image is ${formatBytes(buffer.length)}, so Codiff skipped rendering it.`);
  }

  return bufferToImageRevision(path, buffer);
};

/**
 * Read one immutable GitLab range through the canonical provider Artifact
 * Source. Mutation target validation uses the same normalized files as review
 * rendering instead of acquiring a second merge-request diff payload.
 * @param {string} repoRoot
 * @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest
 * @param {{diff_refs?: {base_sha?: string, head_sha?: string}, sha?: string}} metadata
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const readMergeRequestRange = async (repoRoot, mergeRequest, metadata, transport) => {
  const baseSha = metadata.diff_refs?.base_sha;
  const headSha = metadata.diff_refs?.head_sha || metadata.sha;
  if (!baseSha || !headSha) {
    throw new Error('GitLab did not return complete merge request range coordinates.');
  }
  const signal = getCommandActionSignal() || new AbortController().signal;
  const run = await getGitLabProviderArtifactRun(repoRoot, mergeRequest, { signal }, transport);
  return (await run.readStackAndRange({ headSha: headSha, requestedBaseSha: baseSha }, signal))
    .range;
};

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
 * @param {{expectedHeadSha?: string, forceRefresh?: boolean}} [options]
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
  const project = gitlabArtifactProject(mergeRequest);
  let range;
  try {
    range = await readMergeRequestRange(repoRoot, mergeRequest, metadata, transport);
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ProviderOutputLimitError') {
      throw error;
    }
    range = gitlab.createGitLabRangeArtifact({
      baseSha,
      diffs: [],
      headSha,
      incompleteReason: `GitLab repository comparison exceeds the ${formatBytes(MAX_REVIEW_RANGE_BYTES)} limit, so Codiff could not load a complete review diff.`,
      project,
      truncated: true,
    });
  }
  const snapshot = { headSha, metadata, range };
  rememberMergeRequestHydrationSnapshot(repoRoot, mergeRequest, snapshot);
  return snapshot;
};

/**
 * @param {string} repoRoot
 * @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const readMergeRequestVersions = (repoRoot, mergeRequest, transport) =>
  (transport || createMergeRequestTransport(repoRoot, mergeRequest)).requestPages({
    maxBytes: MAX_REVIEW_VERSIONS_BYTES,
    path: mergeRequestEndpoint(mergeRequest, '/versions'),
    query: { per_page: 100 },
  });

/**
 * Mutation validation needs the provider's fresh merge-request patch rather
 * than a render hydration snapshot.
 * @param {string} repoRoot
 * @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const readMergeRequestDiffs = (repoRoot, mergeRequest, transport) =>
  (transport || createMergeRequestTransport(repoRoot, mergeRequest)).requestPages({
    maxBytes: MAX_REVIEW_RANGE_BYTES,
    path: mergeRequestEndpoint(mergeRequest, '/diffs'),
    query: { per_page: 100 },
  });

/**
 * @param {any} note
 * @param {string} url
 * @param {{isOutdated?: boolean, isResolved?: boolean, position?: any, threadId?: string, versions?: ReadonlyArray<any>}} [thread]
 */
const normalizeGitLabReviewComment = (note, url, thread) => {
  const position = note.position || note.original_position || thread?.position;
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
  const positionIdentity =
    typeof position?.base_sha === 'string' &&
    typeof position?.start_sha === 'string' &&
    typeof position?.head_sha === 'string'
      ? {
          baseSha: position.base_sha,
          headSha: position.head_sha,
          startSha: position.start_sha,
        }
      : null;
  const matchingVersions = positionIdentity
    ? (thread?.versions || []).filter(
        (version) =>
          version.base_commit_sha === positionIdentity.baseSha &&
          version.head_commit_sha === positionIdentity.headSha &&
          version.start_commit_sha === positionIdentity.startSha,
      )
    : [];
  const version = matchingVersions.length === 1 ? matchingVersions[0] : null;
  const versionIndex = version ? (thread?.versions || []).indexOf(version) : -1;
  const versionLabel =
    versionIndex >= 0 ? `v${(thread?.versions?.length || 0) - versionIndex}` : undefined;
  return {
    author: {
      avatarUrl: note.author?.avatar_url,
      login: note.author?.username || note.author?.name || 'GitLab user',
      url: note.author?.web_url,
    },
    body: decodeHtmlEntities(note.body),
    filePath,
    id: `gitlab:${note.id}`,
    ...(!note.position && (note.original_position || thread?.isOutdated)
      ? { isOutdated: true }
      : {}),
    ...(thread?.isResolved != null ? { isThreadResolved: thread.isResolved } : {}),
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
    ...(positionIdentity
      ? {
          position: {
            range: {
              base: {
                label: { kind: 'commit', text: positionIdentity.baseSha.slice(0, 7) },
                sha: positionIdentity.baseSha,
              },
              head: {
                label: {
                  kind: 'version',
                  text: versionLabel || positionIdentity.headSha.slice(0, 7),
                },
                sha: positionIdentity.headSha,
              },
            },
            ...(version ? { versionId: String(version.id) } : {}),
          },
          positionIdentity,
          versionHeadSha: positionIdentity.headSha,
          ...(version ? { versionId: String(version.id) } : {}),
          ...(versionLabel ? { versionLabel } : {}),
        }
      : {}),
    submittedAt: note.created_at,
    ...(thread?.threadId ? { threadId: thread.threadId } : {}),
    url: `${url}#note_${note.id}`,
  };
};

/** Treat every GitLab discussion as one thread and inherit root coordinates. */
const normalizeGitLabDiscussion = (discussion, url, versions = []) => {
  const notes = (discussion?.notes || []).filter((note) => !note.system);
  const root = notes.find((note) => note.position || note.original_position) || notes[0];
  const position = root?.position || root?.original_position;
  const threadId =
    typeof discussion?.id === 'string' ? discussion.id : String(discussion?.id || '');
  const isResolved = discussion?.resolved === true || notes.some((note) => note.resolved === true);
  return notes
    .map((note) =>
      normalizeGitLabReviewComment(note, url, {
        isOutdated: !root?.position && Boolean(root?.original_position),
        isResolved,
        position,
        threadId,
        versions,
      }),
    )
    .filter(Boolean);
};

/** @param {any} note @param {PullRequestReviewComment} submittedComment @param {string} url */
const normalizeSubmittedGitLabReviewComment = (note, submittedComment, url) => {
  const normalized = normalizeGitLabReviewComment(note, url);
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
    body: decodeHtmlEntities(note.body),
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
const readMergeRequestComments = async (
  repoRoot,
  mergeRequest,
  transport,
  source = mergeRequest,
) => {
  const client = transport || createMergeRequestTransport(repoRoot, mergeRequest);
  try {
    const [discussions, versions] = await Promise.all([
      loadGitLabReviewDiscussions(source, client),
      loadGitLabReviewVersionTimeline(source, client)
        .then((timeline) =>
          timeline.toReversed().map((version) => ({
            base_commit_sha: version.baseSha,
            head_commit_sha: version.headSha,
            id: version.versionId,
            start_commit_sha: version.startSha,
          })),
        )
        .catch(() => []),
    ]);
    return discussions.flatMap((discussion) =>
      normalizeGitLabDiscussion(discussion, mergeRequest.url, versions),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'ProviderOutputLimitError') {
      throw new Error(
        `GitLab merge request discussions exceed the ${formatBytes(MAX_REVIEW_COMMENTS_BYTES)} limit, so Codiff could not load them.`,
      );
    }
    throw error;
  }
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
  headSha: metadata.sha,
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
 * Hydrate only the explicitly requested MR file. The rest remain patch-only
 * until the renderer asks for their exact local contents.
 *
 * @param {string} repoRoot
 * @param {ReturnType<typeof parseGitLabMergeRequestUrl>} mergeRequest
 * @param {any} metadata
 * @param {ArtifactFile} file
 */
const hydrateMergeRequestSection = async (repoRoot, mergeRequest, metadata, file) => {
  const refs = await resolveMergeRequestContentRefs(repoRoot, mergeRequest, metadata).catch(
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
    mergeRequest,
    file,
    oldFiles.get(oldPath),
    newFiles.get(file.path),
    {
      base: metadata.diff_refs?.base_sha,
      head: metadata.diff_refs?.head_sha || metadata.sha,
    },
  );
};

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source */
const readMergeRequestState = async (launchPath, source) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const mergeRequest = parseGitLabMergeRequestUrl(source.url);
  selectMergeRequestRemote(repoRoot, mergeRequest);
  const { metadata, range } = await readMergeRequestHydrationSnapshot(repoRoot, mergeRequest, {
    forceRefresh: true,
  });
  // Return the provider-normalized Range Artifact immediately. Exact local
  // contents are a deferred section request after first usable render.
  const files = rangeArtifactToPullRequestFiles(range, mergeRequest.number, {
    deferContents: true,
  });
  const reviewSource = createMergeRequestSource(mergeRequest, metadata);
  return {
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    generatedAt: Date.now(),
    launchPath,
    reviewCommentsLoadState: 'not-loaded',
    root: repoRoot,
    source: reviewSource,
  };
};

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source */
const readMergeRequestReviewComments = async (launchPath, source) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const mergeRequest = parseGitLabMergeRequestUrl(source.url);
  selectMergeRequestRemote(repoRoot, mergeRequest);
  return readMergeRequestComments(
    repoRoot,
    mergeRequest,
    createMergeRequestTransport(repoRoot, mergeRequest),
    source,
  );
};

/**
 * Load exact local contents for one merge-request file when explicitly retried.
 * @param {string} launchPath
 * @param {Extract<ReviewSource, {type: 'pull-request'}>} source
 * @param {string} requestedPath
 */
const readMergeRequestSectionContent = async (launchPath, source, requestedPath) => {
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
  return hydrateMergeRequestSection(repoRoot, mergeRequest, metadata, file);
};

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source @param {string} requestedPath */
const readMergeRequestImageContent = async (launchPath, source, requestedPath) => {
  try {
    const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
    const path = validateRepositoryPath(requestedPath);
    const mergeRequest = parseGitLabMergeRequestUrl(source.url);
    selectMergeRequestRemote(repoRoot, mergeRequest);
    const { metadata, range } = await readMergeRequestHydrationSnapshot(repoRoot, mergeRequest, {
      expectedHeadSha: source.headSha,
    });
    const file = range.files.find((candidate) => candidate.path === path);
    if (!file) {
      throw new Error('File is not part of this merge request.');
    }
    const refs = await resolveMergeRequestContentRefs(repoRoot, mergeRequest, metadata).catch(
      () => null,
    );
    const transport = createMergeRequestTransport(repoRoot, mergeRequest);
    const providerRefs = {
      base: metadata.diff_refs?.base_sha,
      head: metadata.diff_refs?.head_sha || metadata.sha,
    };
    const oldPath = file.oldPath || file.path;
    const oldRef = refs?.base || providerRefs.base;
    const newRef = refs?.head || providerRefs.head;
    const requests = [
      ...(oldRef ? [{ maxBytes: IMAGE_FILE_LIMIT, path: oldPath, ref: oldRef }] : []),
      ...(newRef ? [{ maxBytes: IMAGE_FILE_LIMIT, path: file.path, ref: newRef }] : []),
    ];
    const blobs = await readGitLabFileBlobArtifacts(repoRoot, mergeRequest, requests, transport);
    /** @param {string | undefined} ref @param {string} imagePath */
    const toImage = (ref, imagePath) => {
      const blob = ref ? blobs.get(`${ref}:${imagePath}`) : null;
      return blob ? bufferToImageRevision(imagePath, Buffer.from(blob.bytes)) : undefined;
    };
    const oldImage = toImage(oldRef, oldPath);
    const newImage = toImage(newRef, file.path);
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

const extractedGitLabReviewMutations = createGitLabReviewMutations({
  createTransport: createMergeRequestTransport,
  getDiscussionReplyEndpoint: getGitLabDiscussionReplyEndpoint,
  mergeRequestEndpoint,
  normalizeSubmittedGitLabReviewComment,
  parseGitLabMergeRequestUrl,
  readMergeRequestDiffs,
  readMergeRequestMetadata,
  selectMergeRequestRemote,
});

module.exports = {
  createGlabGitLabTransport,
  createGitLabPosition: createGitLabMutationPosition,
  createMergeRequestFetchRefspecs,
  createMergeRequestSource,
  normalizeGitLabReviewComment,
  normalizeGitLabDiscussion,
  parseGitLabMergeRequestUrl,
  readGitLabImageFile,
  readMergeRequestImageContent,
  readMergeRequestReviewComments,
  readMergeRequestSectionContent,
  recoverGitLabVersionId,
  resolveGitLabReviewTargets,
  resolveGitLabCommentTarget: extractedGitLabReviewMutations.resolveGitLabCommentTarget,
  readMergeRequestState,
  submitMergeRequestComment: extractedGitLabReviewMutations.submitMergeRequestComment,
  submitMergeRequestReview: extractedGitLabReviewMutations.submitMergeRequestReview,
};
