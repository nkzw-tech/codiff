// @ts-check

const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { gitBufferWithInput } = require('./git-state/common.cjs');
const { isGeneratedWalkthroughPath } = require('../core/lib/narrative-walkthrough-diff.cjs');

const GENERATED_ATTRIBUTES = ['linguist-generated', 'gitlab-generated'];

/** @param {string} value */
const isGeneratedAttributeValue = (value) =>
  value !== 'unspecified' && value !== 'unset' && value !== 'false';

/** @param {import('../core/types.ts').ReviewSource} source */
const getGeneratedAttributeSource = (source) =>
  source.type === 'commit'
    ? source.ref
    : source.type === 'range'
      ? source.head
      : source.type === 'branch-diff'
        ? source.headRef
        : source.type === 'pull-request'
          ? source.headSha
          : undefined;

/** @param {Buffer} output */
const parseGeneratedAttributePaths = (output) => {
  const fields = output.toString('utf8').split('\0');
  const generatedPaths = new Set();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const path = fields[index];
    const value = fields[index + 2];
    if (path && isGeneratedAttributeValue(value)) {
      generatedPaths.add(path);
    }
  }
  return generatedPaths;
};

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} paths
 * @param {ReadonlyArray<string>} options
 * @param {NodeJS.ProcessEnv} [env]
 */
const checkGeneratedAttributePaths = async (repoRoot, paths, options, env) =>
  parseGeneratedAttributePaths(
    await gitBufferWithInput(
      repoRoot,
      ['check-attr', ...options, '-z', '--stdin', ...GENERATED_ATTRIBUTES],
      Buffer.from(`${paths.join('\0')}\0`),
      { env },
    ),
  );

/**
 * Git before 2.40 cannot use `git check-attr --source`. Populate a temporary,
 * isolated index from the reviewed tree and ask the older `--cached` mode to
 * resolve attributes from that index instead.
 *
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} paths
 * @param {string} source
 */
const readGeneratedAttributePathsFromTree = async (repoRoot, paths, source) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'codiff-generated-files-'));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(temporaryDirectory, 'index'),
  };

  try {
    await gitBufferWithInput(repoRoot, ['read-tree', source], Buffer.alloc(0), { env });
    return await checkGeneratedAttributePaths(repoRoot, paths, ['--cached'], env);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
};

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} paths
 * @param {string | undefined} source
 */
const readGeneratedAttributePaths = async (repoRoot, paths, source) => {
  if (paths.length === 0) {
    return new Set();
  }

  try {
    return await checkGeneratedAttributePaths(repoRoot, paths, source ? ['--source', source] : []);
  } catch {
    if (source) {
      try {
        // Git before 2.40 rejects `--source`; use its historical-tree fallback.
        return await readGeneratedAttributePathsFromTree(repoRoot, paths, source);
      } catch {
        // Ignore invalid or unavailable historical sources.
      }
    }
    return new Set();
  }
};

/** @param {import('../core/types.ts').RepositoryState} state */
const annotateGeneratedFiles = async (state) => {
  const generatedAttributePaths = await readGeneratedAttributePaths(
    state.root,
    state.files.map((file) => file.path),
    getGeneratedAttributeSource(state.source),
  );
  return {
    ...state,
    files: state.files.map((file) =>
      file.generated ||
      generatedAttributePaths.has(file.path) ||
      isGeneratedWalkthroughPath(file.path)
        ? { ...file, generated: true }
        : file,
    ),
  };
};

module.exports = {
  GENERATED_ATTRIBUTES,
  annotateGeneratedFiles,
  getGeneratedAttributeSource,
  isGeneratedAttributeValue,
  readGeneratedAttributePaths,
};
