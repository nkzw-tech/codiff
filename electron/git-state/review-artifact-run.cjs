// @ts-check

const { loadReviewArtifacts } = require('../review-artifact-bridge.cjs');
const {
  artifactToChangedFiles,
  createNativeCommitArtifactSource,
  readBlobObjectIds,
} = require('./commit-artifacts.cjs');
const { listRepositoryHistory } = require('./commit.cjs');
const { readReviewHistoryCache, writeReviewHistoryCache } = require('../review-history-cache.cjs');
const { mapWithConcurrency } = require('../bounded-map.cjs');

const unitArtifactRuns = new Map();
const maxRememberedUnits = 512;
const maxComparisonRunMetrics = 32;
const maxPersistentArtifactCacheConcurrency = 8;
const nativeGitRangeDiffSemantics = 'native-git-patch-with-raw-unified-0-v1';

/** @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactProject} project */
const artifactCacheProject = (project) => ({
  host: project.host,
  project: project.project,
  provider: project.provider,
});
/** @param {{commitSha: string, parentSha: string | null}} request */
const commitRequestKey = (request) => `${request.commitSha}:${request.parentSha ?? 'root'}`;

/**
 * Cache keys deliberately name the immutable coordinates and the Core artifact
 * schema rather than relying on a host-local cache label. Range output also
 * carries the native diff semantics because changing that parser changes the
 * normalized immutable payload even when endpoint SHAs stay the same.
 *
 * @param {'commit-artifact' | 'stack-and-range-artifact'} kind
 * @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactProject} project
 * @param {string} schemaVersion
 * @param {{baseSha?: string, commitSha?: string, headSha?: string, parentSha?: string | null}} coordinates
 * @param {string} [rangeDiffSemantics]
 */
const artifactCacheKey = (
  kind,
  project,
  schemaVersion,
  coordinates,
  rangeDiffSemantics = nativeGitRangeDiffSemantics,
) => ({
  ...(kind === 'stack-and-range-artifact'
    ? {
        baseSha: coordinates.baseSha,
        diffSemantics: rangeDiffSemantics,
        headSha: coordinates.headSha,
      }
    : {
        commitSha: coordinates.commitSha,
        parentSha: coordinates.parentSha ?? null,
      }),
  artifactSchemaVersion: schemaVersion,
  kind,
  project: artifactCacheProject(project),
});

/** @param {unknown} value */
const isCompleteArtifact = (value) =>
  Boolean(
    value &&
    typeof value === 'object' &&
    value.coverage === 'complete' &&
    Array.isArray(value.files) &&
    value.files.every((file) => file && typeof file === 'object' && file.coverage === 'complete'),
  );

/** @param {unknown} value */
const isCompleteStackAndRange = (value) =>
  Boolean(
    value &&
    typeof value === 'object' &&
    isCompleteArtifact(value.range) &&
    value.stack &&
    typeof value.stack === 'object' &&
    value.stack.coverage === 'complete',
  );

/** @param {unknown} value @param {string | undefined} kind */
const hasArtifactProvenance = (value, kind) =>
  kind == null ||
  Boolean(
    value &&
    typeof value === 'object' &&
    value.provenance &&
    typeof value.provenance === 'object' &&
    value.provenance.kind === kind,
  );

/** @param {unknown} value @param {string | undefined} kind */
const hasStackAndRangeProvenance = (value, kind) =>
  kind == null ||
  Boolean(
    value &&
    typeof value === 'object' &&
    hasArtifactProvenance(value.range, kind) &&
    hasArtifactProvenance(value.stack, kind),
  );

/**
 * Layer the durable immutable-artifact cache below one Comparison Run. A run
 * still owns cancellation and its in-memory single-flight values; this layer
 * only avoids reacquiring completed native Git output after a later run or app
 * restart. Incomplete source responses stay retryable and never poison an
 * immutable complete-artifact key.
 *
 * @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactSource} source
 * @param {{
 *   project: import('../../core/lib/review-artifacts.ts').ReviewArtifactProject,
 *   diffSemantics?: string,
 *   provenanceKind?: 'github-api' | 'gitlab-api' | 'native-git',
 *   schemaVersion: string,
 *   validators?: {
 *     validateCommitArtifact?: (value: any) => any,
 *     validateRangeArtifact?: (value: any) => any,
 *     validateStackSnapshot?: (value: any) => any,
 *   },
 *   cache?: {read?: (key: unknown) => Promise<any | null>, write?: (key: unknown, value: any) => Promise<boolean>},
 * }} options
 * @returns {import('../../core/lib/review-artifacts.ts').ReviewArtifactSource}
 */
