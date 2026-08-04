// @ts-check

/**
 * Local GitHub review-history adapter over gh transport + @nkzw/codiff-github.
 *
 * Process spawning (gh, git fetch) stays here. Pure force-push timeline and
 * compare/evolution projection live in the package.
 */

const { createGhGitHubTransport } = require('./gh-github-transport.cjs');
const { getCommandActionSignal } = require('../../command-log.cjs');
const { git, gitOrEmpty } = require('../common.cjs');
const { rangeArtifactToChangedFiles } = require('../commit-artifacts.cjs');
const { readRangeState } = require('../commit.cjs');
const {
  artifactToReplayPatchFiles,
  createArtifactBlobLookup,
  getComparisonArtifactRun,
  listArtifactRepositoryHistory,
  materializeReviewUnitFromArtifacts,
  recordComparisonRunMetric,
  rememberReviewUnitArtifactRun,
} = require('../review-artifact-run.cjs');
const {
  getGitHubComparisonArtifactRun,
  githubArtifactProject,
} = require('../provider-artifact-sources.cjs');
const { loadGitHubHistory } = require('../../github-history-bridge.cjs');
const { createImmutableCache } = require('../../immutable-cache.cjs');
const {
  readReviewHistoryCache,
  writeReviewHistoryCache,
} = require('../../review-history-cache.cjs');
const { mapWithConcurrency } = require('../../bounded-map.cjs');
const { readReviewRemotes } = require('../../review-source.cjs');

const fingerprintCache = new Map();
const FINGERPRINT_CACHE_VERSION = 'commit-fingerprint-v3:bulk-diff-tree-v1';
const maxFingerprintCacheConcurrency = 8;
const readImmutableHistory = createImmutableCache();

/**
 * @typedef {import('../../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../../core/lib/review-artifacts.ts').ReviewArtifactProject} ReviewArtifactProject
 * @typedef {import('../../../core/types.ts').ReviewEvolutionUnit} ReviewEvolutionUnit
 * @typedef {import('../../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../../../core/types.ts').ReviewVersionOption} ReviewVersionOption
 * @typedef {Extract<ReviewSource, { type: 'pull-request' }>} PullRequestSource
 */

/**
 * @param {PullRequestSource} source
 */
const assertGitHubSource = (source) => {
  if (source.provider && source.provider !== 'github') {
    throw new Error('GitHub review history requires a GitHub pull request source.');
  }
  if (!source.owner?.trim() || !source.repo?.trim()) {
    throw new Error('GitHub review history requires owner and repo on the pull request source.');
  }
  if (!source.number || !Number.isInteger(source.number) || source.number <= 0) {
    throw new Error('GitHub review history requires a pull request number.');
  }
  return {
    headSha: source.headSha ?? null,
    number: source.number,
    owner: source.owner,
    repo: source.repo,
  };
};

/** @param {string} repoRoot @param {PullRequestSource | undefined} source @returns {ReviewArtifactProject} */
const reviewArtifactProject = (repoRoot, source) =>
  source?.owner && source.repo
    ? githubArtifactProject(source)
    : { host: 'local', project: repoRoot, provider: 'git' };

/** @param {string} repoRoot @param {PullRequestSource | undefined} source @param {{comparisonRun?: {artifactRuns?: Map<string, Promise<any>>}, signal?: AbortSignal}} control */
const getArtifactRun = (repoRoot, source, control) =>
  source
    ? getGitHubComparisonArtifactRun(repoRoot, source, control)
    : getComparisonArtifactRun(repoRoot, reviewArtifactProject(repoRoot, source), control);

/**
 * @param {string} sha
 */
const shortSha = (sha) => sha.slice(0, 7);

/**
 * @param {string} repoRoot
 * @param {string} sha
 * @param {ReadonlyArray<{owner: string; repo: string}>} [repositories]
 * @param {AbortSignal} [signal]
 */
