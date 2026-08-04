import type {
  DiffComparison,
  DiffComparisonAnalysis,
  DiffComparisonView,
  DiffRange,
  GitSha,
  ReviewCommitEvolution,
  ReviewEvolutionUnit,
  ReviewPlan,
  ReviewStructureRecommendation,
  ReviewUnit,
  ReviewVersionId,
  ReviewVersionOption,
  Revision,
  RevisionLabel,
  SuggestedReviewComparison,
  TargetComparisonReviewStructure,
  VersionComparisonReviewStructure,
} from '../types.ts';

export const commitRevisionLabel = (text: string, url?: string): RevisionLabel => ({
  kind: 'commit',
  text,
  ...(url ? { url } : {}),
});

export const versionRevisionLabel = (text: string, url?: string): RevisionLabel => ({
  kind: 'version',
  text,
  ...(url ? { url } : {}),
});

export const revisionRef = (
  sha: GitSha,
  label: RevisionLabel,
  aliases?: ReadonlyArray<RevisionLabel>,
): Extract<Revision, { kind?: 'commit' }> => ({
  label,
  sha,
  ...(aliases?.length ? { aliases } : {}),
});

export const indexRevision = (
  label: RevisionLabel = { kind: 'review-marker', text: 'Index' },
  aliases?: ReadonlyArray<RevisionLabel>,
): Extract<Revision, { kind: 'index' }> => ({
  kind: 'index',
  label,
  ...(aliases?.length ? { aliases } : {}),
});

export const workingCopyRevision = (
  label: RevisionLabel = { kind: 'review-marker', text: 'Working copy' },
  aliases?: ReadonlyArray<RevisionLabel>,
): Extract<Revision, { kind: 'working-copy' }> => ({
  kind: 'working-copy',
  label,
  ...(aliases?.length ? { aliases } : {}),
});

export const isCommitRevision = (
  revision: Revision,
): revision is Extract<Revision, { kind?: 'commit' }> =>
  revision.kind !== 'index' && revision.kind !== 'working-copy';

export const shaForRevision = (revision: Revision): GitSha => {
  if (!isCommitRevision(revision)) {
    throw new Error(`Expected a commit revision, received ${revision.kind}.`);
  }
  return revision.sha;
};

export const diffRange = (base: Revision, head: Revision): DiffRange => ({ base, head });

export const diffComparison = (before: DiffRange, after: DiffRange): DiffComparison => ({
  after,
  before,
});

export const reviewVersionOption = ({
  activity,
  createdAt,
  diffStat,
  isHead,
  number,
  previousCreatedAt,
  previousNumber,
  range,
  unavailableReason,
  versionId,
}: {
  activity?: ReviewVersionOption['activity'];
  createdAt: string;
  diffStat?: ReviewVersionOption['diffStat'];
  isHead?: boolean;
  number?: number;
  previousCreatedAt?: string;
  previousNumber?: number;
  range: DiffRange;
  unavailableReason?: string;
  versionId: ReviewVersionId;
}): ReviewVersionOption => ({
  createdAt,
  range,
  versionId,
  ...(activity ? { activity } : {}),
  ...(diffStat ? { diffStat } : {}),
  ...(isHead != null ? { isHead } : {}),
  ...(number != null ? { number } : {}),
  ...(previousCreatedAt ? { previousCreatedAt } : {}),
  ...(previousNumber != null ? { previousNumber } : {}),
  ...(unavailableReason ? { unavailableReason } : {}),
});

/** Prefer reviewer activity before falling back to the previous available version. */
export const suggestReviewComparison = (
  versions: ReadonlyArray<ReviewVersionOption>,
): SuggestedReviewComparison | null => {
  const selectable = versions.filter((version) => !version.unavailableReason);
  const to = selectable.at(-1);
  if (!to) {
    return null;
  }
  const fromActivity = selectable
    .slice(0, -1)
    .filter((version) => version.activity?.reasons.length)
    .toSorted((left, right) =>
      (right.activity?.latestAt ?? '').localeCompare(left.activity?.latestAt ?? ''),
    )[0];
  if (fromActivity) {
    return {
      fromVersionId: fromActivity.versionId,
      reason: 'reviewer-activity',
      toVersionId: to.versionId,
    };
  }
  const from = selectable.at(-2);
  return from
    ? {
        fromVersionId: from.versionId,
        reason: 'previous-version',
        toVersionId: to.versionId,
      }
    : null;
};

