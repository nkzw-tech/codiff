// @ts-check

const {
  EAGER_TEXT_FILE_LIMIT,
  MANUAL_TEXT_FILE_LIMIT,
  bufferToTextFile,
  createSummary,
  fileSort,
  formatBytes,
  getFingerprint,
  getGravatarHash,
  git,
  gitBufferWithInput,
  normalizeStatus,
  readGitImageFile,
  summarizeContent,
  validateRepositoryPath,
} = require('./common.cjs');
const { readCommitMetadataForCommit } = require('./commit-metadata.cjs');

/**
 * @typedef {import('../../src/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../src/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../../src/types.ts').RepositoryState} RepositoryState
 * @typedef {import('./common.cjs').StatusItem} StatusItem
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

/** @param {string} path */
const createEmptyFileContent = (path) => ({
  binary: false,
  file: {
    cacheKey: `empty:${path}`,
    contents: '',
    name: path,
  },
});

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

/** @param {string} repoRoot @param {string} commit @param {string | undefined} firstParent @param {string} path */
const readCommitPatch = (repoRoot, commit, firstParent, path) =>
  git(
    repoRoot,
    firstParent
      ? ['diff', '--patch', '--no-ext-diff', '--find-renames', firstParent, commit, '--', path]
      : ['show', '--format=', '--patch', '--no-ext-diff', '--find-renames', commit, '--', path],
  );

/** @param {ReadonlyArray<string>} values @param {number} size */
const chunk = (values, size) => {
  /** @type {Array<Array<string>>} */
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

/** @param {string} patch */
const splitCommitPatch = (patch) =>
  patch
    .split(/(?=^diff --git )/m)
    .map((part) => part.trimEnd())
    .filter((part) => part.startsWith('diff --git '))
    .map((part) => `${part}\n`);

/**
 * @param {string} repoRoot
 * @param {string} ref
 * @param {ReadonlyArray<string>} paths
 */
const readTreeEntries = async (repoRoot, ref, paths) => {
  /** @type {Map<string, {object: string; type: string}>} */
  const entries = new Map();
  const uniquePaths = [...new Set(paths)];

  for (const pathChunk of chunk(uniquePaths, 200)) {
    if (pathChunk.length === 0) {
      continue;
    }

    const raw = await git(repoRoot, ['ls-tree', '-rz', ref, '--', ...pathChunk]);
    for (const record of raw.split('\0')) {
      if (!record) {
        continue;
      }

      const tabIndex = record.indexOf('\t');
      if (tabIndex === -1) {
        continue;
      }

      const [mode, type, object] = record.slice(0, tabIndex).split(' ');
      const path = record.slice(tabIndex + 1);
      if (mode && type && object) {
        entries.set(path, { object, type });
      }
    }
  }

  return entries;
};

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} objects
 */
const readObjectSizes = async (repoRoot, objects) => {
  /** @type {Map<string, {size: number; type: string}>} */
  const sizes = new Map();
  const uniqueObjects = [...new Set(objects)];
  if (uniqueObjects.length === 0) {
    return sizes;
  }

  const output = (
    await gitBufferWithInput(
      repoRoot,
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      `${uniqueObjects.join('\n')}\n`,
    )
  ).toString('utf8');

  for (const line of output.split('\n')) {
    if (!line) {
      continue;
    }

    const [object, type, size] = line.split(' ');
    if (object && type && size && type !== 'missing') {
      sizes.set(object, {
        size: Number(size),
        type,
      });
    }
  }

  return sizes;
};

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<{object: string; size: number}>} objects
 */
