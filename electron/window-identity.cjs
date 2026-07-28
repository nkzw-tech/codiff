// @ts-check

const { execFileSync } = require('node:child_process');
const { realpathSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const { parseReviewUrl } = require('./review-source.cjs');

/**
 * @typedef {import('../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../core/types.ts').CodiffLaunchOptions} CodiffLaunchOptions
 * @typedef {{key: string; repositoryRoot: string; sourceKey: string}} WindowIdentity
 * @typedef {{number: number; owner: string; repo: string}} ParsedPullRequest
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
    return getRealPath(
      execFileSync('git', ['-C', resolvedPath, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
      }).trim(),
    );
  } catch {
    return getRealPath(resolvedPath);
  }
};

/** @param {string} repositoryRoot @param {string} ref */
const resolveCommitRef = (repositoryRoot, ref) => {
  try {
    return execFileSync('git', ['-C', repositoryRoot, 'rev-parse', '--verify', `${ref}^{commit}`], {
      encoding: 'utf8',
    })
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
      execFileSync(
        'git',
        ['-C', repositoryRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'],
        { encoding: 'utf8' },
      ),
    );
  } catch {
    return false;
  }
};

/** @param {string} repositoryRoot @param {string} baseRef @param {string} headRef */
const resolveMergeBase = (repositoryRoot, baseRef, headRef) => {
  try {
    return execFileSync('git', ['-C', repositoryRoot, 'merge-base', baseRef, headRef], {
      encoding: 'utf8',
    })
      .trim()
      .toLowerCase();
  } catch {
    return null;
  }
};

/** @param {Extract<ReviewSource, {type: 'pull-request'}>} source */
const getPullRequestSourceKey = (source) => {
  const review = parseReviewUrl(source.url);
  if (review?.provider === 'gitlab') {
    return `pull-request:gitlab:${review.host}/${review.projectPath.toLowerCase()}#${
      review.number
    }`;
  }
  const pullRequest =
    source.owner && source.repo && source.number
      ? {
          number: source.number,
          owner: source.owner,
          repo: source.repo,
        }
      : review?.provider === 'github'
        ? /** @type {ParsedPullRequest} */ ({
            number: review.number,
            owner: review.owner,
            repo: review.repo,
          })
        : null;

  return pullRequest
    ? `pull-request:${pullRequest.owner.toLowerCase()}/${pullRequest.repo.toLowerCase()}#${
        pullRequest.number
      }`
    : null;
};

/** @param {string} repositoryRoot @param {ReviewSource} [source] */
const getSourceKey = (repositoryRoot, source = { type: 'working-tree' }) => {
  if (source.type === 'working-tree') {
    return 'working-tree';
  }

  if (source.type === 'commit') {
    const commit = resolveCommitRef(repositoryRoot, source.ref);
    return commit ? `commit:${commit}` : null;
  }

  if (source.type === 'branch') {
    const head = resolveCommitRef(repositoryRoot, 'HEAD');
    const target = resolveCommitRef(repositoryRoot, source.ref);
    const nextBase = target && head ? resolveMergeBase(repositoryRoot, target, head) : null;
    return nextBase && head ? `branch-diff:${source.ref}:${nextBase}:${head}` : null;
  }

  if (source.type === 'branch-diff') {
    const base = resolveCommitRef(repositoryRoot, source.baseSha);
    const head = resolveCommitRef(repositoryRoot, source.headSha);
    return base && head ? `branch-diff:${source.ref}:${base}:${head}` : null;
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
      return base && head ? `branch-working-tree:${source.ref}:${base}:${head}` : null;
    }

    const head = resolveCommitRef(repositoryRoot, 'HEAD');
    const target = resolveCommitRef(repositoryRoot, source.ref);
    const nextBase = target && head ? resolveMergeBase(repositoryRoot, target, head) : null;
    return nextBase && head ? `branch-working-tree:${source.ref}:${nextBase}:${head}` : null;
  }

  if (source.type === 'pull-request') {
    return getPullRequestSourceKey(source);
  }

  return null;
};

/** @param {import('../core/types.ts').ResolvedReviewSource} source */
const getResolvedSourceKey = (source) => {
  if (source.type === 'working-tree') {
    return 'working-tree';
  }
  if (source.type === 'commit') {
    return `commit:${source.sha.toLowerCase()}`;
  }
  if (source.type === 'branch-diff') {
    return `branch-diff:${source.ref}:${source.baseSha.toLowerCase()}:${source.headSha.toLowerCase()}`;
  }
  if (source.type === 'branch-working-tree' && source.baseSha && source.headSha) {
    return `branch-working-tree:${source.ref}:${source.baseSha.toLowerCase()}:${source.headSha.toLowerCase()}`;
  }
  if (source.type === 'pull-request') {
    return getPullRequestSourceKey(source);
  }
  return null;
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
};