const createPersistentReviewArtifactSource = (source, options) => {
  const read = options.cache?.read || readReviewHistoryCache;
  const write = options.cache?.write || writeReviewHistoryCache;
  const validateCommitArtifact = options.validators?.validateCommitArtifact || ((value) => value);
  const validateRangeArtifact = options.validators?.validateRangeArtifact || ((value) => value);
  const validateStackSnapshot = options.validators?.validateStackSnapshot || ((value) => value);
  const diffSemantics = options.diffSemantics || nativeGitRangeDiffSemantics;

  /** @param {unknown} key @param {(value: any) => any} validate */
  const readComplete = async (key, validate) => {
    try {
      const value = await read(key);
      return value == null ? null : validate(value);
    } catch {
      // A corrupt or obsolete entry is indistinguishable from an immutable
      // cache miss. The source remains the authority for replacement data.
      return null;
    }
  };

  /** @param {unknown} key @param {unknown} value */
  const remember = async (key, value) => {
    try {
      await write(key, value);
    } catch {
      // Disk cache availability must not make a review unavailable.
    }
  };

  /** @param {ReadonlyArray<import('../../core/lib/review-artifacts.ts').CommitArtifactRequest>} commits @param {AbortSignal} signal */
  const readCachedCommitArtifacts = async (commits, signal) => {
    signal.throwIfAborted();
    const requested = [
      ...new Map(commits.map((commit) => [commitRequestKey(commit), commit])).values(),
    ];
    const cached = await mapWithConcurrency(
      requested,
      maxPersistentArtifactCacheConcurrency,
      async (commit) => {
        const key = artifactCacheKey('commit-artifact', options.project, options.schemaVersion, {
          commitSha: commit.commitSha,
          parentSha: commit.parentSha,
        });
        const artifact = await readComplete(key, validateCommitArtifact);
        return artifact &&
          isCompleteArtifact(artifact) &&
          hasArtifactProvenance(artifact, options.provenanceKind) &&
          artifact.commitSha === commit.commitSha &&
          artifact.parentSha === commit.parentSha
          ? [commitRequestKey(commit), artifact]
          : null;
      },
    );
    signal.throwIfAborted();
    return new Map(cached.filter(Boolean));
  };

  /** @param {string} baseSha @param {string} headSha @param {AbortSignal} signal */
  const readCachedStackAndRange = async (baseSha, headSha, signal) => {
    signal.throwIfAborted();
    const key = artifactCacheKey(
      'stack-and-range-artifact',
      options.project,
      options.schemaVersion,
      { baseSha, headSha },
      diffSemantics,
    );
    const cached = await readComplete(key, (value) => {
      if (!value || typeof value !== 'object') {
        throw new Error('Invalid cached stack-and-range artifact.');
      }
      return {
        range: validateRangeArtifact(value.range),
        stack: validateStackSnapshot(value.stack),
      };
    });
    signal.throwIfAborted();
    return cached &&
      isCompleteStackAndRange(cached) &&
      hasStackAndRangeProvenance(cached, options.provenanceKind) &&
      cached.range.baseSha === cached.stack.baseSha &&
      cached.range.headSha === headSha &&
      cached.stack.headSha === headSha
      ? cached
      : null;
  };

  return {
    readBlobs: (objectIds, signal) => source.readBlobs(objectIds, signal),
    readCachedCommitArtifacts,
    readCachedStackAndRange,
    readFileBlobs: (requests, signal) =>
      source.readFileBlobs ? source.readFileBlobs(requests, signal) : Promise.resolve(new Map()),
    async readCommitArtifacts(commits, signal) {
      const requested = [
        ...new Map(commits.map((commit) => [commitRequestKey(commit), commit])).values(),
      ];
      const artifacts = await readCachedCommitArtifacts(requested, signal);
      const misses = requested.filter((commit) => !artifacts.has(commitRequestKey(commit)));
      if (misses.length === 0) {
        return artifacts;
      }
      const acquired = await source.readCommitArtifacts(misses, signal);
      signal.throwIfAborted();
      const completeArtifacts = [];
      for (const commit of misses) {
        const artifact = acquired.get(commitRequestKey(commit));
        if (
          !artifact ||
          artifact.commitSha !== commit.commitSha ||
          artifact.parentSha !== commit.parentSha
        ) {
          continue;
        }
        artifacts.set(commitRequestKey(commit), artifact);
        if (
          isCompleteArtifact(artifact) &&
          hasArtifactProvenance(artifact, options.provenanceKind)
        ) {
          completeArtifacts.push({
            artifact,
            key: artifactCacheKey('commit-artifact', options.project, options.schemaVersion, {
              commitSha: commit.commitSha,
              parentSha: commit.parentSha,
            }),
          });
        }
      }
      await mapWithConcurrency(
        completeArtifacts,
        maxPersistentArtifactCacheConcurrency,
        async ({ artifact, key }) => remember(key, artifact),
      );
      signal.throwIfAborted();
      return artifacts;
    },
    async readStackAndRange(request, signal) {
      const { headSha, requestedBaseSha: baseSha } = request;
      const key = artifactCacheKey(
        'stack-and-range-artifact',
        options.project,
        options.schemaVersion,
        {
          baseSha,
          headSha,
        },
        diffSemantics,
      );
      const cached = await readCachedStackAndRange(baseSha, headSha, signal);
      if (cached) {
        return cached;
      }
      const acquired = await source.readStackAndRange(request, signal);
      signal.throwIfAborted();
      if (
        isCompleteStackAndRange(acquired) &&
        hasStackAndRangeProvenance(acquired, options.provenanceKind)
      ) {
        await remember(key, acquired);
      }
      signal.throwIfAborted();
      return acquired;
    },
  };
};

