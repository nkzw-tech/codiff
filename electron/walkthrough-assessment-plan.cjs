// @ts-check

const {
  buildAssessmentVersionContext,
  capturedThreadStateById,
  toAssessmentChangedRanges,
  toAssessmentThreadCandidates,
} = require('./walkthrough-assessment-adapter.cjs');

/**
 * Derive current assessment demand, retain only reusable/current outcomes, and
 * describe independent background replacements. Live resolution never enters
 * this artifact projection.
 *
 * @param {{
 *   artifact: import('../core/types.ts').WalkthroughArtifactV5,
 *   authoring: Pick<typeof import('../core/walkthrough-authoring.ts'),
 *     'assessmentValuesEqual' | 'createAssessmentDemandsFromSelections' |
 *     'normalizeAssessmentInput' | 'reconcileWalkthroughAssessments' |
 *     'selectWalkthroughAssessmentCandidates'>,
 *   byCommitSha?: Readonly<Record<string, import('../core/types.ts').RepositoryState>>,
 *   byUnitId?: Readonly<Record<string, import('../core/types.ts').RepositoryState>>,
 *   comments: ReadonlyArray<import('../core/types.ts').PullRequestExistingReviewComment>,
 *   profile: import('../core/types.ts').GenerationProfile,
 *   selection?: import('../core/lib/generate-review-walkthrough.ts').WalkthroughGenerationSelection,
 *   units?: ReadonlyArray<import('../core/types.ts').ReviewEvolutionUnit>,
 *   versions?: ReadonlyArray<import('../core/types.ts').ReviewVersionOption>,
 * }} input
 */
const buildWalkthroughAssessmentPlan = (input) => {
  const review = input.artifact.generationRequest.review;
  const codeScope =
    review.relation === 'single-diff'
      ? { type: 'single-diff' }
      : review.relation === 'target-comparison'
        ? { range: review.range, type: 'target-comparison' }
        : { comparison: review.comparison, type: 'version-comparison' };

  const versionContext =
    review.relation === 'single-diff'
      ? undefined
      : buildAssessmentVersionContext(input.versions ?? [], review);
  const candidates = versionContext
    ? toAssessmentThreadCandidates(
        input.comments,
        versionContext,
        codeScope,
        input.authoring.normalizeAssessmentInput,
      )
    : toAssessmentThreadCandidates(
        input.comments,
        codeScope,
        input.authoring.normalizeAssessmentInput,
      );

  const byCommitSha = input.byCommitSha ?? {};
  const byUnitId = input.byUnitId ?? {};
  const unitRoutes =
    review.structure === 'commit-by-commit'
      ? (input.units ?? []).flatMap((unit) =>
          unit.kind === 'commit' && byCommitSha[unit.commit.sha]
            ? [
                {
                  changedRanges: toAssessmentChangedRanges(byCommitSha[unit.commit.sha].files),
                  codeScope: { sha: unit.commit.sha, type: 'commit' },
                },
              ]
            : [],
        )
      : review.structure === 'commit-evolution'
        ? (input.units ?? []).flatMap((unit) =>
            unit.kind !== 'commit' && unit.reviewable && byUnitId[unit.unitId]
              ? [
                  {
                    changedRanges: toAssessmentChangedRanges(byUnitId[unit.unitId].files),
                    codeScope: { type: 'evolution-unit', unitId: unit.unitId },
                    ...(versionContext
                      ? {
                          interval: {
                            from: versionContext.from,
                            to: versionContext.to,
                          },
                        }
                      : {}),
                  },
                ]
              : [],
          )
        : undefined;
  const selections = input.authoring.selectWalkthroughAssessmentCandidates(candidates, {
    changedRanges: toAssessmentChangedRanges(input.artifact.capturedContext.files),
    codeScope,
    ...(versionContext ? { from: versionContext.from, to: versionContext.to } : {}),
    ...(unitRoutes ? { unitRoutes } : {}),
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
