import { expect, test, vi } from 'vite-plus/test';
import {
  generateReviewWalkthrough,
  type GenerateReviewWalkthroughInput,
  type ReviewWalkthroughRunModel,
} from '../lib/generate-review-walkthrough.ts';
import type {
  GenerationMetadata,
  GenerationProfile,
  GitSha,
  RepositoryState,
  ReviewCommitSummary,
  ReviewCommitUnit,
  TreeInspectionScope,
} from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';

const gitSha = (value: string) => value as GitSha;
const sha = {
  base: gitSha('a'.repeat(40)),
  commitA: gitSha('1'.repeat(40)),
  commitB: gitSha('2'.repeat(40)),
  head: gitSha('b'.repeat(40)),
};
const range = {
  base: { label: { kind: 'commit' as const, text: 'base' }, sha: sha.base },
  head: { label: { kind: 'commit' as const, text: 'head' }, sha: sha.head },
};
const baseState = {
  branch: 'feature',
  files: [createChangedFile('src/app.ts')],
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source: {
    headSha: sha.head,
    number: 1,
    provider: 'github',
    type: 'pull-request',
    url: 'https://example.com/example/review/1',
  },
} satisfies RepositoryState;
const stateFor = (path: string): RepositoryState => ({
  ...baseState,
  files: [createChangedFile(path)],
});
const draft = {
  chapters: [
    {
      blurb: 'Review the change.',
      icon: 'gear',
      id: 'main',
      stops: [
        {
          hunkIds: ['h1'],
          id: 'change',
          importance: 'critical',
          prose: 'Check this change.',
          title: 'Main change',
        },
      ],
      title: 'Core',
    },
  ],
  focus: 'Focus on the changed behavior.',
  kind: 'narrative',
  title: 'Walkthrough',
  version: 4,
};
const profileFor = (scope: TreeInspectionScope): GenerationProfile => ({
  agent: 'codex',
  authoringVersion: 'walkthrough-v5-narrative-1',
  modelCandidates: ['model-a'],
  settings: { scope: scope.kind },
});
const metadataFor = (profile: GenerationProfile): GenerationMetadata => ({
  agent: profile.agent,
  generatedAt: '2026-07-28T12:00:00.000Z',
  model: profile.modelCandidates[0] ?? 'missing-model',
  profile,
});
const successfulRunner =
  (): ReviewWalkthroughRunModel =>
  async ({ profile }) => ({
    generationMetadata: metadataFor(profile),
    response: draft,
  });
const commitSummary = (commitSha: GitSha, subject: string): ReviewCommitSummary => ({
  authoredAt: '2026-01-01T00:00:00.000Z',
  authorName: 'Ada',
  parentShas: [],
  sha: commitSha,
  shortSha: commitSha.slice(0, 8),
  subject,
});
const commitUnit = (commitSha: GitSha, order: number): ReviewCommitUnit => ({
  commit: commitSummary(commitSha, `Commit ${order + 1}`),
  kind: 'commit',
  order,
  reviewable: true,
});
const targetInput = (
  units: ReadonlyArray<ReviewCommitUnit>,
  overrides: Partial<GenerateReviewWalkthroughInput> = {},
): GenerateReviewWalkthroughInput => ({
  narrativeProfile: profileFor,
  runModel: successfulRunner(),
  selection: { range, relation: 'target-comparison', structure: 'commit-by-commit' },
  states: {
    byCommitSha: Object.fromEntries(
      units.map((unit) => [unit.commit.sha, stateFor(`src/${unit.order}.ts`)]),
    ),
    whole: baseState,
  },
  units,
  ...overrides,
});

test('publishes aggregate target-comparison narratives with one call', async () => {
  const runModel = vi.fn(successfulRunner());
  const result = await generateReviewWalkthrough({
    narrativeProfile: profileFor,
    runModel,
    selection: { range, relation: 'target-comparison', structure: 'net-change' },
    states: { whole: baseState },
  });

  expect(result.status).toBe('ready');
  expect(runModel).toHaveBeenCalledTimes(1);
  if (result.status === 'ready') {
    expect(result.plan).toEqual({ reviewRelation: 'target-comparison', structure: 'net-change' });
    expect(result.artifact.narrative).toMatchObject({
      generationMetadata: { model: 'model-a' },
      structure: 'net-change',
    });
  }
});