const ensureCommitAvailable = async (repoRoot, sha, repositories = [], signal) => {
  signal?.throwIfAborted();
  const existing = (
    await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { signal })
  ).trim();
  if (existing) {
    return existing;
  }

  let remotes = [];
  try {
    remotes = readReviewRemotes(repoRoot);
  } catch {
    remotes = [];
  }
  const repositoryOrder = new Map(
    repositories.map((repository, index) => [
      `${repository.owner}/${repository.repo}`.toLowerCase(),
      index,
    ]),
  );
  const matchingRemotes = remotes
    .filter((remote) => {
      if (remote.direction !== 'fetch' || remote.provider !== 'github') {
        return false;
      }
      return repositoryOrder.has(remote.projectPath.toLowerCase());
    })
    .sort((left, right) => {
      const leftOrder = repositoryOrder.get(left.projectPath.toLowerCase()) ?? Infinity;
      const rightOrder = repositoryOrder.get(right.projectPath.toLowerCase()) ?? Infinity;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return left.name === 'origin' ? -1 : right.name === 'origin' ? 1 : 0;
    });
  const candidates =
    repositories.length === 0
      ? remotes
          .filter((remote) => remote.direction === 'fetch' && remote.name === 'origin')
          .slice(0, 1)
      : [...new Map(matchingRemotes.map((remote) => [remote.name, remote])).values()];

  for (const remote of candidates) {
    signal?.throwIfAborted();
    try {
      await git(repoRoot, ['fetch', '--no-tags', remote.name, sha], { signal });
    } catch {
      signal?.throwIfAborted();
      try {
        await git(repoRoot, ['fetch', '--no-tags', '--depth=1', remote.name, sha], { signal });
      } catch {
        signal?.throwIfAborted();
        // Try the next matching repository.
      }
    }
    const fetched = (
      await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], {
        signal,
      })
    ).trim();
    if (fetched) {
      return fetched;
    }
  }

  const after = (
    await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { signal })
  ).trim();
  if (!after) {
    throw new Error(
      `Commit ${shortSha(sha)} is not available locally. Fetch the pull request refs or run \`git fetch origin ${sha}\`.`,
    );
  }
  return after;
};

/**
 * @param {string} repoRoot
 * @param {string} base
 * @param {string} head
 */
const readCommitStack = async (repoRoot, base, head) => {
  const raw = await gitOrEmpty(repoRoot, [
    'log',
    '--format=%H%x00%P%x00%an%x00%aI%x00%s',
    `${base}..${head}`,
  ]);
  if (!raw.trim()) {
    return [];
  }
  const commits = raw
    .trim()
    .split('\n')
    .map((line) => {
      const [sha, parents, authorName, authoredAt, subject] = line.split('\0');
      return {
        authorName: authorName || 'Unknown',
        authoredAt: authoredAt || new Date(0).toISOString(),
        parentShas: parents ? parents.split(' ').filter(Boolean) : [],
        sha,
        shortSha: shortSha(sha),
        subject: subject || sha.slice(0, 7),
      };
    });
  const github = await loadGitHubHistory();
  return github.orderReviewCommitStack(commits);
};

/**
 * @param {string} repoRoot
 * @param {string} sha
 */
const readCommitMeta = async (repoRoot, sha) => {
  const raw = (
    await gitOrEmpty(repoRoot, ['log', '-1', '--format=%H%x00%P%x00%an%x00%aI%x00%s', sha])
  ).trim();
  if (!raw) {
    throw new Error(`Commit ${shortSha(sha)} metadata is unavailable.`);
  }
  const [fullSha, parents, authorName, authoredAt, subject] = raw.split('\0');
  return {
    authorName: authorName || 'Unknown',
    authoredAt: authoredAt || new Date(0).toISOString(),
    parentShas: parents ? parents.split(' ').filter(Boolean) : [],
    sha: fullSha || sha,
    shortSha: shortSha(fullSha || sha),
    subject: subject || shortSha(fullSha || sha),
  };
};

