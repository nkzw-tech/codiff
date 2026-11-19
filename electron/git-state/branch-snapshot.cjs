// @ts-check

const { promises: fs } = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, join, resolve } = require('node:path');
const {
  MANUAL_TEXT_FILE_LIMIT,
  createSummary,
  formatBytes,
  git,
  gitBuffer,
  gitBufferWithInput,
  parseStatus,
  readFileStat,
} = require('./common.cjs');
const { readObjectSizes } = require('./git-files.cjs');
const { listUntrackedItems } = require('./working-tree.cjs');

/**
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 * @typedef {{
 *   conflictedPaths: ReadonlyArray<string>;
 *   env: NodeJS.ProcessEnv;
 *   tree: string;
 *   pathspec: ReadonlyArray<string>;
 *   placeholders: ReadonlyArray<StatusItem>;
 * }} BranchSnapshot
 */

/** @param {string} path @param {StatusItem['status']} status @returns {StatusItem} */
const snapshotError = (path, status) => ({
  path,
  status,
  staged: false,
  unstaged: true,
  untracked: true,
  summary: createSummary('Git could not add this file to the review snapshot.', {
    canLoad: false,
    loadState: 'error',
  }),
});

/** @param {string} repoRoot @param {NodeJS.ProcessEnv} env @param {ReadonlyArray<string>} pathspec */
const readStatus = (repoRoot, env, pathspec) =>
  git(
    repoRoot,
    [
      '--no-optional-locks',
      'status',
      '--no-renames',
      '--porcelain=v1',
      '-z',
      '-uno',
      '--',
      ...pathspec,
    ],
    { env },
  );

/**
 * Status and index writes can run a clean filter before staging begins. Locate
 * failing tracked files with path-limited status reads on the original index.
 * Keep their blobs in the private index so unrelated rename pairs stay intact.
 * @param {string} repoRoot
 * @param {NodeJS.ProcessEnv} env
 * @param {string} base
 * @param {unknown} originalError
 */
const isolateStatusErrors = async (repoRoot, env, base, originalError) => {
  /** @type {Map<string, string>} */
  const entries = new Map();
  const index = await git(repoRoot, ['ls-files', '--stage', '-z'], { env });
  for (const entry of index.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab > 0 && entry.slice(0, tab).endsWith(' 0')) entries.set(entry.slice(tab + 1), entry);
  }
  /** @type {Array<string>} */
  const failed = [];
  /** @param {Array<string>} paths @returns {Promise<void>} */
  const inspect = async (paths) => {
    try {
      await readStatus(
        repoRoot,
        env,
        paths.map((path) => `:(literal)${path}`),
      );
    } catch (error) {
      if (/** @type {{code?: number}} */ (error).code !== 128) throw originalError;
      if (paths.length > 1) {
        const middle = Math.ceil(paths.length / 2);
        await inspect(paths.slice(0, middle));
        await inspect(paths.slice(middle));
        return;
      }
      // Only quarantine errors attributable to the file itself.
      try {
        await git(repoRoot, ['hash-object', '--', paths[0]], { env });
      } catch (error) {
        if (/** @type {{code?: number}} */ (error).code !== 128) throw originalError;
        failed.push(paths[0]);
        return;
      }
      throw originalError;
    }
  };
  const paths = [...entries.keys()];
  for (let i = 0; i < paths.length; i += 64) await inspect(paths.slice(i, i + 64));
  if (!failed.length) throw originalError;

  // Reinsert the entries to clear cached stat data. Otherwise even marking
  // them assume-unchanged can re-run the failing filter while writing the index.
  await gitBufferWithInput(
    repoRoot,
    ['update-index', '-z', '--index-info'],
    failed.map((path) => entries.get(path) + '\0').join(''),
    { env },
  );
  await gitBufferWithInput(
    repoRoot,
    ['update-index', '--assume-unchanged', '-z', '--stdin'],
    failed.join('\0') + '\0',
    { env },
  );
  const additions = new Set(
    (
      await git(
        repoRoot,
        ['diff', '--cached', '--no-renames', '--diff-filter=A', '--name-only', '-z', base, '--'],
        { env },
      )
    ).split('\0'),
  );
  return failed.map((path) => snapshotError(path, additions.has(path) ? 'added' : 'modified'));
};

