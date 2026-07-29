import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createWalkthroughAssessmentScheduler } =
  require('../walkthrough-assessment-scheduler.cjs') as typeof import('../walkthrough-assessment-scheduler.cjs');

const identity = { codeScope: { type: 'single-diff' }, threadId: 'thread-1' };
const demand = {
  capturedPresentationState: { threadState: 'open' },
  identity,
  input: {
    codeScope: identity.codeScope,
    thread: {
      comments: [{ author: { login: 'reviewer' }, body: 'Check this.', id: 'comment-1' }],
      id: identity.threadId,
    },
  },
} as never;
const component = (error: string) => ({ ...demand, outcome: { error, status: 'failed' } }) as never;

test('an obsolete completion cannot overwrite a newer request for the same identity', async () => {
  const completions: Array<(value: never) => void> = [];
  const replace = vi.fn((_cacheKey, replacement) => ({
    status: 'replaced',
    walkthrough: {
      assessments: { items: [replacement.component] },
      version: 5,
    },
  }));
  const onUpdate = vi.fn();
  const scheduler = createWalkthroughAssessmentScheduler({ concurrency: 2, replace });
  const first = scheduler.schedule({
    cacheKey: 'cache',
    demand,
    expectedComponent: null,
    generate: () => new Promise((resolve) => completions.push(resolve)),
    onUpdate,
  });
  const second = scheduler.schedule({
    cacheKey: 'cache',
    demand,
    expectedComponent: null,
    generate: () => new Promise((resolve) => completions.push(resolve)),
    onUpdate,
  });

  await vi.waitFor(() => expect(completions).toHaveLength(2));
  completions[1]!(component('Current failure.'));
  await second;
  completions[0]!(component('Obsolete failure.'));
  await first;

  expect(replace).toHaveBeenCalledTimes(1);
  expect(replace.mock.calls[0]?.[1].component.outcome.error).toBe('Current failure.');
  expect(onUpdate).toHaveBeenCalledTimes(1);
});

test('bounds independent sibling work without coupling their outcomes', async () => {
  let active = 0;
  let maximum = 0;
  const replace = vi.fn((_cacheKey, replacement) => ({
    status: 'replaced',
    walkthrough: { assessments: { items: [replacement.component] }, version: 5 },
  }));
  const scheduler = createWalkthroughAssessmentScheduler({ concurrency: 2, replace });
  const scheduled = Array.from({ length: 4 }, (_, index) => {
    const nextDemand = {
      ...demand,
      identity: { ...identity, threadId: `thread-${index}` },
    } as never;
    return scheduler.schedule({
      cacheKey: 'cache',
      demand: nextDemand,
      expectedComponent: null,
      generate: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
        return { ...component(`failure-${index}`), identity: nextDemand.identity } as never;
      },
      onUpdate: vi.fn(),
    });
  });

  await Promise.all(scheduled);
  expect(maximum).toBe(2);
  expect(replace).toHaveBeenCalledTimes(4);
});
