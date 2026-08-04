// @ts-check

// Narrative walkthrough generation and normalization trust boundary.

const { createHash } = require('node:crypto');
const {
  cleanText,
  normalizeEnum,
  oneLine,
  parseJSONMessage,
  truncate,
} = require('./agent-shared.cjs');
const {
  AGENTS,
  narrativeWalkthroughResponseSchema,
  narrativeWalkthroughSchema,
} = require('./narrative-walkthrough-schema.cjs');
const { getSectionWalkthroughHunks } = require('../core/lib/narrative-walkthrough-diff.cjs');
const {
  buildWalkthroughPrompt: buildSharedWalkthroughPrompt,
  loadAuthoring,
  normalizeNarrativeWalkthrough: normalizeSharedWalkthrough,
} = require('./walkthrough-authoring-bridge.cjs');

/**
 * @typedef {import('../core/types.ts').NarrativeWalkthroughResult} NarrativeWalkthroughResult
 * @typedef {import('../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../core/types.ts').WalkthroughContext} WalkthroughContext
 * @typedef {import('./agent.cjs').Agent} Agent
 * @typedef {import('./agent.cjs').AgentOptions} AgentOptions
 */

const MAX_PROSE_CHARS = 4_000;
const BASE_WALKTHROUGH_TIMEOUT_MS = 90_000;
const MAX_WALKTHROUGH_TIMEOUT_MS = 300_000;
const INCLUDED_WALKTHROUGH_FILES = 8;
const INCLUDED_WALKTHROUGH_HUNKS = 12;
const TIMEOUT_MS_PER_EXTRA_FILE = 1_000;
const TIMEOUT_MS_PER_EXTRA_HUNK = 2_000;
const LARGE_WALKTHROUGH_HUNK_THRESHOLD = 100;
const WALKTHROUGH_CACHE_KEY_VERSION = 1;
const NARRATIVE_WALKTHROUGH_AUTHORING_VERSION = 'narrative-v4';

