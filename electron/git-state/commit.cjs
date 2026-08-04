// @ts-check

const { fileSort, getFingerprint, getGravatarHash, git, normalizeStatus } = require('./common.cjs');
const { readComparisonState } = require('./comparison.cjs');
const { readCommitMetadataForCommit } = require('./commit-metadata.cjs');
const {
  applyGeneratedAttributeStates,
  readRevisionGeneratedAttributeStates,
} = require('../generated-files.cjs');
const { readWorkingTreeState } = require('./working-tree.cjs');
const { transferRepositoryWatcherInitialSnapshot } = require('../repository-watcher.cjs');

/**
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').GitSha} GitSha
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../../core/types.ts').ResolvedReviewSource} ResolvedReviewSource
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 * @typedef {Extract<ReviewSource, {type: 'branch'}>} BranchSource
 * @typedef {Extract<ReviewSource, {type: 'branch-diff'}>} BranchDiffSource
 * @typedef {Extract<ReviewSource, {type: 'branch-working-tree'}>} BranchWorkingTreeSource
 * @typedef {Extract<ReviewSource, {type: 'commit'}>} CommitSource
 * @typedef {Extract<ReviewSource, {type: 'range'}>} RangeSource
 * @typedef {BranchSource | BranchDiffSource | CommitSource | RangeSource} ComparisonSource
 * @typedef {Extract<ResolvedReviewSource, {type: 'commit' | 'branch-diff' | 'range'}>} ResolvedComparisonSource
 * @typedef {{
 *   newSha: GitSha;
 *   oldSha?: GitSha;
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

  for (let index = 0; index < parts.length;) {
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

/** @param {string} repoRoot @param {string} commit @returns {Promise<Array<GitSha>>} */
const readCommitParents = async (repoRoot, commit) => {
  const raw = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', commit])).trim();
  return raw ? /** @type {Array<GitSha>} */ (raw.split(' ').slice(1)) : [];
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
 * @returns {Promise<GitSha>}
 */
const resolveRangeEndpoint = async (repoRoot, ref) => {
  if (ref !== 'HEAD') {
    try {
      return /** @type {GitSha} */ (
        (await git(repoRoot, ['rev-parse', '--verify', `refs/heads/${ref}^{commit}`])).trim()
      );
    } catch {
      // Fall back to Git's normal ref parser for tags, hashes, and fully-qualified refs.
    }
  }

  return /** @type {GitSha} */ (
    (await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
  );
};

/**
 * Resolve a `base...head` (symmetric -> merge-base) or `base..head` range to the
 * concrete (oldSha, newSha) pair the commit helpers diff against.
 * @param {string} repoRoot @param {string} base @param {string} head @param {boolean} symmetric
 * @returns {Promise<{ newSha: GitSha; oldSha: GitSha }>}
 */
const resolveRangeRefs = async (repoRoot, base, head, symmetric) => {
  const newSha = await resolveRangeEndpoint(repoRoot, head);
  const oldSha = symmetric
    ? (
        await git(repoRoot, ['merge-base', await resolveRangeEndpoint(repoRoot, base), newSha])
      ).trim()
    : await resolveRangeEndpoint(repoRoot, base);
  return { newSha, oldSha: /** @type {GitSha} */ (oldSha) };
};

/** @param {string} left @param {string} right */
const getEditDistance = (left, right) => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current[rightIndex + 1] =
        left[leftIndex] === right[rightIndex]
          ? previous[rightIndex]
          : Math.min(previous[rightIndex], previous[rightIndex + 1], current[rightIndex]) + 1;
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
};

/** @param {string} requested @param {string} candidate */
const getBranchSuggestionScore = (requested, candidate) => {
  const requestedLower = requested.toLowerCase();
  const aliases = [candidate.toLowerCase()];
  const slashIndex = candidate.indexOf('/');
  if (slashIndex !== -1) {
    aliases.push(candidate.slice(slashIndex + 1).toLowerCase());
  }

  return Math.min(
    ...aliases.map((alias) => {
      if (
        (requestedLower === 'main' && alias === 'master') ||
        (requestedLower === 'master' && alias === 'main')
      ) {
        return 1;
      }

      return alias.startsWith(requestedLower) && requestedLower.length >= 3
        ? 1
        : getEditDistance(requestedLower, alias);
    }),
  );
};

/** @param {string} ref */
const getBranchSuggestionThreshold = (ref) =>
  ref.length <= 4 ? 1 : ref.length <= 8 ? 2 : Math.floor(ref.length / 3);

/** @param {string} repoRoot @param {string} ref @returns {Promise<string | null>} */
const getBranchSuggestion = async (repoRoot, ref) => {
  const raw = await git(repoRoot, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
  ]);
  const candidates = [
    ...new Set(
      raw
        .split('\n')
        .map((branch) => branch.trim())
        .filter((branch) => branch && !branch.endsWith('/HEAD') && branch !== ref),
    ),
  ];
  const [best] = candidates
    .map((branch) => ({
      branch,
      score: getBranchSuggestionScore(ref, branch),
    }))
    .sort((left, right) => left.score - right.score || left.branch.localeCompare(right.branch));

  return best && best.score <= getBranchSuggestionThreshold(ref) ? best.branch : null;
};