/**
 * @param {string} repoRoot
 * @param {string} ancestor
 * @param {string} descendant
 */
const isAncestor = async (repoRoot, ancestor, descendant) => {
  try {
    await git(repoRoot, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
};

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} [source]
 * @param {{comparisonRun?: {artifactRuns?: Map<string, Promise<any>>}, signal?: AbortSignal}} [control]
 */
const createLocalGit = (repoRoot, source, control = {}) => {
  const commitArtifacts = new Map();
  const rangeArtifacts = new Map();
  const readRangeArtifact = (base, head) =>
    readImmutableHistory(
      `${repoRoot}:range-artifact:${base}:${head}`,
      async () => {
        const run = await getArtifactRun(repoRoot, source, control);
        const { range } = await run.readStackAndRange(
          { headSha: head, requestedBaseSha: base },
          control.signal || run.signal,
        );
        return range;
      },
      { shareInFlight: control.signal == null },
    ).then((range) => {
      rangeArtifacts.set(`${base}:${head}`, range);
      return range;
    });

  return {
    ensureCommit: (
      /** @type {string} */ sha,
      /** @type {{repositories?: ReadonlyArray<{owner: string; repo: string}>, signal?: AbortSignal}} */ options = {},
    ) => {
      const signal = options.signal || control.signal;
      signal?.throwIfAborted();
      return readImmutableHistory(
        `${repoRoot}:ensure:${sha}`,
        async () => {
          signal?.throwIfAborted();
          const resolved = await ensureCommitAvailable(repoRoot, sha, options.repositories, signal);
          signal?.throwIfAborted();
          return resolved;
        },
        { shareInFlight: signal == null },
      );
    },
    /**
     * @param {string} ancestor
     * @param {string} descendant
     */
    isAncestor: (ancestor, descendant) =>
      readImmutableHistory(`${repoRoot}:ancestor:${ancestor}:${descendant}`, () =>
        isAncestor(repoRoot, ancestor, descendant),
      ),
    /**
     * @param {string} left
     * @param {string} right
     */
    mergeBase: async (left, right) => {
      return readImmutableHistory(`${repoRoot}:merge-base:${left}:${right}`, async () => {
        const base = (await gitOrEmpty(repoRoot, ['merge-base', left, right])).trim();
        if (!base) {
          throw new Error(
            `No merge base is available for ${shortSha(left)} and ${shortSha(right)}.`,
          );
        }
        return base;
      });
    },
    /** @param {ReadonlyArray<import('../../../core/lib/review-artifacts.ts').CommitArtifactRequest>} commits @param {AbortSignal} [signal] */
    readCommitArtifacts: async (commits, signal) => {
      const run = await getArtifactRun(repoRoot, source, control);
      const artifacts = await run.readCommitArtifacts(
        commits,
        signal || control.signal || run.signal,
      );
      for (const [sha, artifact] of artifacts) {
        commitArtifacts.set(sha, artifact);
      }
      return artifacts;
    },
    /**
     * @param {string} sha
     */
    readCommitDiff: (sha) =>
      readImmutableHistory(`${repoRoot}:commit-diff:${sha}`, async () => {
        const parent = (
          await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^`])
        ).trim();
        const state = await readRangeState(repoRoot, parent || `${sha}^`, sha, false);
        return state.files;
      }),
    /** @param {string} sha */
    readCommitPatchFiles: (sha) =>
      readImmutableHistory(`${repoRoot}:commit-patch:${sha}`, async () => {
        const parent = (
          await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^`])
        ).trim();
        const run = await getArtifactRun(repoRoot, source, control);
        const artifacts = await run.readCommitArtifacts(
          [{ commitSha: sha, parentSha: parent || null }],
          control.signal || run.signal,
        );
        const artifact = artifacts.get(sha);
        if (!artifact) {
          throw new Error(`Commit Artifact ${shortSha(sha)} is unavailable.`);
        }
        commitArtifacts.set(sha, artifact);
        return artifactToReplayPatchFiles(artifact);
      }),
    /**
     * @param {string} sha
     */
    readCommitMeta: (sha) =>
      readImmutableHistory(`${repoRoot}:commit-meta:${sha}`, () => readCommitMeta(repoRoot, sha)),
    /**
     * @param {string} base
     * @param {string} head
     */
    readCommitStack: (base, head) =>
      readImmutableHistory(
        `${repoRoot}:commit-stack:${base}:${head}`,
        async () => {
          const run = await getArtifactRun(repoRoot, source, control);
          return (
            await run.readStackAndRange(
              { headSha: head, requestedBaseSha: base },
              control.signal || run.signal,
            )
          ).stack.commits;
        },
        { shareInFlight: control.signal == null },
      ),
    /**
     * @param {string} base
     * @param {string} head
     * @param {boolean} symmetric
     * @param {AbortSignal} [signal]
     */
    readRangeFiles: async (base, head, symmetric, signal) => {
      const activeSignal = signal || control.signal;
      activeSignal?.throwIfAborted();
      const files = await readImmutableHistory(
        `${repoRoot}:range:${base}:${head}:${symmetric}`,
        async () => {
          activeSignal?.throwIfAborted();
          if (!symmetric) {
            const range = await readRangeArtifact(base, head);
            activeSignal?.throwIfAborted();
            return rangeArtifactToChangedFiles(range);
          }
          const state = await readRangeState(repoRoot, base, head, symmetric);
          activeSignal?.throwIfAborted();
          return state.files;
        },
        { shareInFlight: activeSignal == null },
      );
      activeSignal?.throwIfAborted();
      return files;
    },
    /** @param {string} base @param {string} head @param {AbortSignal} [signal] */
    readRangePatchFiles: async (base, head, signal) => {
      const activeSignal = signal || control.signal;
      activeSignal?.throwIfAborted();
      const files = await readImmutableHistory(
        `${repoRoot}:range-patch:${base}:${head}`,
        async () => {
          activeSignal?.throwIfAborted();
          const range = await readRangeArtifact(base, head);
          activeSignal?.throwIfAborted();
          return {
            coverage: range.coverage,
            files: artifactToReplayPatchFiles(range),
          };
        },
        { shareInFlight: activeSignal == null },
      );
      activeSignal?.throwIfAborted();
      return files;
    },
    /** @param {ReadonlyArray<{path: string, ref: string}>} requests */
    readReplayBlobs: async (requests) => {
      const run = await getArtifactRun(repoRoot, source, control);
      return createArtifactBlobLookup(
        repoRoot,
        run,
        [...rangeArtifacts.values(), ...commitArtifacts.values()],
        control.signal || run.signal,
      )(requests);
    },
  };
};