/**
 * Compose a preferred Artifact Source with one canonical fallback. Completed
 * fallback cache entries are checked before reacquiring the preferred source,
 * which lets an initial provider comparison feed a later Desktop Comparison
 * Run without making provider I/O the default for every locally available key.
 *
 * @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactSource & {readCachedCommitArtifacts?: Function, readCachedStackAndRange?: Function}} primary
 * @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactSource & {readCachedCommitArtifacts?: Function, readCachedStackAndRange?: Function}} fallback
 * @returns {import('../../core/lib/review-artifacts.ts').ReviewArtifactSource}
 */
const createFallbackReviewArtifactSource = (primary, fallback) => ({
  async readBlobs(objectIds, signal) {
    signal.throwIfAborted();
    let preferred = new Map();
    try {
      preferred = await primary.readBlobs(objectIds, signal);
    } catch {
      signal.throwIfAborted();
    }
    const missing = [...new Set(objectIds)].filter((objectId) => !preferred.has(objectId));
    if (missing.length === 0) {
      return preferred;
    }
    let replacements = new Map();
    try {
      replacements = await fallback.readBlobs(missing, signal);
    } catch {
      signal.throwIfAborted();
    }
    return new Map([...preferred, ...replacements]);
  },
  async readFileBlobs(requests, signal) {
    signal.throwIfAborted();
    const requestKey = (request) => `${request.ref}:${request.path}`;
    let preferred = new Map();
    if (primary.readFileBlobs) {
      try {
        preferred = await primary.readFileBlobs(requests, signal);
      } catch {
        signal.throwIfAborted();
      }
    }
    const missing = [
      ...new Map(
        requests
          .filter((request) => !preferred.has(requestKey(request)))
          .map((request) => [requestKey(request), request]),
      ).values(),
    ];
    if (missing.length === 0 || !fallback.readFileBlobs) {
      return preferred;
    }
    let replacements = new Map();
    try {
      replacements = await fallback.readFileBlobs(missing, signal);
    } catch {
      signal.throwIfAborted();
    }
    return new Map([...preferred, ...replacements]);
  },
  async readCommitArtifacts(commits, signal) {
    signal.throwIfAborted();
    const requested = [
      ...new Map(commits.map((commit) => [commitRequestKey(commit), commit])).values(),
    ];
    const cachedFallback = fallback.readCachedCommitArtifacts
      ? await fallback.readCachedCommitArtifacts(requested, signal)
      : new Map();
    const preferredRequests = requested.filter(
      (commit) => !isCompleteArtifact(cachedFallback.get(commitRequestKey(commit))),
    );
    let preferred = new Map();
    if (preferredRequests.length > 0) {
      try {
        preferred = await primary.readCommitArtifacts(preferredRequests, signal);
      } catch {
        signal.throwIfAborted();
      }
    }
    const fallbackRequests = preferredRequests.filter(
      (commit) => !isCompleteArtifact(preferred.get(commitRequestKey(commit))),
    );
    let replacements = new Map();
    if (fallbackRequests.length > 0) {
      try {
        replacements = await fallback.readCommitArtifacts(fallbackRequests, signal);
      } catch {
        signal.throwIfAborted();
      }
    }
    const artifacts = new Map(cachedFallback);
    for (const commit of preferredRequests) {
      const key = commitRequestKey(commit);
      const preferredArtifact = preferred.get(key);
      const replacement = replacements.get(key);
      if (isCompleteArtifact(replacement) || !preferredArtifact) {
        if (replacement) artifacts.set(key, replacement);
      } else {
        artifacts.set(key, preferredArtifact);
      }
    }
    return artifacts;
  },
  async readStackAndRange(request, signal) {
    const { headSha, requestedBaseSha: baseSha } = request;
    signal.throwIfAborted();
    const cachedFallback = fallback.readCachedStackAndRange
      ? await fallback.readCachedStackAndRange(baseSha, headSha, signal)
      : null;
    if (cachedFallback) {
      return cachedFallback;
    }
    let preferred;
    try {
      preferred = await primary.readStackAndRange(request, signal);
      if (isCompleteStackAndRange(preferred)) {
        return preferred;
      }
    } catch {
      signal.throwIfAborted();
    }
    try {
      const replacement = await fallback.readStackAndRange(request, signal);
      return isCompleteStackAndRange(replacement) || !preferred ? replacement : preferred;
    } catch {
      signal.throwIfAborted();
      if (preferred) {
        return preferred;
      }
      throw new Error(`Neither Artifact Source could read ${baseSha}..${headSha}.`);
    }
  },
});

