import { describe, expect, test } from 'vite-plus/test';
import {
  attributeRebaseOverlaps,
  createCommitFingerprint,
  createEvolutionUnitId,
  matchVersionCommitStacks,
  projectCommitEvolution,
  projectEvolutionUnit,
  recommendVersionWalkthroughStructure,
  scoreBaseCommitAsRebaseOverlap,
  toCommitArtifact,
  versionCommitEvolutionAlgorithmVersion,
  versionCommitFingerprintAlgorithmVersion,
  type CommitFingerprint,
} from '../lib/commit-stack-evolution.ts';
import type { ReviewArtifactProvenance } from '../lib/review-artifacts.ts';
import type { ChangedFile, GitSha, ReviewVersionId } from '../types.ts';

const gitSha = (value: string) => value as GitSha;
const reviewVersionId = (value: string) => value as ReviewVersionId;
const provenance: ReviewArtifactProvenance = {
  kind: 'native-git',
  project: { host: 'local', project: '/repo', provider: 'git' },
};

const endpoint = (id: string, headSha: string) => ({
  baseSha: gitSha(`base-${id}`),
  createdAt: '2026-07-15T00:00:00.000Z',
  headSha: gitSha(headSha),
  label: `v${id}`,
  startSha: gitSha(`base-${id}`),
  versionId: reviewVersionId(id),
});

test('keeps evolution unit identity stable when classification changes', async () => {
  const range = { from: endpoint('1', 'old-head'), to: endpoint('2', 'new-head') };
  const id = await createEvolutionUnitId(range, {
    afterSha: gitSha('new-commit'),
    beforeSha: gitSha('old-commit'),
  });

  expect(
    await createEvolutionUnitId(range, {
      afterSha: gitSha('new-commit'),
      beforeSha: gitSha('old-commit'),
    }),
  ).toBe(id);
  expect(
    await createEvolutionUnitId(range, {
      baseCommitSha: gitSha('new-commit'),
      beforeSha: gitSha('old-commit'),
    }),
  ).not.toBe(id);
});

const commit = (index: number, generation: 'new' | 'old' = 'old') => ({
  authoredDate: `2026-07-15T00:${String(index).padStart(2, '0')}:00.000Z`,
  authorName: 'Ada',
  message: `Change logical unit ${index}`,
  parentShas: index === 1 ? [gitSha(`${generation}-base`)] : [gitSha(`${generation}-${index - 1}`)],
  sha: gitSha(`${generation}-${index}`),
  shortSha: `${generation[0]}${index}`,
  title: `Change logical unit ${index}`,
  webUrl: `https://gitlab.example/commit/${generation}-${index}`,
});

