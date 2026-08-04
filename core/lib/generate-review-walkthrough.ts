import type {
  DiffComparisonAnalysis,
  EvolutionUnitId,
  GenerationMetadata,
  GenerationProfile,
  GitSha,
  RepositoryState,
  ReviewEvolutionUnit,
  ReviewPlan,
  ReviewUnit,
  TargetComparisonReviewPlan,
  TreeInspectionScope,
  VersionComparisonReviewPlan,
  WalkthroughArtifactV5,
  WalkthroughCapturedContext,
  WalkthroughGenerationProgress,
  WalkthroughGenerationRequest,
  WalkthroughNarrativeContentV5,
  WalkthroughNarrativeV5,
} from '../types.ts';
import { resolveReviewPlan } from './review-history.ts';
import {
  buildWalkthroughPrompt,
  captureWalkthroughContext,
  createWalkthroughArtifactV5,
  createWalkthroughGenerationRequest,
  normalizeWalkthroughDraft,
  type WalkthroughPromptOptions,
} from './walkthrough-authoring.ts';
import {
  runWalkthroughGenerationTasks,
  walkthroughGenerationConcurrency,
  type ReusableWalkthroughGenerationComponent,
  type WalkthroughGenerationFailure as TaskFailure,
  type WalkthroughGenerationTask,
} from './walkthrough-generation-tasks.ts';

export type WalkthroughGenerationSelection =
  | { relation: 'single-diff' }
  | {
      range: Extract<
        WalkthroughGenerationRequest['review'],
        { relation: 'target-comparison' }
      >['range'];
      relation: 'target-comparison';
      structure: TargetComparisonReviewPlan['structure'] | 'auto';
    }
  | {
      comparison: Extract<
        WalkthroughGenerationRequest['review'],
        { relation: 'version-comparison' }
      >['comparison'];
      relation: 'version-comparison';
      structure: VersionComparisonReviewPlan['structure'] | 'auto';
    };

export type ResolvedWalkthroughGenerationPlan =
  | { reviewRelation: 'single-diff'; structure: 'single-diff' }
  | ReviewPlan;

export type NarrativeSemanticInput = {
  capturedContext: WalkthroughCapturedContext;
  generationRequest: WalkthroughGenerationRequest;
  promptOptions: WalkthroughPromptOptions;
};

export type ReviewFocusSemanticInput = {
  generationRequest: WalkthroughGenerationRequest;
  units: ReadonlyArray<{
    content: WalkthroughNarrativeContentV5;
    unitId: EvolutionUnitId;
  }>;
};

export type NarrativeIdentity =
  | 'review-focus'
  | 'single'
  | { kind: 'commit'; sha: GitSha }
  | { kind: 'evolution-unit'; unitId: EvolutionUnitId };

type ComponentSemanticInput = NarrativeSemanticInput | ReviewFocusSemanticInput;
type ComponentOutput = WalkthroughNarrativeContentV5 | string;

export type ReusableWalkthroughComponent = ReusableWalkthroughGenerationComponent<
  NarrativeIdentity,
  ComponentSemanticInput,
  ComponentOutput
>;

export type WalkthroughGenerationFailure = TaskFailure<NarrativeIdentity>;

export type ReviewWalkthroughModelResult = {
  generationMetadata: GenerationMetadata;
  response: unknown;
};

export type ReviewWalkthroughRunModel = (input: {
  profile: GenerationProfile;
  prompt: string;
  semanticInput: NarrativeSemanticInput;
  signal: AbortSignal;
  state: RepositoryState;
}) => Promise<ReviewWalkthroughModelResult>;

export type ReviewWalkthroughRunFocusModel = (input: {
  profile: GenerationProfile;
  semanticInput: ReviewFocusSemanticInput;
  signal: AbortSignal;
}) => Promise<{ content: string; generationMetadata: GenerationMetadata }>;

