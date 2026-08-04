// @ts-check

/**
 * Local GitLab review-history adapter over glab transport + @nkzw/codiff-gitlab.
 */

const { createGlabGitLabTransport } = require('./glab-gitlab-transport.cjs');
const { git, gitBufferWithInput, gitOrEmpty } = require('./common.cjs');
const {
  MAX_BLOB_ARTIFACT_BYTES,
  artifactToChangedFiles,
  rangeArtifactToChangedFiles,
} = require('./commit-artifacts.cjs');
const {
  artifactToReplayPatchFiles,
  createArtifactBlobLookup,
  listArtifactRepositoryHistory,
  materializeReviewUnitFromArtifacts,
  recordComparisonRunMetric,
  rememberReviewUnitArtifactRun,
} = require('./review-artifact-run.cjs');
const {
  getGitLabComparisonArtifactRun,
  gitlabArtifactProject,
} = require('./provider-artifact-sources.cjs');
const {
  loadGitLabHistory,
  loadGitLabReviewDiscussions,
  loadGitLabReviewVersionTimeline,
} = require('../gitlab-history-bridge.cjs');
const { readReviewHistoryCache, writeReviewHistoryCache } = require('../review-history-cache.cjs');
const { mapWithConcurrency } = require('../bounded-map.cjs');
const { createImmutableCache } = require('../immutable-cache.cjs');
const { readReviewRemotes } = require('../review-source.cjs');

/**
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').DiffComparisonView} DiffComparisonView
 * @typedef {import('../../core/types.ts').ReviewCommitEvolution} ReviewCommitEvolution
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../../core/types.ts').ReviewVersionOption} ReviewVersionOption
 * @typedef {Extract<ReviewSource, { type: 'pull-request' }>} PullRequestSource
 */

const MR_BASE_VERSION_ID = 'mr-base';
const versionCompareCache = new Map();
const versionCommitFingerprintCache = new Map();
const FINGERPRINT_CACHE_VERSION = 'commit-fingerprint-v3:bulk-diff-tree-v1';
const maxFingerprintCacheConcurrency = 8;

const readImmutableHistory = createImmutableCache();

/** @param {PullRequestSource} source */
const sourceCacheKey = (source) =>
  `${source.host}:${source.projectPath}:!${source.number}:${source.headSha || 'unknown-head'}`;

/**
 * @param {string} repoRoot
 * @param {string} baseSha
 * @param {string} headSha
 * @param {PullRequestSource} source
 * @param {{signal?: AbortSignal}} [options]
 */
