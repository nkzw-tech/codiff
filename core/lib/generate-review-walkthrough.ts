import type {
  GenerationMetadata,
  GenerationProfile,
  GitSha,
  RepositoryState,
  ReviewCommitUnit,
  TargetComparisonReviewPlan,
  TreeInspectionScope,
  WalkthroughArtifactV5,
  WalkthroughCapturedContext,
  WalkthroughGenerationProgress,
  WalkthroughGenerationRequest,
  WalkthroughNarrativeContentV5,
  WalkthroughNarrativeV5,
} from '../types.ts';
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
      structure: TargetComparisonReviewPlan['structure'];
    };

export type ResolvedWalkthroughGenerationPlan =
  | { reviewRelation: 'single-diff'; structure: 'single-diff' }
  | TargetComparisonReviewPlan;

export type NarrativeSemanticInput = {
  capturedContext: WalkthroughCapturedContext;
  generationRequest: WalkthroughGenerationRequest;
  promptOptions: WalkthroughPromptOptions;
};

export type NarrativeIdentity = 'single' | { kind: 'commit'; sha: GitSha };

export type ReusableWalkthroughComponent = ReusableWalkthroughGenerationComponent<
  NarrativeIdentity,
  NarrativeSemanticInput,
  WalkthroughNarrativeContentV5
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

export type GenerateReviewWalkthroughInput = {
  customInstructions?: string;
  narrativeProfile: (scope: TreeInspectionScope) => GenerationProfile;
  onProgress?: (progress: WalkthroughGenerationProgress) => void;
  reusableComponents?: ReadonlyArray<ReusableWalkthroughComponent>;
  runModel: ReviewWalkthroughRunModel;
  selection: WalkthroughGenerationSelection;
  signal?: AbortSignal;
  states: {
    byCommitSha?: Readonly<Partial<Record<GitSha, RepositoryState>>>;
    whole?: RepositoryState;
  };
  units?: ReadonlyArray<ReviewCommitUnit>;
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
  if (input.selection.relation === 'single-diff') {
    return { reviewRelation: 'single-diff', structure: 'single-diff' };
  }
  if (input.selection.structure === 'net-change') {
    return { reviewRelation: 'target-comparison', structure: 'net-change' };
  }
  if (!input.units?.length) {
    throw new Error('Commit-by-commit generation requires at least one commit unit.');
  }
  return {
    reviewRelation: 'target-comparison',
    structure: 'commit-by-commit',
    units: input.units,
  };
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
  if (selection.relation !== 'target-comparison') {
    throw new Error('Target Comparison plan does not match the selected review relation.');
  }
  return createWalkthroughGenerationRequest(
    { range: selection.range, relation: 'target-comparison', structure: plan.structure },
    customInstructions,
  );
};

const runTask = (
  identity: NarrativeIdentity,
  label: string,
  state: RepositoryState | undefined,
  generationRequest: WalkthroughGenerationRequest,
  profile: GenerationProfile,
  promptOptions: WalkthroughPromptOptions,
  runModel: ReviewWalkthroughRunModel,
): WalkthroughGenerationTask<
  NarrativeIdentity,
  NarrativeSemanticInput,
  WalkthroughNarrativeContentV5
