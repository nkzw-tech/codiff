// @ts-check

const {
  fileSort,
  getFingerprint,
  getImageMimeType,
  getWhitespaceDiffArgs,
  git,
  readFilteredImageBytes,
  readGitImageFile,
  readWorkingTreeFile,
  readWorkingTreeImageFile,
  summarizeContent,
  validateRepositoryPath,
} = require('./common.cjs');
const { parseNumstat } = require('./commit-metadata.cjs');
const { createEmptyFileContent, readGitFiles } = require('./git-files.cjs');

/**
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../../core/types.ts').DiffSection} DiffSection
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 * @typedef {Pick<StatusItem, 'oldPath' | 'path' | 'status'>} ComparisonItem
 * @typedef {{
 *   blobCacheKeys?: boolean;
 *   env?: NodeJS.ProcessEnv;
 *   force?: boolean;
 *   section?: {kind: DiffSection['kind']; ref: string};
 *   showWhitespace?: boolean;
 * }} ComparisonOptions
 */

/**
 * @param {string} newRef
 * @param {string | undefined} oldRef
 * @param {ReadonlyArray<Pick<StatusItem, 'oldPath' | 'path'>>} items
 * @param {ComparisonOptions} options
 */
const createComparisonPatchArgs = (newRef, oldRef, items, options) => {
  const paths = [
    ...new Set(items.flatMap(({ oldPath, path }) => (oldPath ? [oldPath, path] : [path]))),
  ];
  const pathspec = paths.map((path) => `:(literal)${path}`);
  const single = items.length === 1;
  const [item] = items;
  const nestedRename =
    single &&
    item.oldPath &&
    (item.path.startsWith(`${item.oldPath}/`) || item.oldPath.startsWith(`${item.path}/`));
  // A literal filename can match a directory on the opposite side. Exclude
  // descendants on single-file reads, except when the rename itself crosses that boundary.
  if (single && !nestedRename) {
    pathspec.push(...paths.map((path) => `:(exclude,literal)${path}/`));
  }
  return [
    ...(oldRef ? ['diff'] : ['show', '--format=']),
    '--patch',
    '--no-ext-diff',
    // A textconv cache writes a real notes ref pointing into the temporary object store.
    ...(options.section?.kind === 'combined' ? ['--no-textconv'] : []),
    '--find-renames',
    ...(nestedRename ? ['--diff-filter=RC'] : []),
    ...getWhitespaceDiffArgs(options),
    ...(oldRef ? [oldRef] : []),
    newRef,
    '--',
    ...pathspec,
  ];
};

/**
 * @param {string} repoRoot
 * @param {string} newRef
 * @param {string | undefined} oldRef
 * @param {Pick<StatusItem, 'oldPath' | 'path'>} item
 * @param {ComparisonOptions} options
 */
const readComparisonPatch = (repoRoot, newRef, oldRef, item, options) =>
  git(repoRoot, createComparisonPatchArgs(newRef, oldRef, [item], options), { env: options.env });

/**
 * @template T
 * @param {ReadonlyArray<T>} values
 * @param {number} size
 */