const readLocalCommitStack = async (repoRoot, baseSha, headSha, source, options = {}) => {
  if (baseSha === headSha) {
    return [];
  }
  const raw = await git(
    repoRoot,
    ['log', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%cI%x00%s', `${baseSha}..${headSha}`],
    options,
  );
  if (!raw.trim()) {
    throw new Error(
      `No local commits are available for ${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}.`,
    );
  }
  const projectUrl = source.url.replace(/\/-\/merge_requests\/\d+.*$/, '');
  const commits = raw
    .trim()
    .split('\n')
    .map((line) => {
      const [
        sha,
        parents,
        authorName,
        authorEmail,
        authoredDate,
        committerName,
        committedDate,
        title,
      ] = line.split('\0');
      return {
        authoredDate,
        authorEmail,
        authorName,
        committedDate,
        committerName,
        message: title,
        parentShas: parents ? parents.split(' ').filter(Boolean) : [],
        sha,
        shortSha: sha.slice(0, 7),
        title,
        webUrl: `${projectUrl}/-/commit/${sha}`,
      };
    });
  const gitlab = await loadGitLabHistory();
  return gitlab.orderGitLabCommitsTopologically(commits);
};

/**
 * Adapt the provider-neutral Stack Snapshot shape to the GitLab package's
 * commit-reader contract.
 * @param {import('../../core/types.ts').ReviewCommitSummary} commit
 * @param {PullRequestSource} source
 */
const toGitLabEvolutionCommit = (commit, source) => {
  const authorName = commit.authorName || 'Unknown';
  const subject = commit.subject || commit.sha.slice(0, 8);
  const projectUrl = source.url.replace(/\/-\/merge_requests\/\d+.*$/, '');
  return {
    authoredDate: commit.authoredAt,
    authorEmail: '',
    authorName,
    committedDate: commit.authoredAt,
    committerName: authorName,
    message: subject,
    parentShas: commit.parentShas,
    sha: commit.sha,
    shortSha: commit.shortSha || commit.sha.slice(0, 8),
    title: subject,
    webUrl: commit.webUrl || `${projectUrl}/-/commit/${commit.sha}`,
  };
};

/** @param {ReadonlyArray<import('../../core/types.ts').ReviewCommitSummary>} commits @param {string} targetSha @param {string} ancestorSha */
const commitGraphReaches = (commits, targetSha, ancestorSha) => {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const visit = (sha, visited = new Set()) => {
    if (sha === ancestorSha) return true;
    if (visited.has(sha)) return false;
    visited.add(sha);
    return (bySha.get(sha)?.parentShas || []).some((parent) => visit(parent, visited));
  };
  return visit(targetSha);
};

/** @param {import('../../core/lib/review-artifacts.ts').RangeArtifact} range */
const rangeArtifactDiffStat = (range) => {
  let additions = 0;
  let deletions = 0;
  for (const file of range.files) {
    for (const line of (file.patch || '').split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
    }
  }
  return { additions, deletions, filesChanged: range.files.length };
};

/** @param {string} repoRoot @param {PullRequestSource} source @param {string} sha @param {AbortSignal} signal */
const readArtifactBaseRef = async (repoRoot, source, sha, signal) => {
  const committedAt = (
    await gitOrEmpty(repoRoot, ['show', '-s', '--format=%cI', sha], { signal })
  ).trim();
  const projectUrl = source.url.replace(/\/-\/merge_requests\/\d+.*$/, '');
  return {
    committedAt: committedAt || null,
    sha,
    shortSha: sha.slice(0, 7),
    webUrl: `${projectUrl}/-/commit/${sha}`,
  };
};

/**
 * Derive target-base movement from the same Range Artifact and Stack Snapshot
 * backends used by aggregate comparison. Provider compare is therefore never
 * reacquired by the GitLab package outside this Comparison Run.
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {string} fromSha
 * @param {string} toSha
 * @param {{comparisonRun?: {artifactRuns?: Map<string, Promise<any>>}, signal?: AbortSignal}} [control]
 */
const readArtifactBaseMovement = async (repoRoot, source, fromSha, toSha, control = {}) => {
  const run = await getGitLabComparisonArtifactRun(repoRoot, source, control);
  const signal = control.signal || run.signal;
  const [from, to] = await Promise.all([
    readArtifactBaseRef(repoRoot, source, fromSha, signal),
    readArtifactBaseRef(repoRoot, source, toSha, signal),
  ]);
  if (fromSha === toSha) {
    return {
      changed: false,
      commits: [],
      commitsBetween: 0,
      commitTimestampDeltaMs: null,
      diffStat: { additions: 0, deletions: 0, filesChanged: 0 },
      from,
      relationship: 'forward',
      to,
      truncated: false,
    };
  }
  try {
    const forward = await run.readStackAndRange(
      { headSha: toSha, requestedBaseSha: fromSha },
      signal,
    );
    const forwardComplete =
      forward.range.coverage === 'complete' && forward.stack.coverage === 'complete';
    let relationship = commitGraphReaches(forward.stack.commits, toSha, fromSha)
      ? 'forward'
      : 'unknown';
    let movement = forward;
    if (relationship === 'unknown' && forwardComplete) {
      try {
        const reverse = await run.readStackAndRange(
          { headSha: fromSha, requestedBaseSha: toSha },
          signal,
        );
        const reverseComplete =
          reverse.range.coverage === 'complete' && reverse.stack.coverage === 'complete';
        if (commitGraphReaches(reverse.stack.commits, fromSha, toSha)) {
          relationship = 'backward';
          movement = reverse;
        } else if (reverseComplete) {
          relationship = 'divergent';
        }
      } catch {
        signal.throwIfAborted();
      }
    }
    const movementComplete =
      movement.range.coverage === 'complete' && movement.stack.coverage === 'complete';
    const fromTimestamp = from.committedAt ? Date.parse(from.committedAt) : Number.NaN;
    const toTimestamp = to.committedAt ? Date.parse(to.committedAt) : Number.NaN;
    return {
      changed: true,
      commits: movement.stack.commits.map((commit) => ({
        authoredAt: commit.authoredAt,
        authorName: commit.authorName,
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        webUrl:
          commit.webUrl || `${to.webUrl?.replace(/\/commit\/[^/]+$/, '')}/commit/${commit.sha}`,
      })),
      commitsBetween:
        relationship === 'unknown' || !movementComplete ? null : movement.stack.commits.length,
      commitTimestampDeltaMs:
        Number.isFinite(fromTimestamp) && Number.isFinite(toTimestamp)
          ? toTimestamp - fromTimestamp
          : null,
      diffStat: rangeArtifactDiffStat(forward.range),
      from,
      relationship,
      to,
      truncated: !movementComplete,
    };
  } catch (error) {
    signal.throwIfAborted();
    return {
      changed: true,
      commits: [],
      commitsBetween: null,
      commitTimestampDeltaMs: null,
      diffStat: null,
      from,
      relationship: 'unknown',
      to,
      truncated: false,
      warning: error instanceof Error ? error.message : 'Base movement details are unavailable.',
    };
  }
};

/** @param {string} repoRoot @param {PullRequestSource} source @param {{signal?: AbortSignal}} [control] */
const createLocalReaders = (repoRoot, source, control = {}) => {
  const commitArtifacts = new Map();
  const rangeArtifacts = new Map();
  const readRangeArtifact = (fromSha, toSha) =>
    readImmutableHistory(
      `${repoRoot}:range:${fromSha}:${toSha}`,
      async () => {
        const run = await getGitLabComparisonArtifactRun(repoRoot, source, control);
        const { range } = await run.readStackAndRange(
          { headSha: toSha, requestedBaseSha: fromSha },
          control.signal || run.signal,
        );
        return range;
      },
      { shareInFlight: control.signal == null },
    ).then((range) => {
      rangeArtifacts.set(`${fromSha}:${toSha}`, range);
      return range;
    });

  return {
    /** @param {string} fromSha @param {string} toSha */
    readBaseMovement: (fromSha, toSha) =>
      readArtifactBaseMovement(repoRoot, source, fromSha, toSha, control),
    /** @param {string} path @param {string} ref */
    readBlob: (path, ref) =>
      readImmutableHistory(`${repoRoot}:blob:${ref}:${path}`, async () => {
        try {
          return (
            await gitBufferWithInput(repoRoot, ['show', `${ref}:${path}`], '', {
              maxOutputBytes: MAX_BLOB_ARTIFACT_BYTES,
            })
          ).toString('utf8');
        } catch {
          return null;
        }
      }),
    /** @param {string} sha */
    readCommitDiff: async (sha) => {
      const cached = commitArtifacts.get(sha);
      if (cached) {
        return artifactToChangedFiles(cached);
      }
      const parent = (
        await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^`])
      ).trim();
      const run = await getGitLabComparisonArtifactRun(repoRoot, source, control);
      const artifacts = await run.readCommitArtifacts(
        [{ commitSha: sha, parentSha: parent || null }],
        control.signal || run.signal,
      );
      const artifact = artifacts.get(sha);
      if (!artifact) {
        throw new Error(`Commit Artifact ${sha.slice(0, 7)} is unavailable.`);
      }
      commitArtifacts.set(sha, artifact);
      return artifactToChangedFiles(artifact);
    },
    /** @param {ReadonlyArray<import('../../core/lib/review-artifacts.ts').CommitArtifactRequest>} commits @param {AbortSignal} [signal] */
    readCommitArtifacts: async (commits, signal) => {
      const run = await getGitLabComparisonArtifactRun(repoRoot, source, control);
      const artifacts = await run.readCommitArtifacts(
        commits,
        signal || control.signal || run.signal,
      );
      for (const [sha, artifact] of artifacts) {
        commitArtifacts.set(sha, artifact);
      }
      return artifacts;
    },
    /** @param {string} sha */
    readCommitPatchFiles: (sha) =>
      readImmutableHistory(`${repoRoot}:commit-patch:${sha}`, async () => {
        const parent = (
          await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^`])
        ).trim();
        const run = await getGitLabComparisonArtifactRun(repoRoot, source, control);
        const artifacts = await run.readCommitArtifacts(
          [{ commitSha: sha, parentSha: parent || null }],
          control.signal || run.signal,
        );
        const artifact = artifacts.get(sha);
        if (!artifact) {
          throw new Error(`Commit Artifact ${sha.slice(0, 7)} is unavailable.`);
        }
        commitArtifacts.set(sha, artifact);
        return artifactToReplayPatchFiles(artifact);
      }),
    /** @param {string} baseSha @param {string} headSha */
    readCommitStack: (baseSha, headSha) =>
      readImmutableHistory(
        `${repoRoot}:commit-stack:${baseSha}:${headSha}`,
        async () => {
          const run = await getGitLabComparisonArtifactRun(repoRoot, source, control);
          const { stack } = await run.readStackAndRange(
            { headSha: headSha, requestedBaseSha: baseSha },
            control.signal || run.signal,
          );
          return stack.commits.map((commit) => toGitLabEvolutionCommit(commit, source));
        },
        { shareInFlight: control.signal == null },
      ),
    /** @param {string} fromSha @param {string} toSha */
    readRangeDiff: (fromSha, toSha) =>
      readRangeArtifact(fromSha, toSha).then((range) => rangeArtifactToChangedFiles(range)),
    /** @param {string} fromSha @param {string} toSha */
    readRangePatchFiles: (fromSha, toSha) =>
      readRangeArtifact(fromSha, toSha).then((range) => ({
        coverage: range.coverage,
        files: artifactToReplayPatchFiles(range),
      })),
    /** @param {ReadonlyArray<{path: string, ref: string}>} requests */
    readReplayBlobs: async (requests) => {
      const run = await getGitLabComparisonArtifactRun(repoRoot, source, control);
      return createArtifactBlobLookup(
        repoRoot,
        run,
        [...rangeArtifacts.values(), ...commitArtifacts.values()],
        control.signal || run.signal,
      )(requests);
    },
  };
};

