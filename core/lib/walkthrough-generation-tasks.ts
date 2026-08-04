import type {
  GenerationMetadata,
  GenerationProfile,
  WalkthroughGenerationProgress,
  WalkthroughGenerationUnitProgress,
} from '../types.ts';

export const walkthroughGenerationConcurrency = 3;

export type WalkthroughGenerationTask<Identity, SemanticInput, Output> = {
  id: string;
  identity: Identity;
  label: string;
  profile: GenerationProfile;
  run: (input: {
    profile: GenerationProfile;
    semanticInput: SemanticInput;
    signal: AbortSignal;
  }) => Promise<{ generationMetadata: GenerationMetadata; output: Output }>;
  semanticInput: SemanticInput;
};

export type ReusableWalkthroughGenerationComponent<Identity, SemanticInput, Output> = {
  generationMetadata: GenerationMetadata;
  identity: Identity;
  output: Output;
  profile: GenerationProfile;
  semanticInput: SemanticInput;
};

export type WalkthroughGenerationFailure<Identity> = {
  error: string;
  identity: Identity;
  label: string;
};

export type RunWalkthroughGenerationTasksInput<Identity, SemanticInput, Output> = {
  concurrency?: number;
  onProgress?: (progress: WalkthroughGenerationProgress) => void;
  reusableComponents?: ReadonlyArray<
    ReusableWalkthroughGenerationComponent<Identity, SemanticInput, Output>
  >;
  signal?: AbortSignal;
  tasks: ReadonlyArray<WalkthroughGenerationTask<Identity, SemanticInput, Output>>;
};

export type RunWalkthroughGenerationTasksResult<Identity, SemanticInput, Output> =
  | {
      components: ReadonlyArray<
        ReusableWalkthroughGenerationComponent<Identity, SemanticInput, Output>
      >;
      status: 'ready';
    }
  | {
      components: ReadonlyArray<
        ReusableWalkthroughGenerationComponent<Identity, SemanticInput, Output>
      >;
      failures: ReadonlyArray<WalkthroughGenerationFailure<Identity>>;
      reason: string;
      status: 'failed';
    }
  | {
      components: ReadonlyArray<
        ReusableWalkthroughGenerationComponent<Identity, SemanticInput, Output>
      >;
      reason: string;
      status: 'cancelled';
    };

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
};

const inputsEqual = (first: unknown, second: unknown) =>
  JSON.stringify(stableValue(first)) === JSON.stringify(stableValue(second));

const failureReason = (error: unknown) => (error instanceof Error ? error.message : String(error));

const cancellationReason = (signal: AbortSignal) =>
  signal.reason instanceof Error
    ? signal.reason.message
    : typeof signal.reason === 'string' && signal.reason
      ? signal.reason
      : 'Walkthrough generation was cancelled.';

