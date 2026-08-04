// @ts-check

/**
 * Provider-neutral local review-history facade.
 * Dispatches to GitLab (native versions) or GitHub (force-push heads).
 */

const {
  classifyGitLabReviewVersionEvolution,
  compareGitLabReviewVersionAggregate,
  listGitLabRepositoryHistory,
  listGitLabReviewVersions,
  loadGitLabVersionCommitUnitDiff,
} = require('./gitlab-review-history.cjs');
const {
  classifyGitHubReviewVersionEvolution,
  compareGitHubReviewVersionAggregate,
  listGitHubRepositoryHistory,
  listGitHubReviewVersions,
  loadGitHubVersionCommitUnitDiff,
} = require('./github-history/github-review-history.cjs');
const { git } = require('./common.cjs');
const { loadReviewArtifacts } = require('../review-artifact-bridge.cjs');
const { loadReviewHistoryCached } = require('../review-history-cache.cjs');

/**
 * Derive persistent cache identity from the built Core exports rather than
 * duplicating algorithm labels in Electron. A failed import remains retryable
 * so a transient build or startup race does not poison later cache lookups.
 *
 * @param {typeof loadReviewArtifacts} loadCore
 */
const createComparisonAlgorithmIdentityLoader = (loadCore) => {
  let comparisonAlgorithmIdentityPromise = null;
  return () => {
    if (!comparisonAlgorithmIdentityPromise) {
      const attempt = loadCore().then((core) => ({
        artifactSchemaVersion: core.reviewArtifactSchemaVersion,
        matcherVersion: core.versionCommitEvolutionAlgorithmVersion,
        projectionVersion: core.regionAwareReplayProjectionVersion,
        replayVersion: core.replayCompareAlgorithmVersion,
      }));
      comparisonAlgorithmIdentityPromise = attempt;
      void attempt.catch(() => {
        if (comparisonAlgorithmIdentityPromise === attempt) {
          comparisonAlgorithmIdentityPromise = null;
        }
      });
    }
    return comparisonAlgorithmIdentityPromise;
  };
};

const loadComparisonAlgorithmIdentity =
  createComparisonAlgorithmIdentityLoader(loadReviewArtifacts);

/**
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').ReviewEvolutionUnit} ReviewEvolutionUnit
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../../core/types.ts').ReviewVersionOption} ReviewVersionOption
 * @typedef {Extract<ReviewSource, { type: 'pull-request' }>} PullRequestSource
 */

/**
 * @param {PullRequestSource} source
 */
const isGitLabSource = (source) => source.provider === 'gitlab';

/**
 * @param {PullRequestSource} source
 */
const isGitHubSource = (source) =>
  source.provider === 'github' ||
  (!source.provider && !source.host) ||
  source.host === 'github.com';

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {{includeActivity?: boolean}} [options]
 * @returns {Promise<{ versions: ReadonlyArray<ReviewVersionOption>, warning?: string | null }>}
 */
const listReviewVersions = async (repoRoot, source, options = {}) => {
  if (isGitLabSource(source)) {
    const versions = await listGitLabReviewVersions(repoRoot, source, options);
    return { versions, warning: null };
  }
  if (isGitHubSource(source)) {
    return listGitHubReviewVersions(repoRoot, source, options);
  }
  return {
    versions: [],
    warning: 'Review history is not available for this pull request provider.',
  };
};

/**
 * Read the current provider review's commit/sidebar history through its
 * canonical local Artifact Source.
 * @param {string} launchPath
 * @param {PullRequestSource} source
 * @param {number} [limit]
 */
const listReviewRepositoryHistory = async (launchPath, source, limit = 200) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  if (isGitLabSource(source)) {
    return listGitLabRepositoryHistory(repoRoot, source, limit);
  }
  if (isGitHubSource(source)) {
    return listGitHubRepositoryHistory(repoRoot, source, limit);
  }
  return { entries: [], root: repoRoot };
};

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {{
 *   from?: import('../../core/types.ts').ReviewVersionCompareEndpoint,
 *   fromVersionId?: string,
 *   to?: import('../../core/types.ts').ReviewVersionCompareEndpoint,
 *   toVersionId?: string,
 * }} range
 * @param {ReadonlyArray<ReviewVersionOption>} [versions]
 */