/**
 * @param {PullRequestSource} source
 */
const assertGitLabSource = (source) => {
  if (source.provider !== 'gitlab') {
    throw new Error('GitLab review history requires a GitLab merge request source.');
  }
  if (!source.host?.trim()) {
    throw new Error('GitLab review history requires a host on the merge request source.');
  }
  if (!source.projectPath?.trim()) {
    throw new Error('GitLab review history requires a projectPath on the merge request source.');
  }
  if (!source.number || !Number.isInteger(source.number) || source.number <= 0) {
    throw new Error('GitLab review history requires a merge request number.');
  }
  return {
    host: source.host,
    iid: source.number,
    projectPath: source.projectPath,
  };
};

/** @param {PullRequestSource} source @returns {import('../../core/lib/review-artifacts.ts').ReviewArtifactProject} */
const reviewArtifactProject = (source) => gitlabArtifactProject(source);

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 */
const createTransportForSource = (repoRoot, source, signal) => {
  const { host } = assertGitLabSource(source);
  return createGlabGitLabTransport({ hostname: host, repoRoot, signal });
};

/**
 * @param {any} unit
 */
const toGitLabAlgorithmUnit = (unit) => {
  if (!unit.reviewable) {
    throw new Error('This commit evolution unit is not reviewable.');
  }
  const kind =
    unit.kind === 'introduced'
      ? 'added'
      : unit.kind === 'removed'
        ? 'removed'
        : unit.kind === 'revised'
          ? 'likely-revised'
          : unit.kind === 'rewritten-same-patch'
            ? 'same-patch'
            : unit.kind === 'retained'
              ? 'unchanged'
              : unit.kind === 'ambiguous'
                ? 'likely-revised'
                : null;
  if (!kind) {
    throw new Error(`Unsupported reviewable GitLab evolution unit kind: ${unit.kind}.`);
  }
  return {
    confidence: unit.confidence,
    kind,
    order: unit.order,
    reviewable: true,
    unitId: unit.unitId,
    ...(unit.after ? { after: unit.after } : {}),
    ...(unit.before ? { before: unit.before } : {}),
    ...(unit.baseCommit ? { baseCommit: unit.baseCommit } : {}),
  };
};

