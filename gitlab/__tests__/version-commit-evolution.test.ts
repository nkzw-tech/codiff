import type { ChangedFile } from '@nkzw/codiff-core/types';
import type { GitSha, ReviewVersionId } from '@nkzw/codiff-core/types';
import { describe, expect, test } from 'vite-plus/test';
import {
  attributeRebaseOverlaps,
  createCommitFingerprint,
  matchVersionCommitStacks,
  recommendVersionWalkthroughStructure,
  scoreBaseCommitAsRebaseOverlap,
  toCommitArtifact,
  type CommitFingerprint,
  type ReviewArtifactProvenance,
} from '../src/version-commit-evolution.ts';

const gitSha = (value: string) => value as GitSha;
const reviewVersionId = (value: string) => value as ReviewVersionId;
const provenance: ReviewArtifactProvenance = {
  kind: 'gitlab-api',
  project: { host: 'gitlab.example.com', project: 'group/project', provider: 'gitlab' },
};
const fingerprintMap = (entries: ReadonlyArray<readonly [string, CommitFingerprint]> = []) =>
  new Map<GitSha, CommitFingerprint>(
    entries.map(([sha, fingerprint]) => [gitSha(sha), fingerprint]),
  );

const endpoint = (id: string, headSha: string) => ({
  baseSha: gitSha(`base-${id}`),
  createdAt: '2026-07-15T00:00:00.000Z',
  headSha: gitSha(headSha),
  label: `v${id}`,
  startSha: gitSha(`base-${id}`),
  versionId: reviewVersionId(id),
});

const commit = (index: number, generation: 'new' | 'old' = 'old') => ({
  authoredDate: `2026-07-15T00:${String(index).padStart(2, '0')}:00.000Z`,
  authorName: 'Ada',
  message: `Change logical unit ${index}`,
  parentShas: [gitSha(index === 1 ? `${generation}-base` : `${generation}-${index - 1}`)],
  sha: gitSha(`${generation}-${index}`),
  shortSha: `${generation[0]}${index}`,
  title: `Change logical unit ${index}`,
  webUrl: `https://gitlab.example/commit/${generation}-${index}`,
});

const fingerprint = (
  sha: string,
  index: number,
  patchId: string,
  revision = 'same',
): CommitFingerprint => ({
  additions: 10 + index,
  changedPaths: [`src/unit-${index}.ts`],
  changeTokenSketch: [`token-${index}`, `revision-${revision}`],
  commitSha: gitSha(sha),
  coverage: 'complete',
  deletions: index,
  exactChangeId: patchId,
  filesChanged: 1,
  subjectKey: `change logical unit ${index}`,
});

const changedFile = (offset: number): ChangedFile => ({
  fingerprint: String(offset),
  path: 'src/app.ts',
  sections: [
    {
      binary: false,
      id: String(offset),
      kind: 'commit',
      loadState: 'ready',
      patch: `diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -${offset},1 +${offset},1 @@\n-old value\n+new value\n`,
    },
  ],
  status: 'modified',
});