export type GenerateReviewWalkthroughInput = {
  analysis?: DiffComparisonAnalysis;
  customInstructions?: string;
  materializeUnit?: (unit: ReviewUnit, signal: AbortSignal) => Promise<RepositoryState | undefined>;
  narrativeProfile: (scope: TreeInspectionScope) => GenerationProfile;
  onProgress?: (progress: WalkthroughGenerationProgress) => void;
  promptOptions?: WalkthroughPromptOptions;
  reusableComponents?: ReadonlyArray<ReusableWalkthroughComponent>;
  reviewFocusProfile?: GenerationProfile;
  runModel: ReviewWalkthroughRunModel;
  runReviewFocusModel?: ReviewWalkthroughRunFocusModel;
  selection: WalkthroughGenerationSelection;
  signal?: AbortSignal;
  states: {
    byCommitSha?: Readonly<Partial<Record<GitSha, RepositoryState>>>;
    byUnitId?: Readonly<Partial<Record<EvolutionUnitId, RepositoryState>>>;
    whole?: RepositoryState;
  };
  units?: ReadonlyArray<ReviewEvolutionUnit>;
};

export type GenerateReviewWalkthroughResult =
  | {
      artifact: WalkthroughArtifactV5;
      plan: ResolvedWalkthroughGenerationPlan;
      reusableComponents: ReadonlyArray<ReusableWalkthroughComponent>;
      status: 'ready';
    }
  | {
      failures: ReadonlyArray<WalkthroughGenerationFailure>;
      reason: string;
      reusableComponents: ReadonlyArray<ReusableWalkthroughComponent>;
      status: 'failed';
    };

const hasMaterializedDiff = (state: RepositoryState | undefined): state is RepositoryState =>
  Boolean(
    state?.files.some((file) =>
      file.sections.some((section) => section.binary || section.patch.trim().length > 0),
    ),
  );

const resolvePlan = (input: GenerateReviewWalkthroughInput): ResolvedWalkthroughGenerationPlan => {
  const { selection } = input;
  if (selection.relation === 'single-diff') {
    return { reviewRelation: 'single-diff', structure: 'single-diff' };
  }
  if (selection.relation === 'target-comparison') {
    const plan = resolveReviewPlan({
      structure: selection.structure === 'auto' ? 'net-change' : selection.structure,
      units: input.units,
    });
    if (plan.structure === 'commit-by-commit' && plan.units.length === 0) {
      throw new Error('Commit-by-commit generation requires at least one commit unit.');
    }
    return plan;
  }
  const plan = resolveReviewPlan({
    analysis: input.analysis,
    comparison: selection.comparison,
    recommendation: input.analysis?.commitEvolution?.recommendation,
    structure: selection.structure,
    units: input.analysis?.commitEvolution?.units,
  });
  if (selection.structure !== 'auto' && plan.structure !== selection.structure) {
    throw new Error('Commit Evolution generation requires at least one reviewable Evolution Unit.');
  }
  return plan;
};

const generationRequestForPlan = (
  plan: ResolvedWalkthroughGenerationPlan,
  selection: WalkthroughGenerationSelection,
  customInstructions: string | undefined,
): WalkthroughGenerationRequest => {
  if (plan.reviewRelation === 'single-diff') {
    return createWalkthroughGenerationRequest(
      { relation: 'single-diff', structure: 'single-diff' },
      customInstructions,
    );
  }
  if (plan.reviewRelation === 'target-comparison') {
    if (selection.relation !== 'target-comparison') {
      throw new Error('Target Comparison plan does not match the selected review relation.');
    }
    return createWalkthroughGenerationRequest(
      {
        range: selection.range,
        relation: 'target-comparison',
        structure: plan.structure,
      },
      customInstructions,
    );
  }
  if (selection.relation !== 'version-comparison') {
    throw new Error('Version Comparison plan does not match the selected review relation.');
  }
  return createWalkthroughGenerationRequest(
    {
      comparison: selection.comparison,
      relation: 'version-comparison',
      structure: plan.structure,
    },
    customInstructions,
  );
};