/** @param {unknown} value @param {string} [fallback] */
const cleanRich = (value, fallback = '') => {
  const text = typeof value === 'string' ? value : fallback;
  const trimmed = text.trim();
  if (trimmed.length <= MAX_PROSE_CHARS) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_PROSE_CHARS)}…`;
};

/** @param {string} line */
const isCommitTitleLine = (line) => {
  const title = line.trim();
  return title.length > 0 && title.length <= 72 && !/[.!?]$/.test(title);
};

/** @param {string} body @param {string} title */
const stripLeadingCommitTitle = (body, title) => {
  if (!body || !title) {
    return body;
  }
  const lines = body.split(/\r?\n/);
  const titleIndex = lines.findIndex((line) => line.trim());
  if (titleIndex === -1 || lines[titleIndex].trim() !== title.trim()) {
    return body;
  }
  let nextIndex = titleIndex + 1;
  while (nextIndex < lines.length && !lines[nextIndex].trim()) {
    nextIndex += 1;
  }
  return [...lines.slice(0, titleIndex), ...lines.slice(nextIndex)].join('\n').trim();
};

/** @param {unknown} value */
const normalizeGeneratedAt = (value) => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return '';
};

/** @param {any} input */
const isLegacyV3Walkthrough = (input) =>
  input?.version === 3 ||
  (Array.isArray(input?.chapters) &&
    input.chapters.some((chapter) =>
      (chapter?.stops || []).some((stop) => Array.isArray(stop?.anchors)),
    )) ||
  (Array.isArray(input?.support) && input.support.some((item) => Array.isArray(item?.files)));

const normalizeNarrativeWalkthrough = async (
  input,
  files,
  facts = {},
  hunkIdByAlias = new Map(),
) => {
  if (!input || typeof input !== 'object') {
    throw new Error('Narrative walkthrough is not an object.');
  }
  if (isLegacyV3Walkthrough(input)) {
    throw new Error(
      'Narrative walkthrough uses the legacy v3 anchors[] schema. Regenerate it with the v4 hunkIds[] schema for this diff.',
    );
  }

  const state = {
    branch: typeof facts.branch === 'string' || facts.branch === null ? facts.branch : null,
    files,
    generatedAt:
      typeof facts.generatedAt === 'number'
        ? facts.generatedAt
        : typeof facts.generatedAt === 'string'
          ? Date.parse(facts.generatedAt) || Date.now()
          : Date.now(),
    launchPath: typeof facts.root === 'string' ? facts.root : '',
    root: typeof facts.root === 'string' ? facts.root : '',
    source:
      facts.source && typeof facts.source === 'object' ? facts.source : { type: 'working-tree' },
  };
  const agent = normalizeEnum(facts.agent, AGENTS, 'codex');
  const generatedAt = normalizeGeneratedAt(facts.generatedAt) || new Date().toISOString();
  const walkthrough = await normalizeSharedWalkthrough(
    input,
    state,
    {
      agent,
      customInstructions:
        typeof facts.customInstructions === 'string' ? facts.customInstructions : undefined,
      generatedAt,
      model: cleanText(facts.model, 'unknown'),
    },
    hunkIdByAlias,
  );
  const content = walkthrough.narrative.content;
  if (facts.context && typeof facts.context === 'object' && !content.context) {
    content.context = facts.context;
  }

  // A commit composer only makes sense for a live staging set — never a past
  // commit, branch, or pull request. For working trees, always expose the
  // composer even when the agent did not draft a message, so the reviewer can
  // complete the whole workflow in Codiff.
  if (state.source.type === 'working-tree') {
    const inputCommit = input.commit && typeof input.commit === 'object' ? input.commit : {};
    const rawBody = cleanRich(inputCommit.body);
    let title = cleanText(inputCommit.title);
    if (!title && rawBody) {
      const firstLine = rawBody
        .split(/\r?\n/)
        .find((line) => line.trim())
        ?.trim();
      if (firstLine && isCommitTitleLine(firstLine)) {
        title = firstLine;
      }
    }
    /** @type {Record<string, unknown>} */
    const commit = {};
    if (title) commit.title = title;
    const body = stripLeadingCommitTitle(rawBody, title);
    if (body) commit.body = body;
    content.commit = commit;
  } else {
    delete content.commit;
  }

  return walkthrough;
};

const buildWalkthroughContextInput = (context, agentLabel) =>
  context
    ? `${agentLabel} conversation context:
${JSON.stringify(context, null, 2)}

Use this context as orientation for reviewer intent, implementation rationale, validation, and known risks.
Treat the repository change digest as the source of truth for what changed.
If the context and digest conflict, trust the digest.
`
    : '';

/**
 * Summarize the walkthrough being replaced without carrying stale hunk ids or
 * anchors into the next request.
 * @param {unknown} previousWalkthrough
 */
const buildPreviousWalkthroughInput = (previousWalkthrough) => {
  if (!previousWalkthrough || typeof previousWalkthrough !== 'object') {
    return '';
  }

  const persisted = /** @type {any} */ (previousWalkthrough);
  const walkthrough = persisted.version === 5 ? persisted.narrative?.content : persisted;
  if (!walkthrough || typeof walkthrough !== 'object') {
    return '';
  }
  const chapters = (Array.isArray(walkthrough.chapters) ? walkthrough.chapters : [])
    .map((chapter) => ({
      blurb: oneLine(chapter?.blurb),
      stops: (Array.isArray(chapter?.stops) ? chapter.stops : []).map((stop) => ({
        prose: truncate(cleanText(stop?.prose), MAX_PROSE_CHARS),
        title: oneLine(stop?.title),
      })),
      title: oneLine(chapter?.title),
    }))
    .filter((chapter) => chapter.title || chapter.stops.length > 0);
  if (chapters.length === 0) {
    return '';
  }

  const commit =
    walkthrough.commit && typeof walkthrough.commit === 'object'
      ? {
          body: truncate(cleanText(walkthrough.commit.body), MAX_PROSE_CHARS),
          title: oneLine(walkthrough.commit.title),
        }
      : undefined;
  const summary = {
    chapters,
    ...(commit?.body || commit?.title ? { commit } : {}),
    focus: oneLine(walkthrough.focus),
    title: oneLine(walkthrough.title),
  };

  return `Previous walkthrough to update:
