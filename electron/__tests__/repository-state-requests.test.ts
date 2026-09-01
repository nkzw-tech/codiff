import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createRepositoryStateRequestCoordinator } = require('../repository-state-requests.cjs') as {
  createRepositoryStateRequestCoordinator: () => {
    resolve: <T>(
      webContentsId: number,
      read: () => Promise<T>,
      accept: (state: T) => void,
    ) => Promise<T>;
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

test('only accepts the newest repository state when requests resolve in reverse order', async () => {
  const coordinator = createRepositoryStateRequestCoordinator();
  const first = deferred<string>();
  const second = deferred<string>();
  const accept = vi.fn();

  const firstRequest = coordinator.resolve(7, () => first.promise, accept);
  const secondRequest = coordinator.resolve(7, () => second.promise, accept);
  second.resolve('newest');
  await expect(secondRequest).resolves.toBe('newest');
  first.resolve('stale');
  await expect(firstRequest).resolves.toBe('stale');

  expect(accept).toHaveBeenCalledOnce();
  expect(accept).toHaveBeenCalledWith('newest');
});
