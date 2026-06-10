// @ts-check

const { gitOrEmpty } = require('./git-state/common.cjs');

/**
 * @typedef {{ kind?: string; type?: string }} WalkthroughSource
 * @typedef {{ generatedAt?: unknown; source?: WalkthroughSource; chapters?: unknown; support?: unknown }} WalkthroughInput
 */

/** @param {unknown} value @returns {ReadonlyArray<any>} */
const asArray = (value) => (Array.isArray(value) ? value : []);

const WORKING_TREE_HUNK_ID = /^(.*):(staged|unstaged):h[1-9]\d*$/;

/**
 * @param {unknown} value
 * @returns {string | null}
 */
const pathFromWorkingTreeHunkId = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const match = WORKING_TREE_HUNK_ID.exec(value.trim());
  return match?.[1] || null;
};

/**
 * The paths a walkthrough is anchored to, gathered from legacy stop anchors,
 * support files, v4 hunk ids, and normalized hunk objects. Repo-root relative,
 * matching how the walkthrough records them (and how `git log -- <path>` expects
 * them).
 * @param {WalkthroughInput} input
 * @returns {Array<string>}
 */
const collectWalkthroughPaths = (input) => {
  /** @type {Set<string>} */
  const paths = new Set();
  /** @param {unknown} value */
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) {
      paths.add(value.trim());
    }
  };
  /** @param {unknown} value */
  const addHunkIdPath = (value) => {
    add(pathFromWorkingTreeHunkId(value));
  };
  /** @param {any} anchor */
  const visit = (anchor) => {
    if (anchor && typeof anchor === 'object') {
      add(anchor.path);
      add(anchor.oldPath);
    }
  };
  /** @param {any} group */
  const visitHunkGroup = (group) => {
    for (const hunkId of asArray(group?.hunkIds)) {
      addHunkIdPath(hunkId);
    }
    for (const hunk of asArray(group?.hunks)) {
      visit(hunk);
    }
  };

  for (const chapter of asArray(input?.chapters)) {
    for (const stop of asArray(chapter?.stops)) {
      visitHunkGroup(stop);
      for (const anchor of asArray(stop?.anchors)) {
        visit(anchor);
      }
    }
  }
  for (const group of asArray(input?.support)) {
    visitHunkGroup(group);
    for (const file of asArray(group?.files)) {
      visit(file);
    }
  }

  return [...paths];
};

/** @param {WalkthroughInput} input */
const isWorkingTreeWalkthrough = (input) => {
  const kind = input?.source?.kind ?? input?.source?.type;
  // Working-tree is the implicit default the normalizer falls back to.
  return kind == null || kind === 'working-tree';
};

/**
 * When a working-tree walkthrough fails to anchor because the current diff is
 * empty, work out *why* so the modal can say something useful instead of a bare
 * "no changed files". The common cause: the staged/working changes were
 * committed since the walkthrough was authored, so `git diff` is now clean.
 *
 * Returns a human-readable reason, or null when nothing more specific than the
 * caller's default can be determined.
 *
 * @param {{ repositoryRoot: string; input: WalkthroughInput; hasFiles: boolean }} params
 * @returns {Promise<string | null>}
 */
const diagnoseWalkthroughMismatch = async ({ repositoryRoot, input, hasFiles }) => {
  // With files present, the mismatch is about anchors, not a vanished diff; the
  // caller's existing detail message is more appropriate there.
  if (hasFiles || !isWorkingTreeWalkthrough(input)) {
    return null;
  }

  const paths = collectWalkthroughPaths(input);
  if (!paths.length) {
    return null;
  }

  // The newest commit touching any anchored path. Empty when those paths have
  // never been committed (e.g. untracked files that were since discarded).
  const log = await gitOrEmpty(repositoryRoot, [
    'log',
    '-n',
    '1',
    '--pretty=format:%h%x1f%s%x1f%cI',
    '--',
    ...paths,
  ]);
  // Fields are joined by the unit-separator byte (git's %x1f) so commit
  // subjects with arbitrary characters parse safely.
  const unitSeparator = String.fromCharCode(0x1f);
  const [hash, subject, isoDate] = log.trim().split(unitSeparator);

  if (!hash) {
    return 'This walkthrough was anchored to uncommitted changes, but the working tree is now clean — they appear to have been reverted or discarded, so the walkthrough no longer matches.';
  }

  // If the only commit touching these files predates the walkthrough, those
  // changes were never committed; they were stashed/reverted instead.
  const generatedAt =
    typeof input?.generatedAt === 'string' ? Date.parse(input.generatedAt) : Number.NaN;
  const committedAt = Date.parse(isoDate);
  const committedAfterAuthoring =
    Number.isNaN(generatedAt) || Number.isNaN(committedAt) || committedAt >= generatedAt - 60_000;

  if (!committedAfterAuthoring) {
    return 'This walkthrough was anchored to uncommitted changes, but the working tree is now clean — they appear to have been stashed or reverted, so the walkthrough no longer matches.';
  }

  const commitLabel = subject ? `“${subject}” (${hash})` : hash;
  return `These changes were committed since the walkthrough was authored — most recently in ${commitLabel}. The walkthrough is anchored to uncommitted working-tree changes, which are now gone, so it no longer matches. Open that commit to review the changes.`;
};

module.exports = {
  collectWalkthroughPaths,
  diagnoseWalkthroughMismatch,
};
