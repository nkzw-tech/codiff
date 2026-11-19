// @ts-check

const {
  fileSort,
  getFingerprint,
  getWhitespaceDiffArgs,
  git,
  readGitImageFile,
  summarizeContent,
  validateRepositoryPath,
} = require('./common.cjs');
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
 *   literalPaths?: boolean;
 *   section?: {kind: DiffSection['kind']; ref: string};
 *   showWhitespace?: boolean;
 * }} ComparisonOptions
 */

/**
 * @param {ReadonlyArray<Pick<StatusItem, 'oldPath' | 'path'>>} items
 * @param {ComparisonOptions} options
 */
const getPathspec = (items, options) => {
  const paths = [
    ...new Set(items.flatMap((item) => (item.oldPath ? [item.oldPath, item.path] : [item.path]))),
  ];
  return options.literalPaths ? paths.map((path) => `:(literal)${path}`) : paths;
};

/**
 * @param {string} newRef
 * @param {string | undefined} oldRef
 * @param {ReadonlyArray<Pick<StatusItem, 'oldPath' | 'path'>>} items
 * @param {ComparisonOptions} options
 */
const createComparisonPatchArgs = (newRef, oldRef, items, options) => [
  ...(oldRef ? ['diff'] : ['show', '--format=']),
  '--patch',
  '--no-ext-diff',
  // A textconv cache writes a real notes ref pointing into the temporary object store.
  ...(options.section?.kind === 'combined' ? ['--no-textconv'] : []),
  '--find-renames',
  ...getWhitespaceDiffArgs(options),
  ...(oldRef ? [oldRef] : []),
  newRef,
  '--',
  ...getPathspec(items, options),
];

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
  patch
    .split(/(?=^diff --git )/m)
    .map((part) => part.trimEnd())
    .filter((part) => part.startsWith('diff --git '))
    .map((part) => `${part}\n`);

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

  for (const itemChunk of chunk(items, 200)) {
    if (itemChunk.length === 0) {
      continue;
    }

    const patch = await git(
      repoRoot,
      createComparisonPatchArgs(newRef, oldRef, itemChunk, options),
      { env: options.env },
    );
    const patchChunks = splitCommitPatch(patch);

    if (patchChunks.length === itemChunk.length) {
      for (let index = 0; index < itemChunk.length; index += 1) {
        patches.set(itemChunk[index].path, patchChunks[index]);
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
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<DiffImageContentResult>}
 */
const readComparisonImageContent = async (
  repoRoot,
  newRef,
  oldRef,
  status,
  requestedPath,
  sourceLabel,
  env,
) => {
  try {
    const path = validateRepositoryPath(requestedPath);
    const item = status.find((candidate) => candidate.path === path);
    if (!item) {
      throw new Error(`File is not part of this ${sourceLabel}.`);
    }

    const [oldImage, newImage] = await Promise.all([
      oldRef ? readGitImageFile(repoRoot, oldRef, item.oldPath || item.path, env) : undefined,
      readGitImageFile(repoRoot, newRef, item.path, env),
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