/** @param {string} repoRoot @param {{headSha?: string, number: number, owner: string, repo: string}} pull */
const githubReviewVersionTimelineKey = (repoRoot, pull) =>
  [
    repoRoot,
    'github-version-timeline',
    `${pull.owner}/${pull.repo}#${pull.number}`,
    pull.headSha || 'unknown-head',
  ].join(':');

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 */
const loadGitHubReviewVersionTimeline = async (repoRoot, source) => {
  const pull = assertGitHubSource(source);
  const signal = getCommandActionSignal();
  return readImmutableHistory(
    githubReviewVersionTimelineKey(repoRoot, pull),
    async () => {
      signal?.throwIfAborted();
      const github = /** @type {any} */ (await loadGitHubHistory());
      const timeline = await github.listGitHubReviewVersionTimeline({
        git: createLocalGit(repoRoot, source),
        pull,
        transport: createGhGitHubTransport({ repoRoot }),
      });
      signal?.throwIfAborted();
      return timeline;
    },
    { shareInFlight: signal == null },
  );
};

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {{includeActivity?: boolean}} [options]
 */
const listGitHubReviewVersions = async (repoRoot, source, options = {}) => {
  const pull = assertGitHubSource(source);
  const timelineKey = githubReviewVersionTimelineKey(repoRoot, pull);
  const timeline = await loadGitHubReviewVersionTimeline(repoRoot, source);
  if (options.includeActivity === false) {
    return timeline;
  }
  const signal = getCommandActionSignal();
  const activity = await readImmutableHistory(
    `${timelineKey}:activity`,
    async () => {
      signal?.throwIfAborted();
      const github = /** @type {any} */ (await loadGitHubHistory());
      const result = await github.fetchGitHubPullRequestReviewerActivity({
        pull,
        transport: createGhGitHubTransport({ repoRoot }),
        versions: timeline.versions,
      });
      signal?.throwIfAborted();
      return result;
    },
    { shareInFlight: signal == null },
  );
  return {
    ...timeline,
    versions: timeline.versions.map((version) => {
      const versionActivity = activity.get(version.versionId);
      return versionActivity ? { ...version, activity: versionActivity } : version;
    }),
  };
};