/**
 * Attach non-persistent phase telemetry to the Electron-owned Comparison Run.
 * The shared algorithms report immutable-work facts through callbacks; this
 * boundary keeps them out of review results and durable caches while making
 * the facts available to the existing JSONL milestone.
 * @param {{comparisonRun?: Record<string, any>} | Record<string, any> | undefined} control
 * @param {Record<string, unknown>} metric
 */
const recordComparisonRunMetric = (control, metric) => {
  const run = control?.comparisonRun || control;
  if (!run || typeof run !== 'object') {
    return;
  }
  const existing = Array.isArray(run.comparisonMetrics) ? run.comparisonMetrics : [];
  run.comparisonMetrics = [...existing, metric].slice(-maxComparisonRunMetrics);
};

/** @param {string | undefined} objectId */
const isReadableObjectId = (objectId) => Boolean(objectId && !/^0+$/.test(objectId));

/** @param {string | undefined} patch */
const replayPatchBody = (patch) => {
  const hunkStart = patch?.search(/^@@\s/m) ?? -1;
  return hunkStart === -1 ? '' : patch.slice(hunkStart);
};

/** @param {import('../../core/types.ts').GitFileStatus} status */
const replayPatchStatus = (status) =>
  status === 'added' || status === 'deleted' || status === 'renamed' ? status : 'modified';

/**
 * Preserve an Artifact's completeness and object identities when adapting it
 * for regional replay. Those identities can prove equal final file bytes
 * without a Blob Artifact read, so this must not go through ChangedFile.
 * @param {import('../../core/lib/review-artifacts.ts').CommitArtifact | import('../../core/lib/review-artifacts.ts').RangeArtifact} artifact
 */
