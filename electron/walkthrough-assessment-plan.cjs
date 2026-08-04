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
 *   byCommitSha?: Readonly<Record<string, import('../core/types.ts').RepositoryState>>,
 *   comments: ReadonlyArray<import('../core/types.ts').PullRequestExistingReviewComment>,
 *   profile: import('../core/types.ts').GenerationProfile,
 *   units?: ReadonlyArray<import('../core/types.ts').ReviewCommitUnit>,
 * }} input
 */
const buildWalkthroughAssessmentPlan = (input) => {
  const review = input.artifact.generationRequest.review;
  const codeScope =
    review.relation === 'target-comparison'
      ? { range: review.range, type: 'target-comparison' }
      : { type: 'single-diff' };
  const candidates = toAssessmentThreadCandidates(
    input.comments,
    codeScope,
    input.authoring.normalizeAssessmentInput,
  );
  const selections = input.authoring.selectWalkthroughAssessmentCandidates(candidates, {
    changedRanges: toAssessmentChangedRanges(input.artifact.capturedContext.files),
    codeScope,
    ...(review.structure === 'commit-by-commit'
      ? {
          unitRoutes: (input.units ?? []).flatMap((unit) => {
            const unitState = input.byCommitSha?.[unit.commit.sha];
            return unitState
              ? [
                  {
                    changedRanges: toAssessmentChangedRanges(unitState.files),
                    codeScope: { sha: unit.commit.sha, type: 'commit' },
                  },
                ]
              : [];
          }),
        }
      : {}),
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