/**
 * @param {import('../../gitlab/src/version-compare.ts').MergeRequestVersionRef} version
 * @param {{
 *   activity?: ReviewVersionOption['activity'],
 *   diffStat?: ReviewVersionOption['diffStat'],
 *   isHead?: boolean,
 *   number?: number,
 *   previousCreatedAt?: string,
 *   previousNumber?: number,
 * }} [extra]
 * @param {typeof import('../../gitlab/dist/index.mjs')} gitlab
 */
const toReviewVersionOption = (version, extra, gitlab) =>
  gitlab.projectMergeRequestVersionRef({
    ...version,
    ...(extra?.activity ? { activity: extra.activity } : {}),
    ...(extra?.diffStat ? { diffStat: extra.diffStat } : {}),
    ...(extra?.isHead != null ? { isHead: extra.isHead } : {}),
    ...(extra?.number != null ? { number: extra.number } : {}),
    ...(extra?.previousCreatedAt ? { previousCreatedAt: extra.previousCreatedAt } : {}),
    ...(extra?.previousNumber != null ? { previousNumber: extra.previousNumber } : {}),
  });

/** @param {string} repoRoot @param {PullRequestSource} source */
const loadGitLabVersionRefs = async (repoRoot, source) => {
  assertGitLabSource(source);
  const transport = createTransportForSource(repoRoot, source);
  return readImmutableHistory(`${sourceCacheKey(source)}:versions`, () =>
    loadGitLabReviewVersionTimeline(source, transport),
  );
};

