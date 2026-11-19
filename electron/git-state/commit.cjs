// @ts-check

const {
  createSection,
  fileSort,
  getFingerprint,
  getGravatarHash,
  git,
  normalizeStatus,
  validateRepositoryPath,
} = require('./common.cjs');
const { withBranchSnapshot } = require('./branch-snapshot.cjs');
const {
  readComparisonImageContent,
  readComparisonSectionContent,
  readComparisonState,
} = require('./comparison.cjs');
const { readCommitMetadataForCommit } = require('./commit-metadata.cjs');
const {
  applyGeneratedAttributeStates,
  readGeneratedAttributeStates,
} = require('../generated-files.cjs');

/**
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').DiffImageContentRequest} DiffImageContentRequest
 * @typedef {import('../../core/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../../core/types.ts').DiffSectionContentRequest} DiffSectionContentRequest
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 * @typedef {Extract<ReviewSource, {type: 'branch'}>} BranchSource
 * @typedef {Extract<ReviewSource, {type: 'branch-diff'}>} BranchDiffSource
 * @typedef {Extract<ReviewSource, {type: 'branch-working-tree'}>} BranchWorkingTreeSource
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

/** @param {string} repoRoot @param {string} commit @returns {Promise<Array<string>>} */
const readCommitParents = async (repoRoot, commit) => {
  const raw = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', commit])).trim();
  return raw ? raw.split(' ').slice(1) : [];
};

/**
 * @param {string} repoRoot
 * @param {string} commit
 * @param {string | undefined} firstParent
 * @param {{env?: NodeJS.ProcessEnv; pathspec?: ReadonlyArray<string>; sort?: boolean}} [options]
 */
