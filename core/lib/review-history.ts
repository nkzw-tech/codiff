import type {
  DiffComparison,
  DiffRange,
  GitSha,
  ReviewPlan,
  ReviewUnit,
  Revision,
  RevisionLabel,
  TargetComparisonReviewStructure,
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

export const resolveReviewPlan = ({
  structure,
  units,
}: {
  structure: TargetComparisonReviewStructure;
  units?: ReadonlyArray<ReviewUnit>;
}): ReviewPlan => {
  if (structure === 'net-change') {
    return { reviewRelation: 'target-comparison', structure: 'net-change' };
  }

  return {
    reviewRelation: 'target-comparison',
    structure: 'commit-by-commit',
    units: units ?? [],
  };
};
