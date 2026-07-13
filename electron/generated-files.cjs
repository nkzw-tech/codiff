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

/** @param {string} value */
const isNotGeneratedAttributeValue = (value) => value === 'unset' || value === 'false';

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
          : // `branch-working-tree` includes live uncommitted files, so the generated
            // attribute state must be computed live (like `working-tree`) rather than
            // pinned to a fixed ref.
            undefined;

/** @param {Buffer} output */
const parseGeneratedAttributeStates = (output) => {
  const fields = output.toString('utf8').split('\0');
  const generatedStates = new Map();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const path = fields[index];
    const value = fields[index + 2];
    if (path && isGeneratedAttributeValue(value)) {
      generatedStates.set(path, true);
    } else if (path && isNotGeneratedAttributeValue(value) && generatedStates.get(path) !== true) {
      generatedStates.set(path, false);
    }
  }
  return generatedStates;
};

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} paths
 * @param {ReadonlyArray<string>} options
 * @param {NodeJS.ProcessEnv} [env]
 */
const checkGeneratedAttributeStates = async (repoRoot, paths, options, env) =>
  parseGeneratedAttributeStates(
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
const readGeneratedAttributeStatesFromTree = async (repoRoot, paths, source) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'codiff-generated-files-'));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(temporaryDirectory, 'index'),
  };

  try {
    await gitBufferWithInput(repoRoot, ['read-tree', source], Buffer.alloc(0), { env });
    return await checkGeneratedAttributeStates(repoRoot, paths, ['--cached'], env);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
};

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} paths
 * @param {string | undefined} source
 */
const readGeneratedAttributeStates = async (repoRoot, paths, source) => {
  if (paths.length === 0) {
    return new Map();
  }

  try {
    return await checkGeneratedAttributeStates(repoRoot, paths, source ? ['--source', source] : []);
  } catch {
    if (source) {
      try {
        // Git before 2.40 rejects `--source`; use its historical-tree fallback.
        return await readGeneratedAttributeStatesFromTree(repoRoot, paths, source);
      } catch {
        // Ignore invalid or unavailable historical sources.
      }
    }
    return new Map();
  }
};

/**
 * @param {import('../core/types.ts').RepositoryState} state
 * @param {ReadonlyMap<string, boolean>} generatedAttributeStates
 */
const applyGeneratedAttributeStates = (state, generatedAttributeStates) => ({
  ...state,
  files: state.files.map((file) => {
    const attributeState = generatedAttributeStates.get(file.path);
    if (attributeState != null) {
      return file.generated === attributeState ? file : { ...file, generated: attributeState };
    }
    if (file.generated != null) {
      return file;
    }
    return isGeneratedWalkthroughPath(file.path) ? { ...file, generated: true } : file;
  }),
});

/** @param {import('../core/types.ts').RepositoryState} state */
const annotateGeneratedFiles = async (state) =>
  applyGeneratedAttributeStates(
    state,
    await readGeneratedAttributeStates(
      state.root,
      state.files.map((file) => file.path),
      getGeneratedAttributeSource(state.source),
    ),
  );

module.exports = {
  GENERATED_ATTRIBUTES,
  annotateGeneratedFiles,
  applyGeneratedAttributeStates,
  getGeneratedAttributeSource,
  isGeneratedAttributeValue,
  readGeneratedAttributeStates,
};
