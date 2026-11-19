// @ts-check

const { promises: fs } = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, join, resolve } = require('node:path');
const { createSummary, git, gitBuffer, gitBufferWithInput, parseStatus } = require('./common.cjs');
const { listUntrackedItems } = require('./working-tree.cjs');

/**
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 * @typedef {{
 *   conflictedPaths: ReadonlyArray<string>;
 *   env: NodeJS.ProcessEnv;
 *   tree: string;
 *   pathspec: ReadonlyArray<string>;
 *   untrackedPlaceholders: ReadonlyArray<StatusItem>;
 * }} BranchSnapshot
 */

/**
 * Stage the working tree's pending changes into a temporary index and object store, and pass
 * the resulting tree to `run`. Use the supplied Git environment to read the tree. Snapshot
 * objects expire when `run` settles.
 * @template T
 * @param {string} repoRoot
 * @param {(snapshot: BranchSnapshot) => Promise<T>} run
 * @param {ReadonlyArray<string>} [paths] Paths in the reviewed file pair for a lazy read.
 */
const withBranchSnapshot = async (repoRoot, run, paths) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'codiff-branch-snapshot-'));

  try {
    const [indexPath, objectsPath] = (
      await git(repoRoot, ['rev-parse', '--git-path', 'index', '--git-path', 'objects'])
    )
      .trim()
      .split('\n')
      .map((path) => resolve(repoRoot, path));
    const configCount = Number(process.env.GIT_CONFIG_COUNT || 0);
    const env = {
      ...process.env,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [
        JSON.stringify(objectsPath),
        process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
      ]
        .filter(Boolean)
        .join(delimiter),
      GIT_CONFIG_COUNT: String(configCount + 3),
      [`GIT_CONFIG_KEY_${configCount}`]: 'lfs.storage',
      [`GIT_CONFIG_VALUE_${configCount}`]: join(directory, 'lfs'),
      [`GIT_CONFIG_KEY_${configCount + 1}`]: 'core.splitIndex',
      [`GIT_CONFIG_VALUE_${configCount + 1}`]: 'false',
      // A post-index-change hook could modify the working tree during review.
      [`GIT_CONFIG_KEY_${configCount + 2}`]: 'core.hooksPath',
      [`GIT_CONFIG_VALUE_${configCount + 2}`]: join(directory, 'hooks'),
      GIT_INDEX_FILE: join(directory, 'index'),
      GIT_OBJECT_DIRECTORY: join(directory, 'objects'),
    };
    await Promise.all([fs.mkdir(env.GIT_OBJECT_DIRECTORY), fs.mkdir(join(directory, 'hooks'))]);
    try {
      const indexStat = await fs.stat(indexPath);
      await fs.copyFile(indexPath, env.GIT_INDEX_FILE);
      await fs.utimes(env.GIT_INDEX_FILE, indexStat.atime, Math.floor(indexStat.mtimeMs / 1000));
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
        throw error;
      }
    }

    const pathspec = paths?.map((path) => `:(literal)${path}`) ?? [];
    const [listedUntracked, originalStatus] = await Promise.all([
      listUntrackedItems(repoRoot),
      git(
        repoRoot,
        ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uno', '--', ...pathspec],
        { env },
      ),
    ]);
    const untracked = paths
      ? listedUntracked.filter((item) => paths.includes(item.path))
      : listedUntracked;
    const status = parseStatus(originalStatus);
    const cachedRemovals = status.filter((item) => item.staged && item.status === 'deleted');
    const removedUntracked = cachedRemovals.length
      ? (
          await git(
            repoRoot,
            [
              'ls-files',
              '--others',
              '--exclude-standard',
              '-z',
              '--',
              ...cachedRemovals.map((item) => `:(literal)${item.path}`),
            ],
            { env },
          )
        )
          .split('\0')
          .filter(Boolean)
      : [];
    const recoveredPaths = new Set(removedUntracked);
    const placeholders = untracked.filter(
      (item) => item.directory && !recoveredPaths.has(item.path),
    );
    let untrackedPaths = [
      ...new Set([
        ...untracked.filter((item) => !item.directory).map((item) => item.path),
        ...removedUntracked,
      ]),
    ];
    // An untracked-only or already deleted path will not match 'git add --update'.
    const updates = status.filter((item) => item.unstaged);
    if (!paths || updates.length) {
      await git(
        repoRoot,
        [
          'add',
          '--update',
          '--',
          ...(paths ? updates.map((item) => `:(literal)${item.path}`) : []),
        ],
        { env },
      );
    }
    while (untrackedPaths.length > 0) {
      try {
        await gitBufferWithInput(
          repoRoot,
          ['add', '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'],
          Buffer.from(`${untrackedPaths.map((path) => `:(literal)${path}`).join('\0')}\0`),
          { env },
        );
        break;
      } catch (error) {
        const exitCode = /** @type {Error & {exitCode?: number}} */ (error).exitCode;
        if (exitCode === 1) {
          // --ignore-errors stages the readable files. Ask the private index which
          // paths are still untracked instead of parsing localized Git diagnostics.
          const remaining = new Set(
            (
              await git(
                repoRoot,
                ['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspec],
                { env },
              )
            ).split('\0'),
          );
          for (const path of untrackedPaths.filter((path) => remaining.has(path))) {
            placeholders.push({
              path,
              staged: false,
              status: 'untracked',
              unstaged: true,
              untracked: true,
              summary: createSummary('Git could not add this file to the review snapshot.', {
                canLoad: false,
                loadState: 'error',
              }),
            });
          }
          break;
        }
        if (exitCode !== 128) {
          throw error;
        }
        const remainingPaths = (
          await Promise.all(
            untrackedPaths.map(async (path) => {
              try {
                await fs.lstat(resolve(repoRoot, path));
                return path;
              } catch (fileError) {
                const code = /** @type {NodeJS.ErrnoException} */ (fileError).code;
                if (code === 'ENOENT' || code === 'ENOTDIR') {
                  return null;
                }
                throw fileError;
              }
            }),
          )
        ).filter((path) => path !== null);
        if (remainingPaths.length === untrackedPaths.length) {
          throw error;
        }
        untrackedPaths = remainingPaths;
      }
    }

    let treeEnv = env;
    if (paths) {
      // Only materialize this pair. The copied index can still contain unresolved
      // conflicts elsewhere, which would make a whole-index write-tree fail.
      const entries = await gitBuffer(repoRoot, ['ls-files', '--stage', '-z', '--', ...pathspec], {
        env,
      });
      treeEnv = { ...env, GIT_INDEX_FILE: join(directory, 'selected-index') };
      await gitBufferWithInput(repoRoot, ['update-index', '-z', '--index-info'], entries, {
        env: treeEnv,
      });
    }
    const tree = (await git(repoRoot, ['write-tree'], { env: treeEnv })).trim();
    return await run({
      conflictedPaths: status
        .filter((item) => item.status === 'conflicted')
        .map((item) => item.path),
      env,
      tree,
      pathspec,
      untrackedPlaceholders: placeholders,
    });
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
};

module.exports = { withBranchSnapshot };