test('runs commit narratives with bounded concurrency and preserves canonical plan order', async () => {
  const units = ['3', '4', '5', '6'].map((value, index) =>
    commitUnit(gitSha(value.repeat(40)), index),
  );
  const pending: Array<{
    resolve: (value: Awaited<ReturnType<ReviewWalkthroughRunModel>>) => void;
    scope: TreeInspectionScope;
  }> = [];
  let active = 0;
  let maximumActive = 0;
  const runModel: ReviewWalkthroughRunModel = ({ semanticInput }) =>
    new Promise((resolve) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      pending.push({
        resolve: (value) => {
          active -= 1;
          resolve(value);
        },
        scope: semanticInput.promptOptions.scope!,
      });
    });
  const generation = generateReviewWalkthrough(targetInput(units, { runModel }));
  await vi.waitFor(() => expect(pending).toHaveLength(3));
  const complete = (index: number) => {
    const profile = profileFor(pending[index]!.scope);
    pending[index]!.resolve({ generationMetadata: metadataFor(profile), response: draft });
  };
  complete(2);
  await vi.waitFor(() => expect(pending).toHaveLength(4));
  complete(3);
  complete(1);
  complete(0);
  const result = await generation;

  expect(maximumActive).toBe(3);
  expect(result.status).toBe('ready');
  if (result.status === 'ready' && result.artifact.narrative.structure === 'commit-by-commit') {
    expect(result.artifact.narrative.units.map((unit) => unit.sha)).toEqual(
      units.map((unit) => unit.commit.sha),
    );
    expect(result.artifact.narrative.units.map((unit) => unit.commit)).toEqual(
      units.map((unit) => unit.commit),
    );
  }
});

test('fails atomically for a missing commit diff while retaining successful components', async () => {
  const units = [commitUnit(sha.commitA, 0), commitUnit(sha.commitB, 1)];
  const result = await generateReviewWalkthrough(
    targetInput(units, {
      states: { byCommitSha: { [sha.commitA]: stateFor('src/a.ts') }, whole: baseState },
    }),
  );

  expect(result.status).toBe('failed');
  expect('artifact' in result).toBe(false);
  if (result.status === 'failed') {
    expect(result.failures).toContainEqual({
      error: 'The planned narrative component has no materialized diff.',
      identity: { kind: 'commit', sha: sha.commitB },
      label: `${sha.commitB.slice(0, 8)} Commit 2`,
    });
    expect(result.reusableComponents).toHaveLength(1);
  }
});

test('retries only failed commit narratives', async () => {
  const units = [commitUnit(sha.commitA, 0), commitUnit(sha.commitB, 1)];
  const first = await generateReviewWalkthrough(
    targetInput(units, {
      runModel: async ({ profile, semanticInput }) => {
        if (semanticInput.promptOptions.scope?.kind === 'commit') {
          if (semanticInput.promptOptions.scope.sha === sha.commitB) {
            throw new Error('second failed');
          }
        }
        return { generationMetadata: metadataFor(profile), response: draft };
      },
    }),
  );
  expect(first.status).toBe('failed');
  if (first.status !== 'failed') {
    return;
  }

  const retry = vi.fn(successfulRunner());
  const second = await generateReviewWalkthrough(
    targetInput(units, { reusableComponents: first.reusableComponents, runModel: retry }),
  );

  expect(second.status).toBe('ready');
  expect(retry).toHaveBeenCalledTimes(1);
  expect(retry.mock.calls[0]?.[0].semanticInput.promptOptions.scope).toEqual({
    kind: 'commit',
    sha: sha.commitB,
  });
});

test('publishes a regenerated component after its profile invalidates cached output', async () => {
  const unit = commitUnit(sha.commitA, 0);
  const seeded = await generateReviewWalkthrough(targetInput([unit]));
  if (seeded.status !== 'ready') {
    throw new Error('Expected the cache seed to succeed.');
  }
  const runModel = vi.fn(successfulRunner());
  const result = await generateReviewWalkthrough(
    targetInput([unit], {
      narrativeProfile: (scope) => ({
        ...profileFor(scope),
        modelCandidates: ['model-b'],
      }),
      reusableComponents: seeded.reusableComponents,
      runModel,
    }),
  );

  expect(runModel).toHaveBeenCalledTimes(1);
  expect(result.status).toBe('ready');
  if (result.status === 'ready' && result.artifact.narrative.structure === 'commit-by-commit') {
    expect(result.artifact.narrative.units[0]?.generationMetadata.model).toBe('model-b');
  }
});

test('rejects empty aggregate and commit diffs without publishing an artifact', async () => {
  const emptyState = stateFor('src/empty.ts');
  emptyState.files = [createChangedFile('src/empty.ts', { patch: '' })];
  const aggregate = await generateReviewWalkthrough({
    narrativeProfile: profileFor,
    runModel: successfulRunner(),
    selection: { range, relation: 'target-comparison', structure: 'net-change' },
    states: { whole: emptyState },
  });
  const unit = commitUnit(sha.commitA, 0);
  const commit = await generateReviewWalkthrough(
    targetInput([unit], {
      states: { byCommitSha: { [sha.commitA]: emptyState }, whole: baseState },
    }),
  );

  expect(aggregate.status).toBe('failed');
  expect(commit.status).toBe('failed');
  expect('artifact' in aggregate).toBe(false);
  expect('artifact' in commit).toBe(false);
});