const resolveGitHubComparison = async (repoRoot, source, range, versions) => {
  const resolvedVersions = versions ?? (await listGitHubReviewVersions(repoRoot, source)).versions;
  const endpointId = (
    /** @type {import('../../core/types.ts').ReviewVersionCompareEndpoint | undefined} */ endpoint,
    /** @type {string | undefined} */ fallbackVersionId,
  ) => {
    if (!endpoint) return fallbackVersionId;
    if (endpoint.kind === 'version') return endpoint.versionId;
    if (endpoint.kind === 'head-sha') return endpoint.sha;
    if (endpoint.kind === 'comment-position') return endpoint.headSha;
    return undefined;
  };
  let fromVersionId = endpointId(range.from, range.fromVersionId);
  let toVersionId = endpointId(range.to, range.toVersionId);
  let comparisonVersions = resolvedVersions;
  const baseEndpoint =
    range.from?.kind === 'base' ? 'from' : range.to?.kind === 'base' ? 'to' : null;
  if (baseEndpoint) {
    const targetId = baseEndpoint === 'from' ? toVersionId : fromVersionId;
    const target = resolvedVersions.find((version) => version.versionId === targetId);
    if (!target) {
      throw new Error('GitHub base comparison requires a selected target version.');
    }
    const syntheticBase = {
      createdAt: target.createdAt,
      range: {
        base: target.range.base,
        head: target.range.base,
      },
      versionId: `github-base:${target.versionId}`,
    };
    comparisonVersions = [syntheticBase, ...resolvedVersions];
    if (baseEndpoint === 'from') {
      fromVersionId = syntheticBase.versionId;
    } else {
      toVersionId = syntheticBase.versionId;
    }
  }
  if (!fromVersionId || !toVersionId) {
    throw new Error('GitHub review comparison endpoints could not be resolved.');
  }
  return {
    range: { fromVersionId, toVersionId },
    versions: comparisonVersions,
  };
};

/** @param {import('../../core/types.ts').Revision} revision */
const shaOf = (revision) => ('sha' in revision ? revision.sha : null);
/**
 * @param {{
 *   from?: import('../../core/types.ts').ReviewVersionCompareEndpoint,
 *   fromVersionId?: string,
 *   to?: import('../../core/types.ts').ReviewVersionCompareEndpoint,
 *   toVersionId?: string,
 * }} range
 * @param {ReadonlyArray<ReviewVersionOption>} versions
 */
const findComparisonCoordinates = (range, versions) => {
  /**
   * @param {import('../../core/types.ts').ReviewVersionCompareEndpoint | undefined} endpoint
   * @param {string | undefined} fallbackVersionId
   */
  const endpointVersion = (endpoint, fallbackVersionId) => {
    if (endpoint?.kind === 'comment-position') {
      return { baseSha: endpoint.baseSha, headSha: endpoint.headSha };
    }
    const identity =
      endpoint?.kind === 'version'
        ? endpoint.versionId
        : endpoint?.kind === 'head-sha'
          ? endpoint.sha
          : fallbackVersionId;
    const version = versions.find(
      (candidate) => candidate.versionId === identity || shaOf(candidate.range.head) === identity,
    );
    return version
      ? { baseSha: shaOf(version.range.base), headSha: shaOf(version.range.head) }
      : null;
  };
  let from = endpointVersion(range.from, range.fromVersionId);
  let to = endpointVersion(range.to, range.toVersionId);
  if (range.from?.kind === 'base' && to) from = { baseSha: to.baseSha, headSha: to.baseSha };
  if (range.to?.kind === 'base' && from) to = { baseSha: from.baseSha, headSha: from.baseSha };
  return from?.baseSha && from.headSha && to?.baseSha && to.headSha ? { from, to } : null;
};

/** @param {PullRequestSource} source */
const projectIdentity = (source) =>
  isGitLabSource(source)
    ? `${source.host}:${source.projectPath}:!${source.number}`
    : `${source.owner}/${source.repo}#${source.number}`;

/**
 * @param {'aggregate' | 'evolution'} kind
 * @param {PullRequestSource} source
 * @param {{from: {baseSha: string, headSha: string}, to: {baseSha: string, headSha: string}}} coordinates
 */
const comparisonCacheKey = async (kind, source, coordinates) => ({
  algorithmVersion: 'review-comparison-cache-v2',
  ...(await loadComparisonAlgorithmIdentity()),
  fromBaseSha: coordinates.from.baseSha,
  fromHeadSha: coordinates.from.headSha,
  kind,
  project: projectIdentity(source),
  provider: isGitLabSource(source) ? 'gitlab' : 'github',
  toBaseSha: coordinates.to.baseSha,
  toHeadSha: coordinates.to.headSha,
});

/** @param {PullRequestSource} source @param {ReviewEvolutionUnit} unit */
const unitDiffCacheKey = async (source, unit) => ({
  algorithmVersion: 'evolution-unit-diff-v2',
  ...(await loadComparisonAlgorithmIdentity()),
  afterSha: unit.after?.sha ?? null,
  beforeSha: unit.before?.sha ?? null,
  kind: 'unit-diff',
  project: projectIdentity(source),
  provider: isGitLabSource(source) ? 'gitlab' : 'github',
  unitId: unit.unitId,
});