const artifactToReplayPatchFiles = (artifact) =>
  artifact.files.map((file) => ({
    coverage: file.coverage,
    newObjectId: file.newObjectId,
    newPath: file.path,
    oldObjectId: file.oldObjectId,
    oldPath: file.oldPath || file.path,
    patchBody: replayPatchBody(file.patch),
    status: replayPatchStatus(file.status),
  }));

/**
 * Index exact endpoint blobs already named by Commit and Range Artifacts. A
 * commit endpoint also inherits an unchanged path from its selected parent;
 * a Range Artifact maps its raw old/new object IDs directly to base/head.
 * @param {ReadonlyArray<import('../../core/lib/review-artifacts.ts').CommitArtifact | import('../../core/lib/review-artifacts.ts').RangeArtifact>} artifacts
 */
const createArtifactBlobIndex = (artifacts) => {
  const objectIds = new Map();
  const parents = new Map();
  for (const artifact of artifacts) {
    const isCommit = 'commitSha' in artifact;
    const oldRef = isCommit ? artifact.parentSha : artifact.baseSha;
    const newRef = isCommit ? artifact.commitSha : artifact.headSha;
    if (isCommit && artifact.parentSha) {
      parents.set(artifact.commitSha, artifact.parentSha);
    }
    for (const file of artifact.files) {
      if (oldRef && isReadableObjectId(file.oldObjectId)) {
        objectIds.set(`${oldRef}:${file.oldPath || file.path}`, file.oldObjectId);
      }
      if (isReadableObjectId(file.newObjectId)) {
        objectIds.set(`${newRef}:${file.path}`, file.newObjectId);
      }
    }
  }
  return {
    get(path, ref) {
      return (
        objectIds.get(`${ref}:${path}`) || objectIds.get(`${parents.get(ref)}:${path}`) || null
      );
    },
    objectIds: [...new Set(objectIds.values())],
  };
};

/** @param {{path: string, ref: string}} request */
const replayBlobRequestKey = (request) => `${request.ref}:${request.path}`;

/**
 * Make one proof-triggered regional replay reader. Raw Range Artifact IDs are
 * consumed first; endpoint paths absent from those raw records are resolved in
 * one `cat-file --batch-check` request, then all immutable blob contents are
 * read through the Comparison Run's deduplicated bulk cache.
 *
 * @param {string} repoRoot
 * @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactRun} run
 * @param {ReadonlyArray<import('../../core/lib/review-artifacts.ts').CommitArtifact | import('../../core/lib/review-artifacts.ts').RangeArtifact>} artifacts
 * @param {AbortSignal} [signal]
 */
const createArtifactBlobLookup = (repoRoot, run, artifacts, signal) => {
  const index = createArtifactBlobIndex(artifacts);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const activeSignal = signal || run.signal;

  /** @param {ReadonlyArray<{path: string, ref: string}>} requests */
  return async (requests) => {
    const objectIdsByRequest = new Map();
    const unresolved = [];
    for (const request of requests) {
      const key = replayBlobRequestKey(request);
      const objectId = index.get(request.path, request.ref);
      if (objectId) {
        objectIdsByRequest.set(key, objectId);
      } else {
        unresolved.push(request);
      }
    }
    if (unresolved.length > 0) {
      const resolved = await readBlobObjectIds(repoRoot, unresolved, { signal: activeSignal });
      for (const request of unresolved) {
        const objectId = resolved.get(replayBlobRequestKey(request));
        if (objectId) {
          objectIdsByRequest.set(replayBlobRequestKey(request), objectId);
        }
      }
    }

    const blobs = await run.readBlobs([...new Set(objectIdsByRequest.values())], activeSignal);
    const results = new Map();
    for (const request of requests) {
      const key = replayBlobRequestKey(request);
      const objectId = objectIdsByRequest.get(key);
      const blob = objectId ? blobs.get(objectId) : null;
      if (!blob) {
        results.set(key, null);
        continue;
      }
      try {
        results.set(key, decoder.decode(blob.bytes));
      } catch {
        // A non-text object is explicit missing textual evidence for replay.
        results.set(key, null);
      }
    }
    return results;
  };
};

/** @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactProject} project */
const projectKey = (project) => `${project.provider}:${project.host}:${project.project}`;

