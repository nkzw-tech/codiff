// @ts-check

const { fileSort, getGravatarHash, git, normalizeStatus } = require('./common.cjs');
const {
  readComparisonImageContent,
  readComparisonSectionContent,
  readComparisonState,
} = require('./comparison.cjs');
const { readCommitMetadataForCommit } = require('./commit-metadata.cjs');

/**
 * @typedef {import('../../src/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../../src/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../../src/types.ts').ReviewSource} ReviewSource
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 * @typedef {Extract<ReviewSource, {type: 'branch'}>} BranchSource
 * @typedef {Extract<ReviewSource, {type: 'branch-diff'}>} BranchDiffSource
 * @typedef {Extract<ReviewSource, {type: 'commit'}>} CommitSource
 * @typedef {Extract<ReviewSource, {type: 'range'}>} RangeSource
 * @typedef {BranchSource | BranchDiffSource | CommitSource | RangeSource} ComparisonSource
 * @typedef {CommitSource | BranchDiffSource | RangeSource} ResolvedComparisonSource
 * @typedef {{
 *   newRef: string;
 *   oldRef?: string;
 *   repoRoot: string;
 *   source: ResolvedComparisonSource;
 *   sourceLabel: string;
 *   status: Array<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>;
 * }} ResolvedComparison
 */

/**
 * @param {string} raw
 * @param {{sort?: boolean}} [options]
 * @returns {Array<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>}
 */
const parseCommitNameStatus = (raw, options = {}) => {
  const parts = raw.split('\0').filter(Boolean);
  /** @type {Array<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>} */
  const files = [];

  for (let index = 0; index < parts.length; ) {
    const statusCode = parts[index++];
    const statusType = statusCode[0];

    if (statusType === 'R' || statusType === 'C') {
      const oldPath = parts[index++];
      const path = parts[index++];
      files.push({
        oldPath,
        path,
        status: 'renamed',
      });
    } else {
      const path = parts[index++];
      files.push({
        path,
        status: normalizeStatus(statusType),
      });
    }
  }

  return options.sort === false ? files : files.sort(fileSort);
};

/** @param {string} repoRoot @param {string} commit @returns {Promise<Array<string>>} */
const readCommitParents = async (repoRoot, commit) => {
  const raw = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', commit])).trim();
  return raw ? raw.split(' ').slice(1) : [];
};

/**
 * @param {string} repoRoot
 * @param {string} commit
 * @param {string | undefined} firstParent
 * @param {{sort?: boolean}} [options]
 */
const readCommitNameStatus = async (repoRoot, commit, firstParent, options = {}) =>
  parseCommitNameStatus(
    await git(
      repoRoot,
      firstParent
        ? ['diff', '--name-status', '-r', '-z', '-M', firstParent, commit]
        : ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--root', '-M', commit],
    ),
    options,
  );

/**
 * @param {string} repoRoot
 * @param {string} ref
 */
