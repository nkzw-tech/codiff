// @ts-check

/** @param {unknown} response */
const parseStructuredModelResponse = (response) => {
  if (response && typeof response === 'object') {
    return response;
  }
  const text = typeof response === 'string' ? response : String(response ?? '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] || text).trim();
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/** @param {AbortSignal | undefined} signal @param {() => Promise<string>} run */
const runWithCancellation = async (signal, run) => {
  if (!signal) {
    return run();
  }
  signal.throwIfAborted();
  /** @type {((reason?: unknown) => void) | null} */
  let rejectCancellation = null;
  const cancelled = new Promise((_, reject) => {
    rejectCancellation = reject;
  });
  const onAbort = () => rejectCancellation?.(signal.reason ?? new Error('Generation cancelled.'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([run(), cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};

/**
 * Invoke one configured model profile while recording the actual fallback that
 * produced the accepted response. The caller owns schema-specific parsing.
 *
 * @param {{
 *   agent: ReturnType<typeof import('./agent.cjs').getAgent>,
 *   agentOptions?: Parameters<ReturnType<typeof import('./agent.cjs').getAgent>['run']>[5],
 *   generatedAt?: () => string,
 *   outputName?: string,
 *   profile: import('../core/types.ts').GenerationProfile,
 *   prompt: string,
 *   repoRoot: string,
 *   schema: unknown,
 *   signal?: AbortSignal,
 *   timeoutMessage?: string,
 *   timeoutMs?: number,
 * }} input
 */
const invokeWalkthroughModel = async (input) => {
  if (input.profile.agent !== input.agent.id) {
    throw new Error('The generation profile does not match the selected agent.');
  }
  const candidates = [
    ...new Set(input.profile.modelCandidates.map((model) => input.agent.normalizeModel(model))),
  ];
  if (candidates.length === 0) {
    throw new Error('A generation profile requires at least one model candidate.');
  }
  let generatedModel = candidates[0];
  const onModelFallback = input.agentOptions?.onModelFallback;
  const response = await runWithCancellation(input.signal, () =>
    input.agent.run(
      input.repoRoot,
      input.prompt,
      input.schema,
      input.outputName,
      input.timeoutMessage,
      {
        ...input.agentOptions,
        fallbackModel: candidates.at(-1),
        model: candidates[0],
        onModelFallback: async (fallbackModel, originalModel) => {
          input.signal?.throwIfAborted();
          generatedModel = input.agent.normalizeModel(fallbackModel);
          await onModelFallback?.(fallbackModel, originalModel);
        },
        signal: input.signal,
        timeoutMs: input.timeoutMs ?? input.agent.defaultTimeoutMs,
      },
    ),
  );
  input.signal?.throwIfAborted();
  return {
    generationMetadata: {
      agent: input.agent.id,
      generatedAt: input.generatedAt?.() ?? new Date().toISOString(),
      model: generatedModel,
      profile: input.profile,
    },
    response,
  };
};

module.exports = { invokeWalkthroughModel, parseStructuredModelResponse };
