import { expect, test } from 'vite-plus/test';
import {
  commitRevisionLabel,
  diffComparison,
  diffRange,
  indexRevision,
  resolveReviewPlan,
  reviewableUnits,
  reviewVersionOption,
  revisionRef,
  shaForRevision,
  suggestReviewComparison,
  versionOptionHeadSha,
  versionRevisionLabel,
} from '../lib/review-history.ts';
import type {
  DiffComparisonAnalysis,
  EvolutionUnitId,
  GitSha,
  ReviewCommitUnit,
  ReviewEvolutionUnit,
  ReviewSelection,
  ReviewVersionId,
} from '../types.ts';

const gitSha = (value: string) => value as GitSha;
const evolutionUnitId = (value: string) => value as EvolutionUnitId;
const reviewVersionId = (value: string) => value as ReviewVersionId;

const base = revisionRef(gitSha('a'.repeat(40)), commitRevisionLabel('base'));
const headOld = revisionRef(gitSha('b'.repeat(40)), versionRevisionLabel('v1'));
const headNew = revisionRef(gitSha('c'.repeat(40)), versionRevisionLabel('v2'));
const before = diffRange(base, headOld);
const after = diffRange(base, headNew);
const comparison = diffComparison(before, after);

const commit = {
  authoredAt: '2026-01-01T00:00:00.000Z',
  authorName: 'A',
  parentShas: [base.sha],
  sha: headNew.sha,
  shortSha: headNew.sha.slice(0, 7),
  subject: 'Add review history',
};

const units: ReadonlyArray<ReviewEvolutionUnit> = [
  { commit, kind: 'commit', order: 0, reviewable: true },
  {
    after: commit,
    confidence: 'high',
    kind: 'introduced',
    order: 1,
    reviewable: true,
    unitId: evolutionUnitId('introduced-1'),
  },
  {
    after: { ...commit, sha: headOld.sha },
    before: { ...commit, sha: headOld.sha },
    confidence: 'exact',
    kind: 'retained',
    order: 2,
    reviewable: false,
    unitId: evolutionUnitId('retained-1'),
  },
];

const analysisFor = (
  evolutionUnits: ReadonlyArray<ReviewEvolutionUnit>,
  completeCoverage: boolean,
): DiffComparisonAnalysis => ({
  commitEvolution: {
    recommendation: {
      rationale: 'Some units may be ambiguous.',
      suggestedStructure: completeCoverage ? 'commit-evolution' : 'complete-comparison',
    },
    summary: {
      absorbedIntoBase: 0,
      added: 0,
      ambiguous: completeCoverage ? 0 : 1,
      completeCoverage,
      pairingCoverage: completeCoverage ? 1 : 0,
      removed: 0,
      retained: 0,
      reviewable: evolutionUnits.filter((unit) => unit.reviewable).length,
      revised: 0,
      rewrittenSamePatch: 0,
      unreviewableAmbiguous: completeCoverage ? 0 : 1,
    },
    units: evolutionUnits,
  },
  summary: {
    addedLines: 1,
    baseMoved: false,
    commentsAffected: 0,
    conflictFiles: 0,
    deletedLines: 0,
    empty: false,
    filesChanged: 1,
    intentionalFiles: 1,
    noiseFiles: 0,
  },
});

test('keeps revision SHA identity separate from labels and non-commit markers', () => {
  expect(shaForRevision(base)).toBe(base.sha);
  expect(comparison.after.head.label.text).toBe('v2');
  expect(() => shaForRevision(indexRevision())).toThrow('Expected a commit revision');
  expect(reviewVersionId('version-1')).toBe('version-1');
  expect(evolutionUnitId('unit-1')).toBe('unit-1');
});

test('projects version options through branded version and revision identities', () => {
  const version = reviewVersionOption({
    createdAt: '2026-01-02T00:00:00.000Z',
    number: 2,
    range: after,
    versionId: reviewVersionId('version-2'),
  });

  expect(version.versionId).toBe('version-2');
  expect(versionOptionHeadSha(version)).toBe(headNew.sha);
  expect(shaForRevision(version.range.base)).toBe(base.sha);
});