const emptyStateForRequest = (request: WalkthroughGenerationRequest): RepositoryState => ({
  branch: null,
  files: [],
  generatedAt: 0,
  launchPath: '',
  root: '',
  source:
    request.review.relation === 'single-diff'
      ? { type: 'working-tree' }
      : { base: '', head: '', symmetric: false, type: 'range' },
});

const unitAfter = (unit: ReviewUnit) =>
  unit.kind === 'commit'
    ? unit.commit
    : unit.kind === 'introduced' || unit.kind === 'revised' || unit.kind === 'ambiguous'
      ? unit.after
      : undefined;

const unitBefore = (unit: ReviewUnit) =>
  unit.kind === 'removed' || unit.kind === 'revised' || unit.kind === 'ambiguous'
    ? unit.before
    : undefined;

const identityForUnit = (
  unit: ReviewUnit,
): Exclude<NarrativeIdentity, 'review-focus' | 'single'> =>
  unit.kind === 'commit'
    ? { kind: 'commit', sha: unit.commit.sha }
    : { kind: 'evolution-unit', unitId: unit.unitId };

const labelForUnit = (unit: ReviewUnit) => {
  const summary = unitAfter(unit) ?? unitBefore(unit);
  return summary ? `${summary.shortSha} ${summary.subject}` : 'Evolution Unit';
};

const promptOptionsForUnit = (
  unit: ReviewUnit,
  generationRequest: WalkthroughGenerationRequest,
  base: WalkthroughPromptOptions | undefined,
): WalkthroughPromptOptions => {
  if (unit.kind === 'commit') {
    return {
      ...base,
      commitContext: { sha: unit.commit.sha, subject: unit.commit.subject },
      scope: { kind: 'commit', sha: unit.commit.sha },
    };
  }
  const request = generationRequest.review;
  if (request.relation !== 'version-comparison') {
    throw new Error('Evolution Unit generation requires a Version Comparison request.');
  }
  const after = unitAfter(unit);
  const before = unitBefore(unit);
  return {
    ...base,
    scope: { kind: 'evolution-unit', unitId: unit.unitId },
    versionCommitContext: {
      ...(after ? { after: { shortSha: after.shortSha, subject: after.subject } } : {}),
      ...(before ? { before: { shortSha: before.shortSha, subject: before.subject } } : {}),
      evolutionKind: unit.kind,
      kind: 'version-commit',
      range: {
        fromLabel: request.comparison.before.head.label.text,
        toLabel: request.comparison.after.head.label.text,
      },
      ...('rebaseOverlaps' in unit && unit.rebaseOverlaps
        ? {
            rebaseOverlaps: unit.rebaseOverlaps.map((overlap) => ({
              authorName: overlap.authorName,
              overlappingPaths: overlap.overlappingPaths,
              shortSha: overlap.shortSha,
              subject: overlap.subject,
            })),
          }
        : {}),
      unitId: unit.unitId,
    },
    versionCompareRange: {
      fromLabel: request.comparison.before.head.label.text,
      structure: 'commit-evolution',
      toLabel: request.comparison.after.head.label.text,
    },
  };
};

const aggregatePromptOptions = (
  generationRequest: WalkthroughGenerationRequest,
  base: WalkthroughPromptOptions | undefined,
): WalkthroughPromptOptions => {
  if (generationRequest.review.relation !== 'version-comparison') {
    return base ?? {};
  }
  return {
    ...base,
    versionCompareRange: {
      fromLabel: generationRequest.review.comparison.before.head.label.text,
      structure: generationRequest.review.structure,
      toLabel: generationRequest.review.comparison.after.head.label.text,
    },
  };
};

