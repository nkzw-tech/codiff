import { expect, test, vi } from 'vite-plus/test';
import {
  runWalkthroughGenerationTasks,
  type WalkthroughGenerationTask,
} from '../lib/walkthrough-generation-tasks.ts';
import type { GenerationMetadata, GenerationProfile } from '../types.ts';

const profile: GenerationProfile = {
  agent: 'codex',
  authoringVersion: 'test-v1',
  modelCandidates: ['primary', 'fallback'],
};

const metadata = (model = 'primary'): GenerationMetadata => ({
  agent: profile.agent,
  generatedAt: '2026-08-04T00:00:00.000Z',
  model,
  profile,
});

const task = (
  id: string,
  run: WalkthroughGenerationTask<string, { prompt: string }, string>['run'],
): WalkthroughGenerationTask<string, { prompt: string }, string> => ({
  id,
  identity: id,
  label: `${id} task`,
  profile,
  run,
  semanticInput: { prompt: `Explain ${id}.` },
});

test('retains successes so retry invokes only failed tasks', async () => {
  const firstRun = vi.fn(async ({ semanticInput }: { semanticInput: { prompt: string } }) => {
    if (semanticInput.prompt.includes('second')) {
      throw new Error('model unavailable');
    }
    return { generationMetadata: metadata(), output: semanticInput.prompt };
  });
  const tasks = [task('first', firstRun), task('second', firstRun)];

  const first = await runWalkthroughGenerationTasks({ tasks });

  expect(first.status).toBe('failed');
  expect(first.components).toHaveLength(1);
  if (first.status !== 'failed') {
    return;
  }
  expect(first.failures).toEqual([
    { error: 'model unavailable', identity: 'second', label: 'second task' },
  ]);

  const retry = vi.fn(async ({ semanticInput }: { semanticInput: { prompt: string } }) => ({
    generationMetadata: metadata(),
    output: semanticInput.prompt,
  }));
  const second = await runWalkthroughGenerationTasks({
    reusableComponents: first.components,
    tasks: [task('first', retry), task('second', retry)],
  });

  expect(second.status).toBe('ready');
  expect(retry).toHaveBeenCalledTimes(1);
  expect(retry.mock.calls[0]?.[0].semanticInput).toEqual({ prompt: 'Explain second.' });
});

test('bounds concurrent model work while preserving task order', async () => {
  let active = 0;
  let maximumActive = 0;
  const pending: Array<() => void> = [];
  const run = vi.fn(
    ({ semanticInput }: { semanticInput: { prompt: string } }) =>
      new Promise<{ generationMetadata: GenerationMetadata; output: string }>((resolve) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        pending.push(() => {
          active -= 1;
          resolve({ generationMetadata: metadata(), output: semanticInput.prompt });
        });
      }),
  );
  const generation = runWalkthroughGenerationTasks({
    concurrency: 3,
    tasks: ['first', 'second', 'third', 'fourth'].map((id) => task(id, run)),
  });

  await vi.waitFor(() => expect(pending).toHaveLength(3));
  pending[0]!();
  await vi.waitFor(() => expect(pending).toHaveLength(4));
  pending.slice(1).forEach((complete) => complete());
  const result = await generation;

  expect(maximumActive).toBe(3);
  expect(result.status).toBe('ready');
  expect(result.components.map((component) => component.identity)).toEqual([
    'first',
    'second',
    'third',
    'fourth',
  ]);
});

test('cancellation prevents queued tasks from starting and suppresses readiness', async () => {
  const controller = new AbortController();
  const started: Array<string> = [];
  const run = vi.fn(
    ({ semanticInput }: { semanticInput: { prompt: string } }) =>
      new Promise<{ generationMetadata: GenerationMetadata; output: string }>(() => {
        started.push(semanticInput.prompt);
      }),
  );
  const generation = runWalkthroughGenerationTasks({
    concurrency: 1,
    signal: controller.signal,
    tasks: [task('first', run), task('second', run)],
  });
  await vi.waitFor(() => expect(started).toEqual(['Explain first.']));

  controller.abort(new Error('The review changed.'));
  const result = await generation;

  expect(result).toMatchObject({ reason: 'The review changed.', status: 'cancelled' });
  expect(started).toEqual(['Explain first.']);
});

test('reports generic unit progress without topology-specific fields', async () => {
  const progress = vi.fn();

  const result = await runWalkthroughGenerationTasks({
    onProgress: progress,
    tasks: [
      task('narrative', async () => ({
        generationMetadata: metadata('fallback'),
        output: 'Ready',
      })),
    ],
  });

  expect(result.status).toBe('ready');
  expect(progress.mock.calls.map(([event]) => event.phase)).toEqual([
    'preparing',
    'generating',
    'generating',
    'combining',
  ]);
  expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ completed: 1, total: 1 });
});

test('does not reuse a component with invalid successful-call metadata', async () => {
  const run = vi.fn(async () => ({ generationMetadata: metadata(), output: 'fresh' }));
  const reusableComponents = [
    {
      generationMetadata: metadata('outside-policy'),
      identity: 'narrative',
      output: 'stale',
      profile,
      semanticInput: { prompt: 'Explain narrative.' },
    },
  ];

  const result = await runWalkthroughGenerationTasks({
    reusableComponents,
    tasks: [task('narrative', run)],
  });

  expect(result.status).toBe('ready');
  expect(run).toHaveBeenCalledTimes(1);
  expect(result.components.at(-1)?.output).toBe('fresh');
});

test('reuses only exact semantic inputs and preserves declared task order', async () => {
  const run = vi.fn(async ({ semanticInput }: { semanticInput: { prompt: string } }) => ({
    generationMetadata: metadata(),
    output: `fresh: ${semanticInput.prompt}`,
  }));
  const reusableComponents = [
    {
      generationMetadata: metadata(),
      identity: 'second',
      output: 'cached second',
      profile,
      semanticInput: { prompt: 'Explain second.' },
    },
    {
      generationMetadata: metadata(),
      identity: 'first',
      output: 'stale first',
      profile,
      semanticInput: { prompt: 'Explain an older first.' },
    },
  ];

  const result = await runWalkthroughGenerationTasks({
    reusableComponents,
    tasks: [task('first', run), task('second', run)],
  });

  expect(result.status).toBe('ready');
  expect(run).toHaveBeenCalledTimes(1);
  expect(result.components.map(({ identity, output }) => ({ identity, output }))).toEqual([
    { identity: 'first', output: 'fresh: Explain first.' },
    { identity: 'second', output: 'cached second' },
  ]);
});
