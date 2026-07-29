import type {
  AssessmentCapturedPresentationState,
  AssessmentComponent,
  AssessmentIdentity,
  AssessmentInput,
  GenerationProfile,
} from '../types.ts';

export type AssessmentDemand = {
  capturedPresentationState: AssessmentCapturedPresentationState;
  identity: AssessmentIdentity;
  input: AssessmentInput;
};

export type AssessmentReconciliation = {
  generate: ReadonlyArray<AssessmentDemand>;
  remove: ReadonlyArray<AssessmentComponent>;
  reuse: ReadonlyArray<AssessmentComponent>;
};

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

export const assessmentValuesEqual = (left: unknown, right: unknown) =>
  JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));

const identityKey = (identity: AssessmentIdentity) => JSON.stringify(stableValue(identity));

/**
 * Reconcile desired assessments against independently reusable components.
 *
 * Only the authoritative assessment input and requested generation profile
 * affect reuse. Narrative content, sibling comments, generation time, and
 * captured/live thread state are deliberately absent.
 */
export const reconcileWalkthroughAssessments = ({
  components,
  demands,
  profile,
}: {
  components: ReadonlyArray<AssessmentComponent>;
  demands: ReadonlyArray<AssessmentDemand>;
  profile: GenerationProfile;
}): AssessmentReconciliation => {
  const componentByIdentity = new Map(
    components.map((component) => [identityKey(component.identity), component]),
  );
  const demandKeys = new Set<string>();
  const generate: Array<AssessmentDemand> = [];
  const reuse: Array<AssessmentComponent> = [];

  for (const demand of demands) {
    const key = identityKey(demand.identity);
    if (demandKeys.has(key)) {
      throw new Error('Assessment demand identities must be unique.');
    }
    demandKeys.add(key);
    const component = componentByIdentity.get(key);
    if (
      component?.outcome.status === 'ready' &&
      assessmentValuesEqual(component.input, demand.input) &&
      assessmentValuesEqual(component.outcome.generationMetadata.profile, profile)
    ) {
      reuse.push(component);
    } else {
      generate.push(demand);
    }
  }

  return {
    generate,
    remove: components.filter((component) => !demandKeys.has(identityKey(component.identity))),
    reuse,
  };
};