const runNarrativeTask = (
  identity: Exclude<NarrativeIdentity, 'review-focus'>,
  label: string,
  state: RepositoryState | undefined,
  materializationError: unknown,
  generationRequest: WalkthroughGenerationRequest,
  profile: GenerationProfile,
  promptOptions: WalkthroughPromptOptions,
  runModel: ReviewWalkthroughRunModel,
): WalkthroughGenerationTask<NarrativeIdentity, ComponentSemanticInput, ComponentOutput> => {
  const semanticInput: NarrativeSemanticInput = {
    capturedContext: captureWalkthroughContext(state ?? emptyStateForRequest(generationRequest)),
    generationRequest,
    promptOptions,
  };
  return {
    id:
      identity === 'single'
        ? 'single'
        : identity.kind === 'commit'
          ? `commit:${identity.sha}`
          : `evolution:${identity.unitId}`,
    identity,
    label,
    profile,
    run: async ({ profile: requestedProfile, semanticInput: requestedInput, signal }) => {
      if (materializationError) {
        throw materializationError;
      }
      if (!hasMaterializedDiff(state) || !('capturedContext' in requestedInput)) {
        throw new Error('The planned narrative component has no materialized diff.');
      }
      const result = await runModel({
        profile: requestedProfile,
        prompt: buildWalkthroughPrompt(
          requestedInput.capturedContext,
          requestedInput.generationRequest,
          requestedInput.promptOptions,
        ),
        semanticInput: requestedInput,
        signal,
        state,
      });
      return {
        generationMetadata: result.generationMetadata,
        output: normalizeWalkthroughDraft(result.response, state, result.generationMetadata),
      };
    },
    semanticInput,
  };
};

const runReviewFocusTask = (
  semanticInput: ReviewFocusSemanticInput,
  profile: GenerationProfile,
  runModel: ReviewWalkthroughRunFocusModel,
): WalkthroughGenerationTask<NarrativeIdentity, ComponentSemanticInput, ComponentOutput> => ({
  id: 'review-focus',
  identity: 'review-focus',
  label: 'Review focus',
  profile,
  run: async ({ profile: requestedProfile, semanticInput: requestedInput, signal }) => {
    if ('capturedContext' in requestedInput) {
      throw new Error('Review focus received an incompatible semantic input.');
    }
    const result = await runModel({
      profile: requestedProfile,
      semanticInput: requestedInput,
      signal,
    });
    const content = result.content.trim();
    if (!content) {
      throw new Error('Review focus model returned empty content.');
    }
    return { generationMetadata: result.generationMetadata, output: content };
  },
  semanticInput,
});

const failureReason = (error: unknown) => (error instanceof Error ? error.message : String(error));

const failedResult = (
  failures: ReadonlyArray<WalkthroughGenerationFailure>,
  reusableComponents: ReadonlyArray<ReusableWalkthroughComponent>,
): GenerateReviewWalkthroughResult => ({
  failures,
  reason: failures.map((failure) => `${failure.label}: ${failure.error}`).join('; '),
  reusableComponents,
  status: 'failed',
});

const singleFailure = (
  error: unknown,
  reusableComponents: ReadonlyArray<ReusableWalkthroughComponent>,
): GenerateReviewWalkthroughResult =>
  failedResult(
    [
      {
        error: failureReason(error),
        identity: 'single',
        label: 'Complete comparison',
      },
    ],
    reusableComponents,
  );

const captureCompositeContext = (
  wholeState: RepositoryState,
  components: ReadonlyArray<ReusableWalkthroughComponent>,
): WalkthroughCapturedContext => ({
  ...captureWalkthroughContext(wholeState),
  files: components.flatMap((component) =>
    'capturedContext' in component.semanticInput
      ? component.semanticInput.capturedContext.files
      : [],
  ),
});

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
};

const valuesEqual = (left: unknown, right: unknown) =>
  JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));

const componentMatchesTask = (
  component: ReusableWalkthroughComponent,
  task: WalkthroughGenerationTask<NarrativeIdentity, ComponentSemanticInput, ComponentOutput>,
) =>
  valuesEqual(component.identity, task.identity) &&
  valuesEqual(component.semanticInput, task.semanticInput) &&
  valuesEqual(component.profile, task.profile) &&
  valuesEqual(component.generationMetadata.profile, task.profile) &&
  component.generationMetadata.agent === task.profile.agent &&
  task.profile.modelCandidates.includes(component.generationMetadata.model);