/**
 * Build the minimum Core version selector including a synthetic MR-base
 * endpoint so the UI can compare base → v1 the same way Web does. Reviewer
 * activity is added by a separate deferred projection.
 *
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @returns {Promise<ReadonlyArray<ReviewVersionOption>>}
 */
const listGitLabReviewVersionOptions = async (repoRoot, source) => {
  return readImmutableHistory(`${sourceCacheKey(source)}:options`, async () => {
    const gitlab = await loadGitLabHistory();
    const versions = await loadGitLabVersionRefs(repoRoot, source);
    if (versions.length === 0) {
      return [];
    }

    const first = versions[0];
    const baseOption = toReviewVersionOption(
      {
        baseSha: first.baseSha,
        createdAt: first.createdAt,
        headSha: first.baseSha,
        label: 'MR base',
        startSha: first.baseSha,
        versionId: MR_BASE_VERSION_ID,
      },
      {
        isHead: false,
        number: 0,
      },
      gitlab,
    );

    const options = versions.map((version, index) =>
      toReviewVersionOption(
        version,
        {
          isHead: index === versions.length - 1,
          number: index + 1,
          ...(index > 0
            ? {
                previousCreatedAt: versions[index - 1].createdAt,
                previousNumber: index,
              }
            : {}),
        },
        gitlab,
      ),
    );

    return [baseOption, ...options];
  });
};

/** @param {import('../../core/types.ts').Revision} revision */
const revisionSha = (revision) => ('sha' in revision ? revision.sha : null);

/** @param {string} repoRoot @param {PullRequestSource} source @param {string} baseSha @param {string} headSha */
const ensureGitLabCurrentRange = async (repoRoot, source, baseSha, headSha) => {
  const [base, head] = await Promise.all([
    gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${baseSha}^{commit}`]),
    gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${headSha}^{commit}`]),
  ]);
  if (base.trim() && head.trim()) {
    return;
  }
  const remote = readReviewRemotes(repoRoot)
    .filter(
      (candidate) =>
        candidate.direction === 'fetch' &&
        candidate.provider === 'gitlab' &&
        candidate.host.toLowerCase() === source.host?.toLowerCase() &&
        candidate.projectPath.toLowerCase() === source.projectPath?.toLowerCase(),
    )
    .sort((left, right) => (left.name === 'origin' ? -1 : right.name === 'origin' ? 1 : 0))[0];
  if (!remote || !source.number) {
    throw new Error('The GitLab review does not match a fetch remote in this repository.');
  }
  await git(repoRoot, [
    'fetch',
    '--no-tags',
    remote.name,
    `+refs/merge-requests/${source.number}/head:refs/codiff/merge-requests/${source.number}/head`,
    ...(source.targetBranch
      ? [`+refs/heads/${source.targetBranch}:refs/codiff/merge-requests/${source.number}/base`]
      : []),
  ]);
  const [resolvedBase, resolvedHead] = await Promise.all([
    gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${baseSha}^{commit}`]),
    gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${headSha}^{commit}`]),
  ]);
  if (!resolvedBase.trim() || !resolvedHead.trim()) {
    throw new Error('The current GitLab review range is unavailable after fetching its refs.');
  }
};

/**
 * Read the current MR stack/sidebar through the canonical native Artifact
 * Source after verifying the provider's hidden head and target refs.
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {number} [limit]
 */
const listGitLabRepositoryHistory = async (repoRoot, source, limit = 200) => {
  const versions = await listGitLabReviewVersions(repoRoot, source, { includeActivity: false });
  const current = versions.find((version) => version.isHead) || versions.at(-1);
  const baseSha = current ? revisionSha(current.range.base) : null;
  const headSha = current ? revisionSha(current.range.head) : null;
  if (!baseSha || !headSha) {
    return { entries: [], root: repoRoot };
  }
  await ensureGitLabCurrentRange(repoRoot, source, baseSha, headSha);
  const artifactRun = getGitLabComparisonArtifactRun(repoRoot, source);
  return listArtifactRepositoryHistory(
    repoRoot,
    reviewArtifactProject(source),
    baseSha,
    headSha,
    limit,
    {},
    artifactRun,
  );
};

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {{includeActivity?: boolean}} [options]
 * @returns {Promise<ReadonlyArray<ReviewVersionOption>>}
 */