test('suggests reviewer activity before falling back to the previous version', () => {
  const version = (id: string, createdAt: string, latestAt?: string) =>
    reviewVersionOption({
      ...(latestAt
        ? { activity: { latestAt, reasons: [{ kind: 'comment' as const, occurredAt: latestAt }] } }
        : {}),
      createdAt,
      range: after,
      versionId: reviewVersionId(id),
    });
  const versions = [
    version('v1', '2026-01-01T00:00:00.000Z'),
    version('v2', '2026-01-02T00:00:00.000Z', '2026-01-02T12:00:00.000Z'),
    version('v3', '2026-01-03T00:00:00.000Z'),
  ];

  expect(suggestReviewComparison(versions)).toEqual({
    fromVersionId: 'v2',
    reason: 'reviewer-activity',
    toVersionId: 'v3',
  });
  expect(suggestReviewComparison(versions.map(({ activity: _activity, ...item }) => item))).toEqual(
    {
      fromVersionId: 'v2',
      reason: 'previous-version',
      toVersionId: 'v3',
    },
  );
});

test('uses commit SHAs for commit units and typed IDs for Evolution Units', () => {
  const reviewable = reviewableUnits(units);

  expect(reviewable.map((unit) => unit.kind)).toEqual(['commit', 'introduced']);
  expect(reviewable[0]).toMatchObject({ commit: { sha: headNew.sha }, kind: 'commit' });
  expect(reviewable[0]).not.toHaveProperty('unitId');
  expect(reviewable[1]).toMatchObject({ kind: 'introduced', unitId: 'introduced-1' });
});

test('resolves target comparisons without introducing Evolution Units', () => {
  const unit: ReviewCommitUnit = {
    commit: {
      authoredAt: '2026-07-01T00:00:00.000Z',
      authorName: 'Ada',
      parentShas: [gitSha('a'.repeat(40))],
      sha: gitSha('b'.repeat(40)),
      shortSha: 'bbbbbbbb',
      subject: 'Add target classification',
    },
    kind: 'commit',
    order: 0,
    reviewable: true,
  };

  expect(resolveReviewPlan({ structure: 'net-change', units: [unit] })).toEqual({
    reviewRelation: 'target-comparison',
    structure: 'net-change',
  });
  expect(resolveReviewPlan({ structure: 'commit-by-commit', units: [unit] })).toEqual({
    reviewRelation: 'target-comparison',
    structure: 'commit-by-commit',
    units: [unit],
  });
});

test('resolves automatic and explicit Version Comparison plans', () => {
  expect(
    resolveReviewPlan({
      comparison,
      recommendation: {
        rationale: 'Review introduced units.',
        suggestedStructure: 'commit-evolution',
      },
      structure: 'auto',
      units,
    }),
  ).toMatchObject({
    reviewRelation: 'version-comparison',
    structure: 'commit-evolution',
    units: [{ kind: 'introduced', unitId: 'introduced-1' }],
  });

  expect(resolveReviewPlan({ comparison, structure: 'complete-comparison', units })).toMatchObject({
    reviewRelation: 'version-comparison',
    structure: 'complete-comparison',
  });
});

test('falls back to Complete Comparison when Evolution Unit coverage is partial', () => {
  const ambiguous: ReviewEvolutionUnit = {
    before: commit,
    confidence: 'unmatched',
    kind: 'ambiguous',
    order: 3,
    reviewable: false,
    unitId: evolutionUnitId('ambiguous-1'),
  };

  expect(
    resolveReviewPlan({
      analysis: analysisFor([...units, ambiguous], true),
      comparison,
      recommendation: {
        rationale: 'Evolution would otherwise be preferred.',
        suggestedStructure: 'commit-evolution',
      },
      structure: 'auto',
      units: [...units, ambiguous],
    }),
  ).toMatchObject({
    reviewRelation: 'version-comparison',
    structure: 'complete-comparison',
  });
});

test('rejects an explicit Commit Evolution plan when analysis coverage is incomplete', () => {
  expect(() =>
    resolveReviewPlan({
      analysis: analysisFor([], false),
      comparison,
      structure: 'commit-evolution',
      units,
    }),
  ).toThrow('requires complete Evolution Unit coverage');
});

test('names target and version selections by review-version identity', () => {
  const target: ReviewSelection = {
    kind: 'target-comparison',
    versionId: reviewVersionId('target'),
  };
  const comparisonSelection: ReviewSelection = {
    fromVersionId: reviewVersionId('from'),
    kind: 'version-comparison',
    toVersionId: reviewVersionId('to'),
  };

  expect(target.versionId).toBe('target');
  expect(comparisonSelection).toMatchObject({ fromVersionId: 'from', toVersionId: 'to' });
});