const narrativeOutput = (component: ReusableWalkthroughComponent) => {
  if (typeof component.output === 'string') {
    throw new Error('Narrative composition received Review focus content.');
  }
  return component.output;
};

const materializedStateForUnit = (
  unit: ReviewUnit,
  states: GenerateReviewWalkthroughInput['states'],
) =>
  unit.kind === 'commit' ? states.byCommitSha?.[unit.commit.sha] : states.byUnitId?.[unit.unitId];

const mapWithConcurrency = async <Input, Output>(
  values: ReadonlyArray<Input>,
  concurrency: number,
  map: (value: Input, index: number) => Promise<Output>,
): Promise<Array<Output>> => {
  const output = new Array<Output>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await map(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker()),
  );
  return output;
};

export async function generateReviewWalkthrough(
  input: GenerateReviewWalkthroughInput,
): Promise<GenerateReviewWalkthroughResult> {
  const reusableComponents = [...(input.reusableComponents ?? [])];
  let plan: ResolvedWalkthroughGenerationPlan;
  try {
    plan = resolvePlan(input);
  } catch (error: unknown) {
    return singleFailure(error, reusableComponents);
  }

  const wholeState = input.states.whole;
  if (!wholeState || (!hasMaterializedDiff(wholeState) && plan.structure !== 'commit-evolution')) {
    return singleFailure(
      'Walkthrough generation requires a non-empty complete diff.',
      reusableComponents,
    );
  }
  const generationRequest = generationRequestForPlan(
    plan,
    input.selection,
    input.customInstructions,
  );

  if (
    plan.structure === 'single-diff' ||
    plan.structure === 'net-change' ||
    plan.structure === 'complete-comparison'
  ) {
    const task = runNarrativeTask(
      'single',
      'Complete comparison',
      wholeState,
      undefined,
      generationRequest,
      input.narrativeProfile({ kind: 'complete-diff' }),
      aggregatePromptOptions(generationRequest, input.promptOptions),
      input.runModel,
    );
    const result = await runWalkthroughGenerationTasks({
      onProgress: input.onProgress,
      reusableComponents,
      signal: input.signal,
      tasks: [task],
    });
    if (result.status !== 'ready') {
      return {
        failures: result.status === 'failed' ? result.failures : [],
        reason: result.reason,
        reusableComponents: result.components,
        status: 'failed',
      };
    }
    const component = result.components.find((candidate) => componentMatchesTask(candidate, task));
    if (!component) {
      return singleFailure('Missing completed aggregate narrative.', result.components);
    }
    return {
      artifact: createWalkthroughArtifactV5(
        {
          content: narrativeOutput(component),
          generationMetadata: component.generationMetadata,
          structure: plan.structure,
        },
        captureWalkthroughContext(wholeState),
        generationRequest,
      ),
      plan,
      reusableComponents: result.components,
      status: 'ready',
    };
  }

  const plannedUnits: ReadonlyArray<ReviewUnit> = plan.units;
  const signal = input.signal ?? new AbortController().signal;
  const materialized = await mapWithConcurrency(
    plannedUnits,
    walkthroughGenerationConcurrency,
    async (unit) => {
      const existing = materializedStateForUnit(unit, input.states);
      if (existing || !input.materializeUnit) {
        return { state: existing };
      }
      try {
        signal.throwIfAborted();
        const state = await input.materializeUnit(unit, signal);
        signal.throwIfAborted();
        return { state };
      } catch (error: unknown) {
        return { error, state: undefined };
      }
    },
  );
  const tasks = plannedUnits.map((unit, index) => {
    const materializedUnit = materialized[index]!;
    const promptOptions = promptOptionsForUnit(unit, generationRequest, input.promptOptions);
    const scope = promptOptions.scope;
    if (!scope) {
      throw new Error('Narrative unit scope was not resolved.');
    }
    return runNarrativeTask(
      identityForUnit(unit),
      labelForUnit(unit),
      materializedUnit.state,
      materializedUnit.error,
      generationRequest,
      input.narrativeProfile(scope),
      promptOptions,
      input.runModel,
    );
  });
  const taskResult = await runWalkthroughGenerationTasks({
    onProgress: input.onProgress,
    reusableComponents,
    signal,
    tasks,
  });
  if (taskResult.status !== 'ready') {
    return {
      failures: taskResult.status === 'failed' ? taskResult.failures : [],
      reason: taskResult.reason,
      reusableComponents: taskResult.components,
      status: 'failed',
    };
  }

  const completed = plannedUnits.map((unit, index) => {
    const task = tasks[index]!;
    const component = taskResult.components.find((candidate) =>
      componentMatchesTask(candidate, task),
    );
    if (!component) {
      throw new Error(`Missing completed narrative for ${labelForUnit(unit)}.`);
    }
    return { component, unit };
  });

  if (plan.structure === 'commit-by-commit') {
    const units = completed.map(({ component, unit }) => {
      if (unit.kind !== 'commit') {
        throw new Error('Commit narrative composition received an Evolution Unit.');
      }
      return {
        commit: unit.commit,
        content: narrativeOutput(component),
        generationMetadata: component.generationMetadata,
        sha: unit.commit.sha,
      };
    });
    return {
      artifact: createWalkthroughArtifactV5(
        { structure: 'commit-by-commit', units },
        captureCompositeContext(
          wholeState,
          completed.map(({ component }) => component),
        ),
        generationRequest,
      ),
      plan,
      reusableComponents: taskResult.components,
      status: 'ready',
    };
  }

  const evolutionUnits = completed.map(({ component, unit }) => {
    if (unit.kind === 'commit') {
      throw new Error('Evolution narrative composition received a target commit.');
    }
    return {
      ...(unit.kind === 'removed' ? {} : unitAfter(unit) ? { commit: unitAfter(unit) } : {}),
      content: narrativeOutput(component),
      generationMetadata: component.generationMetadata,
      kind: unit.kind,
      unitId: unit.unitId,
    };
  });
  if (!input.reviewFocusProfile || !input.runReviewFocusModel) {
    return failedResult(
      [
        {
          error: 'Commit Evolution requires a Review focus model call.',
          identity: 'review-focus',
          label: 'Review focus',
        },
      ],
      taskResult.components,
    );
  }
  const reviewFocusSemanticInput: ReviewFocusSemanticInput = {
    generationRequest,
    units: evolutionUnits.map((unit) => ({
      content: unit.content,
      unitId: unit.unitId,
    })),
  };
  const focusTask = runReviewFocusTask(
    reviewFocusSemanticInput,
    input.reviewFocusProfile,
    input.runReviewFocusModel,
  );
  const focusResult = await runWalkthroughGenerationTasks({
    onProgress: input.onProgress,
    reusableComponents: taskResult.components,
    signal,
    tasks: [focusTask],
  });
  if (focusResult.status !== 'ready') {
    return {
      failures: focusResult.status === 'failed' ? focusResult.failures : [],
      reason: focusResult.reason,
      reusableComponents: [...taskResult.components, ...focusResult.components],
      status: 'failed',
    };
  }
  const reviewFocus = focusResult.components.find((component) =>
    componentMatchesTask(component, focusTask),
  );
  if (!reviewFocus || typeof reviewFocus.output !== 'string') {
    return failedResult(
      [
        {
          error: 'Missing completed Review focus.',
          identity: 'review-focus',
          label: 'Review focus',
        },
      ],
      focusResult.components,
    );
  }
  const narrative: WalkthroughNarrativeV5 = {
    reviewFocus: {
      content: reviewFocus.output,
      generationMetadata: reviewFocus.generationMetadata,
    },
    structure: 'commit-evolution',
    units: evolutionUnits,
  };
  return {
    artifact: createWalkthroughArtifactV5(
      narrative,
      captureCompositeContext(
        wholeState,
        completed.map(({ component }) => component),
      ),
      generationRequest,
    ),
    plan,
    reusableComponents: [...taskResult.components, ...focusResult.components],
    status: 'ready',
  };
}