const chunk = (values, size) => {
  /** @type {Array<Array<T>>} */
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

/** @param {string} patch */
const splitCommitPatch = (patch) =>
  patch.split(/(?=^diff --git )/m).filter((part) => part.startsWith('diff --git '));

/**
 * @param {string} repoRoot
 * @param {string} newRef
 * @param {string | undefined} oldRef
 * @param {ReadonlyArray<Pick<StatusItem, 'oldPath' | 'path'>>} items
 * @param {ComparisonOptions} options
 */
const readComparisonPatches = async (repoRoot, newRef, oldRef, items, options) => {
  /** @type {Map<string, string>} */
  const patches = new Map();

  /** @param {typeof items} itemChunk @returns {Promise<void>} */
  const readChunk = async (itemChunk) => {
    const [command, ...args] = createComparisonPatchArgs(newRef, oldRef, itemChunk, options);
    let output;
    try {
      output = await git(repoRoot, [command, '--numstat', '-z', ...args], { env: options.env });
    } catch (error) {
      if (
        itemChunk.length < 2 ||
        /** @type {NodeJS.ErrnoException} */ (error).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      ) {
        throw error;
      }
      const middle = Math.ceil(itemChunk.length / 2);
      await readChunk(itemChunk.slice(0, middle));
      await readChunk(itemChunk.slice(middle));
      return;
    }
    if (!output) {
      return;
    }
    // Git emits numstat paths in patch order and omits whitespace-only changes from both.
    const separator = output.indexOf('\0\0');
    const paths = [...parseNumstat(output.slice(0, separator)).keys()];
    const patchChunks = splitCommitPatch(output.slice(separator + 2));
    if (paths.length === patchChunks.length) {
      for (const [index, path] of paths.entries()) {
        patches.set(path, patchChunks[index]);
      }
    } else {
      await Promise.all(
        itemChunk.map(async (item) => {
          patches.set(
            item.path,
            await readComparisonPatch(repoRoot, newRef, oldRef, item, options),
          );
        }),
      );
    }
  };

  for (const itemChunk of chunk(items, 200)) {
    await readChunk(itemChunk);
  }
  return patches;
};

/**
 * @param {string} ref Section identity. Combined sections use the merge base so edits to other files preserve their ids.
 * @param {ComparisonItem} item
 * @param {import('./common.cjs').FileContentResult} oldFile
 * @param {import('./common.cjs').FileContentResult} newFile
 * @param {string} patch
 * @param {DiffSection['kind']} [kind]
 */
const createComparisonFile = (ref, item, oldFile, newFile, patch, kind = 'commit') => {
  const summary = summarizeContent(oldFile, newFile);

  return {
    fingerprint: getFingerprint(
      `${ref}\n${item.status}\n${item.oldPath || ''}\n${summary.loadState || 'ready'}\n${
        summary.summary?.reason || ''
      }\n${summary.summary?.fingerprint || ''}\n${patch}\n${oldFile.file?.contents || ''}\n${
        newFile.file?.contents || ''
      }${kind === 'combined' ? `\n${oldFile.fingerprint || ''}\n${newFile.fingerprint || ''}` : ''}`,
    ),
    oldPath: item.oldPath,
    path: item.path,
    sections: [
      {
        binary: summary.binary || /Binary files .* differ/.test(patch),
        id: `${item.path}:${ref}`,
        kind,
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
 * @param {string} newRef
 * @param {ComparisonItem} item
 * @param {import('./common.cjs').FileContentResult} oldFile
 * @param {import('./common.cjs').FileContentResult} newFile
 * @param {string} patch
 * @param {ComparisonOptions} options
 */
const createComparisonFileWithOptions = (newRef, item, oldFile, newFile, patch, options) =>
  createComparisonFile(
    options.section?.ref ?? newRef,
    item,
    oldFile,
    newFile,
    patch,
    options.section?.kind,
  );

/**
 * @param {Map<string, ReturnType<typeof createEmptyFileContent> | import('./common.cjs').FileContentResult>} oldFiles
 * @param {string | undefined} oldRef
 * @param {Pick<StatusItem, 'oldPath' | 'path'>} item
 */
const getOldComparisonFile = (oldFiles, oldRef, item) =>
  oldRef
    ? oldFiles.get(item.oldPath || item.path) || createEmptyFileContent(item.oldPath || item.path)
    : createEmptyFileContent(item.oldPath || item.path);

/**
 * @param {string} repoRoot
 * @param {string} newRef
 * @param {string | undefined} oldRef
 * @param {ReadonlyArray<ComparisonItem>} status
 * @param {ComparisonOptions} options
 */
const readComparisonFiles = async (repoRoot, newRef, oldRef, status, options) => {
  const readOptions = {
    blobCacheKeys: options.blobCacheKeys,
    env: options.env,
    force: options.force,
  };
  const [oldFiles, newFiles] = await Promise.all([
    oldRef
      ? readGitFiles(
          repoRoot,
          oldRef,
          status.map((item) => item.oldPath || item.path),
          readOptions,
        )
      : Promise.resolve(new Map()),
    readGitFiles(
      repoRoot,
      newRef,
      status.map((item) => item.path),
      readOptions,
    ),
  ]);

  if (options.section?.kind === 'combined') {
    // Clean filters can store an image as a small text pointer. Classify these
    // using the checkout so the renderer can offer the actual image preview.
    for (const { path, status: fileStatus } of status) {
      if (!getImageMimeType(path)) continue;
      if (fileStatus === 'deleted') {
        // A deleted image has no checkout. Keep its text diff when its filter
        // cannot recover image bytes from the stored pointer.
        if (oldRef && options.env && oldFiles.get(path)?.file) {
          const bytes = await readFilteredImageBytes(repoRoot, `${oldRef}:${path}`, options.env);
          if (bytes) oldFiles.set(path, { binary: true, fingerprint: getFingerprint(bytes) });
        }
        continue;
      }
      const stored = newFiles.get(path);
      if (stored?.file) {
        const checkout = await readWorkingTreeFile(repoRoot, path, options);
        if (
          checkout.binary ||
          checkout.loadState === 'deferred' ||
          checkout.loadState === 'too-large'
        ) {
          newFiles.set(path, {
            ...checkout,
            fingerprint: checkout.fingerprint ?? stored.file.cacheKey,
          });
        }
      }
    }
  }
  return { newFiles, oldFiles };
};

/**
 * @param {{
 *   launchPath: string;
 *   newRef: string;
 *   oldRef?: string;
 *   options?: ComparisonOptions;
 *   repoRoot: string;
 *   source: ReviewSource;
 *   status: ReadonlyArray<ComparisonItem>;
 * }} input
 * @returns {Promise<RepositoryState>}
 */
const readComparisonState = async ({
  launchPath,
  newRef,
  oldRef,
  options = {},
  repoRoot,
  source,
  status,
}) => {
  const { oldFiles, newFiles } = await readComparisonFiles(
    repoRoot,
    newRef,
    oldRef,
    status,
    options,
  );
  const readyItems = status.filter((item) => {
    const oldFile = getOldComparisonFile(oldFiles, oldRef, item);
    const newFile = newFiles.get(item.path) || createEmptyFileContent(item.path);
    return summarizeContent(oldFile, newFile).loadState === 'ready';
  });
  const patches = await readComparisonPatches(repoRoot, newRef, oldRef, readyItems, options);
  /** @type {Array<ChangedFile>} */
  const files = status
    .map((item) =>
      createComparisonFileWithOptions(
        newRef,
        item,
        getOldComparisonFile(oldFiles, oldRef, item),
        newFiles.get(item.path) || createEmptyFileContent(item.path),
        patches.get(item.path) || '',
        options,
      ),
    )
    .sort(fileSort);

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source,
  };
};

/**
 * @param {string} repoRoot
 * @param {string} newRef
 * @param {string | undefined} oldRef
 * @param {ReadonlyArray<ComparisonItem>} status
 * @param {string} requestedPath
 * @param {string} sourceLabel
 * @param {ComparisonOptions} [options]
 */
const readComparisonSectionContent = async (
  repoRoot,
  newRef,
  oldRef,
  status,
  requestedPath,
  sourceLabel,
  options = {},
) => {
  const path = validateRepositoryPath(requestedPath);
  const item = status.find((candidate) => candidate.path === path);
  if (!item) {
    throw new Error(`File is not part of this ${sourceLabel}.`);
  }

  const { oldFiles, newFiles } = await readComparisonFiles(
    repoRoot,
    newRef,
    oldRef,
    [item],
    options,
  );
  const oldFile = getOldComparisonFile(oldFiles, oldRef, item);
  const newFile = newFiles.get(item.path) || createEmptyFileContent(item.path);
  const summary = summarizeContent(oldFile, newFile);
  const patch =
    summary.loadState === 'ready'
      ? await readComparisonPatch(repoRoot, newRef, oldRef, item, options)
      : '';

  return createComparisonFileWithOptions(newRef, item, oldFile, newFile, patch, options)
    .sections[0];
};

/**
 * @param {string} repoRoot
 * @param {string} newRef
 * @param {string | undefined} oldRef
 * @param {ReadonlyArray<ComparisonItem>} status
 * @param {string} requestedPath
 * @param {string} sourceLabel
 * @param {{env?: NodeJS.ProcessEnv; workingTree?: boolean}} [options]
 * @returns {Promise<DiffImageContentResult>}
 */
const readComparisonImageContent = async (
  repoRoot,
  newRef,
  oldRef,
  status,
  requestedPath,
  sourceLabel,
  options = {},
) => {
  try {
    const path = validateRepositoryPath(requestedPath);
    const item = status.find((candidate) => candidate.path === path);
    if (!item) {
      throw new Error(`File is not part of this ${sourceLabel}.`);
    }

    const readNewImage = async () => {
      if (item.status === 'deleted' || !getImageMimeType(item.path)) {
        return undefined;
      }
      if (options.workingTree) {
        const checkout = await readWorkingTreeImageFile(repoRoot, item.path);
        if (checkout) {
          return checkout;
        }
        // A sparse checkout can omit a file that still exists in the snapshot.
      }
      return readGitImageFile(repoRoot, newRef, item.path, options.env);
    };
    const oldPath = item.oldPath || item.path;
    const [oldImage, newImage] = await Promise.all([
      oldRef && item.status !== 'added' && getImageMimeType(oldPath)
        ? readGitImageFile(repoRoot, oldRef, oldPath, options.env)
        : undefined,
      readNewImage(),
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

module.exports = {
  readComparisonImageContent,
  readComparisonSectionContent,
  readComparisonState,
};