/**
 * @typedef {{
 *   createSource: () => import('../../core/lib/review-artifacts.ts').ReviewArtifactSource | Promise<import('../../core/lib/review-artifacts.ts').ReviewArtifactSource>,
 *   diffSemantics: string,
 *   identity: string,
 *   provenanceKind: 'github-api' | 'gitlab-api' | 'native-git',
 * }} ArtifactSourceBackend
 */

/**
 * @param {string} repoRoot
 * @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactProject} project
 * @param {{comparisonRun?: {artifactRuns?: Map<string, Promise<any>>}, signal?: AbortSignal}} [control]
 * @param {{fallbackSource?: ArtifactSourceBackend, source?: ArtifactSourceBackend}} [options]
 * @returns {Promise<import('../../core/lib/review-artifacts.ts').ReviewArtifactRun>}
 */
const getComparisonArtifactRun = (repoRoot, project, control = {}, options = {}) => {
  const owner = control.comparisonRun || control;
  if (!owner.artifactRuns) {
    owner.artifactRuns = new Map();
  }
  const source = options.source || /** @type {ArtifactSourceBackend} */ ({
    createSource: () => createNativeCommitArtifactSource(repoRoot, project),
    diffSemantics: nativeGitRangeDiffSemantics,
    identity: 'native-git',
    provenanceKind: 'native-git',
  });
  const key = `${repoRoot}:${projectKey(project)}:${source.identity}${
    options.fallbackSource ? `+${options.fallbackSource.identity}` : ''
  }`;
  const existing = owner.artifactRuns.get(key);
  if (existing) {
    return existing;
  }
  const pending = loadReviewArtifacts()
    .then(
      async ({
        createReviewArtifactRun,
        reviewArtifactSchemaVersion,
        validateCommitArtifact,
        validateRangeArtifact,
        validateStackSnapshot,
      }) => {
        const validators = {
          validateCommitArtifact,
          validateRangeArtifact,
          validateStackSnapshot,
        };
        /** @param {ArtifactSourceBackend} backend */
        const createPersistentSource = async (backend) =>
          createPersistentReviewArtifactSource(await backend.createSource(), {
            diffSemantics: backend.diffSemantics,
            project,
            provenanceKind: backend.provenanceKind,
            schemaVersion: reviewArtifactSchemaVersion,
            validators,
          });
        const preferred = await createPersistentSource(source);
        const artifactSource = options.fallbackSource
          ? createFallbackReviewArtifactSource(
              preferred,
              await createPersistentSource(options.fallbackSource),
            )
          : preferred;
        return createReviewArtifactRun(artifactSource, { signal: control.signal });
      },
    )
    .then((run) => {
      // Unit materialization receives only this artifact run. Retain its
      // request-scoped owner so later proof replay remains visible in the same
      // Comparison Run diagnostic record as aggregate comparison and matching.
      run.comparisonRun = owner;
      return run;
    });
  owner.artifactRuns.set(key, pending);
  return pending;
};

/** @param {import('../../core/lib/review-artifacts.ts').CommitArtifact | undefined} artifact */
const artifactDiffStat = (artifact) => {
  if (!artifact) {
    return undefined;
  }
  let additions = 0;
  let deletions = 0;
  for (const file of artifact.files) {
    for (const line of (file.patch || '').split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
    }
  }
  return { additions, deletions, filesChanged: artifact.files.length };
};

/**
 * Build the commit sidebar from the same immutable Stack Snapshot and Commit
 * Artifacts used by comparison/evolution. Target-base history remains the
 * generic native repository log and only its boundary commit joins the batch.
 * @param {string} repoRoot
 * @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactProject} project
 * @param {string} baseSha
 * @param {string} headSha
 * @param {number} [limit]
 * @param {{comparisonRun?: {artifactRuns?: Map<string, Promise<any>>}, signal?: AbortSignal}} [control]
 * @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactRun | Promise<import('../../core/lib/review-artifacts.ts').ReviewArtifactRun>} [artifactRun]
 * @returns {Promise<import('../../core/types.ts').RepositoryHistory>}
 */