const listGitLabReviewVersions = async (repoRoot, source, options = {}) => {
  const versionOptions = await listGitLabReviewVersionOptions(repoRoot, source);
  if (options.includeActivity === false || versionOptions.length === 0) {
    return versionOptions;
  }
  return readImmutableHistory(`${sourceCacheKey(source)}:options:activity`, async () => {
    const { iid, projectPath } = assertGitLabSource(source);
    const [gitlab, versions] = await Promise.all([
      loadGitLabHistory(),
      loadGitLabVersionRefs(repoRoot, source),
    ]);
    const transport = createTransportForSource(repoRoot, source);
    const activityTransport = {
      ...transport,
      requestPages: (request) =>
        request.path.endsWith(`/merge_requests/${iid}/discussions`)
          ? loadGitLabReviewDiscussions(source, transport)
          : transport.requestPages(request),
    };
    const activity = await gitlab.fetchGitLabMergeRequestReviewerActivity({
      iid,
      projectPath,
      transport: activityTransport,
      versions,
    });
    return versionOptions.map((version) => {
      const versionActivity = activity.get(version.versionId);
      return versionActivity ? { ...version, activity: versionActivity } : version;
    });
  });
};

/**
 * @param {string} versionId
 * @param {ReadonlyArray<import('../../gitlab/src/version-compare.ts').MergeRequestVersionRef>} versions
 * @returns {import('../../gitlab/src/version-compare.ts').VersionCompareEndpoint}
 */
const toCompareEndpoint = (versionId, versions) => {
  if (versionId === MR_BASE_VERSION_ID) {
    return { kind: 'mr-base' };
  }
  if (versions.some((version) => version.versionId === versionId)) {
    return { kind: 'mr-version', versionId };
  }
  // Fall back to head-sha if the UI passed a synthetic head id.
  if (/^[0-9a-f]{7,40}$/i.test(versionId)) {
    return { headSha: versionId, kind: 'head-sha' };
  }
  return { kind: 'mr-version', versionId };
};

/**
 * @typedef {
 *   | { kind: 'base' }
 *   | { kind: 'version', versionId: string }
 *   | { kind: 'head-sha', sha: string }
 *   | { baseSha: string, commentId: string, headSha: string, kind: 'comment-position', startSha: string }
 * } RequestedCompareEndpoint
 */

/**
 * Resolve host-facing comparison coordinates without discarding the exact
 * diff identity carried by a comment position. GitLab's comparison reader can
 * resolve the comment through discussions, while commit evolution needs the
 * durable identity directly because it does not load discussion notes.
 *
 * @param {RequestedCompareEndpoint | undefined} endpoint
 * @param {string | undefined} fallbackVersionId
 * @param {ReadonlyArray<import('../../gitlab/src/version-compare.ts').MergeRequestVersionRef>} versions
 * @param {boolean} [forCommitEvolution]
 * @returns {import('../../gitlab/src/version-compare.ts').VersionCompareEndpoint}
 */
const toRequestedCompareEndpoint = (
  endpoint,
  fallbackVersionId,
  versions,
  forCommitEvolution = false,
) => {
  if (!endpoint) {
    if (!fallbackVersionId) {
      throw new Error('A review comparison endpoint is required.');
    }
    return toCompareEndpoint(fallbackVersionId, versions);
  }
  if (endpoint.kind === 'base') {
    return { kind: 'mr-base' };
  }
  if (endpoint.kind === 'version') {
    return toCompareEndpoint(endpoint.versionId, versions);
  }
  if (endpoint.kind === 'head-sha') {
    return { headSha: endpoint.sha, kind: 'head-sha' };
  }
  return forCommitEvolution
    ? {
        baseSha: endpoint.baseSha,
        headSha: endpoint.headSha,
        kind: 'diff-identity',
        startSha: endpoint.startSha,
      }
    : { commentId: endpoint.commentId, kind: 'comment-position' };
};

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {{
 *   from?: RequestedCompareEndpoint,
 *   fromVersionId?: string,
 *   to?: RequestedCompareEndpoint,
 *   toVersionId?: string,
 * }} range
 * @returns {Promise<{
 *   versionCompare: DiffComparisonView,
 *   versionCommitEvolution: ReviewCommitEvolution | null,
 *   versionCommitEvolutionError: string | null,
 * }>}
 */
