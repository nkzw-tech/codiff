import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import { normalizeScenarioFixtureRevisions } from '../../evals/adapters/review-scenario.mjs';
import { initializeEvalRun, loadCaseAdapter, readCases } from '../../evals/lib.mjs';
import { createTemporaryDirectory } from './helpers/resources.ts';

test('semantic fixture normalization removes materialized commit identities', () => {
  const first = normalizeScenarioFixtureRevisions(
    { path: '/commits/aaaaaaaa11111111', sha: 'aaaaaaaa11111111' },
    { head: 'aaaaaaaa11111111' },
  );
  const second = normalizeScenarioFixtureRevisions(
    { path: '/commits/bbbbbbbb22222222', sha: 'bbbbbbbb22222222' },
    { head: 'bbbbbbbb22222222' },
  );
  expect(first).toEqual(second);
});

test('duplicate eval labels fail before metadata or attempt artifacts change', async () => {
  await using directory = await createTemporaryDirectory('codiff-eval-run-');
  const runDir = join(directory.path, 'runs', 'shared-label');
  const attemptDir = join(runDir, 'old-case', 'attempt-1');
  const existingMetadata = '{"label":"shared-label","suite":"single-commit"}\n';
  await mkdir(attemptDir, { recursive: true });
  await writeFile(join(runDir, 'run.json'), existingMetadata);
  await writeFile(join(attemptDir, 'meta.json'), '{"variant":"old-suite"}\n');
  const existingEntries = (await readdir(runDir, { recursive: true })).toSorted();

  await expect(
    initializeEvalRun({
      label: 'shared-label',
      metadata: { label: 'shared-label', suite: 'review-scenario' },
      runDir,
    }),
  ).rejects.toThrow(
    'Eval run label "shared-label" already exists. Choose a new label to keep suites and attempts isolated.',
  );

  expect(await readFile(join(runDir, 'run.json'), 'utf8')).toBe(existingMetadata);
  expect(await readFile(join(attemptDir, 'meta.json'), 'utf8')).toBe('{"variant":"old-suite"}\n');
  expect((await readdir(runDir, { recursive: true })).toSorted()).toEqual(existingEntries);
});

test('review-scenario prepare-only materializes model inputs without generated artifacts', async () => {
  await using directory = await createTemporaryDirectory('codiff-eval-prepare-');
  const attemptDir = join(directory.path, 'attempt-1');
  await mkdir(attemptDir, { recursive: true });
  const evalCase = (await readCases()).find((candidate) => candidate.kind === 'review-scenario');
  if (!evalCase) {
    throw new Error('Expected a review-scenario eval case.');
  }
  const adapter = await loadCaseAdapter(evalCase, 'runAttempt');
  const result = await adapter.runAttempt({
    attempt: 1,
    attemptDir,
    effort: 'high',
    evalCase,
    model: 'prepared-input-only',
    prepareOnly: true,
    root: process.cwd(),
  });
  const entries = (await readdir(attemptDir, { recursive: true })).toSorted();

  expect(result.meta).toMatchObject({
    actualCallTopology: { whole: 0 },
    exitStatus: 'prepared',
    modelCalls: 0,
  });
  expect(entries).toEqual([
    'inputs',
    'inputs/provider-transcripts.json',
    'inputs/review-state.json',
    'prompt.txt',
    'scenario.json',
  ]);
  expect(entries).not.toEqual(
    expect.arrayContaining([
      'contract.json',
      'review-target.json',
      'share-manifest.json',
      'walkthrough.json',
    ]),
  );
}, 15_000);