${JSON.stringify(summary)}

Re-author it for the current digest. Keep stops that are still accurate, revise changed explanations, add new review ideas, and remove ideas whose code is gone. Re-anchor every stop to the current digest's hunk aliases; never reuse ids or anchors from the previous walkthrough. Return the complete updated walkthrough.
`;
};

/** @param {RepositoryState} state */
const getWalkthroughSize = (state) => ({
  fileCount: state.files.length,
  hunkCount: state.files.reduce(
    (total, file) =>
      total +
      (file.sections || []).reduce(
        (sectionTotal, section) => sectionTotal + getSectionWalkthroughHunks(file, section).length,
        0,
      ),
    0,
  ),
});

/**
 * Use the compatibility model for large default-Codex walkthroughs. Explicit
 * model selections and non-Codex backends keep their configured model.
 *
 * @param {RepositoryState} state
 * @param {Agent} agent
 * @param {unknown} model
 */
const resolveNarrativeWalkthroughModel = (state, agent, model) => {
  const normalizedModel = agent.normalizeModel(model);
  return agent.id === 'codex' &&
    normalizedModel === agent.defaultModel &&
    getWalkthroughSize(state).hunkCount >= LARGE_WALKTHROUGH_HUNK_THRESHOLD
    ? agent.fallbackModel
    : normalizedModel;
};

/**
 * Small walkthroughs retain the normal agent timeout. Larger digests get more
 * time for hunk classification and structured output, capped at five minutes.
 *
 * @param {RepositoryState} state
 * @param {number} [minimumMs]
 */
const getNarrativeWalkthroughTimeoutMs = (state, minimumMs = BASE_WALKTHROUGH_TIMEOUT_MS) => {
  const { fileCount, hunkCount } = getWalkthroughSize(state);
  const estimatedMs =
    BASE_WALKTHROUGH_TIMEOUT_MS +
    Math.max(0, fileCount - INCLUDED_WALKTHROUGH_FILES) * TIMEOUT_MS_PER_EXTRA_FILE +
    Math.max(0, hunkCount - INCLUDED_WALKTHROUGH_HUNKS) * TIMEOUT_MS_PER_EXTRA_HUNK;

  return Math.min(MAX_WALKTHROUGH_TIMEOUT_MS, Math.max(minimumMs, estimatedMs));
};

const buildNarrativeWalkthroughRequest = async (
  state,
  context,
  agentLabel = 'Codex',
  customPrompt,
  previousWalkthrough,
) => {
  const authoring = await loadAuthoring();
  const hunkIndex = authoring.indexWalkthroughHunks(state.files);
  const sharedPrompt = await buildSharedWalkthroughPrompt(state, {
    customInstructions: typeof customPrompt === 'string' ? customPrompt : undefined,
  });
  return {
    hunkIdByAlias: hunkIndex.hunkIdByAlias,
    prompt: `${sharedPrompt}

