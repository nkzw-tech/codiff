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
 * @param {import('../core/types.ts').Revision} revision
 */
const readRevisionGeneratedAttributeStates = async (repoRoot, paths, revision) => {
  if (paths.length === 0) {
    return new Map();
  }

  const kind = revision.kind || 'commit';
  const source = kind === 'commit' && 'sha' in revision ? revision.sha : undefined;
  const options = kind === 'index' ? ['--cached'] : source ? ['--source', source] : [];
  try {
    return await checkGeneratedAttributeStates(repoRoot, paths, options);
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

/**
 * @param {import('../core/types.ts').RepositoryState} state
 * @param {import('../core/types.ts').Revision} revision
 */
const annotateGeneratedFiles = async (state, revision) =>
  applyGeneratedAttributeStates(
    state,
    await readRevisionGeneratedAttributeStates(
      state.root,
      state.files.map((file) => file.path),
      revision,
    ),
  );

module.exports = {
  annotateGeneratedFiles,
  applyGeneratedAttributeStates,
  readRevisionGeneratedAttributeStates,
};