> => {
  const semanticInput = {
    capturedContext: captureWalkthroughContext(state ?? emptyStateForRequest(generationRequest)),
    generationRequest,
    promptOptions,
  };
  return {
    id: identity === 'single' ? 'single' : `commit:${identity.sha}`,
    identity,
    label,
    profile,
    run: async ({ profile: requestedProfile, semanticInput: requestedInput, signal }) => {
      if (!hasMaterializedDiff(state)) {
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

const emptyStateForRequest = (request: WalkthroughGenerationRequest): RepositoryState => ({
  branch: null,
  files: [],
  generatedAt: 0,
  launchPath: '',
  root: '',
  source:
    request.review.relation === 'target-comparison'
      ? { base: '', head: '', symmetric: false, type: 'range' }
      : { type: 'working-tree' },
});

const failedResult = (
  error: unknown,
  reusableComponents: ReadonlyArray<ReusableWalkthroughComponent>,
): GenerateReviewWalkthroughResult => {
  const message = error instanceof Error ? error.message : String(error);
  return {
    failures: [{ error: message, identity: 'single', label: 'Complete comparison' }],
    reason: message,
    reusableComponents,
    status: 'failed',
  };
};

const captureCompositeContext = (
  wholeState: RepositoryState,
  components: ReadonlyArray<ReusableWalkthroughComponent>,
): WalkthroughCapturedContext => ({
  ...captureWalkthroughContext(wholeState),
  files: components.flatMap((component) => component.semanticInput.capturedContext.files),
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
  task: WalkthroughGenerationTask<
    NarrativeIdentity,
    NarrativeSemanticInput,
    WalkthroughNarrativeContentV5
  >,
) =>
  valuesEqual(component.identity, task.identity) &&
  valuesEqual(component.semanticInput, task.semanticInput) &&
  valuesEqual(component.profile, task.profile) &&
  valuesEqual(component.generationMetadata.profile, task.profile) &&
  component.generationMetadata.agent === task.profile.agent &&
  task.profile.modelCandidates.includes(component.generationMetadata.model);

export async function generateReviewWalkthrough(
  input: GenerateReviewWalkthroughInput,
): Promise<GenerateReviewWalkthroughResult> {
  const reusableComponents = [...(input.reusableComponents ?? [])];
  let plan: ResolvedWalkthroughGenerationPlan;
  try {
    plan = resolvePlan(input);
  } catch (error: unknown) {
    return failedResult(error, reusableComponents);
  }

  const wholeState = input.states.whole;
  if (!hasMaterializedDiff(wholeState)) {
    return failedResult(
      'Walkthrough generation requires a non-empty complete diff.',
      reusableComponents,
    );
  }
  const generationRequest = generationRequestForPlan(
    plan,
    input.selection,
    input.customInstructions,
  );

  const tasks =
    plan.structure === 'commit-by-commit'
      ? plan.units.map((unit) =>
          runTask(
            { kind: 'commit', sha: unit.commit.sha },
            `${unit.commit.shortSha} ${unit.commit.subject}`,
            input.states.byCommitSha?.[unit.commit.sha],
            generationRequest,
            input.narrativeProfile({ kind: 'commit', sha: unit.commit.sha }),
            {
              commitContext: { sha: unit.commit.sha, subject: unit.commit.subject },
              scope: { kind: 'commit', sha: unit.commit.sha },
            },
            input.runModel,
          ),
        )
      : [
          runTask(
            'single',
            'Complete comparison',
            wholeState,
            generationRequest,
            input.narrativeProfile({ kind: 'complete-diff' }),
            {},
            input.runModel,
          ),
        ];

  const taskResult = await runWalkthroughGenerationTasks({
    onProgress: input.onProgress,
    reusableComponents,
    signal: input.signal,
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

  let narrative: WalkthroughNarrativeV5;
  if (plan.structure === 'commit-by-commit') {
    const units = plan.units.map((unit, index) => {
      const task = tasks[index]!;
      const component = taskResult.components.find((candidate) =>
        componentMatchesTask(candidate, task),
      );
      if (!component) {
        throw new Error(`Missing completed narrative for commit ${unit.commit.sha}.`);
      }
      return {
        commit: unit.commit,
        content: component.output,
        generationMetadata: component.generationMetadata,
        sha: unit.commit.sha,
      };
    });
    narrative = { structure: 'commit-by-commit', units };
  } else {
    const task = tasks[0]!;
    const component = taskResult.components.find((candidate) =>
      componentMatchesTask(candidate, task),
    );
    if (!component) {
      throw new Error('Missing completed aggregate narrative.');
    }
    narrative = {
      content: component.output,
      generationMetadata: component.generationMetadata,
      structure: plan.structure,
    };
  }

  const contributingComponents = tasks
    .map((task) => taskResult.components.find((component) => componentMatchesTask(component, task)))
    .filter((component): component is ReusableWalkthroughComponent => component != null);
  return {
    artifact: createWalkthroughArtifactV5(
      narrative,
      plan.structure === 'commit-by-commit'
        ? captureCompositeContext(wholeState, contributingComponents)
        : captureWalkthroughContext(wholeState),
      generationRequest,
    ),
    plan,
    reusableComponents: taskResult.components,
    status: 'ready',
  };
}