const resolveGitLabReviewComparison = async (repoRoot, source, range, control = {}) => {
  const { iid, projectPath } = assertGitLabSource(source);
  const transport = createTransportForSource(repoRoot, source, control.signal);
  const gitlab = await loadGitLabHistory();
  const versions = await loadGitLabVersionRefs(repoRoot, source);
  if (versions.length === 0) {
    throw new Error('GitLab did not return merge request versions.');
  }

  return {
    evolutionFromEndpoint: toRequestedCompareEndpoint(
      range.from,
      range.fromVersionId,
      versions,
      true,
    ),
    evolutionToEndpoint: toRequestedCompareEndpoint(range.to, range.toVersionId, versions, true),
    fromEndpoint: toRequestedCompareEndpoint(range.from, range.fromVersionId, versions),
    gitlab,
    iid,
    onReplayDiagnostics: control.onReplayDiagnostics,
    projectPath,
    readers: createLocalReaders(repoRoot, source, control),
    repoRoot,
    signal: control.signal,
    source,
    toEndpoint: toRequestedCompareEndpoint(range.to, range.toVersionId, versions),
    transport,
    versions,
  };
};

const loadGitLabReviewVersionAggregate = async (context) => {
  const {
    fromEndpoint,
    gitlab,
    iid,
    onReplayDiagnostics,
    projectPath,
    readers,
    signal,
    source,
    toEndpoint,
    transport,
    versions,
  } = context;
  const cachePrefix = `${source.host}:${projectPath}:${iid}`;
  const compare = await gitlab.fetchGitLabMergeRequestVersionCompare({
    from: fromEndpoint,
    iid,
    ...(onReplayDiagnostics ? { onReplayDiagnostics } : {}),
    projectPath,
    readBaseMovement: readers.readBaseMovement,
    readCached: ({ from, to }) =>
      versionCompareCache.get(
        `${cachePrefix}:${from.baseSha}:${from.headSha}:${to.baseSha}:${to.headSha}`,
      ) || null,
    readBlob: async () => null,
    readBlobs: readers.readReplayBlobs,
    readRangeFiles: (baseSha, headSha) => readers.readRangePatchFiles(baseSha, headSha),
    ...(signal ? { signal } : {}),
    to: toEndpoint,
    transport,
    versions,
    writeCached: (value) => {
      versionCompareCache.set(
        `${cachePrefix}:${value.range.from.baseSha}:${value.range.from.headSha}:${value.range.to.baseSha}:${value.range.to.headSha}`,
        value,
      );
    },
  });
  return gitlab.projectVersionCompare(compare);
};

const loadGitLabReviewVersionEvolution = async (context, control = {}) => {
  const {
    evolutionFromEndpoint,
    evolutionToEndpoint,
    gitlab,
    iid,
    projectPath,
    readers,
    repoRoot,
    source,
    transport,
    versions,
  } = context;
  const cachePrefix = `${source.host}:${projectPath}`;
  const fingerprintKey = (sha) => ({
    algorithmVersion: FINGERPRINT_CACHE_VERSION,
    commitSha: sha,
    kind: 'commit-fingerprint',
    project: `${source.host}:${projectPath}`,
    provider: 'gitlab',
  });
  const evolution = await gitlab.fetchGitLabMergeRequestVersionCommitEvolution({
    cache: {
      read: async (shas) =>
        new Map(
          (
            await mapWithConcurrency(shas, maxFingerprintCacheConcurrency, async (sha) => [
              sha,
              versionCommitFingerprintCache.get(`${cachePrefix}:${sha}`) ||
                (await readReviewHistoryCache(fingerprintKey(sha))),
            ])
          ).filter((entry) => entry[1] != null),
        ),
      write: async (fingerprints) => {
        await mapWithConcurrency(
          fingerprints,
          maxFingerprintCacheConcurrency,
          async (fingerprint) => {
            versionCommitFingerprintCache.set(
              `${cachePrefix}:${fingerprint.commitSha}`,
              fingerprint,
            );
            await writeReviewHistoryCache(fingerprintKey(fingerprint.commitSha), fingerprint);
          },
        );
      },
    },
    control,
    from: evolutionFromEndpoint,
    iid,
    project: {
      host: source.host,
      project: projectPath,
      provider: 'gitlab',
    },
    projectPath,
    readers,
    to: evolutionToEndpoint,
    transport,
    versions,
  });
  const projected = gitlab.projectCommitEvolution(evolution);
  const project = reviewArtifactProject(source);
  const artifactRun = await getGitLabComparisonArtifactRun(repoRoot, source, control);
  rememberReviewUnitArtifactRun(repoRoot, project, projected.units, artifactRun);
  return projected;
};

/** Load the aggregate comparison without waiting for evolution classification. */
const compareGitLabReviewVersionAggregate = async (repoRoot, source, range, control = {}) => {
  control.signal?.throwIfAborted();
  const diagnosticsControl = {
    ...control,
    onReplayDiagnostics: (diagnostics) =>
      recordComparisonRunMetric(control, {
        kind: 'regional-replay',
        provider: 'gitlab',
        ...diagnostics,
      }),
  };
  const comparison = await readImmutableHistory(
    `${sourceCacheKey(source)}:aggregate:${JSON.stringify(range)}`,
    async () =>
      loadGitLabReviewVersionAggregate(
        await resolveGitLabReviewComparison(repoRoot, source, range, diagnosticsControl),
      ),
    { shareInFlight: control.signal == null },
  );
  control.signal?.throwIfAborted();
  return comparison;
};