const listArtifactRepositoryHistory = async (
  repoRoot,
  project,
  baseSha,
  headSha,
  limit = 200,
  control = {},
  artifactRun,
) => {
  const run = await (artifactRun || getComparisonArtifactRun(repoRoot, project, control));
  const [{ stack }, baseHistory] = await Promise.all([
    run.readStackAndRange(
      { headSha: headSha, requestedBaseSha: baseSha },
      control.signal || run.signal,
    ),
    listRepositoryHistory(repoRoot, limit, baseSha),
  ]);
  const baseEntries = baseHistory.entries.map((entry) => ({ ...entry, scope: 'base' }));
  const requests = [
    ...stack.commits.map((commit) => ({
      commitSha: commit.sha,
      parentSha: commit.parentShas[0] || null,
    })),
    ...baseEntries.slice(0, 1).map((commit) => ({
      commitSha: commit.sha,
      parentSha: commit.parentShas[0] || null,
    })),
  ];
  const artifacts = await run.readCommitArtifacts(requests, control.signal || run.signal);
  const reviewEntries = stack.commits.map((commit) => ({
    author: commit.authorName,
    committedAt: Date.parse(commit.authoredAt),
    ...(artifactDiffStat(
      artifacts.get(
        commitRequestKey({ commitSha: commit.sha, parentSha: commit.parentShas[0] || null }),
      ),
    )
      ? {
          diffStat: artifactDiffStat(
            artifacts.get(
              commitRequestKey({ commitSha: commit.sha, parentSha: commit.parentShas[0] || null }),
            ),
          ),
        }
      : {}),
    parentShas: commit.parentShas,
    scope: 'pull-request',
    sha: commit.sha,
    subject: commit.subject,
  }));
  if (baseEntries[0]) {
    const diffStat = artifactDiffStat(
      artifacts.get(
        commitRequestKey({
          commitSha: baseEntries[0].sha,
          parentSha: baseEntries[0].parentShas[0] || null,
        }),
      ),
    );
    if (diffStat) {
      baseEntries[0] = { ...baseEntries[0], diffStat };
    }
  }
  return { entries: [...reviewEntries, ...baseEntries], root: repoRoot };
};

/**
 * @param {string} repoRoot
 * @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactProject} project
 * @param {ReadonlyArray<import('../../core/types.ts').ReviewEvolutionUnit>} units
 * @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactRun} run
 */
const rememberReviewUnitArtifactRun = (repoRoot, project, units, run) => {
  for (const unit of units) {
    unitArtifactRuns.set(`${repoRoot}:${projectKey(project)}:${unit.unitId}`, run);
  }
  while (unitArtifactRuns.size > maxRememberedUnits) {
    unitArtifactRuns.delete(unitArtifactRuns.keys().next().value);
  }
};

/** @param {import('../../core/types.ts').ReviewEvolutionUnit} unit */
const artifactSelection = (unit) => {
  if (unit.kind === 'introduced' && unit.after) {
    return { commit: unit.after, reverse: false };
  }
  if ((unit.kind === 'removed' || unit.kind === 'absorbed-into-base') && unit.before) {
    return { commit: unit.before, reverse: true };
  }
  if (
    (unit.kind === 'retained' || unit.kind === 'rewritten-same-patch') &&
    (unit.after || unit.before)
  ) {
    return { commit: unit.after || unit.before, reverse: false };
  }
  return null;
};

/**
 * Unit materialization happens after aggregate/evolution IPC has released its
 * local variables. Keep its terminal replay outcome on the same owning run so
 * a JSONL comparison record accounts for both whole-version and per-unit
 * evidence work.
 * @param {any} run
 * @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactProject} project
 * @param {import('../../core/types.ts').ReviewEvolutionUnit} unit
 * @param {Record<string, unknown>} metric
 */
const recordUnitReplayMetric = (run, project, unit, metric) =>
  recordComparisonRunMetric(run.comparisonRun || run, {
    kind: 'unit-regional-replay',
    provider: project.provider,
    unitId: unit.unitId,
    ...metric,
  });

/**
 * @param {string} repoRoot
 * @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactProject} project
 * @param {import('../../core/types.ts').ReviewEvolutionUnit} unit
 * @returns {Promise<ReadonlyArray<import('../../core/types.ts').ChangedFile> | null>}
 */
