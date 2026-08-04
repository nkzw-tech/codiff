// @ts-check

const { realpathSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const {
  decodeReviewSource,
  decodeResolvedReviewSource,
  formatReviewSourceIdentity,
} = require('../core/lib/review-source-codec.cjs');
const { gitSync } = require('./git-state/common.cjs');

/**
 * @typedef {import('../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../core/types.ts').CodiffLaunchOptions} CodiffLaunchOptions
 * @typedef {{key: string; repositoryRoot: string; sourceKey: string}} WindowIdentity
 */

/** @param {string} path */
const getRealPath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** @param {string} repositoryPath */
const resolveRepositoryRoot = (repositoryPath) => {
  const resolvedPath = resolve(repositoryPath);

  try {
    return getRealPath(gitSync(resolvedPath, ['rev-parse', '--show-toplevel']).trim());
  } catch {
    return getRealPath(resolvedPath);
  }
};

/** @param {string} repositoryRoot @param {string} ref */
const resolveCommitRef = (repositoryRoot, ref) => {
  try {
    return gitSync(repositoryRoot, ['rev-parse', '--verify', `${ref}^{commit}`])
      .trim()
      .toLowerCase();
  } catch {
    return null;
  }
};

/** @param {string} repositoryRoot */
const hasWorkingTreeChanges = (repositoryRoot) => {
  try {
    return Boolean(
      gitSync(repositoryRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
    );
  } catch {
    return false;
  }
};

/** @param {string} repositoryRoot @param {string} baseRef @param {string} headRef */
const resolveMergeBase = (repositoryRoot, baseRef, headRef) => {
  try {
    return gitSync(repositoryRoot, ['merge-base', baseRef, headRef]).trim().toLowerCase();
  } catch {
    return null;
  }
};

/** @param {string} repositoryRoot @param {ReviewSource} [source] */
const getSourceKey = (repositoryRoot, source = { type: 'working-tree' }) => {
  if (source.type === 'commit') {
    const commit = resolveCommitRef(repositoryRoot, source.ref);
    return commit
      ? formatReviewSourceIdentity({ sha: commit, type: /** @type {const} */ ('commit') })
      : null;
  }

  if (source.type === 'branch') {
    const head = resolveCommitRef(repositoryRoot, 'HEAD');
    const target = resolveCommitRef(repositoryRoot, source.ref);
    const nextBase = target && head ? resolveMergeBase(repositoryRoot, target, head) : null;
    return nextBase && head
      ? formatReviewSourceIdentity({
          baseSha: nextBase,
          headSha: head,
          ref: source.ref,
          type: /** @type {const} */ ('branch-diff'),
        })
      : null;
  }

  if (source.type === 'branch-diff') {
    const base = resolveCommitRef(repositoryRoot, source.baseSha);
    const head = resolveCommitRef(repositoryRoot, source.headSha);
    return base && head
      ? formatReviewSourceIdentity({ ...source, baseSha: base, headSha: head })
      : null;
  }

  if (source.type === 'branch-working-tree') {
    if (
      typeof source.baseSha === 'string' &&
      typeof source.headSha === 'string' &&
      source.baseSha &&
      source.headSha
    ) {
      const base = resolveCommitRef(repositoryRoot, source.baseSha);
      const head = resolveCommitRef(repositoryRoot, source.headSha);
      return base && head
        ? formatReviewSourceIdentity({ ...source, baseSha: base, headSha: head })
        : null;
    }

    const head = resolveCommitRef(repositoryRoot, 'HEAD');
    const target = resolveCommitRef(repositoryRoot, source.ref);
    const nextBase = target && head ? resolveMergeBase(repositoryRoot, target, head) : null;
    return nextBase && head
      ? formatReviewSourceIdentity({
          baseSha: nextBase,
          headSha: head,
          ref: source.ref,
          type: /** @type {const} */ ('branch-working-tree'),
        })
      : null;
  }

  const decoded = decodeReviewSource(source);
  return decoded ? formatReviewSourceIdentity(decoded) : null;
};

/** @param {import('../core/types.ts').ResolvedReviewSource} source */
const getResolvedSourceKey = (source) => {
  const resolved = decodeResolvedReviewSource(source);
  return resolved ? formatReviewSourceIdentity(resolved) : null;
};

/** @param {string} repositoryPath @param {Partial<CodiffLaunchOptions>} [launchOptions] */
const getWindowIdentity = (repositoryPath, launchOptions = {}) => {
  if (launchOptions.planFile) {
    const planPath = getRealPath(launchOptions.planFile);
    const resultPath = launchOptions.planResultFile
      ? getRealPath(launchOptions.planResultFile)
      : 'standalone';
    return {
      key: `plan:${planPath}\0${resultPath}`,
      repositoryRoot: getRealPath(dirname(planPath)),
      sourceKey: `plan:${planPath}`,
    };
  }
  const repositoryRoot = resolveRepositoryRoot(repositoryPath);
  const implicitWalkthroughHead =
    launchOptions.walkthrough &&
    !launchOptions.walkthroughFile &&
    !launchOptions.source &&
    !hasWorkingTreeChanges(repositoryRoot)
      ? resolveCommitRef(repositoryRoot, 'HEAD')
      : null;
  const sourceKey = implicitWalkthroughHead
    ? `commit:${implicitWalkthroughHead}`
    : getSourceKey(repositoryRoot, launchOptions.source);
  return sourceKey
    ? {
        key: `${repositoryRoot}\0${sourceKey}`,
        repositoryRoot,
        sourceKey,
      }
    : null;
};

/** @param {{root: string; source: import('../core/types.ts').ResolvedReviewSource}} state */
const getWindowIdentityForRepositoryState = (state) => {
  const repositoryRoot = getRealPath(state.root);
  const sourceKey = getResolvedSourceKey(state.source);
  return sourceKey
    ? {
        key: `${repositoryRoot}\0${sourceKey}`,
        repositoryRoot,
        sourceKey,
      }
    : null;
};

/**
 * Retarget one independent viewport after it resolves a new review source.
 * Existing viewports are intentionally left untouched, even when this creates
 * multiple viewports with the same working-tree identity.
 *
 * @param {number} webContentsId
 * @param {{root: string; source: import('../core/types.ts').ResolvedReviewSource}} state
 * @param {{identities: Map<number, WindowIdentity | null>, launchOptions: Map<number, CodiffLaunchOptions>, repositories: Map<number, string>}} stores
 */
const storeResolvedWindowState = (webContentsId, state, stores) => {
  stores.repositories.set(webContentsId, state.root);
  const launchOptions = stores.launchOptions.get(webContentsId);
  if (launchOptions) {
    stores.launchOptions.set(webContentsId, {
      ...launchOptions,
      source: state.source,
    });
  }
  const identity = getWindowIdentityForRepositoryState(state);
  if (identity) {
    stores.identities.set(webContentsId, identity);
  }
  return identity;
};

/**
 * @param {WindowIdentity | null} identity
 * @param {ReadonlyMap<number, WindowIdentity | null>} existingIdentities
 */
const findMatchingWindowIdentity = (identity, existingIdentities) => {
  if (!identity) {
    return null;
  }

  for (const [id, existingIdentity] of existingIdentities) {
    if (existingIdentity?.key === identity.key) {
      return id;
    }
  }

  return null;
};

module.exports = {
  findMatchingWindowIdentity,
  getWindowIdentity,
  getWindowIdentityForRepositoryState,
  storeResolvedWindowState,
};