/** @param {string | BranchSource | BranchDiffSource} input @returns {BranchSource | BranchDiffSource} */
const normalizeBranchSourceInput = (input) =>
  typeof input === 'string' ? { ref: input, type: 'branch' } : input;

/**
 * @param {string} repoRoot
 * @param {BranchSource | BranchDiffSource} source
 * @returns {Promise<{newSha: GitSha; oldSha: GitSha; source: BranchDiffSource; sourceLabel: string}>}
 */
const resolveBranchComparison = async (repoRoot, source) => {
  if (source.type === 'branch-diff') {
    return {
      newSha: source.headSha,
      oldSha: source.baseSha,
      source,
      sourceLabel: 'branch',
    };
  }

  const newSha = await resolveRangeEndpoint(repoRoot, 'HEAD');
  let branchRef;
  try {
    branchRef = await resolveRangeEndpoint(repoRoot, source.ref);
  } catch {
    const suggestion = await getBranchSuggestion(repoRoot, source.ref);
    throw new Error(
      `Branch "${source.ref}" does not exist in this repository.${
        suggestion ? ` Did you mean "${suggestion}"?` : ''
      }`,
    );
  }
  const oldSha = /** @type {GitSha} */ (
    (await git(repoRoot, ['merge-base', branchRef, newSha])).trim()
  );
  return {
    newSha,
    oldSha,
    source: {
      baseSha: oldSha,
      headSha: newSha,
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
    const commit = /** @type {GitSha} */ (
      (await git(repoRoot, ['rev-parse', '--verify', `${source.ref}^{commit}`])).trim()
    );
    const [firstParent] = await readCommitParents(repoRoot, commit);
    return {
      newSha: commit,
      oldSha: firstParent,
      source: {
        sha: commit,
        type: 'commit',
      },
      sourceLabel: 'commit',
    };
  }

  if (source.type === 'range') {
    const { newSha, oldSha } = await resolveRangeRefs(
      repoRoot,
      source.base,
      source.head,
      source.symmetric,
    );
    return {
      newSha,
      oldSha,
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
  const status = await readCommitNameStatus(repoRoot, comparison.newSha, comparison.oldSha, {
    sort: false,
  });

  return {
    ...comparison,
    repoRoot,
    status,
  };
};

/** @param {string} repoRoot @param {string} commit @returns {Promise<ResolvedComparison>} */
const readResolvedCommitComparison = async (repoRoot, commit) => {
  const [firstParent] = await readCommitParents(repoRoot, commit);
  const status = await readCommitNameStatus(repoRoot, commit, firstParent, {
    sort: false,
  });
  return {
    newSha: /** @type {GitSha} */ (commit),
    oldSha: firstParent,
    repoRoot,
    source: {
      sha: /** @type {GitSha} */ (commit),
      type: 'commit',
    },
    sourceLabel: 'commit',
    status,
  };
};

/** @param {string} launchPath @param {ResolvedComparison} comparison */
const readResolvedComparisonState = (launchPath, comparison) =>
  readComparisonState({
    launchPath,
    newSha: comparison.newSha,
    oldSha: comparison.oldSha,
    repoRoot: comparison.repoRoot,
    source: comparison.source,
    status: comparison.status,
  });

/** @param {ResolvedComparison} comparison */
const readComparisonGeneratedAttributeStates = (comparison) =>
  readRevisionGeneratedAttributeStates(
    comparison.repoRoot,
    comparison.status.map((file) => file.path),
    {
      label: { kind: 'commit', text: comparison.newSha.slice(0, 7) },
      sha: comparison.newSha,
    },
  );

/** @param {string} launchPath @param {ComparisonSource} source @returns {Promise<RepositoryState>} */
const readComparisonSourceState = async (launchPath, source) => {
  const comparison = await readResolvedComparison(launchPath, source);
  const [state, generatedAttributeStates] = await Promise.all([
    readResolvedComparisonState(launchPath, comparison),
    readComparisonGeneratedAttributeStates(comparison),
  ]);
  return applyGeneratedAttributeStates(state, generatedAttributeStates);
};

/** @param {string} launchPath @param {ResolvedComparison} comparison */
const readCommitStateFromComparison = async (launchPath, comparison) => {
  const [commitMetadata, state, generatedAttributeStates] = await Promise.all([
    readCommitMetadataForCommit(
      comparison.repoRoot,
      comparison.newSha,
      comparison.oldSha,
      comparison.status,
    ),
    readResolvedComparisonState(launchPath, comparison),
    readComparisonGeneratedAttributeStates(comparison),
  ]);

  return {
    ...applyGeneratedAttributeStates(state, generatedAttributeStates),
    commitMetadata,
  };
};

/** @param {string} launchPath @param {string} ref @returns {Promise<RepositoryState>} */
const readCommitState = async (launchPath, ref) =>
  readCommitStateFromComparison(
    launchPath,
    await readResolvedComparison(launchPath, { ref, type: 'commit' }),
  );

/**
 * @param {string} launchPath
 * @param {string} repoRoot
 * @param {string} commit
 * @returns {Promise<RepositoryState>}
 */
const readResolvedCommitState = async (launchPath, repoRoot, commit) =>
  readCommitStateFromComparison(launchPath, await readResolvedCommitComparison(repoRoot, commit));

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

/** @param {string} launchPath @param {string | BranchSource | BranchDiffSource} input @returns {Promise<RepositoryState>} */
const readBranchState = (launchPath, input) =>
  readComparisonSourceState(launchPath, normalizeBranchSourceInput(input));

/**
 * Reduce a `branch-working-tree` input (which may or may not already carry a
 * resolved baseSha/headSha) down to the plain branch/branch-diff shape that
 * {@link readBranchState} already understands.
 * @param {string | BranchSource | BranchDiffSource | BranchWorkingTreeSource} input
 * @returns {string | BranchSource | BranchDiffSource}
 */
const toBranchComparisonInput = (input) => {
  if (typeof input !== 'object' || input.type !== 'branch-working-tree') {
    return input;
  }

  return input.baseSha && input.headSha
    ? { baseSha: input.baseSha, headSha: input.headSha, ref: input.ref, type: 'branch-diff' }
    : { ref: input.ref, type: 'branch' };
};

/**
 * Merge a resolved branch-diff `ChangedFile` and a working-tree `ChangedFile`
 * for the same path into a single entry whose sections are the concatenation
 * of both (branch commit section(s) first, then staged/unstaged section(s)),
 * with the fingerprint recomputed from the combined sections.
 * @param {ChangedFile | undefined} branchFile
 * @param {ChangedFile | undefined} workingTreeFile
 * @returns {ChangedFile}
 */
const mergeChangedFile = (branchFile, workingTreeFile) => {
  if (!branchFile) {
    return /** @type {ChangedFile} */ (workingTreeFile);
  }

  if (!workingTreeFile) {
    return branchFile;
  }

  const sections = [...branchFile.sections, ...workingTreeFile.sections];
  const fingerprint = getFingerprint(
    `${workingTreeFile.status}\n${workingTreeFile.oldPath || branchFile.oldPath || ''}\n${sections
      .map(
        (section) =>
          `${section.loadState || 'ready'}\n${section.binary ? 'binary' : 'text'}\n${
            section.patch
          }\n${section.summary?.reason || ''}\n${section.summary?.fingerprint || ''}\n${
            section.oldFile?.contents || ''
          }\n${section.newFile?.contents || ''}`,
      )
      .join('\n')}`,
  );

  return {
    fingerprint,
    oldPath: workingTreeFile.oldPath || branchFile.oldPath,
    path: workingTreeFile.path,
    sections,
    // The working-tree status reflects the most current state of the file
    // (e.g. a branch-added file that was subsequently deleted locally).
    status: workingTreeFile.status,
  };
};

/**
 * Merge a resolved branch-diff `RepositoryState` and a working-tree
 * `RepositoryState` into a combined `branch-working-tree` state: file lists
 * are unioned by path, and files present in both have their sections
 * concatenated (branch commit section(s) followed by staged/unstaged
 * section(s)).
 * @param {RepositoryState} branchState
 * @param {RepositoryState} workingTreeState
 * @returns {RepositoryState}
 */
const mergeBranchAndWorkingTreeState = (branchState, workingTreeState) => {
  const branchSource = /** @type {BranchDiffSource} */ (branchState.source);
  const branchFilesByPath = new Map(branchState.files.map((file) => [file.path, file]));
  const workingTreeFilesByPath = new Map(workingTreeState.files.map((file) => [file.path, file]));
  const paths = [...new Set([...branchFilesByPath.keys(), ...workingTreeFilesByPath.keys()])];

  const files = paths
    .map((path) => mergeChangedFile(branchFilesByPath.get(path), workingTreeFilesByPath.get(path)))
    .sort(fileSort);

  return transferRepositoryWatcherInitialSnapshot(workingTreeState, {
    ...branchState,
    files,
    generatedAt: Date.now(),
    source: {
      baseSha: branchSource.baseSha,
      headSha: branchSource.headSha,
      ref: branchSource.ref,
      type: 'branch-working-tree',
    },
  });
};

/**
 * @param {string} launchPath
 * @param {string | BranchSource | BranchDiffSource | BranchWorkingTreeSource} input
 * @param {{showWhitespace?: boolean}} [options]
 * @returns {Promise<RepositoryState>}
 */
const readBranchWorkingTreeState = async (launchPath, input, options = {}) => {
  const [branchState, workingTreeState] = await Promise.all([
    readBranchState(launchPath, toBranchComparisonInput(input)),
    readWorkingTreeState(launchPath, {
      eagerContents: false,
      showWhitespace: options.showWhitespace,
    }),
  ]);
  return mergeBranchAndWorkingTreeState(branchState, workingTreeState);
};

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
    const [sha, parentShas, committedAt, subject, author, email] = record.trim().split('\x1f');
    if (!sha || !committedAt || subject == null) {
      continue;
    }

    const gravatarUrl = email
      ? `https://www.gravatar.com/avatar/${getGravatarHash(email)}?s=80&d=identicon`
      : undefined;

    entries.push({
      author: author || '',
      committedAt: Number(committedAt) * 1000,
      gravatarUrl,
      parentShas: parentShas ? /** @type {Array<GitSha>} */ (parentShas.split(' ')) : [],
      sha: /** @type {GitSha} */ (sha),
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
  readBranchState,
  readBranchWorkingTreeState,
  readCommitState,
  readResolvedCommitState,
  readRangeState,
};
