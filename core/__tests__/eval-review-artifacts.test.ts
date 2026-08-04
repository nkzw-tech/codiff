import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import { loadCaseAdapter, readCases } from '../../evals/lib.mjs';
import {
  assertEvalAttemptMeta,
  assertEvalContract,
  assertEvalShareManifest,
  assertScenarioReviewTarget,
  buildEvalShareManifest,
  buildScenarioReviewTarget,
  computeFixtureDigest,
  remapWalkthroughHunks,
  resolveScenarioReviewRange,
} from '../../evals/review-artifacts.mjs';
import { createChangedFile } from './helpers/fixtures.ts';

const require = createRequire(import.meta.url);
const { getSectionWalkthroughHunks } = require('../lib/narrative-walkthrough-diff.cjs') as {
  getSectionWalkthroughHunks: (
    file: ReturnType<typeof createChangedFile>,
    section: ReturnType<typeof createChangedFile>['sections'][number],
  ) => Array<{ id: string }>;
};

test('builds a portable format-neutral share manifest', () => {
  const file = createChangedFile('src/app.ts');
  const hunkId = getSectionWalkthroughHunks(file, file.sections[0])[0]!.id;
  const manifest = buildEvalShareManifest({
    artifactId: 'baseline/current-review',
    reviewScope: { kind: 'merge-request', structure: 'net-change' },
    state: {
      branch: 'feature/test-scenario',
      files: [file],
      generatedAt: Date.parse('2026-07-24T00:00:00.000Z'),
      launchPath: '/private/scenario',
      root: '/private/scenario',
      source: { type: 'working-tree' },
    },
    walkthrough: {
      chapters: [
        {
          blurb: 'Review the change.',
          id: 'chapter',
          stops: [{ hunkIds: [hunkId], id: 'stop', prose: 'Review it.', title: 'Change' }],
          title: 'Scenario',
        },
      ],
      repo: { root: '/private/scenario' },
      title: 'Scenario walkthrough',
      version: 4,
    },
  });

  expect(manifest).toMatchObject({
    kind: 'codiff-walkthrough-share',
    repository: { root: 'eval:baseline/current-review' },
    reviewScope: { kind: 'merge-request', structure: 'net-change' },
    walkthrough: { repo: { root: 'eval:baseline/current-review' } },
  });
  expect(JSON.stringify(manifest)).not.toContain('/private/scenario');
});

test('remaps hunk references recursively without knowing the walkthrough format', () => {
  const fromFile = createChangedFile('src/app.ts');
  const toFile = {
    ...fromFile,
    fingerprint: 'rematerialized',
    sections: [{ ...fromFile.sections[0], id: 'rematerialized-section' }],
  };
  const fromId = getSectionWalkthroughHunks(fromFile, fromFile.sections[0])[0]!.id;
  const toId = getSectionWalkthroughHunks(toFile, toFile.sections[0])[0]!.id;
  const walkthrough = {
    capturedContext: { files: [fromFile] },
    customEnvelope: {
      narratives: [
        {
          chapters: [
            {
              stops: [{ hunkIds: [fromId], notes: [{ body: 'Note', hunkId: fromId }] }],
            },
          ],
        },
      ],
    },
  };

  expect(fromId).not.toBe(toId);
  expect(remapWalkthroughHunks({ fromFiles: [fromFile], toFiles: [toFile], walkthrough })).toEqual({
    capturedContext: { files: [toFile] },
    customEnvelope: {
      narratives: [
        {
          chapters: [
            {
              stops: [{ hunkIds: [toId], notes: [{ body: 'Note', hunkId: toId }] }],
            },
          ],
        },
      ],
    },
  });
});

test('does not remap changed-content or unmatched hunk references', () => {
  const fromFile = createChangedFile('src/app.ts', {
    patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
  });
  const toFile = createChangedFile('src/app.ts', {
    patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+different\n',
  });
  const fromId = getSectionWalkthroughHunks(fromFile, fromFile.sections[0])[0]!.id;
  const remapped = remapWalkthroughHunks({
    fromFiles: [fromFile],
    toFiles: [toFile],
    walkthrough: {
      capturedContext: { files: [fromFile] },
      chapters: [
        {
          stops: [
            {
              hunkIds: [fromId, 'unmatched-old-hunk'],
              notes: [
                { body: 'Stale mapped note.', hunkId: fromId },
                { body: 'Stale unmatched note.', hunkId: 'unmatched-old-hunk' },
              ],
            },
          ],
        },
      ],
    },
  });

  expect(remapped.capturedContext.files).toEqual([toFile]);
  expect(remapped.chapters[0].stops[0].hunkIds).toEqual([]);
  expect(remapped.chapters[0].stops[0].notes).toEqual([]);
  expect(JSON.stringify(remapped)).not.toContain(fromId);
  expect(JSON.stringify(remapped)).not.toContain('unmatched-old-hunk');
});