const readObjectContents = async (repoRoot, objects) => {
  /** @type {Map<string, Buffer>} */
  const contents = new Map();
  /** @type {Array<{object: string; size: number}>} */
  let batch = [];
  let batchSize = 0;

  const flush = async () => {
    if (batch.length === 0) {
      return;
    }

    const output = await gitBufferWithInput(
      repoRoot,
      ['cat-file', '--batch'],
      `${batch.map((item) => item.object).join('\n')}\n`,
    );
    let offset = 0;

    for (const item of batch) {
      const headerEnd = output.indexOf(10, offset);
      if (headerEnd === -1) {
        break;
      }

      const header = output.subarray(offset, headerEnd).toString('utf8');
      const [, type, sizeText] = header.split(' ');
      const size = Number(sizeText);
      const contentStart = headerEnd + 1;
      const contentEnd = contentStart + size;

      if (type === 'blob' && Number.isFinite(size)) {
        contents.set(item.object, output.subarray(contentStart, contentEnd));
      }

      offset = contentEnd + 1;
    }

    batch = [];
    batchSize = 0;
  };

  for (const item of objects) {
    if (batchSize > 0 && batchSize + item.size > 32 * 1024 * 1024) {
      await flush();
    }

    batch.push(item);
    batchSize += item.size;
  }

  await flush();
  return contents;
};

/**
 * @param {number} size
 * @param {number} limit
 */
const createLargeBlobResult = (size, limit) => ({
  binary: false,
  loadState: size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
  summary: createSummary(
    size > MANUAL_TEXT_FILE_LIMIT
      ? `File is ${formatBytes(size)}, so Codiff skipped rendering it.`
      : `File is ${formatBytes(size)} and will be loaded on demand.`,
    {
      canLoad: size <= MANUAL_TEXT_FILE_LIMIT,
      limit,
      size,
    },
  ),
});

/**
 * @param {string} repoRoot
 * @param {string} ref
 * @param {ReadonlyArray<string>} paths
 * @param {{force?: boolean}} [options]
 */
const readGitFiles = async (repoRoot, ref, paths, options = {}) => {
  const limit = options.force ? MANUAL_TEXT_FILE_LIMIT : EAGER_TEXT_FILE_LIMIT;
  const entries = await readTreeEntries(repoRoot, ref, paths);
  const sizes = await readObjectSizes(
    repoRoot,
    [...entries.values()].filter((entry) => entry.type === 'blob').map((entry) => entry.object),
  );
  const readableObjects = [...entries.values()]
    .map((entry) => {
      const object = sizes.get(entry.object);
      return object && object.type === 'blob' && object.size <= limit
        ? {
            object: entry.object,
            size: object.size,
          }
        : null;
    })
    .filter(Boolean);
  const contents = await readObjectContents(repoRoot, readableObjects);
  /** @type {Map<string, ReturnType<typeof createEmptyFileContent> | import('./common.cjs').FileContentResult>} */
  const files = new Map();

  for (const path of paths) {
    const entry = entries.get(path);
    if (!entry) {
      files.set(path, createEmptyFileContent(path));
      continue;
    }

    const object = sizes.get(entry.object);
    if (!object || object.type !== 'blob') {
      files.set(path, createEmptyFileContent(path));
      continue;
    }

    if (object.size > limit) {
      files.set(path, createLargeBlobResult(object.size, limit));
      continue;
    }

    const buffer = contents.get(entry.object);
    files.set(
      path,
      buffer
        ? bufferToTextFile(path, buffer, `${ref}:${path}`)
        : {
            binary: false,
            file: {
              cacheKey: `${ref}:${path}:empty`,
              contents: '',
              name: path,
            },
          },
    );
  }

  return files;
};

/**
 * @param {string} repoRoot
 * @param {string} commit
 * @param {string | undefined} firstParent
 * @param {ReadonlyArray<Pick<StatusItem, 'path'>>} items
 */