const runWithCancellation = async <Value>(
  signal: AbortSignal,
  run: () => Promise<Value>,
): Promise<Value> => {
  signal.throwIfAborted();
  let rejectCancellation: ((reason: unknown) => void) | null = null;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const onAbort = () =>
    rejectCancellation?.(signal.reason ?? new Error(cancellationReason(signal)));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([run(), cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};

const validateGenerationMetadata = (metadata: GenerationMetadata, profile: GenerationProfile) => {
  if (!inputsEqual(metadata.profile, profile)) {
    throw new Error('Successful generation metadata does not match the requested profile.');
  }
  if (metadata.agent !== profile.agent) {
    throw new Error('The successful agent does not match the requested profile.');
  }
  if (!profile.modelCandidates.includes(metadata.model)) {
    throw new Error('The successful model is not in the requested fallback chain.');
  }
};

const findReusable = <Identity, SemanticInput, Output>(
  reusable: ReadonlyArray<ReusableWalkthroughGenerationComponent<Identity, SemanticInput, Output>>,
  task: WalkthroughGenerationTask<Identity, SemanticInput, Output>,
) =>
  reusable.find((component) => {
    if (
      !inputsEqual(component.identity, task.identity) ||
      !inputsEqual(component.semanticInput, task.semanticInput) ||
      !inputsEqual(component.profile, task.profile)
    ) {
      return false;
    }
    try {
      validateGenerationMetadata(component.generationMetadata, task.profile);
      return true;
    } catch {
      return false;
    }
  });

/**
 * Run format-neutral model tasks with bounded concurrency. Successful
 * components remain reusable after another task fails, so a retry invokes only
 * the failed or invalidated tasks. Cancellation prevents queued work from
 * starting and suppresses a ready result.
 */
export async function runWalkthroughGenerationTasks<Identity, SemanticInput, Output>(
  input: RunWalkthroughGenerationTasksInput<Identity, SemanticInput, Output>,
): Promise<RunWalkthroughGenerationTasksResult<Identity, SemanticInput, Output>> {
  const signal = input.signal ?? new AbortController().signal;
  const reusableComponents = input.reusableComponents ?? [];
  const progressUnits: Array<WalkthroughGenerationUnitProgress> = input.tasks.map((task) => ({
    id: task.id,
    label: task.label,
    status: 'pending',
  }));
  const outcomes: Array<
    | ReusableWalkthroughGenerationComponent<Identity, SemanticInput, Output>
    | WalkthroughGenerationFailure<Identity>
    | undefined
  > = new Array(input.tasks.length);
  const emitProgress = (phase: WalkthroughGenerationProgress['phase'], summary: string) =>
    input.onProgress?.({
      completed: progressUnits.filter((unit) => unit.status === 'ready').length,
      phase,
      summary,
      total: progressUnits.length,
      units: progressUnits.map((unit) => ({ ...unit })),
    });

  emitProgress('preparing', `Preparing ${input.tasks.length} walkthrough generation tasks.`);
  const pending: Array<number> = [];
  input.tasks.forEach((task, index) => {
    const reused = findReusable(reusableComponents, task);
    if (!reused) {
      pending.push(index);
      return;
    }
    outcomes[index] = reused;
    progressUnits[index] = { ...progressUnits[index]!, status: 'ready' };
  });

  let nextPending = 0;
  let cancelled = signal.aborted;
  const worker = async () => {
    while (nextPending < pending.length && !signal.aborted) {
      const index = pending[nextPending]!;
      nextPending += 1;
      const task = input.tasks[index]!;
      progressUnits[index] = { ...progressUnits[index]!, status: 'generating' };
      emitProgress(
        input.tasks.length === 1 ? 'generating' : 'generating-units',
        `Generating ${task.label}.`,
      );
      try {
        const result = await runWithCancellation(signal, () =>
          task.run({ profile: task.profile, semanticInput: task.semanticInput, signal }),
        );
        validateGenerationMetadata(result.generationMetadata, task.profile);
        const component = {
          generationMetadata: result.generationMetadata,
          identity: task.identity,
          output: result.output,
          profile: task.profile,
          semanticInput: task.semanticInput,
        } satisfies ReusableWalkthroughGenerationComponent<Identity, SemanticInput, Output>;
        outcomes[index] = component;
        progressUnits[index] = { ...progressUnits[index]!, status: 'ready' };
        emitProgress(
          input.tasks.length === 1 ? 'generating' : 'generating-units',
          `Completed ${task.label}.`,
        );
      } catch (error: unknown) {
        if (signal.aborted) {
          cancelled = true;
          progressUnits[index] = {
            ...progressUnits[index]!,
            detail: cancellationReason(signal),
            status: 'failed',
          };
          break;
        }
        const failure = { error: failureReason(error), identity: task.identity, label: task.label };
        outcomes[index] = failure;
        progressUnits[index] = {
          ...progressUnits[index]!,
          detail: failure.error,
          status: 'failed',
        };
        emitProgress(
          input.tasks.length === 1 ? 'generating' : 'generating-units',
          `Failed ${task.label}.`,
        );
      }
    }
  };
  const concurrency = Math.max(
    1,
    Math.min(Math.floor(input.concurrency ?? walkthroughGenerationConcurrency), pending.length),
  );
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const completedComponents = outcomes.flatMap((outcome) =>
    outcome && !('error' in outcome) ? [outcome] : [],
  );

  if (cancelled || signal.aborted) {
    const reason = cancellationReason(signal);
    emitProgress('generating', reason);
    return { components: completedComponents, reason, status: 'cancelled' };
  }

  const failures = outcomes.flatMap((outcome) => (outcome && 'error' in outcome ? [outcome] : []));
  if (failures.length > 0) {
    return {
      components: completedComponents,
      failures,
      reason: failures.map((failure) => `${failure.label}: ${failure.error}`).join('; '),
      status: 'failed',
    };
  }

  emitProgress('combining', 'All walkthrough generation tasks are ready.');
  return { components: completedComponents, status: 'ready' };
}