test('scrubs Windows drive and UNC repository descendants from share manifests', () => {
  const driveRoot = String.raw`C:\Users\private\repo`;
  const uncRoot = String.raw`\\server\share\repo`;
  const file = createChangedFile('src/app.ts');
  const manifest = buildEvalShareManifest({
    artifactId: 'windows/context',
    reviewScope: null,
    state: {
      branch: 'feature',
      files: [file],
      generatedAt: 0,
      launchPath: uncRoot,
      root: driveRoot,
      source: {
        base: `${driveRoot}\\base`,
        head: `${uncRoot}\\head`,
        symmetric: false,
        type: 'range',
      },
    },
    walkthrough: {
      chapters: [],
      context: {
        drive: `${driveRoot}\\src\\app.ts`,
        prose: `Review changes under ${driveRoot}\\src and ${uncRoot}\\docs.`,
        unc: `${uncRoot}\\src\\app.ts`,
      },
      repo: { root: driveRoot },
      title: 'Windows paths',
      version: 4,
    },
  });
  const serialized = JSON.stringify(manifest);

  expect(serialized).not.toContain(driveRoot);
  expect(serialized).not.toContain(uncRoot);
  expect(manifest.walkthrough.context).toEqual({
    drive: 'eval:windows/context/src/app.ts',
    prose: 'Review changes under eval:windows/context\\src and eval:windows/context\\docs.',
    unc: 'eval:windows/context/src/app.ts',
  });
});

test('records and resolves reproducible scenario range targets', () => {
  const revisions = { base: 'a'.repeat(40), head: 'b'.repeat(40) };
  const target = buildScenarioReviewTarget({
    materialized: { revisions },
    scenarioId: 'current-review',
    source: {
      baseRevision: 'base',
      headRevision: 'head',
      symmetric: false,
      type: 'range',
    },
  });

  expect(target).toMatchObject({
    materialization: { scenarioId: 'current-review' },
    source: { baseRevision: 'base', headRevision: 'head' },
    version: 1,
  });
  expect(
    resolveScenarioReviewRange({ materialized: { revisions }, source: target.source }),
  ).toEqual({
    base: revisions.base,
    head: revisions.head,
    symmetric: false,
  });
});

test('validates common attempt and adapter contracts', async () => {
  expect(() => assertEvalShareManifest({ version: 1 })).toThrow(
    'The share manifest must be a version 1 codiff walkthrough share.',
  );
  expect(() => assertScenarioReviewTarget({ version: 1 })).toThrow(
    'review target materialization must be an object.',
  );
  expect(() =>
    assertEvalAttemptMeta({ exitStatus: 'ready', generationMs: 1, modelCalls: 1 }),
  ).toThrow('eval attempt variant must be a non-empty string.');
  expect(() =>
    assertEvalContract({ failures: [], metrics: { coverage: Number.NaN }, pass: true }),
  ).toThrow('Eval contract metrics must contain only finite numbers.');
  const reorderedFixture = Object.fromEntries([
    ['b', 2],
    ['a', 1],
  ]);
  expect(computeFixtureDigest({ a: 1, b: 2 })).toBe(computeFixtureDigest(reorderedFixture));
  expect(
    assertEvalAttemptMeta({
      exitStatus: 'ready',
      fixtureDigest: computeFixtureDigest({ fixture: 'current-review' }),
      generationMs: 1,
      modelCalls: 1,
      promptChars: 100,
      stateMs: 2,
      variant: 'review-scenario',
    }),
  ).toMatchObject({ exitStatus: 'ready', variant: 'review-scenario' });

  const cases = await readCases();
  expect(new Set(cases.map((evalCase) => evalCase.kind))).toEqual(
    new Set(['review-scenario', 'single-commit']),
  );
  for (const evalCase of cases) {
    const adapter = await loadCaseAdapter(evalCase, 'buildJudgePrompt');
    expect(adapter.kind).toBe(evalCase.kind);
    await expect(loadCaseAdapter(evalCase, 'runAttempt')).resolves.toBe(adapter);
  }
});