const readCommitPatches = async (repoRoot, commit, firstParent, items) => {
  /** @type {Map<string, string>} */
  const patches = new Map();

  for (const itemChunk of chunk(
    items.map((item) => item.path),
    200,
  )) {
    if (itemChunk.length === 0) {
      continue;
    }

    const patch = await git(
      repoRoot,
      firstParent
        ? [
            'diff',
            '--patch',
            '--no-ext-diff',
            '--find-renames',
            firstParent,
            commit,
            '--',
            ...itemChunk,
          ]
        : [
            'show',
            '--format=',
            '--patch',
            '--no-ext-diff',
            '--find-renames',
            commit,
            '--',
            ...itemChunk,
          ],
    );
    const patchChunks = splitCommitPatch(patch);

    if (patchChunks.length === itemChunk.length) {
      for (let index = 0; index < itemChunk.length; index += 1) {
        patches.set(itemChunk[index], patchChunks[index]);
      }
    } else {
      await Promise.all(
        itemChunk.map(async (path) => {
          patches.set(path, await readCommitPatch(repoRoot, commit, firstParent, path));
        }),
      );
    }
  }

  return patches;
};

/**
 * @param {string} commit
 * @param {Pick<StatusItem, 'oldPath' | 'path' | 'status'>} item
 * @param {ReturnType<typeof createEmptyFileContent>} oldFile
 * @param {ReturnType<typeof createEmptyFileContent>} newFile
 * @param {string} patch
 */
const createCommitFile = (commit, item, oldFile, newFile, patch) => {
  const summary = summarizeContent(oldFile, newFile);

  return {
    fingerprint: getFingerprint(
      `${commit}\n${item.status}\n${item.oldPath || ''}\n${summary.loadState || 'ready'}\n${
        summary.summary?.reason || ''
      }\n${summary.summary?.fingerprint || ''}\n${patch}\n${oldFile.file?.contents || ''}\n${
        newFile.file?.contents || ''
      }`,
    ),
    oldPath: item.oldPath,
    path: item.path,
    sections: [
      {
        binary: summary.binary || /Binary files .* differ/.test(patch),
        id: `${item.path}:${commit}`,
        kind: 'commit',
        loadState: summary.loadState,
        newFile: newFile.file,
        oldFile: oldFile.file,
        patch,
        summary: summary.summary,
      },
    ],
    status: item.status,
  };
};

/**
 * @param {string} commit
 * @param {Pick<StatusItem, 'oldPath' | 'path' | 'status'>} item
 * @param {ReturnType<typeof createEmptyFileContent>} oldFile
 * @param {ReturnType<typeof createEmptyFileContent>} newFile
 * @param {string} patch
 */
const createCommitSection = (commit, item, oldFile, newFile, patch) =>
  createCommitFile(commit, item, oldFile, newFile, patch).sections[0];

/** @param {string} launchPath @param {string} ref @returns {Promise<RepositoryState>} */
const readCommitState = async (launchPath, ref) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const commit = (await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  const [firstParent] = await readCommitParents(repoRoot, commit);
  const status = await readCommitNameStatus(repoRoot, commit, firstParent, { sort: false });
  const [commitMetadata, oldFiles, newFiles] = await Promise.all([
    readCommitMetadataForCommit(repoRoot, commit, firstParent, status),
    firstParent
      ? readGitFiles(
          repoRoot,
          firstParent,
          status.map((item) => item.oldPath || item.path),
        )
      : Promise.resolve(new Map()),
    readGitFiles(
      repoRoot,
      commit,
      status.map((item) => item.path),
    ),
  ]);
  const readyItems = status.filter((item) => {
    const oldFile = firstParent
      ? oldFiles.get(item.oldPath || item.path) || createEmptyFileContent(item.oldPath || item.path)
      : createEmptyFileContent(item.oldPath || item.path);
    const newFile = newFiles.get(item.path) || createEmptyFileContent(item.path);
    return summarizeContent(oldFile, newFile).loadState === 'ready';
  });
  const patches = await readCommitPatches(repoRoot, commit, firstParent, readyItems);
  /** @type {Array<ChangedFile>} */
  const files = status
    .map((item) =>
      createCommitFile(
        commit,
        item,
        firstParent
          ? oldFiles.get(item.oldPath || item.path) ||
              createEmptyFileContent(item.oldPath || item.path)
          : createEmptyFileContent(item.oldPath || item.path),
        newFiles.get(item.path) || createEmptyFileContent(item.path),
        patches.get(item.path) || '',
      ),
    )
    .sort(fileSort);

  return {
    commitMetadata,
    files,
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source: {
      ref: commit,
      type: 'commit',
    },
  };
};