const materializeReviewUnitFromArtifacts = async (repoRoot, project, unit) => {
  const selection = artifactSelection(unit);
  const run = unitArtifactRuns.get(`${repoRoot}:${projectKey(project)}:${unit.unitId}`);
  if (!run) {
    return null;
  }
  if (run.signal.aborted) {
    recordUnitReplayMetric(run, project, unit, { outcome: 'canceled' });
    return null;
  }
  if ((unit.kind === 'revised' || unit.kind === 'ambiguous') && unit.before && unit.after) {
    const beforeParentSha = unit.before.parentShas[0] || null;
    const afterParentSha = unit.after.parentShas[0] || null;
    if (!beforeParentSha || !afterParentSha) {
      recordUnitReplayMetric(run, project, unit, {
        outcome: 'unavailable',
        reason: 'missing-parent-coordinate',
      });
      return null;
    }
    try {
      const artifacts = await run.readCommitArtifacts(
        [
          { commitSha: unit.before.sha, parentSha: beforeParentSha },
          { commitSha: unit.after.sha, parentSha: afterParentSha },
        ],
        run.signal,
      );
      const before = artifacts.get(
        commitRequestKey({ commitSha: unit.before.sha, parentSha: beforeParentSha }),
      );
      const after = artifacts.get(
        commitRequestKey({ commitSha: unit.after.sha, parentSha: afterParentSha }),
      );
      if (!before || !after) {
        recordUnitReplayMetric(run, project, unit, {
          outcome: 'unavailable',
          reason: 'missing-commit-artifact',
        });
        return null;
      }
      // Let Core describe the exact four-endpoint evidence it needs. This
      // preserves one proof-triggered batch and resolves artifact omissions
      // through the native object-ID lookup instead of preloading every blob
      // named by either commit artifact.
      const readReplayBlobs = createArtifactBlobLookup(repoRoot, run, [before, after], run.signal);
      const { computeVersionComparePreferringReplay } = await loadReviewArtifacts();
      const comparison = await computeVersionComparePreferringReplay({
        from: {
          baseSha: beforeParentSha,
          createdAt: unit.before.authoredAt,
          headSha: unit.before.sha,
          label: unit.before.shortSha,
          versionId: unit.before.sha,
        },
        fromFiles: artifactToReplayPatchFiles(before),
        readBlob: async () => null,
        readBlobs: readReplayBlobs,
        signal: run.signal,
        to: {
          baseSha: afterParentSha,
          createdAt: unit.after.authoredAt,
          headSha: unit.after.sha,
          label: unit.after.shortSha,
          versionId: unit.after.sha,
        },
        toFiles: artifactToReplayPatchFiles(after),
        onDiagnostics: (diagnostics) =>
          recordUnitReplayMetric(run, project, unit, { ...diagnostics, outcome: 'complete' }),
      });
      return comparison.files.map(({ file }, fileIndex) => ({
        ...file,
        fingerprint: `${unit.unitId}:${fileIndex}:${file.fingerprint}`,
        sections: file.sections.map((section, sectionIndex) => ({
          ...section,
          id: `${file.path}:artifact-replay:${unit.unitId}:${sectionIndex}`,
        })),
      }));
    } catch {
      recordUnitReplayMetric(run, project, unit, {
        outcome: run.signal.aborted ? 'canceled' : 'failed',
      });
      return null;
    }
  }
  if (!selection) {
    return null;
  }
  const parentSha = selection.commit.parentShas[0] || null;
  try {
    const artifacts = await run.readCommitArtifacts(
      [{ commitSha: selection.commit.sha, parentSha }],
      run.signal,
    );
    const artifact = artifacts.get(
      commitRequestKey({ commitSha: selection.commit.sha, parentSha }),
    );
    return artifact ? artifactToChangedFiles(artifact, { reverse: selection.reverse }) : null;
  } catch {
    return null;
  }
};

module.exports = {
  artifactCacheKey,
  createArtifactBlobIndex,
  createArtifactBlobLookup,
  createFallbackReviewArtifactSource,
  createPersistentReviewArtifactSource,
  getComparisonArtifactRun,
  listArtifactRepositoryHistory,
  materializeReviewUnitFromArtifacts,
  recordComparisonRunMetric,
  recordUnitReplayMetric,
  rememberReviewUnitArtifactRun,
  artifactToReplayPatchFiles,
};