describe('version commit evolution', () => {
  test('returns only revised logical commits 2, 4, and 6 as reviewable after a rebase', async () => {
    const oldCommits = Array.from({ length: 10 }, (_, index) => commit(index + 1));
    const newCommits = Array.from({ length: 10 }, (_, index) => commit(index + 1, 'new'));
    const revised = new Set([2, 4, 6]);
    const fingerprints = fingerprintMap();
    for (let index = 1; index <= 10; index += 1) {
      fingerprints.set(
        gitSha(`old-${index}`),
        fingerprint(`old-${index}`, index, `patch-${index}`, revised.has(index) ? 'old' : 'same'),
      );
      fingerprints.set(
        gitSha(`new-${index}`),
        fingerprint(
          `new-${index}`,
          index,
          revised.has(index) ? `revised-patch-${index}` : `patch-${index}`,
          revised.has(index) ? 'new' : 'same',
        ),
      );
    }
    const evolution = await matchVersionCommitStacks({
      fingerprints,
      from: endpoint('2', 'old-10'),
      newCommits,
      oldCommits,
      to: endpoint('6', 'new-10'),
    });

    expect(
      evolution.units.filter((unit) => unit.reviewable).map((unit) => unit.before?.sha),
    ).toEqual(['old-2', 'old-4', 'old-6']);
    expect(evolution.summary).toMatchObject({
      reviewable: 3,
      revised: 3,
      rewrittenSamePatch: 7,
      unreviewableAmbiguous: 0,
    });
    expect(evolution.recommendation.structure).toBe('commit-evolution');
  });

  test('keeps duplicate patch IDs unmatched instead of forcing identity', async () => {
    const duplicate = (index: number, generation: 'new' | 'old') => ({
      ...commit(index, generation),
      message: 'Apply shared change',
      title: 'Apply shared change',
    });
    const duplicateFingerprint = (sha: string): CommitFingerprint => ({
      ...fingerprint(sha, 1, 'duplicate'),
      changedPaths: ['src/shared.ts'],
      changeTokenSketch: ['shared-token'],
      subjectKey: 'apply shared change',
    });
    const oldCommits = [duplicate(1, 'old'), duplicate(2, 'old')];
    const newCommits = [duplicate(1, 'new'), duplicate(2, 'new')];
    const fingerprints = fingerprintMap([
      ['old-1', duplicateFingerprint('old-1')],
      ['old-2', duplicateFingerprint('old-2')],
      ['new-1', duplicateFingerprint('new-1')],
      ['new-2', duplicateFingerprint('new-2')],
    ]);
    const evolution = await matchVersionCommitStacks({
      fingerprints,
      from: endpoint('1', 'old-2'),
      newCommits,
      oldCommits,
      to: endpoint('2', 'new-2'),
    });
    expect(evolution.summary.rewrittenSamePatch).toBe(0);
    expect(evolution.summary.ambiguous).toBe(2);
  });

  test('keeps a unique globally cheaper revised pair reviewable', async () => {
    const oldCommit = commit(1);
    const newCommit = commit(1, 'new');
    const evolution = await matchVersionCommitStacks({
      fingerprints: fingerprintMap([
        ['old-1', fingerprint('old-1', 1, 'old-patch', 'old')],
        [
          'new-1',
          {
            ...fingerprint('new-1', 1, 'new-patch', 'new'),
            changeTokenSketch: ['different-token'],
          },
        ],
      ]),
      from: endpoint('1', oldCommit.sha),
      newCommits: [newCommit],
      oldCommits: [oldCommit],
      to: endpoint('2', newCommit.sha),
    });

    expect(evolution.units).toMatchObject([
      {
        after: { sha: 'new-1' },
        before: { sha: 'old-1' },
        confidence: 'high',
        kind: 'likely-revised',
        reviewable: true,
      },
    ]);
    expect(evolution.summary).toMatchObject({
      ambiguous: 0,
      reviewable: 1,
      unreviewableAmbiguous: 0,
    });
  });

  test('keeps commits unclassified when patch evidence or one stack is unavailable', async () => {
    const oldCommits = [commit(1)];
    const newCommits = [commit(1, 'new')];
    const withoutPatches = await matchVersionCommitStacks({
      fingerprints: fingerprintMap(),
      from: endpoint('1', 'old-1'),
      newCommits,
      oldCommits,
      to: endpoint('2', 'new-1'),
    });
    expect(withoutPatches.summary).toMatchObject({ added: 0, ambiguous: 2, removed: 0 });
    expect(withoutPatches.units.every((unit) => !unit.reviewable)).toBe(true);
    expect(withoutPatches.summary).toMatchObject({ unreviewableAmbiguous: 2 });
    expect(withoutPatches.recommendation.structure).toBe('complete-comparison');

    const withOnlyLaterStack = await matchVersionCommitStacks({
      fingerprints: fingerprintMap([['new-1', fingerprint('new-1', 1, 'new-patch')]]),
      from: endpoint('1', 'old-1'),
      newCommits,
      oldCommits: [],
      stackCompleteness: { new: true, old: false },
      to: endpoint('2', 'new-1'),
    });
    expect(withOnlyLaterStack.summary).toMatchObject({ added: 0, ambiguous: 1, removed: 0 });
    expect(withOnlyLaterStack.units[0]?.matchReasons).toContain(
      'Insufficient evidence to classify this commit as new',
    );

    const unrelatedNewCommit = {
      ...newCommits[0]!,
      authorName: 'Lin',
      message: 'Replace an unrelated subsystem',
      title: 'Replace an unrelated subsystem',
    };
    const unrelatedNewFingerprint = {
      ...fingerprint('new-1', 1, 'unrelated-patch'),
      additions: 1000,
      changedPaths: ['unrelated/file.ts'],
      changeTokenSketch: ['unrelated-token'],
      subjectKey: 'replace an unrelated subsystem',
    };
    const unrelatedChanges = await matchVersionCommitStacks({
      fingerprints: fingerprintMap([
        ['old-1', fingerprint('old-1', 1, 'old-patch')],
        ['new-1', unrelatedNewFingerprint],
      ]),
      from: endpoint('1', 'old-1'),
      newCommits: [unrelatedNewCommit],
      oldCommits,
      to: endpoint('2', 'new-1'),
    });
    expect(unrelatedChanges.summary).toMatchObject({ added: 1, ambiguous: 0, removed: 1 });
  });

  test('classifies earlier MR commits rewritten into the later target base', async () => {
    const oldCommits = [commit(1), commit(2), commit(3)];
    const newCommits = [commit(3, 'new'), commit(4, 'new'), commit(5, 'new')];
    const baseCommits = [
      { ...commit(1, 'new'), sha: gitSha('base-1'), shortSha: 'b1' },
      { ...commit(2, 'new'), sha: gitSha('base-2'), shortSha: 'b2' },
    ];
    const fingerprints = fingerprintMap([
      ['old-1', fingerprint('old-1', 1, 'old-patch-1', 'old')],
      ['old-2', fingerprint('old-2', 2, 'old-patch-2', 'old')],
      ['old-3', fingerprint('old-3', 3, 'old-patch-3', 'old')],
      ['base-1', fingerprint('base-1', 1, 'base-patch-1', 'new')],
      ['base-2', fingerprint('base-2', 2, 'base-patch-2', 'new')],
      ['new-3', fingerprint('new-3', 3, 'new-patch-3', 'new')],
      ['new-4', fingerprint('new-4', 4, 'new-patch-4')],
      ['new-5', fingerprint('new-5', 5, 'new-patch-5')],
    ]);

    const evolution = await matchVersionCommitStacks({
      baseCommits,
      fingerprints,
      from: endpoint('1', 'old-3'),
      newCommits,
      oldCommits,
      to: endpoint('2', 'new-5'),
    });

    expect(evolution.summary).toMatchObject({
      absorbedIntoBase: 2,
      added: 2,
      ambiguous: 0,
      reviewable: 3,
      revised: 1,
    });
    expect(
      evolution.units
        .filter((unit) => unit.kind === 'absorbed-into-base')
        .map((unit) => [unit.before?.sha, unit.baseCommit?.sha]),
    ).toEqual([
      ['old-1', 'base-1'],
      ['old-2', 'base-2'],
    ]);
    expect(evolution.recommendation.structure).toBe('commit-evolution');
  });

  test('normalizes hunk offsets and stores only hashed changed-line tokens', async () => {
    const first = await createCommitFingerprint(
      { sha: gitSha('a'), title: 'Update app' },
      toCommitArtifact({
        commitSha: gitSha('a'),
        files: [changedFile(1)],
        parentSha: gitSha('parent-a'),
        provenance,
      }),
    );
    const second = await createCommitFingerprint(
      { sha: gitSha('b'), title: 'Update app' },
      toCommitArtifact({
        commitSha: gitSha('b'),
        files: [changedFile(100)],
        parentSha: gitSha('parent-b'),
        provenance,
      }),
    );
    expect(first.exactChangeId).toBe(second.exactChangeId);
    expect(JSON.stringify(first.changeTokenSketch)).not.toContain('value');
  });

  test('recommends structure from content confidence without an upper commit-count bound', () => {
    expect(
      recommendVersionWalkthroughStructure({ ambiguous: 0, pairingCoverage: 1, reviewable: 1 })
        .structure,
    ).toBe('complete-comparison');
    expect(
      recommendVersionWalkthroughStructure({ ambiguous: 0, pairingCoverage: 0.5, reviewable: 3 })
        .structure,
    ).toBe('complete-comparison');
    expect(
      recommendVersionWalkthroughStructure({ ambiguous: 0, pairingCoverage: 1, reviewable: 30 })
        .structure,
    ).toBe('commit-evolution');
  });
});

