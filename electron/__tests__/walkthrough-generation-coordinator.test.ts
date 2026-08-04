import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createWalkthroughGenerationCoordinator, SUPERSEDED_GENERATION_REASON } =
  require('../walkthrough-generation-coordinator.cjs') as {
    createWalkthroughGenerationCoordinator: () => {
      begin: (key: number) => AbortController;
      cancel: (key: number, reason?: unknown) => void;
      clear: (key: number, reason?: unknown) => void;
      finish: (key: number, controller: AbortController) => void;
      getReusable: (
        key: number,
        cacheKey: string,
        force?: boolean,
      ) => ReadonlyArray<unknown> | undefined;
      retain: (
        key: number,
        controller: AbortController,
        cacheKey: string,
        components: ReadonlyArray<unknown>,
      ) => boolean;
    };
    SUPERSEDED_GENERATION_REASON: string;
  };

test('supersedes an active generation without letting it overwrite current retry state', () => {
  const coordinator = createWalkthroughGenerationCoordinator();
  const first = coordinator.begin(7);
  const second = coordinator.begin(7);

  expect(first.signal.aborted).toBe(true);
  expect(first.signal.reason).toEqual(new Error(SUPERSEDED_GENERATION_REASON));
  expect(coordinator.retain(7, first, 'review-a', ['stale'])).toBe(false);
  coordinator.finish(7, first);
  expect(coordinator.retain(7, second, 'review-a', ['current'])).toBe(true);
  expect(coordinator.getReusable(7, 'review-a')).toEqual(['current']);
});

test('cancel aborts active work without discarding reusable components', () => {
  const coordinator = createWalkthroughGenerationCoordinator();
  const controller = coordinator.begin(9);
  const components = [{ identity: 'ready-unit' }];
  const reason = new Error('The review source changed.');

  expect(coordinator.retain(9, controller, 'review-a', components)).toBe(true);
  coordinator.cancel(9, reason);

  expect(controller.signal.aborted).toBe(true);
  expect(controller.signal.reason).toBe(reason);
  expect(coordinator.getReusable(9, 'review-a')).toBe(components);
});

test('retains partial components only for matching non-forced retries', () => {
  const coordinator = createWalkthroughGenerationCoordinator();
  const current = coordinator.begin(11);
  const components = [{ identity: 'ready-unit' }];

  expect(coordinator.retain(11, current, 'review-a', components)).toBe(true);
  expect(coordinator.getReusable(11, 'review-a')).toBe(components);
  expect(coordinator.getReusable(11, 'review-b')).toBeUndefined();
  expect(coordinator.getReusable(11, 'review-a', true)).toBeUndefined();

  coordinator.clear(11);
  expect(current.signal.aborted).toBe(true);
  expect(coordinator.getReusable(11, 'review-a')).toBeUndefined();
});
