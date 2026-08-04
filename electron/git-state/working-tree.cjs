// @ts-check

const {
  createRepositoryWatcherSnapshot,
  parseRepositoryWatcherStatus,
  setRepositoryWatcherInitialSnapshot,
} = require('../repository-watcher.cjs');
const {
  createSection,
  createSummary,
  fileSort,
  generatedDirectoryPathspecExcludes,
  generatedDirectoryPathspecs,
  getFingerprint,
  getGravatarHash,
  getWhitespaceDiffArgs,
  git,
  MAX_UNTRACKED_INITIAL_ITEMS,
  normalizeStatus,
} = require('./common.cjs');

/**
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').DiffSection} DiffSection
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 * @typedef {'staged' | 'unstaged'} WorkingTreeSectionKind
 */

const diffGitHeaderPattern = /^diff --git (.+)$/;

/** @param {string} record @param {number} count */
const readPorcelainV2StatusPath = (record, count) => {
  let index = 0;
  for (let field = 0; field < count; field += 1) {
    index = record.indexOf(' ', index);
    if (index === -1) {
      return '';
    }
    index += 1;
  }
  return record.slice(index);
};

/** @param {string} x @param {string} y @param {string} path @param {string} [oldPath] */
const createPorcelainV2StatusItem = (x, y, path, oldPath) => {
  const conflictCode = `${x}${y}`;
  const conflicted = ['AA', 'AU', 'DD', 'DU', 'UA', 'UD', 'UU'].includes(conflictCode);
  if (conflicted) {
    return {
      ...(oldPath ? { oldPath } : {}),
      ...(conflictCode === 'DD'
        ? { conflictStage: 1 }
        : conflictCode === 'DU' || conflictCode === 'UA'
          ? {}
          : { conflictStage: 2 }),
      path,
      staged: false,
      status: 'conflicted',
      unstaged: true,
      untracked: false,
    };
  }
  const staged = x !== '.' && x !== ' ';
  const unstaged = y !== '.' && y !== ' ';
  return {
    ...(oldPath ? { oldPath } : {}),
    path,
    staged,
    status: normalizeStatus(staged ? x : y),
    unstaged,
    untracked: false,
  };
};

/** @param {string} raw @returns {Array<StatusItem>} */
const parsePorcelainV2Status = (raw) => {
  const files = [];
  const records = raw.split('\0').filter(Boolean);

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith('? ')) {
      files.push({
        path: record.slice(2),
        staged: false,
        status: 'untracked',
        unstaged: true,
        untracked: true,
      });
      continue;
    }
    if (record.startsWith('1 ')) {
      files.push(
        createPorcelainV2StatusItem(record[2], record[3], readPorcelainV2StatusPath(record, 8)),
      );
      continue;
    }
    if (record.startsWith('2 ')) {
      files.push(
        createPorcelainV2StatusItem(
          record[2],
          record[3],
          readPorcelainV2StatusPath(record, 9),
          records[++index],
        ),
      );
      continue;
    }
    if (record.startsWith('u ')) {
      files.push(
        createPorcelainV2StatusItem(record[2], record[3], readPorcelainV2StatusPath(record, 10)),
      );
    }
  }

  return files;
};

/** @param {string} value */
const unquoteGitPath = (value) => {
  if (!value.startsWith('"')) {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value.slice(1, value.endsWith('"') ? -1 : undefined);
  }
};