/**
 * A fatal conversion error aborts the whole add, including valid paths. Split
 * failed batches until the path can be diagnosed independently of the index.
 * @param {string} repoRoot
 * @param {NodeJS.ProcessEnv} env
 * @param {ReadonlyArray<string>} paths
 * @param {Array<StatusItem>} placeholders
 * @param {Map<string, StatusItem>} [tracked]
 */
const stagePaths = async (repoRoot, env, paths, placeholders, tracked) => {
  if (!paths.length) return;

  try {
    await gitBufferWithInput(
      repoRoot,
      [
        'add',
        '--sparse',
        ...(tracked ? ['--update'] : []),
        '--ignore-errors',
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
      ],
      Buffer.from(paths.map((path) => `:(literal)${path}\0`).join('')),
      { env },
    );
    return;
  } catch (error) {
    const exitCode = /** @type {Error & {exitCode?: number}} */ (error).exitCode;
    if (exitCode !== 1 && exitCode !== 128) throw error;

    // Fail immediately for a locked or unwritable private index.
    if (exitCode === 128) await git(repoRoot, ['update-index', '--force-write-index'], { env });
    if (paths.length > 1) {
      const middle = Math.ceil(paths.length / 2);
      await stagePaths(repoRoot, env, paths.slice(0, middle), placeholders, tracked);
      await stagePaths(repoRoot, env, paths.slice(middle), placeholders, tracked);
      return;
    }
    const [path] = paths;
    try {
      await fs.lstat(resolve(repoRoot, path));
    } catch (statError) {
      const code = /** @type {NodeJS.ErrnoException} */ (statError).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw statError;
    }
    if (exitCode === 128) {
      // A readable, convertible file points to an index/object-store failure.
      try {
        await git(repoRoot, ['hash-object', '-w', '--', path], { env });
      } catch (conversionError) {
        if (/** @type {{ code?: number }} */ (conversionError).code !== 128) throw error;
        // Remove unresolved stages so write-tree can still complete.
        if (tracked?.get(path)?.status === 'conflicted') {
          await git(repoRoot, ['update-index', '--force-remove', '--', path], { env });
        }
        placeholders.push(snapshotError(path, tracked?.get(path)?.status ?? 'untracked'));
        return;
      }
      throw error;
    }
    placeholders.push(snapshotError(path, tracked?.get(path)?.status ?? 'untracked'));
  }
};

/** @param {string} path */
const hasBinaryHeader = async (path) => {
  try {
    const file = await fs.open(path, 'r');
    try {
      const { buffer, bytesRead } = await file.read(Buffer.alloc(8000), 0, 8000, 0);
      return buffer.subarray(0, bytesRead).includes(0);
    } finally {
      await file.close();
    }
  } catch {
    // Let git add diagnose vanished or unreadable files.
    return false;
  }
};

/**
 * Standalone oversized additions only need a size summary. Keep materializing
 * potential rename targets and files whose Git conversions can change their size.
 * @param {string} repoRoot
 * @param {NodeJS.ProcessEnv} env
 * @param {string} base
 * @param {ReadonlyArray<string>} paths
 * @param {Array<StatusItem>} placeholders
 */