const resolveRangeEndpoint = async (repoRoot, ref) => {
  if (ref !== 'HEAD') {
    try {
      return (await git(repoRoot, ['rev-parse', '--verify', `refs/heads/${ref}^{commit}`])).trim();
    } catch {
      // Fall back to Git's normal ref parser for tags, hashes, and fully-qualified refs.
    }
  }

  return (await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
};

/**
 * Resolve a `base...head` (symmetric -> merge-base) or `base..head` range to the
 * concrete (oldRef, newRef) pair the commit helpers diff against.
 * @param {string} repoRoot @param {string} base @param {string} head @param {boolean} symmetric
 * @returns {Promise<{ newRef: string; oldRef: string }>}
 */
const resolveRangeRefs = async (repoRoot, base, head, symmetric) => {
  const newRef = await resolveRangeEndpoint(repoRoot, head);
  const oldRef = symmetric
    ? (
        await git(repoRoot, ['merge-base', await resolveRangeEndpoint(repoRoot, base), newRef])
      ).trim()
    : await resolveRangeEndpoint(repoRoot, base);
  return { newRef, oldRef };
};

/** @param {string | BranchSource | BranchDiffSource} input @returns {BranchSource | BranchDiffSource} */
const normalizeBranchSourceInput = (input) =>
  typeof input === 'string' ? { ref: input, type: 'branch' } : input;

/**
 * @param {string} repoRoot
 * @param {BranchSource | BranchDiffSource} source
 * @returns {Promise<{newRef: string; oldRef: string; source: BranchDiffSource; sourceLabel: string}>}
 */
const resolveBranchComparison = async (repoRoot, source) => {
  if (source.type === 'branch-diff') {
    return {
      newRef: source.headRef,
      oldRef: source.baseRef,
      source,
      sourceLabel: 'branch',
    };
  }

  const { newRef, oldRef } = await resolveRangeRefs(repoRoot, source.ref, 'HEAD', true);
  return {
    newRef,
    oldRef,
    source: {
      baseRef: oldRef,
      headRef: newRef,
      ref: source.ref,
      type: 'branch-diff',
    },
    sourceLabel: 'branch',
  };
};

/**
 * @param {string} repoRoot
 * @param {ComparisonSource} source
 * @returns {Promise<Omit<ResolvedComparison, 'repoRoot' | 'status'>>}
 */
const resolveComparisonSource = async (repoRoot, source) => {
  if (source.type === 'commit') {
    const commit = (
      await git(repoRoot, ['rev-parse', '--verify', `${source.ref}^{commit}`])
    ).trim();
    const [firstParent] = await readCommitParents(repoRoot, commit);
    return {
      newRef: commit,
      oldRef: firstParent,
      source: {
        ref: commit,
        type: 'commit',
      },
      sourceLabel: 'commit',
    };
  }

  if (source.type === 'range') {
    const { newRef, oldRef } = await resolveRangeRefs(
      repoRoot,
      source.base,
      source.head,
      source.symmetric,
    );
    return {
      newRef,
      oldRef,
      source,
      sourceLabel: 'range',
    };
  }

  if (source.type === 'branch' || source.type === 'branch-diff') {
    return resolveBranchComparison(repoRoot, source);
  }

  throw new Error('Unsupported comparison source.');
};

/** @param {string} launchPath @param {ComparisonSource} source @returns {Promise<ResolvedComparison>} */
const readResolvedComparison = async (launchPath, source) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const comparison = await resolveComparisonSource(repoRoot, source);
  const status = await readCommitNameStatus(repoRoot, comparison.newRef, comparison.oldRef, {
    sort: false,
  });

  return {
    ...comparison,
    repoRoot,
    status,
  };
};

/** @param {string} launchPath @param {ResolvedComparison} comparison */
const readResolvedComparisonState = (launchPath, comparison) =>
  readComparisonState({
    launchPath,
    newRef: comparison.newRef,
    oldRef: comparison.oldRef,
    repoRoot: comparison.repoRoot,
    source: comparison.source,
    status: comparison.status,
  });

/** @param {string} launchPath @param {ComparisonSource} source @returns {Promise<RepositoryState>} */
const readComparisonSourceState = async (launchPath, source) =>
  readResolvedComparisonState(launchPath, await readResolvedComparison(launchPath, source));

/**
 * @param {string} launchPath
 * @param {ComparisonSource} source
 * @param {string} requestedPath
 * @param {{force?: boolean}} [options]
 */
const readComparisonSourceSectionContent = async (
  launchPath,
  source,
  requestedPath,
  options = {},
) => {
  const comparison = await readResolvedComparison(launchPath, source);
  return readComparisonSectionContent(
    comparison.repoRoot,
    comparison.newRef,
    comparison.oldRef,
    comparison.status,
    requestedPath,
    comparison.sourceLabel,
    options,
  );
};

/**
 * @param {string} launchPath
 * @param {ComparisonSource} source
 * @param {string} requestedPath
 * @returns {Promise<DiffImageContentResult>}
 */
const readComparisonSourceImageContent = async (launchPath, source, requestedPath) => {
  try {
    const comparison = await readResolvedComparison(launchPath, source);
    return await readComparisonImageContent(
      comparison.repoRoot,
      comparison.newRef,
      comparison.oldRef,
      comparison.status,
      requestedPath,
      comparison.sourceLabel,
    );
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : 'Codiff could not load this image.',
      status: 'unavailable',
    };
  }
};

/** @param {string} launchPath @param {string} ref @returns {Promise<RepositoryState>} */
const readCommitState = async (launchPath, ref) => {
  const comparison = await readResolvedComparison(launchPath, { ref, type: 'commit' });
  const [commitMetadata, state] = await Promise.all([
    readCommitMetadataForCommit(
      comparison.repoRoot,
      comparison.newRef,
      comparison.oldRef,
      comparison.status,
    ),
    readResolvedComparisonState(launchPath, comparison),
  ]);

  return {
    ...state,
    commitMetadata,
  };
};