/** @param {string} line */
const splitDiffGitHeader = (line) => {
  const match = line.match(diffGitHeaderPattern);
  if (!match) {
    return null;
  }

  const paths = [];
  let index = 0;
  const value = match[1];
  while (index < value.length && paths.length < 2) {
    while (value[index] === ' ') {
      index += 1;
    }

    if (value[index] === '"') {
      let end = index + 1;
      let escaped = false;
      while (end < value.length) {
        const char = value[end];
        if (char === '"' && !escaped) {
          end += 1;
          break;
        }
        escaped = char === '\\' && !escaped;
        if (char !== '\\') {
          escaped = false;
        }
        end += 1;
      }
      paths.push(unquoteGitPath(value.slice(index, end)));
      index = end;
      continue;
    }

    const end = value.indexOf(' ', index);
    if (end === -1) {
      paths.push(value.slice(index));
      break;
    }

    paths.push(value.slice(index, end));
    index = end + 1;
  }

  return paths.length === 2 ? paths : null;
};

/** @param {string} path */
const stripGitDiffPrefix = (path) =>
  path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;

/** @param {string} path */
const shouldEagerlyReadWorkingTreeContents = (path) => /\.md$/i.test(path);

/** @param {string} rawPatch @returns {Map<string, {binary: boolean; patch: string}>} */
const splitPatchByPath = (rawPatch) => {
  const patches = new Map();
  const starts = [];
  const pattern = /^diff --git .+$/gm;
  let match;

  while ((match = pattern.exec(rawPatch))) {
    starts.push(match.index);
  }

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? rawPatch.length;
    const patch = rawPatch.slice(start, end);
    const header = patch.slice(0, patch.indexOf('\n') === -1 ? patch.length : patch.indexOf('\n'));
    const paths = splitDiffGitHeader(header);
    const path = paths ? stripGitDiffPrefix(paths[1]) : null;
    if (path) {
      patches.set(path, {
        binary: /Binary files .* differ/.test(patch),
        patch,
      });
    }
  }

  return patches;
};

/**
 * @param {string} repoRoot
 * @param {WorkingTreeSectionKind} kind
 * @param {{head?: string; showWhitespace?: boolean}} [options]
 * @returns {Promise<Map<string, {binary: boolean; patch: string}>>}
 */
const readPatchMap = async (repoRoot, kind, options = {}) => {
  const whitespaceArgs = getWhitespaceDiffArgs(options);
  const args =
    kind === 'staged'
      ? [
          'diff',
          '--cached',
          '--patch',
          '--no-ext-diff',
          ...whitespaceArgs,
          ...(options.head ? [options.head] : []),
        ]
      : ['diff', '--patch', '--no-ext-diff', ...whitespaceArgs];
  return splitPatchByPath(await git(repoRoot, args));
};

/** @param {string} repoRoot @returns {Promise<Array<StatusItem>>} */
const listUntrackedItems = async (repoRoot) => {
  const rawFiles = await git(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    '.',
    ...generatedDirectoryPathspecExcludes,
  ]);
  const paths = rawFiles.split('\0').filter(Boolean).sort();
  /** @type {Array<StatusItem>} */
  const items = paths.slice(0, MAX_UNTRACKED_INITIAL_ITEMS).map((path) => ({
    path,
    staged: false,
    status: 'untracked',
    unstaged: true,
    untracked: true,
  }));

  if (paths.length > MAX_UNTRACKED_INITIAL_ITEMS) {
    const omitted = paths.length - MAX_UNTRACKED_INITIAL_ITEMS;
    items.push({
      directory: true,
      path: `Untracked files not shown (${omitted} more)`,
      staged: false,
      status: 'untracked',
      summary: createSummary(`${omitted} untracked files are not shown.`, {
        canLoad: false,
        fileCount: omitted,
        loadState: 'directory',
      }),
      unstaged: true,
      untracked: true,
    });
  }

  const rawDirectories = await git(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--directory',
    '-z',
    '--',
    ...generatedDirectoryPathspecs,
  ]);

  for (const path of rawDirectories.split('\0').filter(Boolean)) {
    items.push({
      directory: true,
      path: path.endsWith('/') ? path.slice(0, -1) : path,
      staged: false,
      status: 'untracked',
      unstaged: true,
      untracked: true,
    });
  }

  const unique = new Map();
  for (const item of items) {
    unique.set(item.path, item);
  }

  return [...unique.values()].sort(fileSort);
};