${buildWalkthroughContextInput(context, agentLabel)}${buildPreviousWalkthroughInput(previousWalkthrough)}`,
  };
};

const buildNarrativeWalkthroughPrompt = async (
  state,
  context,
  agentLabel = 'Codex',
  customPrompt,
  previousWalkthrough,
) =>
  (
    await buildNarrativeWalkthroughRequest(
      state,
      context,
      agentLabel,
      customPrompt,
      previousWalkthrough,
    )
  ).prompt;

const createNarrativeWalkthroughGenerationRequest = async (
  state,
  agent,
  context,
  customPrompt,
  previousWalkthrough,
) => {
  const { fileCount, hunkCount } = getWalkthroughSize(state);
  const request = await buildNarrativeWalkthroughRequest(
    state,
    context,
    agent.label,
    customPrompt,
    previousWalkthrough,
  );
  const timeoutMs = getNarrativeWalkthroughTimeoutMs(state, agent.defaultTimeoutMs);
  return {
    ...request,
    outputName: 'walkthrough.json',
    schema: narrativeWalkthroughResponseSchema,
    timeoutMessage: `${agent.label} walkthrough timed out after ${Math.ceil(timeoutMs / 1_000)} seconds while processing ${fileCount} files and ${hunkCount} reviewable hunks.`,
    timeoutMs,
  };
};

/**
 * Cache identity for the exact model input. The previous walkthrough is
 * intentionally excluded: forced regeneration replaces the cached result for
 * the current diff rather than creating a second cache lineage.
 *
 * @param {RepositoryState} state
 * @param {Agent} agent
 * @param {unknown} model
 * @param {WalkthroughContext | null | undefined} context
 * @param {unknown} customPrompt
 */
const getNarrativeWalkthroughCacheKey = async (state, agent, model, context, customPrompt) => {
  const prompt = await buildNarrativeWalkthroughPrompt(state, context, agent.label, customPrompt);
  return createHash('sha256')
    .update(
      JSON.stringify({
        agent: agent.id,
        diff: state.files.map((file) => ({
          fingerprint: file.fingerprint,
          oldPath: file.oldPath,
          path: file.path,
          status: file.status,
          sections: file.sections.map((section) => ({
            hunkIds: getSectionWalkthroughHunks(file, section).map((hunk) => hunk.id),
            id: section.id,
            kind: section.kind,
          })),
        })),
        model: agent.normalizeModel(model),
        prompt,
        responseSchema: narrativeWalkthroughResponseSchema,
        version: WALKTHROUGH_CACHE_KEY_VERSION,
      }),
    )
    .digest('hex');
};

const readNarrativeWalkthrough = async (
  state,
  agent,
  agentOptions,
  context,
  customPrompt,
  previousWalkthrough,
) => {
  try {
    const normalizeGeneratedModel = (model) =>
      typeof agent.normalizeModel === 'function'
        ? agent.normalizeModel(model)
        : String(model || agent.defaultModel || 'default');
    let generatedModel = normalizeGeneratedModel(agentOptions?.model);
    const onModelFallback = agentOptions?.onModelFallback;
    const request = await createNarrativeWalkthroughGenerationRequest(
      state,
      agent,
      context,
      customPrompt,
      previousWalkthrough,
    );
    agentOptions?.onProgress?.('agent-generation');
    const response = await agent.run(
      state.root,
      request.prompt,
      request.schema,
      request.outputName,
      request.timeoutMessage,
      {
        ...agentOptions,
        onModelFallback: async (fallbackModel, originalModel) => {
          generatedModel = normalizeGeneratedModel(fallbackModel);
          await onModelFallback?.(fallbackModel, originalModel);
        },
        timeoutMs: request.timeoutMs,
      },
    );
    agentOptions?.onProgress?.('response-received');
    const parsed = parseJSONMessage(response);
    const walkthrough = await normalizeNarrativeWalkthrough(
      parsed,
      state.files,
      {
        agent: agent.id,
        branch: state.branch,
        customInstructions: typeof customPrompt === 'string' ? customPrompt : undefined,
        generatedAt: state.generatedAt,
        model: generatedModel,
        root: state.root,
        source: state.source,
      },
      request.hunkIdByAlias,
    );
    if (context && !walkthrough.narrative.content.context) {
      walkthrough.narrative.content.context = context;
    }

    return {
      status: 'ready',
      walkthrough,
    };
  } catch (error) {
    if (agent.isNotFoundError(error)) {
      return {
        code: agent.notFoundCode,
        reason: error instanceof Error ? error.message : String(error),
        status: 'unavailable',
      };
    }

    return {
      reason: error instanceof Error ? error.message : String(error),
      status: 'unavailable',
    };
  }
};

module.exports = {
  NARRATIVE_WALKTHROUGH_AUTHORING_VERSION,
  buildNarrativeWalkthroughPrompt,
  createNarrativeWalkthroughGenerationRequest,
  getNarrativeWalkthroughCacheKey,
  narrativeWalkthroughSchema,
  narrativeWalkthroughResponseSchema,
  normalizeNarrativeWalkthrough,
  readNarrativeWalkthrough,
  resolveNarrativeWalkthroughModel,
};