/**
 * @param {string} launchPath
 * @param {string} ref
 * @param {string} requestedPath
 * @param {{force?: boolean}} [options]
 */
const readCommitSectionContent = (launchPath, ref, requestedPath, options = {}) =>
  readComparisonSourceSectionContent(launchPath, { ref, type: 'commit' }, requestedPath, options);

/**
 * @param {string} launchPath
 * @param {string} ref
 * @param {string} requestedPath
 * @returns {Promise<DiffImageContentResult>}
 */
const readCommitImageContent = (launchPath, ref, requestedPath) =>
  readComparisonSourceImageContent(launchPath, { ref, type: 'commit' }, requestedPath);

/**
 * @param {string} launchPath @param {string} base @param {string} head @param {boolean} symmetric
 * @returns {Promise<RepositoryState>}
 */
const readRangeState = (launchPath, base, head, symmetric) =>
  readComparisonSourceState(launchPath, {
    base,
    head,
    symmetric,
    type: 'range',
  });

/**
 * @param {string} launchPath @param {string} base @param {string} head @param {boolean} symmetric @param {string} requestedPath @param {{encoding?: BufferEncoding, force?: boolean}} [options]
 */
const readRangeSectionContent = (launchPath, base, head, symmetric, requestedPath, options = {}) =>
  readComparisonSourceSectionContent(
    launchPath,
    {
      base,
      head,
      symmetric,
      type: 'range',
    },
    requestedPath,
    options,
  );

/**
 * @param {string} launchPath @param {string} base @param {string} head @param {boolean} symmetric @param {string} requestedPath
 * @returns {Promise<DiffImageContentResult>}
 */
const readRangeImageContent = (launchPath, base, head, symmetric, requestedPath) =>
  readComparisonSourceImageContent(
    launchPath,
    {
      base,
      head,
      symmetric,
      type: 'range',
    },
    requestedPath,
  );

/** @param {string} launchPath @param {string | BranchSource | BranchDiffSource} input @returns {Promise<RepositoryState>} */
const readBranchState = (launchPath, input) =>
  readComparisonSourceState(launchPath, normalizeBranchSourceInput(input));

/**
 * @param {string} launchPath
 * @param {string | BranchSource | BranchDiffSource} input
 * @param {string} requestedPath
 * @param {{force?: boolean}} [options]
 */
const readBranchSectionContent = (launchPath, input, requestedPath, options = {}) =>
  readComparisonSourceSectionContent(
    launchPath,
    normalizeBranchSourceInput(input),
    requestedPath,
    options,
  );

/**
 * @param {string} launchPath
 * @param {string | BranchSource | BranchDiffSource} input
 * @param {string} requestedPath
 * @returns {Promise<DiffImageContentResult>}
 */
const readBranchImageContent = (launchPath, input, requestedPath) =>
  readComparisonSourceImageContent(launchPath, normalizeBranchSourceInput(input), requestedPath);

/** @param {string} launchPath @param {number} [limit] @param {string} [ref] */
const listRepositoryHistory = async (launchPath, limit = 200, ref = 'HEAD') => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  try {
    if (ref.includes('..')) {
      await git(repoRoot, ['rev-list', '--max-count=1', ref]);
    } else {
      await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
    }
  } catch {
    return {
      entries: [],
      root: repoRoot,
    };
  }

  const raw = await git(repoRoot, [
    'log',
    `--max-count=${limit}`,
    '--format=%H%x1f%P%x1f%ct%x1f%s%x1f%aN%x1f%aE%x1e',
    ref,
  ]);
  const entries = [];

  for (const record of raw.split('\x1e')) {
    const [ref, parents, committedAt, subject, author, email] = record.trim().split('\x1f');
    if (!ref || !committedAt || subject == null) {
      continue;
    }

    const gravatarUrl = email
      ? `https://www.gravatar.com/avatar/${getGravatarHash(email)}?s=80&d=identicon`
      : undefined;

    entries.push({
      author: author || '',
      committedAt: Number(committedAt) * 1000,
      gravatarUrl,
      parents: parents ? parents.split(' ') : [],
      ref,
      subject,
    });
  }

  return {
    entries,
    root: repoRoot,
  };
};

module.exports = {
  listRepositoryHistory,
  parseCommitNameStatus,
  readBranchImageContent,
  readBranchSectionContent,
  readBranchState,
  readCommitImageContent,
  readCommitSectionContent,
  readCommitState,
  readRangeImageContent,
  readRangeSectionContent,
  readRangeState,
};