/**
 * @param {string} launchPath
 * @param {{eagerContents?: boolean; repositoryRoot?: string; showWhitespace?: boolean}} [options]
 * @returns {Promise<RepositoryState>}
 */
const readWorkingTreeState = async (launchPath, options = {}) => {
  const repoRoot =
    options.repositoryRoot || (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const [watcherStatus, untrackedItems, rawHead] = await Promise.all([
    git(repoRoot, ['status', '--porcelain=v2', '--branch', '-z', '-uall']),
    listUntrackedItems(repoRoot),
    gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
  ]);
  const head = rawHead.trim();
  const initialWatcherSnapshot = createRepositoryWatcherSnapshot(
    repoRoot,
    parseRepositoryWatcherStatus(watcherStatus),
  );
  const status = [
    ...parsePorcelainV2Status(watcherStatus).filter(({ untracked }) => !untracked),
    ...untrackedItems,
  ].sort(fileSort);
  const shouldUsePatchOnly = options.eagerContents === false;
  const [stagedPatches, unstagedPatches] = shouldUsePatchOnly
    ? await Promise.all([
        readPatchMap(repoRoot, 'staged', { ...options, head }),
        readPatchMap(repoRoot, 'unstaged', options),
      ])
    : [new Map(), new Map()];
  /** @type {Array<ChangedFile>} */
  const files = [];

  for (const item of status) {
    /** @type {Array<DiffSection>} */
    const sections = [];
    const patchOnly = shouldUsePatchOnly && !shouldEagerlyReadWorkingTreeContents(item.path);

    if (item.staged) {
      sections.push(
        await createSection(repoRoot, item, 'staged', {
          head,
          patch: stagedPatches.get(item.path),
          patchOnly,
          showWhitespace: options.showWhitespace,
        }),
      );
    }

    if (item.unstaged) {
      sections.push(
        await createSection(repoRoot, item, 'unstaged', {
          head,
          patch: item.status === 'conflicted' ? undefined : unstagedPatches.get(item.path),
          patchOnly,
          showWhitespace: options.showWhitespace,
        }),
      );
    }

    const fingerprint = getFingerprint(
      `${item.status}\n${item.oldPath || ''}\n${sections
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

    files.push({
      fingerprint,
      oldPath: item.oldPath,
      path: item.path,
      sections,
      status: item.status,
    });
  }

  return setRepositoryWatcherInitialSnapshot(
    {
      files,
      generatedAt: Date.now(),
      launchPath,
      root: repoRoot,
      source: {
        type: 'working-tree',
      },
    },
    initialWatcherSnapshot,
  );
};

/** @param {string} repoRoot @param {ReadonlyArray<string>} args */
const gitOrEmpty = async (repoRoot, args) => {
  try {
    return await git(repoRoot, args);
  } catch {
    return '';
  }
};

const gitIdentityReads = new Map();

/** @param {string} launchPath */
const readGitIdentity = (launchPath) => {
  const existing = gitIdentityReads.get(launchPath);
  if (existing) {
    return existing;
  }
  const read = Promise.all([
    gitOrEmpty(launchPath, ['config', '--get', 'user.name']),
    gitOrEmpty(launchPath, ['config', '--get', 'user.email']),
  ])
    .then(([configuredName, configuredEmail]) => {
      const email = configuredEmail.trim();
      const name = configuredName.trim();
      return {
        email,
        gravatarUrl: email
          ? `https://www.gravatar.com/avatar/${getGravatarHash(email)}?s=80&d=identicon`
          : undefined,
        name,
      };
    })
    .finally(() => {
      gitIdentityReads.delete(launchPath);
    });
  gitIdentityReads.set(launchPath, read);
  return read;
};

module.exports = {
  parsePorcelainV2Status,
  readGitIdentity,
  readWorkingTreeState,
};