/**
 * Load aggregate files without waiting for commit evolution.
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {{
 *   from?: import('../../core/types.ts').ReviewVersionCompareEndpoint,
 *   fromVersionId?: string,
 *   to?: import('../../core/types.ts').ReviewVersionCompareEndpoint,
 *   toVersionId?: string,
 * }} range
 * @param {ReadonlyArray<ReviewVersionOption>} [versions]
 */
const compareReviewVersionAggregate = async (repoRoot, source, range, versions, options = {}) => {
  options.signal?.throwIfAborted();
  const resolvedVersions = versions ?? (await listReviewVersions(repoRoot, source)).versions;
  const coordinates = findComparisonCoordinates(range, resolvedVersions);
  const load = async () => {
    if (isGitLabSource(source)) {
      return compareGitLabReviewVersionAggregate(repoRoot, source, range, options);
    }
    if (isGitHubSource(source)) {
      const resolved = await resolveGitHubComparison(repoRoot, source, range, resolvedVersions);
      return compareGitHubReviewVersionAggregate(
        repoRoot,
        source,
        resolved.range,
        resolved.versions,
        options,
      );
    }
    throw new Error('Review version compare is not available for this pull request provider.');
  };
  if (!coordinates) {
    return load();
  }
  const key = await comparisonCacheKey('aggregate', source, coordinates);
  options.signal?.throwIfAborted();
  return loadReviewHistoryCached(key, load, { shareInFlight: options.signal == null });
};

/**
 * Load commit evolution independently from aggregate file materialization.
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {{
 *   from?: import('../../core/types.ts').ReviewVersionCompareEndpoint,
 *   fromVersionId?: string,
 *   to?: import('../../core/types.ts').ReviewVersionCompareEndpoint,
 *   toVersionId?: string,
 * }} range
 * @param {ReadonlyArray<ReviewVersionOption>} [versions]
 * @param {{
 *   onProgress?: (progress: import('../../core/types.ts').ReviewVersionEvolutionProgress) => void,
 *   signal?: AbortSignal,
 * }} [options]
 */
const classifyReviewVersionEvolution = async (repoRoot, source, range, versions, options = {}) => {
  options.signal?.throwIfAborted();
  const resolvedVersions = versions ?? (await listReviewVersions(repoRoot, source)).versions;
  options.signal?.throwIfAborted();
  const coordinates = findComparisonCoordinates(range, resolvedVersions);
  const load = async () => {
    if (isGitLabSource(source)) {
      return classifyGitLabReviewVersionEvolution(repoRoot, source, range, options);
    }
    if (isGitHubSource(source)) {
      const resolved = await resolveGitHubComparison(repoRoot, source, range, resolvedVersions);
      return classifyGitHubReviewVersionEvolution(
        repoRoot,
        source,
        resolved.range,
        resolved.versions,
        options,
      );
    }
    throw new Error('Review version evolution is not available for this pull request provider.');
  };
  if (!coordinates) {
    return load();
  }
  const key = await comparisonCacheKey('evolution', source, coordinates);
  options.signal?.throwIfAborted();
  return loadReviewHistoryCached(key, load, { shareInFlight: options.signal == null });
};

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {{
 *   from?: import('../../core/types.ts').ReviewVersionCompareEndpoint,
 *   fromVersionId?: string,
 *   to?: import('../../core/types.ts').ReviewVersionCompareEndpoint,
 *   toVersionId?: string,
 * }} range
 * @param {ReadonlyArray<ReviewVersionOption>} [versions]
 */
const compareReviewVersions = async (repoRoot, source, range, versions) => {
  const resolvedVersions = versions ?? (await listReviewVersions(repoRoot, source)).versions;
  const [versionCompare, evolutionResult] = await Promise.all([
    compareReviewVersionAggregate(repoRoot, source, range, resolvedVersions),
    classifyReviewVersionEvolution(repoRoot, source, range, resolvedVersions).then(
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
    warning: null,
  };
};

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {ReviewEvolutionUnit} unit
 * @returns {Promise<ReadonlyArray<ChangedFile>>}
 */
const loadReviewVersionUnitDiff = async (repoRoot, source, unit) => {
  const load = () => {
    if (isGitLabSource(source)) {
      return loadGitLabVersionCommitUnitDiff(repoRoot, source, unit);
    }
    if (isGitHubSource(source)) {
      return loadGitHubVersionCommitUnitDiff(repoRoot, unit, source);
    }
    throw new Error('Review version unit diffs are not available for this pull request provider.');
  };
  return loadReviewHistoryCached(await unitDiffCacheKey(source, unit), load);
};

module.exports = {
  comparisonCacheKey,
  createComparisonAlgorithmIdentityLoader,
  classifyReviewVersionEvolution,
  compareReviewVersionAggregate,
  compareReviewVersions,
  isGitHubSource,
  isGitLabSource,
  listReviewVersions,
  listReviewRepositoryHistory,
  loadReviewVersionUnitDiff,
};