const fingerprint = (
  sha: string,
  index: number,
  exactChangeId: string,
  revision = 'same',
): CommitFingerprint => ({
  additions: 10 + index,
  changedPaths: [`src/unit-${index}.ts`],
  changeTokenSketch: [`token-${index}`, `revision-${revision}`],
  commitSha: gitSha(sha),
  coverage: 'complete',
  deletions: index,
  exactChangeId,
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
  test('stops global assignment before a superseded comparison can produce units', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      matchVersionCommitStacks({
        fingerprints: new Map([
          ['old-1', fingerprint('old-1', 1, 'old-patch')],
          ['new-1', fingerprint('new-1', 1, 'new-patch')],
        ]),
        from: endpoint('1', 'old-1'),
        newCommits: [commit(1, 'new')],
        oldCommits: [commit(1)],
        signal: controller.signal,
        to: endpoint('2', 'new-1'),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('returns only revised logical commits 2, 4, and 6 as reviewable after a rebase', async () => {
    const oldCommits = Array.from({ length: 10 }, (_, index) => commit(index + 1));
    const newCommits = Array.from({ length: 10 }, (_, index) => commit(index + 1, 'new'));
    const revised = new Set([2, 4, 6]);
    const fingerprints = new Map<string, CommitFingerprint>();
    for (let index = 1; index <= 10; index += 1) {
      fingerprints.set(
        `old-${index}`,
        fingerprint(`old-${index}`, index, `patch-${index}`, revised.has(index) ? 'old' : 'same'),
      );
      fingerprints.set(
        `new-${index}`,
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
    expect(evolution.units.map((unit) => unit.order)).toEqual(
      evolution.units.map((_, index) => index),
    );
    expect(evolution.summary).toMatchObject({
      completeCoverage: true,
      reviewable: 3,
      revised: 3,
      rewrittenSamePatch: 7,
      unreviewableAmbiguous: 0,
    });
    expect(evolution.recommendation.structure).toBe('commit-evolution');
  });

  test('marks duplicate exact patches ambiguous instead of forcing identity', async () => {
    const duplicate = (index: number, generation: 'new' | 'old') => ({
      ...commit(index, generation),
      message: 'Apply shared change',
      title: 'Apply shared change',
    });
    const oldCommits = [duplicate(1, 'old'), duplicate(2, 'old')];
    const newCommits = [duplicate(1, 'new'), duplicate(2, 'new')];
    const duplicateFingerprint = (sha: string): CommitFingerprint => ({
      ...fingerprint(sha, 1, 'duplicate'),
      changedPaths: ['src/shared.ts'],
      changeTokenSketch: ['shared-token'],
      subjectKey: 'apply shared change',
    });
    const fingerprints = new Map<string, CommitFingerprint>([
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

  test('pairs reordered crossing commits by global patch cost rather than stack position', async () => {
    const named = (index: number, generation: 'new' | 'old', name: string) => ({
      ...commit(index, generation),
      message: `Change ${name}`,
      title: `Change ${name}`,
    });
    const oldCommits = [named(1, 'old', 'alpha'), named(2, 'old', 'beta')];
    const newCommits = [named(1, 'new', 'beta'), named(2, 'new', 'alpha')];
    const exact = (sha: string, name: string): CommitFingerprint => ({
      ...fingerprint(sha, 1, `patch-${name}`),
      changedPaths: [`src/${name}.ts`],
      changeTokenSketch: [name],
      patchMaterial: `diff --git a/src/${name}.ts b/src/${name}.ts\n+${name}\n`,
      subjectKey: `change ${name}`,
    });
    const evolution = await matchVersionCommitStacks({
      fingerprints: new Map([
        ['old-1', exact('old-1', 'alpha')],
        ['old-2', exact('old-2', 'beta')],
        ['new-1', exact('new-1', 'beta')],
        ['new-2', exact('new-2', 'alpha')],
      ]),
      from: endpoint('1', 'old-2'),
      newCommits,
      oldCommits,
      to: endpoint('2', 'new-2'),
    });

    expect(evolution.units.map((unit) => [unit.before?.sha, unit.after?.sha, unit.kind])).toEqual([
      ['old-2', 'new-1', 'rewritten-same-patch'],
      ['old-1', 'new-2', 'rewritten-same-patch'],
    ]);
  });

  test('avoids the greedy-steal counterexample with one global assignment', async () => {
    const named = (index: number, generation: 'new' | 'old', name: string) => ({
      ...commit(index, generation),
      message: `Change ${name}`,
      title: `Change ${name}`,
    });
    const oldCommits = [named(1, 'old', 'first'), named(2, 'old', 'second')];
    const newCommits = [named(1, 'new', 'second'), named(2, 'new', 'first')];
    const material = (sha: string, patch: string, name: string): CommitFingerprint => ({
      ...fingerprint(sha, 1, `patch-${name}`),
      changedPaths: ['src/shared.ts'],
      changeTokenSketch: [name],
      patchMaterial: `diff --git a/src/shared.ts b/src/shared.ts\n${patch}`,
      subjectKey: `change ${name}`,
    });
    const evolution = await matchVersionCommitStacks({
      fingerprints: new Map([
        ['old-1', material('old-1', '+alpha\n+first\n', 'first')],
        ['old-2', material('old-2', '+second\n', 'second')],
        ['new-1', material('new-1', '+second\n', 'second')],
        ['new-2', material('new-2', '+alpha\n+first revised\n', 'first')],
      ]),
      from: endpoint('1', 'old-2'),
      newCommits,
      oldCommits,
      to: endpoint('2', 'new-2'),
    });

    expect(evolution.units.map((unit) => [unit.before?.sha, unit.after?.sha])).toEqual([
      ['old-2', 'new-1'],
      ['old-1', 'new-2'],
    ]);
  });

  test('keeps a near-optimal assignment explicitly ambiguous', async () => {
    const repeated = (index: number, generation: 'new' | 'old') => ({
      ...commit(index, generation),
      message: 'Change shared implementation',
      title: 'Change shared implementation',
    });
    const oldCommits = [repeated(1, 'old'), repeated(2, 'old')];
    const newCommits = [repeated(1, 'new'), repeated(2, 'new')];
    const nearlySame = (sha: string, line: string): CommitFingerprint => ({
      ...fingerprint(sha, 1, `patch-${sha}`),
      changedPaths: ['src/shared.ts'],
      changeTokenSketch: ['shared'],
      patchMaterial: `diff --git a/src/shared.ts b/src/shared.ts\n+${line}\n`,
      subjectKey: 'change logical unit',
    });
    const evolution = await matchVersionCommitStacks({
      fingerprints: new Map([
        ['old-1', nearlySame('old-1', 'shared one')],
        ['old-2', nearlySame('old-2', 'shared two')],
        ['new-1', nearlySame('new-1', 'shared three')],
        ['new-2', nearlySame('new-2', 'shared four')],
      ]),
      from: endpoint('1', 'old-2'),
      newCommits,
      oldCommits,
      to: endpoint('2', 'new-2'),
    });

    expect(evolution.summary.ambiguous).toBe(2);
    expect(evolution.units.every((unit) => unit.kind === 'ambiguous')).toBe(true);
  });

  test('keeps a 40-by-40 global assignment and ambiguity audit below the matcher budget', async () => {
    const oldCommits = Array.from({ length: 40 }, (_, index) => commit(index + 1));
    const newCommits = Array.from({ length: 40 }, (_, index) => commit(index + 1, 'new'));
    const complete = (sha: string, index: number): CommitFingerprint => ({
      ...fingerprint(sha, index, `patch-${index}`),
      patchMaterial: `diff --git a/src/unit-${index}.ts b/src/unit-${index}.ts\n+unit ${index}\n`,
    });
    const fingerprints = new Map<string, CommitFingerprint>();
    for (let index = 1; index <= 40; index += 1) {
      fingerprints.set(`old-${index}`, complete(`old-${index}`, index));
      fingerprints.set(`new-${index}`, complete(`new-${index}`, index));
    }

    const startedAt = performance.now();
    const evolution = await matchVersionCommitStacks({
      fingerprints,
      from: endpoint('1', 'old-40'),
      newCommits,
      oldCommits,
      to: endpoint('2', 'new-40'),
    });
    const elapsedMs = performance.now() - startedAt;

    expect(evolution.summary.rewrittenSamePatch).toBe(40);
    expect(evolution.summary.ambiguous).toBe(0);
    expect(elapsedMs).toBeLessThan(100);
  });

  test('rejects reversed stacks before positional matching', async () => {
    const oldCommits = [commit(1), commit(2)];
    const newCommits = [commit(1, 'new'), commit(2, 'new')];

    await expect(
      matchVersionCommitStacks({
        fingerprints: new Map(),
        from: endpoint('1', 'old-2'),
        newCommits,
        oldCommits: [oldCommits[1]!, oldCommits[0]!],
        to: endpoint('2', 'new-2'),
      }),
    ).rejects.toThrow('not parent-before-child');
  });

  test('keeps a unique globally cheaper revised pair reviewable', async () => {
    const oldCommit = commit(1);
    const newCommit = commit(1, 'new');
    const evolution = await matchVersionCommitStacks({
      fingerprints: new Map([
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
      fingerprints: new Map(),
      from: endpoint('1', 'old-1'),
      newCommits,
      oldCommits,
      to: endpoint('2', 'new-1'),
    });
    expect(withoutPatches.summary).toMatchObject({
      added: 0,
      ambiguous: 2,
      completeCoverage: false,
      removed: 0,
    });
    expect(withoutPatches.units.every((unit) => !unit.reviewable)).toBe(true);
    expect(withoutPatches.summary).toMatchObject({ unreviewableAmbiguous: 2 });
    expect(withoutPatches.recommendation.structure).toBe('complete-comparison');

    const withOnlyLaterStack = await matchVersionCommitStacks({
      fingerprints: new Map([['new-1', fingerprint('new-1', 1, 'new-patch')]]),
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
      fingerprints: new Map([
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
    const fingerprints = new Map<string, CommitFingerprint>([
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

  test('does not invent exact identities for opaque or truncated provider evidence', async () => {
    for (const coverage of ['opaque', 'truncated'] as const) {
      const result = await createCommitFingerprint(
        { sha: gitSha(coverage), title: 'Update binary' },
        {
          commitSha: gitSha(coverage),
          coverage,
          files: [{ coverage, path: 'asset.bin', status: 'modified' }],
          parentSha: gitSha('parent'),
          provenance,
        },
      );
      expect(result).toMatchObject({ coverage });
      expect(result.exactChangeId).toBeUndefined();
    }
  });

  test('uses object identity and modes as exact evidence for binary and mode changes', async () => {
    const binary = await createCommitFingerprint(
      { sha: gitSha('binary'), title: 'Update binary' },
      {
        commitSha: gitSha('binary'),
        coverage: 'complete',
        files: [
          {
            coverage: 'complete',
            newMode: '100755',
            newObjectId: 'b'.repeat(40),
            oldMode: '100644',
            oldObjectId: 'a'.repeat(40),
            path: 'tool.bin',
            status: 'modified',
          },
        ],
        parentSha: gitSha('parent'),
        provenance,
      },
    );
    expect(binary.exactChangeId).toBeTruthy();
    expect(binary).toMatchObject({ additions: 0, deletions: 0, filesChanged: 1 });
  });

  test('keeps incomplete plausible pairs ambiguous and never calls them added or removed', async () => {
    const old = { ...fingerprint('old-1', 1, 'ignored'), coverage: 'truncated' as const };
    delete old.exactChangeId;
    const next = { ...fingerprint('new-1', 1, 'ignored'), coverage: 'opaque' as const };
    delete next.exactChangeId;
    const evolution = await matchVersionCommitStacks({
      fingerprints: new Map<GitSha, CommitFingerprint>([
        [gitSha('old-1'), old],
        [gitSha('new-1'), next],
      ]),
      from: endpoint('1', 'old-1'),
      newCommits: [commit(1, 'new')],
      oldCommits: [commit(1)],
      to: endpoint('2', 'new-1'),
    });
    expect(evolution.summary).toMatchObject({ added: 0, ambiguous: 1, removed: 0 });
    expect(evolution.units[0]).toMatchObject({ kind: 'ambiguous', reviewable: true });
  });

  test('reports global assignment diagnostics without changing the evolution result', async () => {
    const diagnostics: Array<unknown> = [];
    let elapsed = 0;
    const evolution = await matchVersionCommitStacks({
      fingerprints: new Map<GitSha, CommitFingerprint>([
        [gitSha('old-1'), fingerprint('old-1', 1, 'patch-1')],
        [gitSha('new-1'), fingerprint('new-1', 1, 'patch-1')],
      ]),
      from: endpoint('1', 'old-1'),
      newCommits: [commit(1, 'new')],
      now: () => {
        elapsed += 5;
        return elapsed;
      },
      oldCommits: [commit(1)],
      onDiagnostics: (value) => diagnostics.push(value),
      to: endpoint('2', 'new-1'),
    });

    expect(evolution.summary).toMatchObject({ ambiguous: 0, rewrittenSamePatch: 1 });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        ambiguousUnitCount: 0,
        elapsedMs: expect.any(Number),
        primaryAssignment: expect.objectContaining({
          ambiguityCount: 0,
          assignmentCost: 0,
          candidatePairCount: 1,
          matrixColumns: 2,
          matrixRows: 2,
        }),
        targetBaseAssignment: null,
      }),
    ]);
    expect((diagnostics[0] as { elapsedMs: number }).elapsedMs).toBeGreaterThan(0);
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

test('projects internal matching kinds onto typed Core Evolution Units', () => {
  const unitId = 'unit-1' as import('../types.ts').EvolutionUnitId;
  const projected = projectEvolutionUnit({
    after: {
      authoredAt: '2026-07-15T00:00:00.000Z',
      authorName: 'Ada',
      parentShas: [gitSha('parent')],
      sha: gitSha('after'),
      shortSha: 'after',
      subject: 'Add projection',
    },
    confidence: 'high',
    kind: 'added',
    order: 0,
    reviewable: true,
    unitId,
  });

  expect(projected).toMatchObject({
    after: { parentShas: ['parent'], sha: 'after' },
    kind: 'introduced',
    unitId,
  });
  expect(
    projectCommitEvolution({
      range: { from: endpoint('1', 'old'), to: endpoint('2', 'new') },
      recommendation: { reason: 'Complete coverage.', structure: 'commit-evolution' },
      summary: {
        absorbedIntoBase: 0,
        added: 1,
        ambiguous: 0,
        completeCoverage: true,
        pairingCoverage: 1,
        removed: 0,
        retained: 0,
        reviewable: 1,
        revised: 0,
        rewrittenSamePatch: 0,
        unreviewableAmbiguous: 0,
      },
      units: [
        {
          after: {
            authoredAt: '2026-07-15T00:00:00.000Z',
            authorName: 'Ada',
            parentShas: [],
            sha: gitSha('after'),
            shortSha: 'after',
            subject: 'Add projection',
            webUrl: '',
          },
          confidence: 'high',
          kind: 'added',
          order: 0,
          reviewable: true,
          unitId,
        },
      ],
    }),
  ).toMatchObject({
    recommendation: { suggestedStructure: 'commit-evolution' },
    units: [{ kind: 'introduced', unitId }],
  });
});

test('versions deterministic analysis independently from generated output', () => {
  expect(versionCommitFingerprintAlgorithmVersion).toBe('commit-fingerprint-v4');
  expect(versionCommitEvolutionAlgorithmVersion).toBe('range-diff-lap-jv-v2');
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
    const baseFingerprints = new Map<string, CommitFingerprint>([
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
