// @ts-check

const {
  capturedThreadStateById,
  toAssessmentChangedRanges,
  toAssessmentThreadCandidates,
} = require('./walkthrough-assessment-adapter.cjs');

/**
 * Keep reusable current-review outcomes, expose failed retries, and describe
 * independent background replacements without persisting pending claims.
 *
 * @param {{
 *   artifact: import('../core/types.ts').WalkthroughArtifactV5,
 *   authoring: Pick<typeof import('../core/walkthrough-authoring.ts'),
 *     'assessmentValuesEqual' | 'createAssessmentDemandsFromSelections' |
 *     'normalizeAssessmentInput' | 'reconcileWalkthroughAssessments' |
 *     'selectWalkthroughAssessmentCandidates'>,
 *   comments: ReadonlyArray<import('../core/types.ts').PullRequestExistingReviewComment>,
 *   profile: import('../core/types.ts').GenerationProfile,
 * }} input
 */
const buildWalkthroughAssessmentPlan = (input) => {
  const codeScope = { type: 'single-diff' };
  const candidates = toAssessmentThreadCandidates(
    input.comments,
    codeScope,
    input.authoring.normalizeAssessmentInput,
  );
  const selections = input.authoring.selectWalkthroughAssessmentCandidates(candidates, {
    changedRanges: toAssessmentChangedRanges(input.artifact.capturedContext.files),
    codeScope,
  });
  const demands = input.authoring.createAssessmentDemandsFromSelections({
    capturedThreadStateById: capturedThreadStateById(input.comments),
    selections,
  });
  const existing = input.artifact.assessments?.items ?? [];
  const reconciliation = input.authoring.reconcileWalkthroughAssessments({
    components: existing,
    demands,
    profile: input.profile,
  });
  const reusableByIdentity = (identity) =>
    reconciliation.reuse.find((component) =>
      input.authoring.assessmentValuesEqual(component.identity, identity),
    );
  const failedByIdentityAndInput = (demand) =>
    existing.find(
      (component) =>
        component.outcome.status === 'failed' &&
        input.authoring.assessmentValuesEqual(component.identity, demand.identity) &&
        input.authoring.assessmentValuesEqual(component.input, demand.input),
    );
  const items = demands.flatMap((demand) => {
    const reusable = reusableByIdentity(demand.identity);
    if (reusable) return [reusable];
    const failed = failedByIdentityAndInput(demand);
    return failed ? [failed] : [];
  });
  return {
    artifact: { ...input.artifact, assessments: { items } },
    selections,
    tasks: reconciliation.generate.map((demand) => ({
      demand,
      expectedComponent: failedByIdentityAndInput(demand) ?? null,
    })),
  };
};

module.exports = { buildWalkthroughAssessmentPlan };