describe('rebase overlap attribution', () => {
  test('scores overlapping base commits as explanatory context', () => {
    const unitFingerprint = {
      additions: 12,
      changedPaths: ['src/auth.ts', 'src/session.ts'],
      changeTokenSketch: ['token', 'session', 'refresh'],
      commitSha: gitSha('unit'),
      coverage: 'complete',
      deletions: 4,
      exactChangeId: 'unit-patch',
      filesChanged: 2,
      subjectKey: 'preserve empty fields',
    } satisfies CommitFingerprint;
    const overlapping = scoreBaseCommitAsRebaseOverlap({
      baseFingerprint: {
        additions: 20,
        changedPaths: ['src/auth.ts', 'src/login.ts'],
        changeTokenSketch: ['token', 'login'],
        deletions: 3,
      },
      unitFingerprint,
    });
    const unrelated = scoreBaseCommitAsRebaseOverlap({
      baseFingerprint: {
        additions: 8,
        changedPaths: ['docs/readme.md'],
        changeTokenSketch: ['docs', 'readme'],
        deletions: 1,
      },
      unitFingerprint,
    });
    expect(overlapping.overlappingPaths).toEqual(['src/auth.ts']);
    expect(overlapping.score).toBeGreaterThan(unrelated.score);
    expect(overlapping.score).toBeGreaterThanOrEqual(0.22);
  });

  test('returns ranked overlapping base commits only', () => {
    const unitFingerprint = {
      additions: 10,
      changedPaths: ['src/auth.ts'],
      changeTokenSketch: ['token'],
      commitSha: gitSha('unit'),
      coverage: 'complete',
      deletions: 2,
      exactChangeId: 'unit-patch',
      filesChanged: 1,
      subjectKey: 'preserve empty fields',
    } satisfies CommitFingerprint;
    const baseFingerprints = fingerprintMap([
      [
        'base-strong',
        {
          additions: 15,
          changedPaths: ['src/auth.ts', 'src/token.ts'],
          changeTokenSketch: ['token', 'auth'],
          commitSha: gitSha('base-strong'),
          coverage: 'complete',
          deletions: 2,
          exactChangeId: 'base-strong',
          filesChanged: 2,
          subjectKey: 'harden auth tokens',
        },
      ],
      [
        'base-weak',
        {
          additions: 4,
          changedPaths: ['src/auth.ts'],
          changeTokenSketch: ['format'],
          commitSha: gitSha('base-weak'),
          coverage: 'complete',
          deletions: 1,
          exactChangeId: 'base-weak',
          filesChanged: 1,
          subjectKey: 'format auth file',
        },
      ],
      [
        'base-unrelated',
        {
          additions: 30,
          changedPaths: ['package.json'],
          changeTokenSketch: ['deps'],
          commitSha: gitSha('base-unrelated'),
          coverage: 'complete',
          deletions: 5,
          exactChangeId: 'base-unrelated',
          filesChanged: 1,
          subjectKey: 'bump deps',
        },
      ],
    ]);
    const overlaps = attributeRebaseOverlaps({
      baseCommits: [
        {
          authoredAt: '2026-07-01T00:00:00.000Z',
          authorName: 'Ada',
          sha: gitSha('base-strong'),
          shortSha: 'strong',
          subject: 'Harden auth tokens',
          webUrl: 'https://gitlab.example/base-strong',
        },
        {
          authoredAt: '2026-07-02T00:00:00.000Z',
          authorName: 'Grace',
          sha: gitSha('base-weak'),
          shortSha: 'weak',
          subject: 'Format auth file',
          webUrl: 'https://gitlab.example/base-weak',
        },
        {
          authoredAt: '2026-07-03T00:00:00.000Z',
          authorName: 'Lin',
          sha: gitSha('base-unrelated'),
          shortSha: 'unrel',
          subject: 'Bump deps',
          webUrl: 'https://gitlab.example/base-unrelated',
        },
      ],
      baseFingerprints,
      unitFingerprint,
    });
    expect(overlaps.map((overlap) => overlap.sha)).toEqual(['base-strong', 'base-weak']);
    expect(overlaps[0]?.overlappingPaths).toEqual(['src/auth.ts']);
  });
});