export const isReviewableUnit = (unit: ReviewEvolutionUnit): unit is ReviewUnit =>
  unit.reviewable === true;

export const reviewableUnits = (
  units: ReadonlyArray<ReviewEvolutionUnit>,
): ReadonlyArray<ReviewUnit> => units.filter(isReviewableUnit);

export const resolveReviewPlan = ({
  analysis,
  comparison,
  recommendation,
  structure,
  units,
}: {
  analysis?: DiffComparisonAnalysis;
  comparison?: DiffComparison;
  recommendation?: ReviewStructureRecommendation;
  structure?: TargetComparisonReviewStructure | VersionComparisonReviewStructure | 'auto';
  units?: ReadonlyArray<ReviewEvolutionUnit>;
}): ReviewPlan => {
  if (structure === 'net-change') {
    return { reviewRelation: 'target-comparison', structure: 'net-change' };
  }

  if (structure === 'commit-by-commit') {
    const commits = (units ?? []).filter(
      (unit): unit is Extract<ReviewUnit, { kind: 'commit' }> =>
        unit.reviewable && unit.kind === 'commit',
    );
    return {
      reviewRelation: 'target-comparison',
      structure: 'commit-by-commit',
      units: commits,
    };
  }

  const evolutionUnits = (units ?? []).filter(
    (unit): unit is Exclude<ReviewUnit, { kind: 'commit' }> =>
      unit.reviewable && unit.kind !== 'commit',
  );
  const partialCoverage = Boolean(
    units?.some((unit) => unit.kind === 'ambiguous' && !unit.reviewable),
  );
  const completeCoverage =
    (analysis?.commitEvolution?.summary.completeCoverage ?? true) && !partialCoverage;
  if (structure === 'commit-evolution' && !completeCoverage) {
    throw new Error(
      'Commit Evolution requires complete Evolution Unit coverage. Choose Complete Comparison or resolve the ambiguous units.',
    );
  }
  const resolved =
    structure === 'complete-comparison'
      ? 'complete-comparison'
      : structure === 'commit-evolution'
        ? 'commit-evolution'
        : completeCoverage &&
            recommendation?.suggestedStructure === 'commit-evolution' &&
            evolutionUnits.length > 0
          ? 'commit-evolution'
          : 'complete-comparison';

  if (resolved === 'commit-evolution' && evolutionUnits.length > 0) {
    return {
      reviewRelation: 'version-comparison',
      structure: 'commit-evolution',
      units: evolutionUnits,
      ...(analysis ? { analysis } : {}),
      ...(comparison ? { comparison } : {}),
    };
  }

  return {
    reviewRelation: 'version-comparison',
    structure: 'complete-comparison',
    ...(analysis ? { analysis } : {}),
    ...(comparison ? { comparison } : {}),
  };
};

export const diffComparisonView = ({
  analysis,
  comparison,
  files,
  from,
  to,
}: {
  analysis: DiffComparisonAnalysis;
  comparison: DiffComparison;
  files: DiffComparisonView['files'];
  from: ReviewVersionOption;
  to: ReviewVersionOption;
}): DiffComparisonView => ({ analysis, comparison, files, from, to });

export const reviewCommitEvolution = (evolution: ReviewCommitEvolution): ReviewCommitEvolution =>
  evolution;

export const versionOptionHeadSha = (version: ReviewVersionOption): GitSha =>
  shaForRevision(version.range.head);

export const versionOptionBaseSha = (version: ReviewVersionOption): GitSha =>
  shaForRevision(version.range.base);

export const versionOptionLabelText = (version: ReviewVersionOption) =>
  version.number != null
    ? version.number === 0
      ? 'Base'
      : `v${version.number}`
    : version.range.head.label.text;

export const evolutionUnitCommit = (unit: ReviewEvolutionUnit) => {
  if (unit.kind === 'commit') {
    return unit.commit;
  }
  if (unit.kind === 'introduced') {
    return unit.after;
  }
  if (unit.kind === 'removed') {
    return unit.before;
  }
  if (unit.kind === 'revised' || unit.kind === 'ambiguous') {
    return unit.after ?? unit.before;
  }
  if (unit.kind === 'absorbed-into-base') {
    return unit.baseCommit ?? unit.before ?? unit.after;
  }
  return unit.after ?? unit.before;
};

export const evolutionUnitRebaseOverlaps = (unit: ReviewEvolutionUnit) =>
  unit.kind === 'revised' ? (unit.rebaseOverlaps ?? []) : [];