const readCommitNameStatus = async (repoRoot, commit, firstParent, options = {}) =>
  parseCommitNameStatus(
    await git(
      repoRoot,
      firstParent
        ? [
            'diff',
            '--name-status',
            '-r',
            '-z',
            '-M',
            firstParent,
            commit,
            '--',
            ...(options.pathspec ?? []),
          ]
        : ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--root', '-M', commit],
      { env: options.env },
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

  const newRef = await resolveRangeEndpoint(repoRoot, 'HEAD');
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
  const oldRef = (await git(repoRoot, ['merge-base', branchRef, newRef])).trim();
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

/** @param {string} repoRoot @param {string} commit @returns {Promise<ResolvedComparison>} */
const readResolvedCommitComparison = async (repoRoot, commit) => {
  const [firstParent] = await readCommitParents(repoRoot, commit);
  const status = await readCommitNameStatus(repoRoot, commit, firstParent, {
    sort: false,
  });
  return {
    newRef: commit,
    oldRef: firstParent,
    repoRoot,
    source: {
      ref: commit,
      type: 'commit',
    },
    sourceLabel: 'commit',
    status,
  };
};

/** @param {string} launchPath @param {ResolvedComparison} comparison @param {{showWhitespace?: boolean}} [options] */
const readResolvedComparisonState = (launchPath, comparison, options = {}) =>
  readComparisonState({
    launchPath,
    newRef: comparison.newRef,
    oldRef: comparison.oldRef,
    options,
    repoRoot: comparison.repoRoot,
    source: comparison.source,
    status: comparison.status,
  });

/** @param {ResolvedComparison} comparison */
const readComparisonGeneratedAttributeStates = (comparison) =>
  readGeneratedAttributeStates(
    comparison.repoRoot,
    comparison.status.map((file) => file.path),
    comparison.newRef,
  );

/** @param {string} launchPath @param {ComparisonSource} source @param {{showWhitespace?: boolean}} [options] @returns {Promise<RepositoryState>} */
const readComparisonSourceState = async (launchPath, source, options = {}) => {
  const comparison = await readResolvedComparison(launchPath, source);
  const [state, generatedAttributeStates] = await Promise.all([
    readResolvedComparisonState(launchPath, comparison, options),
    readComparisonGeneratedAttributeStates(comparison),
  ]);
  return applyGeneratedAttributeStates(state, generatedAttributeStates);
};

/**
 * @param {string} launchPath
 * @param {ComparisonSource} source
 * @param {string} requestedPath
 * @param {{force?: boolean; showWhitespace?: boolean}} [options]
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

/** @param {string} launchPath @param {ResolvedComparison} comparison @param {{showWhitespace?: boolean}} [options] */
const readCommitStateFromComparison = async (launchPath, comparison, options = {}) => {
  const [commitMetadata, state, generatedAttributeStates] = await Promise.all([
    readCommitMetadataForCommit(
      comparison.repoRoot,
      comparison.newRef,
      comparison.oldRef,
      comparison.status,
    ),
    readResolvedComparisonState(launchPath, comparison, options),
    readComparisonGeneratedAttributeStates(comparison),
  ]);

  return {
    ...applyGeneratedAttributeStates(state, generatedAttributeStates),
    commitMetadata,
  };
};

/** @param {string} launchPath @param {string} ref @param {{showWhitespace?: boolean}} [options] @returns {Promise<RepositoryState>} */
const readCommitState = async (launchPath, ref, options = {}) =>
  readCommitStateFromComparison(
    launchPath,
    await readResolvedComparison(launchPath, { ref, type: 'commit' }),
    options,
  );

/**
 * @param {string} launchPath
 * @param {string} repoRoot
 * @param {string} commit
 * @param {{showWhitespace?: boolean}} [options]
 * @returns {Promise<RepositoryState>}
 */
const readResolvedCommitState = async (launchPath, repoRoot, commit, options = {}) =>
  readCommitStateFromComparison(
    launchPath,
    await readResolvedCommitComparison(repoRoot, commit),
    options,
  );

/**
 * @param {string} launchPath
 * @param {string} ref
 * @param {string} requestedPath
 * @param {{force?: boolean; showWhitespace?: boolean}} [options]
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
 * @param {{showWhitespace?: boolean}} [options]
 * @returns {Promise<RepositoryState>}
 */
const readRangeState = (launchPath, base, head, symmetric, options = {}) =>
  readComparisonSourceState(
    launchPath,
    {
      base,
      head,
      symmetric,
      type: 'range',
    },
    options,
  );

/**
 * @param {string} launchPath @param {string} base @param {string} head @param {boolean} symmetric @param {string} requestedPath @param {{encoding?: BufferEncoding, force?: boolean; showWhitespace?: boolean}} [options]
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

/** @param {string} launchPath @param {string | BranchSource | BranchDiffSource} input @param {{showWhitespace?: boolean}} [options] @returns {Promise<RepositoryState>} */
const readBranchState = (launchPath, input, options = {}) =>
  readComparisonSourceState(launchPath, normalizeBranchSourceInput(input), options);

/**
 * @param {string} launchPath
 * @param {string | BranchSource | BranchDiffSource} input
 * @param {string} requestedPath
 * @param {{force?: boolean; showWhitespace?: boolean}} [options]
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

/**
 * Reduce a `branch-working-tree` input (which may or may not already carry a
 * resolved baseRef/headRef) down to the plain branch/branch-diff shape that
 * {@link readBranchState} already understands.
 * @param {string | BranchSource | BranchDiffSource | BranchWorkingTreeSource} input
 * @returns {string | BranchSource | BranchDiffSource}
 */
const toBranchComparisonInput = (input) => {
  if (typeof input !== 'object' || input.type !== 'branch-working-tree') {
    return input;
  }

  return input.baseRef && input.headRef
    ? { baseRef: input.baseRef, headRef: input.headRef, ref: input.ref, type: 'branch-diff' }
    : { ref: input.ref, type: 'branch' };
};

/**
 * `branch+` compares the branch's merge base with a snapshot of the working
 * tree. The returned source describes the branch itself: `headRef` is its
 * resolved commit, never the snapshot tree.
 * @param {string} launchPath
 * @param {string | BranchSource | BranchDiffSource | BranchWorkingTreeSource} input
 */
const resolveBranchWorkingTreeComparison = async (launchPath, input) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const comparison = await resolveBranchComparison(
    repoRoot,
    normalizeBranchSourceInput(toBranchComparisonInput(input)),
  );
  /** @type {BranchWorkingTreeSource} */
  const source = {
    baseRef: comparison.oldRef,
    headRef: comparison.newRef,
    ref: comparison.source.ref,
    type: 'branch-working-tree',
  };
  return { oldRef: comparison.oldRef, repoRoot, source };
};

/** @param {string} oldRef */
const getCombinedSectionRef = (oldRef) => `combined:${oldRef}`;

/**
 * The snapshot stages conflicted paths as their working contents, so restore
 * the real `conflicted` status and keep unresolved paths visible even when
 * their working contents already match the base.
 * @param {string} repoRoot
 * @param {import('./branch-snapshot.cjs').BranchSnapshot} snapshot
 * @param {string} oldRef
 */
const readBranchWorkingTreeStatus = async (repoRoot, snapshot, oldRef) => {
  const status = await readCommitNameStatus(repoRoot, snapshot.tree, oldRef, {
    env: snapshot.env,
    pathspec: snapshot.pathspec,
    sort: false,
  });
  const unreadable = new Set(
    snapshot.placeholders
      .filter((item) => item.summary?.loadState === 'error')
      .map((item) => item.path),
  );
  const conflicted = new Set(snapshot.conflictedPaths);
  /** @type {Array<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>} */
  const items = status
    .filter((item) => !unreadable.has(item.path))
    .map((item) => (conflicted.has(item.path) ? { ...item, status: 'conflicted' } : item));
  const paths = new Set(items.map((item) => item.path));
  for (const path of conflicted) {
    if (!paths.has(path) && !unreadable.has(path)) {
      items.push({ path, status: 'conflicted' });
    }
  }
  return items;
};

/**
 * Represent paths intentionally omitted from the snapshot tree with their working-tree summaries.
 * @param {string} repoRoot
 * @param {StatusItem} item
 * @param {string} ref
 * @returns {Promise<ChangedFile>}
 */
const createSnapshotPlaceholderFile = async (repoRoot, item, ref) => {
  const section = await createSection(repoRoot, item, 'unstaged');
  return {
    fingerprint: getFingerprint(
      `${ref}\n${item.status}\n${item.path}\n${section.summary?.reason || ''}\n${section.summary?.fingerprint || ''}`,
    ),
    path: item.path,
    sections: [{ ...section, id: `${item.path}:${ref}`, kind: 'combined' }],
    status: item.status,
  };
};

/**
 * @param {string} launchPath
 * @param {string | BranchSource | BranchDiffSource | BranchWorkingTreeSource} input
 * @param {{showWhitespace?: boolean}} [options]
 * @returns {Promise<RepositoryState>}
 */
const readBranchWorkingTreeState = async (launchPath, input, options = {}) => {
  const { oldRef, repoRoot, source } = await resolveBranchWorkingTreeComparison(
    launchPath,
    typeof input === 'object' && input.type === 'branch-working-tree'
      ? { ref: input.ref, type: 'branch' }
      : input,
  );
  const ref = getCombinedSectionRef(oldRef);

  return withBranchSnapshot(repoRoot, oldRef, async (snapshot) => {
    const status = await readBranchWorkingTreeStatus(repoRoot, snapshot, oldRef);
    const comparedPaths = new Set(status.map((item) => item.path));
    const [state, placeholders] = await Promise.all([
      readComparisonState({
        launchPath,
        newRef: snapshot.tree,
        oldRef,
        options: {
          blobCacheKeys: true,
          env: snapshot.env,
          section: { kind: 'combined', ref },
          showWhitespace: options.showWhitespace,
        },
        repoRoot,
        source,
        status,
      }),
      Promise.all(
        snapshot.placeholders
          .filter((item) => !comparedPaths.has(item.path))
          .map((item) => createSnapshotPlaceholderFile(repoRoot, item, ref)),
      ),
    ]);
    return { ...state, files: [...state.files, ...placeholders].sort(fileSort) };
  });
};

/**
 * The full comparison has already resolved rename pairs for the UI. Callers
 * without this information can still discover renames for paths new to the base.
 * @param {string} repoRoot
 * @param {string} oldRef
 * @param {DiffSectionContentRequest | DiffImageContentRequest} request
 */
const getBranchSnapshotPaths = async (repoRoot, oldRef, request) => {
  const path = validateRepositoryPath(request.path);
  if (request.basePath != null) {
    const basePath = validateRepositoryPath(request.basePath);
    return basePath === path ? [path] : [basePath, path];
  }
  const baseEntry = await git(repoRoot, ['ls-tree', '-z', oldRef, '--', `:(literal)${path}`]);
  return baseEntry ? [path] : undefined;
};

/**
 * A section read uses the review's merge base and the working tree at the time of the read.
 * @param {string} launchPath
 * @param {DiffSectionContentRequest} request
 */
const readBranchWorkingTreeSectionContent = async (launchPath, request) => {
  const { oldRef, repoRoot } = await resolveBranchWorkingTreeComparison(
    launchPath,
    /** @type {BranchWorkingTreeSource} */ (request.source),
  );

  return withBranchSnapshot(
    repoRoot,
    oldRef,
    async (snapshot) => {
      const placeholder = snapshot.placeholders.find((item) => item.path === request.path);
      if (placeholder) {
        return (
          await createSnapshotPlaceholderFile(repoRoot, placeholder, getCombinedSectionRef(oldRef))
        ).sections[0];
      }
      return readComparisonSectionContent(
        repoRoot,
        snapshot.tree,
        oldRef,
        await readBranchWorkingTreeStatus(repoRoot, snapshot, oldRef),
        request.path,
        'branch',
        {
          blobCacheKeys: true,
          env: snapshot.env,
          force: request.force,
          section: { kind: 'combined', ref: getCombinedSectionRef(oldRef) },
          showWhitespace: request.showWhitespace,
        },
      );
    },
    await getBranchSnapshotPaths(repoRoot, oldRef, request),
  );
};

/**
 * @param {string} launchPath
 * @param {DiffImageContentRequest} request
 * @returns {Promise<DiffImageContentResult>}
 */
const readBranchWorkingTreeImageContent = async (launchPath, request) => {
  try {
    const { oldRef, repoRoot } = await resolveBranchWorkingTreeComparison(
      launchPath,
      /** @type {BranchWorkingTreeSource} */ (request.source),
    );
    return await withBranchSnapshot(
      repoRoot,
      oldRef,
      async (snapshot) => {
        const addition = snapshot.placeholders.find(
          (item) => item.path === request.path && item.summary?.loadState === 'too-large',
        );
        return readComparisonImageContent(
          repoRoot,
          snapshot.tree,
          oldRef,
          addition ? [addition] : await readBranchWorkingTreeStatus(repoRoot, snapshot, oldRef),
          request.path,
          'branch',
          { env: snapshot.env, workingTree: true },
        );
      },
      await getBranchSnapshotPaths(repoRoot, oldRef, request),
    );
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : 'Codiff could not load this image.',
      status: 'unavailable',
    };
  }
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
  readBranchImageContent,
  readBranchSectionContent,
  readBranchState,
  readBranchWorkingTreeImageContent,
  readBranchWorkingTreeSectionContent,
  readBranchWorkingTreeState,
  readCommitImageContent,
  readCommitSectionContent,
  readCommitState,
  readResolvedCommitState,
  readRangeImageContent,
  readRangeSectionContent,
  readRangeState,
};