/**
 * @param {string} launchPath
 * @param {string} ref
 * @param {string} requestedPath
 * @param {{force?: boolean}} [options]
 */
const readCommitSectionContent = async (launchPath, ref, requestedPath, options = {}) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const path = validateRepositoryPath(requestedPath);
  const commit = (await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  const [firstParent] = await readCommitParents(repoRoot, commit);
  const status = await readCommitNameStatus(repoRoot, commit, firstParent, { sort: false });
  const item = status.find((candidate) => candidate.path === path);
  if (!item) {
    throw new Error('File is not part of this commit.');
  }

  const [oldFiles, newFiles] = await Promise.all([
    firstParent
      ? readGitFiles(repoRoot, firstParent, [item.oldPath || item.path], options)
      : Promise.resolve(new Map()),
    readGitFiles(repoRoot, commit, [item.path], options),
  ]);
  const oldFile = firstParent
    ? oldFiles.get(item.oldPath || item.path) || createEmptyFileContent(item.oldPath || item.path)
    : createEmptyFileContent(item.oldPath || item.path);
  const newFile = newFiles.get(item.path) || createEmptyFileContent(item.path);
  const summary = summarizeContent(oldFile, newFile);
  const patch =
    summary.loadState === 'ready'
      ? await readCommitPatch(repoRoot, commit, firstParent, item.path)
      : '';

  return createCommitSection(commit, item, oldFile, newFile, patch);
};

/**
 * @param {string} launchPath
 * @param {string} ref
 * @param {string} requestedPath
 * @returns {Promise<DiffImageContentResult>}
 */
const readCommitImageContent = async (launchPath, ref, requestedPath) => {
  try {
    const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
    const path = validateRepositoryPath(requestedPath);
    const commit = (await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    const [firstParent] = await readCommitParents(repoRoot, commit);
    const status = await readCommitNameStatus(repoRoot, commit, firstParent, { sort: false });
    const item = status.find((candidate) => candidate.path === path);
    if (!item) {
      throw new Error('File is not part of this commit.');
    }

    const [oldImage, newImage] = await Promise.all([
      firstParent ? readGitImageFile(repoRoot, firstParent, item.oldPath || item.path) : undefined,
      readGitImageFile(repoRoot, commit, item.path),
    ]);

    if (!oldImage && !newImage) {
      return {
        reason: 'Codiff could not load either side of this image.',
        status: 'unavailable',
      };
    }

    return {
      ...(newImage ? { newImage } : {}),
      ...(oldImage ? { oldImage } : {}),
      status: 'ready',
    };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : 'Codiff could not load this image.',
      status: 'unavailable',
    };
  }
};

/** @param {string} launchPath @param {string} ref @returns {Promise<RepositoryState>} */
const readBranchState = async (launchPath, ref) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);

  return {
    files: [],
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source: {
      ref,
      type: 'branch',
    },
  };
};

/** @param {string} launchPath @param {ReviewSource} [source] @returns {Promise<RepositoryState>} */
const readRepositoryState = async (launchPath, source = { type: 'working-tree' }) =>
  source.type === 'pull-request'
    ? readPullRequestState(launchPath, source)
    : source.type === 'commit'
      ? readCommitState(launchPath, source.ref)
      : source.type === 'branch'
        ? readBranchState(launchPath, source.ref)
        : readWorkingTreeState(launchPath);

/** @param {string} launchPath @param {number} [limit] @param {string} [ref] */
const listRepositoryHistory = async (launchPath, limit = 200, ref = 'HEAD') => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  try {
    await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
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
  readBranchState,
  readCommitImageContent,
  readCommitSectionContent,
  readCommitState,
};
