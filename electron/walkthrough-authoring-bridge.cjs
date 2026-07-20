// @ts-check

const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

/** @type {Promise<typeof import('../core/dist/walkthrough-authoring.mjs')> | null} */
let modulePromise = null;
/** @type {Promise<typeof import('../core/dist/index.mjs')> | null} */
let coreModulePromise = null;

const loadAuthoring = () => {
  if (!modulePromise) {
    const modulePath = join(__dirname, '../core/dist/walkthrough-authoring.mjs');
    modulePromise = import(pathToFileURL(modulePath).href);
  }
  return modulePromise;
};

const loadCore = () => {
  if (!coreModulePromise) {
    const modulePath = join(__dirname, '../core/dist/index.mjs');
    coreModulePromise = import(pathToFileURL(modulePath).href);
  }
  return coreModulePromise;
};

/** @param {unknown} value Strictly validate one cached or imported persisted document. */
const parsePersistedWalkthrough = async (value) => {
  const core = await loadCore();
  const document = /** @type {any} */ (value);
  return document?.version === 5
    ? core.parseWalkthroughArtifactV5(document)
    : core.parseNarrativeWalkthroughV4(document);
};

/**
 * @param {unknown} value
 * @param {import('../core/types.ts').RepositoryState} state
 * @param {{
 *   agent: import('../core/types.ts').NarrativeWalkthrough['agent'];
 *   customInstructions?: string;
 *   generatedAt: string;
 *   model: string;
 * }} generation
 * @param {ReadonlyMap<string, string>} [hunkIdByAlias]
 */
const normalizeNarrativeWalkthrough = async (value, state, generation, hunkIdByAlias) => {
  const authoring = await loadAuthoring();
  let draft = value;
  if (hunkIdByAlias && hunkIdByAlias.size > 0 && value && typeof value === 'object') {
    const rewriteIds = (ids) =>
      Array.isArray(ids)
        ? ids.map((id) => (typeof id === 'string' ? (hunkIdByAlias.get(id) ?? id) : id))
        : ids;
    const input = /** @type {any} */ (value);
    draft = {
      ...input,
      chapters: Array.isArray(input.chapters)
        ? input.chapters.map((chapter) => ({
            ...chapter,
            stops: Array.isArray(chapter?.stops)
              ? chapter.stops.map((stop) => ({
                  ...stop,
                  hunkIds: rewriteIds(stop?.hunkIds),
                  notes: Array.isArray(stop?.notes)
                    ? stop.notes.map((note) => ({
                        ...note,
                        hunkId:
                          typeof note?.hunkId === 'string'
                            ? (hunkIdByAlias.get(note.hunkId) ?? note.hunkId)
                            : note?.hunkId,
                      }))
                    : stop?.notes,
                }))
              : chapter?.stops,
          }))
        : input.chapters,
      support: Array.isArray(input.support)
        ? input.support.map((item) => ({
            ...item,
            hunkIds: rewriteIds(item?.hunkIds),
          }))
        : input.support,
    };
  }
  const profile = authoring.createWalkthroughGenerationProfile({
    agent: generation.agent,
    modelCandidates: [generation.model],
    settings: { scope: 'complete-diff' },
  });
  return authoring.authorWalkthroughArtifactV5({
    generationMetadata: {
      agent: generation.agent,
      generatedAt: generation.generatedAt,
      model: generation.model,
      profile,
    },
    generationRequest: authoring.createWalkthroughGenerationRequest(
      { relation: 'single-diff', structure: 'single-diff' },
      generation.customInstructions,
    ),
    response: draft,
    state,
  });
};

/**
 * @param {import('../core/types.ts').RepositoryState} state
 * @param {{customInstructions?: string}} [options]
 */
const buildWalkthroughPrompt = async (state, options) => {
  const authoring = await loadAuthoring();
  const capturedContext = authoring.captureWalkthroughContext(state);
  const generationRequest = authoring.createWalkthroughGenerationRequest(
    { relation: 'single-diff', structure: 'single-diff' },
    options?.customInstructions,
  );
  return authoring.buildWalkthroughPrompt(capturedContext, generationRequest);
};

/**
 * @param {import('../core/types.ts').RepositoryState} state
 * @param {{customInstructions?: string}} [options]
 */
const buildWalkthroughPromptInput = async (state, options) => {
  const authoring = await loadAuthoring();
  const capturedContext = authoring.captureWalkthroughContext(state);
  const generationRequest = authoring.createWalkthroughGenerationRequest(
    { relation: 'single-diff', structure: 'single-diff' },
    options?.customInstructions,
  );
  return authoring.buildWalkthroughPromptInput(capturedContext, generationRequest);
};

module.exports = {
  buildWalkthroughPrompt,
  buildWalkthroughPromptInput,
  loadAuthoring,
  normalizeNarrativeWalkthrough,
  parsePersistedWalkthrough,
};