const omitOversizedAdditions = async (repoRoot, env, base, paths, placeholders) => {
  const stats = await Promise.all(paths.map((path) => readFileStat(repoRoot, path)));
  const large = paths.filter(
    (_, i) => stats[i]?.isFile() && stats[i].size > MANUAL_TEXT_FILE_LIMIT,
  );
  if (!large.length) return paths;
  const deletions = await git(
    repoRoot,
    [
      'diff',
      '--cached',
      '--no-renames',
      '--diff-filter=D',
      '--raw',
      '--no-abbrev',
      '-z',
      base,
      '--',
    ],
    { env },
  );
  const records = deletions.split('\0');
  const deletedPaths = new Set();
  const sourceObjects = [];
  for (let i = 0; i + 1 < records.length; i += 2) {
    const [oldMode, , object] = records[i].split(' ');
    deletedPaths.add(records[i + 1]);
    if (oldMode.startsWith(':100')) sourceObjects.push(object);
  }
  const sourceSizes = [...(await readObjectSizes(repoRoot, sourceObjects, env)).values()];

  const [attributes, autoCrlf] = await Promise.all([
    gitBufferWithInput(
      repoRoot,
      [
        'check-attr',
        '-z',
        '--stdin',
        'filter',
        'ident',
        'working-tree-encoding',
        'text',
        'eol',
        'crlf',
      ],
      Buffer.from(large.join('\0') + '\0'),
      { env },
    ),
    git(repoRoot, ['config', '--default=false', '--get', 'core.autocrlf'], { env }),
  ]);
  const converted = new Set();
  const autoText = new Set();
  const autoCrlfEnabled = !/^(false|no|off|0)$/i.test(autoCrlf.trim());
  const fields = attributes.toString('utf8').split('\0');
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [path, attribute, value] = fields.slice(i, i + 3);
    if (
      attribute === 'text' &&
      (value === 'auto' || (value === 'unspecified' && autoCrlfEnabled))
    ) {
      autoText.add(path);
    } else if (value !== 'unset' && value !== 'unspecified') {
      converted.add(path);
    }
  }
  const omitted = new Set();
  for (const [i, path] of paths.entries()) {
    const stat = stats[i];
    if (!stat?.isFile() || stat.size <= MANUAL_TEXT_FILE_LIMIT || converted.has(path)) continue;
    // Git's default 50% similarity threshold requires the smaller blob to be
    // at least half the size of the larger. Same-path replacements always count.
    if (
      deletedPaths.has(path) ||
      sourceSizes.some(({ size }) => size >= stat.size / 2 && size <= stat.size * 2)
    )
      continue;
    if (autoText.has(path) && !(await hasBinaryHeader(resolve(repoRoot, path)))) continue;
    omitted.add(path);
    placeholders.push({
      path,
      status: 'added',
      staged: false,
      unstaged: true,
      untracked: true,
      summary: createSummary(`File is ${formatBytes(stat.size)}, so Codiff skipped rendering it.`, {
        canLoad: false,
        loadState: 'too-large',
        size: stat.size,
        limit: MANUAL_TEXT_FILE_LIMIT,
        fingerprint: `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
      }),
    });
  }
  return paths.filter((path) => !omitted.has(path));
};

/**
 * @param {string} repoRoot
 * @param {NodeJS.ProcessEnv} env
 * @param {string} base
 * @param {{paths?: ReadonlyArray<string>; requestedPath?: string}} selection
 * @param {ReadonlyArray<StatusItem>} errors
 * @returns {Promise<BranchSnapshot>}
 */
const prepareBranchSnapshot = async (repoRoot, env, base, selection, errors) => {
  const { paths } = selection;
  const pathspec = paths?.map((path) => `:(literal)${path}`) ?? [];
  const [originalStatus, baseDeletions] = await Promise.all([
    readStatus(repoRoot, env, pathspec),
    git(
      repoRoot,
      [
        'diff',
        '--cached',
        '--no-renames',
        '--diff-filter=D',
        '--name-only',
        '-z',
        base,
        '--',
        ...pathspec,
      ],
      { env },
    ),
  ]);
  const status = parseStatus(originalStatus);
  const removedPaths = new Set([
    ...baseDeletions.split('\0').filter(Boolean),
    ...status.filter((item) => item.staged && item.status === 'deleted').map((item) => item.path),
  ]);
  const placeholders = errors.filter((item) => !paths || paths.includes(item.path));
  // A deleted child can now be behind a symlink. Remove its index entry
  // directly so Git never has to traverse the replacement on disk.
  const deletions = status.filter((item) => item.worktreeDeleted).map((item) => item.path);
  if (deletions.length) {
    await gitBufferWithInput(
      repoRoot,
      ['update-index', '--force-remove', '-z', '--stdin'],
      Buffer.from(deletions.join('\0') + '\0'),
      { env },
    );
  }
  const updates = new Map(
    status
      .filter((item) => item.unstaged && !item.worktreeDeleted)
      .map((item) => [item.path, item]),
  );
  await stagePaths(repoRoot, env, [...updates.keys()], placeholders, updates);

  /** @param {ReadonlyArray<string>} additions */
  const stageAdditions = async (additions) => {
    if (!additions.length) return;
    const eligible = await omitOversizedAdditions(repoRoot, env, base, additions, placeholders);
    await stagePaths(repoRoot, env, eligible, placeholders);
  };

  // Restore known files before Git collapses generated directories and before
  // the ordinary untracked-file limit is applied. Respect the checkout's ignores.
  const removed = [...removedPaths];
  const restored = new Set();
  for (let i = 0; i < removed.length; i += 64) {
    const batch = removed.slice(i, i + 64).map((path) => `:(literal)${path}`);
    const others = await git(
      repoRoot,
      ['ls-files', '--others', '--directory', '--exclude-standard', '-z', '--', ...batch],
      { env },
    );
    for (const path of others.split('\0')) {
      if (removedPaths.has(path)) restored.add(path);
    }
  }
  await stageAdditions([...restored]);

  const untracked = (await listUntrackedItems(repoRoot, { ...selection, env })).filter(
    (item) => !restored.has(item.path),
  );
  placeholders.push(...untracked.filter((item) => item.directory));
  await stageAdditions(untracked.filter((item) => !item.directory).map((item) => item.path));

  let treeEnv = env;
  if (paths) {
    // Only materialize this pair. The copied index can still contain unresolved
    // conflicts elsewhere, which would make a whole-index write-tree fail.
    const entries = await gitBuffer(repoRoot, ['ls-files', '--stage', '-z', '--', ...pathspec], {
      env,
    });
    treeEnv = { ...env, GIT_INDEX_FILE: `${env.GIT_INDEX_FILE}.selected` };
    await gitBufferWithInput(repoRoot, ['update-index', '-z', '--index-info'], entries, {
      env: treeEnv,
    });
  }
  const tree = (await git(repoRoot, ['write-tree'], { env: treeEnv })).trim();
  return {
    conflictedPaths: status.filter((item) => item.status === 'conflicted').map((item) => item.path),
    env,
    tree,
    pathspec,
    placeholders,
  };
};

/**
 * Stage the working tree's pending changes into a temporary index and object store, and pass
 * the resulting tree to `run`. Use the supplied Git environment to read the tree. Snapshot
 * objects expire when `run` settles.
 * @template T
 * @param {string} repoRoot
 * @param {string} base
 * @param {(snapshot: BranchSnapshot) => Promise<T>} run
 * @param {{ paths?: ReadonlyArray<string>; requestedPath?: string }} [selection] Reviewed file and known rename pair for a lazy read.
 */
const withBranchSnapshot = async (repoRoot, base, run, selection = {}) => {
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
    const copyIndex = async () => {
      try {
        const indexStat = await fs.stat(indexPath);
        await fs.copyFile(indexPath, env.GIT_INDEX_FILE);
        await fs.utimes(env.GIT_INDEX_FILE, indexStat.atime, Math.floor(indexStat.mtimeMs / 1000));
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
          throw error;
        }
      }
    };
    await copyIndex();
    let snapshot;
    try {
      snapshot = await prepareBranchSnapshot(repoRoot, env, base, selection, []);
    } catch (error) {
      const failure = /** @type {{code?: number; exitCode?: number}} */ (error);
      if (failure.code !== 128 && failure.exitCode !== 128) throw error;
      // A failed add can already have updated some entries. Retry from the real index.
      await Promise.all([
        fs.rm(env.GIT_INDEX_FILE, { force: true }),
        fs.rm(`${env.GIT_INDEX_FILE}.selected`, { force: true }),
      ]);
      await copyIndex();
      // Preserve unrelated errors without scanning batches if status succeeds.
      const statusError = await readStatus(repoRoot, env, []).then(
        () => undefined,
        (failure) => failure,
      );
      if (statusError?.code !== 128) throw error;
      const errors = await isolateStatusErrors(repoRoot, env, base, error);
      snapshot = await prepareBranchSnapshot(repoRoot, env, base, selection, errors);
    }
    return await run(snapshot);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
};

module.exports = { withBranchSnapshot };