/** @param {import('../../../core/types.ts').Revision} revision */
const revisionSha = (revision) => ('sha' in revision ? revision.sha : null);

/**
 * Read the current PR stack/sidebar through the canonical native Artifact
 * Source after the GitHub timeline loader has verified the immutable heads.
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {number} [limit]
 */
const listGitHubRepositoryHistory = async (repoRoot, source, limit = 200) => {
  const { versions } = await listGitHubReviewVersions(repoRoot, source);
  const current = versions.find((version) => version.isHead) || versions.at(-1);
  const baseSha = current ? revisionSha(current.range.base) : null;
  const headSha = current ? revisionSha(current.range.head) : null;
  if (!baseSha || !headSha) {
    return { entries: [], root: repoRoot };
  }
  const artifactRun = getArtifactRun(repoRoot, source, {});
  return listArtifactRepositoryHistory(
    repoRoot,
    reviewArtifactProject(repoRoot, source),
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
 * @param {{fromVersionId: string, toVersionId: string}} range
 * @param {ReadonlyArray<ReviewVersionOption>} versions
 */
const createGitHubComparisonInput = async (repoRoot, source, range, versions, control = {}) => ({
  github: await loadGitHubHistory(),
  input: {
    git: createLocalGit(repoRoot, source, control),
    ...(control.onReplayDiagnostics ? { onReplayDiagnostics: control.onReplayDiagnostics } : {}),
    pull: assertGitHubSource(source),
    range,
    ...(control.signal ? { signal: control.signal } : {}),
    versions,
  },
});

/**
 * Load aggregate From→To files independently from evolution classification.
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {{fromVersionId: string, toVersionId: string}} range
 * @param {ReadonlyArray<ReviewVersionOption>} versions
 */
const compareGitHubReviewVersionAggregate = async (
  repoRoot,
  source,
  range,
  versions,
  control = {},
) => {
  control.signal?.throwIfAborted();
  const diagnosticsControl = {
    ...control,
    onReplayDiagnostics: (diagnostics) =>
      recordComparisonRunMetric(control, {
        kind: 'regional-replay',
        provider: 'github',
        ...diagnostics,
      }),
  };
  const { github, input } = await createGitHubComparisonInput(
    repoRoot,
    source,
    range,
    versions,
    diagnosticsControl,
  );
  const key = `${repoRoot}:github-aggregate:${range.fromVersionId}:${range.toVersionId}`;
  const comparison = await readImmutableHistory(
    key,
    () => github.compareGitHubReviewVersionAggregate(input),
    {
      shareInFlight: control.signal == null,
    },
  );
  control.signal?.throwIfAborted();
  return comparison;
};

/**
 * Classify commit evolution independently with immutable signature reuse.
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {{fromVersionId: string, toVersionId: string}} range
 * @param {ReadonlyArray<ReviewVersionOption>} versions
 */
const classifyGitHubReviewVersionEvolution = async (
  repoRoot,
  source,
  range,
  versions,
  control = {},
) => {
  const diagnosticsControl = {
    ...control,
    onMatcherDiagnostics: (diagnostics) =>
      recordComparisonRunMetric(control, {
        kind: 'commit-matching',
        provider: 'github',
        ...diagnostics,
      }),
  };
  const { github, input } = await createGitHubComparisonInput(
    repoRoot,
    source,
    range,
    versions,
    diagnosticsControl,
  );
  const key = `${repoRoot}:github-evolution:${range.fromVersionId}:${range.toVersionId}`;
  const project = `${source.owner}/${source.repo}`;
  const fingerprintKey = (sha) => ({
    algorithmVersion: FINGERPRINT_CACHE_VERSION,
    commitSha: sha,
    kind: 'commit-fingerprint',
    project,
    provider: 'github',
  });
  const evolution = await readImmutableHistory(
    key,
    () =>
      github.classifyGitHubReviewVersionEvolution({
        ...input,
        cache: {
          read: async (shas) =>
            new Map(
              (
                await mapWithConcurrency(shas, maxFingerprintCacheConcurrency, async (sha) => [
                  sha,
                  fingerprintCache.get(`${repoRoot}:${sha}`) ||
                    (await readReviewHistoryCache(fingerprintKey(sha))),
                ])
              ).filter((entry) => entry[1] != null),
            ),
          write: async (fingerprints) => {
            await mapWithConcurrency(
              fingerprints,
              maxFingerprintCacheConcurrency,
              async (fingerprint) => {
                fingerprintCache.set(`${repoRoot}:${fingerprint.commitSha}`, fingerprint);
                await writeReviewHistoryCache(fingerprintKey(fingerprint.commitSha), fingerprint);
              },
            );
          },
        },
        control: diagnosticsControl,
      }),
    { shareInFlight: control.signal == null },
  );
  const artifactProject = reviewArtifactProject(repoRoot, source);
  const artifactRun = await getArtifactRun(repoRoot, source, control);
  rememberReviewUnitArtifactRun(repoRoot, artifactProject, evolution.units, artifactRun);
  return evolution;
};

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {{ fromVersionId: string, toVersionId: string }} range
 * @param {ReadonlyArray<ReviewVersionOption>} versions
 */
const compareGitHubReviewVersions = async (repoRoot, source, range, versions) => {
  const [versionCompare, evolutionResult] = await Promise.all([
    compareGitHubReviewVersionAggregate(repoRoot, source, range, versions),
    classifyGitHubReviewVersionEvolution(repoRoot, source, range, versions).then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ reason, status: 'rejected' }),
    ),
  ]);
  return {
    versionCommitEvolution: evolutionResult.status === 'fulfilled' ? evolutionResult.value : null,
    versionCommitEvolutionError:
      evolutionResult.status === 'rejected'
        ? evolutionResult.reason instanceof Error
          ? evolutionResult.reason.message
          : String(evolutionResult.reason)
        : null,
    versionCompare,
  };
};

/**
 * @param {string} repoRoot
 * @param {ReviewEvolutionUnit} unit
 * @returns {Promise<ReadonlyArray<ChangedFile>>}
 */
const loadGitHubVersionCommitUnitDiff = async (repoRoot, unit, source) => {
  const project = reviewArtifactProject(repoRoot, source);
  const cached = await materializeReviewUnitFromArtifacts(repoRoot, project, unit);
  if (cached) {
    return cached;
  }
  const github = await loadGitHubHistory();
  return github.loadGitHubVersionCommitUnitDiff({
    git: createLocalGit(repoRoot, source),
    unit,
  });
};

module.exports = {
  classifyGitHubReviewVersionEvolution,
  compareGitHubReviewVersionAggregate,
  compareGitHubReviewVersions,
  ensureCommitAvailable,
  listGitHubRepositoryHistory,
  listGitHubReviewVersions,
  loadGitHubVersionCommitUnitDiff,
  readCommitStack,
};