/** Load commit evolution independently, reusing immutable versions and fingerprints. */
const classifyGitLabReviewVersionEvolution = async (repoRoot, source, range, control = {}) => {
  const diagnosticsControl = {
    ...control,
    onMatcherDiagnostics: (diagnostics) =>
      recordComparisonRunMetric(control, {
        kind: 'commit-matching',
        provider: 'gitlab',
        ...diagnostics,
      }),
  };
  return readImmutableHistory(
    `${sourceCacheKey(source)}:evolution:${JSON.stringify(range)}`,
    async () =>
      loadGitLabReviewVersionEvolution(
        await resolveGitLabReviewComparison(repoRoot, source, range, diagnosticsControl),
        diagnosticsControl,
      ),
    { shareInFlight: control.signal == null },
  );
};

const compareGitLabReviewVersions = async (repoRoot, source, range) => {
  const context = await resolveGitLabReviewComparison(repoRoot, source, range);

  const [versionCompare, evolutionResult] = await Promise.all([
    loadGitLabReviewVersionAggregate(context),
    loadGitLabReviewVersionEvolution(context).then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ reason, status: 'rejected' }),
    ),
  ]);
  if (evolutionResult.status === 'fulfilled') {
    return {
      versionCommitEvolution: evolutionResult.value,
      versionCommitEvolutionError: null,
      versionCompare,
    };
  }

  return {
    versionCommitEvolution: null,
    versionCommitEvolutionError:
      evolutionResult.reason instanceof Error
        ? evolutionResult.reason.message
        : String(evolutionResult.reason),
    versionCompare,
  };
};

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {import('../../gitlab/src/version-commit-evolution.ts').VersionCommitEvolutionUnit | import('../../core/types.ts').ReviewEvolutionUnit} unit
 * @returns {Promise<ReadonlyArray<ChangedFile>>}
 */
const loadGitLabVersionCommitUnitDiff = async (repoRoot, source, unit) => {
  const { projectPath } = assertGitLabSource(source);
  const cached = await materializeReviewUnitFromArtifacts(
    repoRoot,
    reviewArtifactProject(source),
    unit,
  );
  if (cached) {
    return cached;
  }
  const transport = createTransportForSource(repoRoot, source);
  const gitlab = await loadGitLabHistory();
  // Core projected units use kind names like 'introduced'/'removed'; package
  // algorithm units use 'added'/'removed'/'likely-revised'. Prefer the raw unit
  // shape when the host still holds algorithm units; otherwise reconstruct.
  /** @type {any} */
  const algorithmUnit = unit;
  // Projected Core ambiguity uses the same replay materializer as a revised
  // unit while the original unit remains explicitly ambiguous to the walkthrough.
  const materializedUnit =
    algorithmUnit.kind === 'added' ||
    algorithmUnit.kind === 'removed' ||
    algorithmUnit.kind === 'likely-revised' ||
    algorithmUnit.kind === 'unchanged' ||
    algorithmUnit.kind === 'same-patch' ||
    algorithmUnit.kind === 'absorbed-into-base' ||
    algorithmUnit.kind === 'unmatched-old' ||
    algorithmUnit.kind === 'unmatched-new'
      ? algorithmUnit
      : toGitLabAlgorithmUnit(algorithmUnit);
  const identity = [
    materializedUnit.unitId,
    materializedUnit.before?.sha,
    materializedUnit.after?.sha,
  ].join(':');
  return readImmutableHistory(`${repoRoot}:gitlab-unit:${identity}`, () =>
    gitlab.fetchGitLabVersionCommitUnitDiff({
      projectPath,
      readers: createLocalReaders(repoRoot, source),
      transport,
      unit: materializedUnit,
    }),
  );
};

module.exports = {
  MR_BASE_VERSION_ID,
  classifyGitLabReviewVersionEvolution,
  compareGitLabReviewVersionAggregate,
  compareGitLabReviewVersions,
  listGitLabRepositoryHistory,
  listGitLabReviewVersions,
  loadGitLabVersionCommitUnitDiff,
  readLocalCommitStack,
  toGitLabEvolutionCommit,
  toRequestedCompareEndpoint,
  toGitLabAlgorithmUnit,
};
