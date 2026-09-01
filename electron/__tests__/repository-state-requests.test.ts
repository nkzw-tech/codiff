import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createRepositoryStateRequestCoordinator } = require('../repository-state-requests.cjs') as {
  createRepositoryStateRequestCoordinator: () => {
    clear: (webContentsId: number) => void;
    resolve: <T>(
      webContentsId: number,
      read: () => Promise<T>,
      accept: (state: T) => void,
      isActive?: () => boolean,
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

test('clear prevents an old request from becoming current after web contents ID reuse', async () => {
  const coordinator = createRepositoryStateRequestCoordinator();
  const oldRequestState = deferred<string>();
  const reusedIdState = deferred<string>();
  const accept = vi.fn();

  const oldRequest = coordinator.resolve(7, () => oldRequestState.promise, accept);
  coordinator.clear(7);
  const reusedIdRequest = coordinator.resolve(7, () => reusedIdState.promise, accept);
  reusedIdState.resolve('reused-id');
  await expect(reusedIdRequest).resolves.toBe('reused-id');
  oldRequestState.resolve('old-window');
  await expect(oldRequest).resolves.toBe('old-window');

  expect(accept).toHaveBeenCalledOnce();
  expect(accept).toHaveBeenCalledWith('reused-id');
});

test('does not accept repository state after the sender becomes inactive', async () => {
  const coordinator = createRepositoryStateRequestCoordinator();
  const repositoryState = deferred<string>();
  const accept = vi.fn();
  let active = true;
  const request = coordinator.resolve(
    7,
    () => repositoryState.promise,
    accept,
    () => active,
  );

  active = false;
  repositoryState.resolve('late-state');

  await expect(request).resolves.toBe('late-state');
  expect(accept).not.toHaveBeenCalled();
});
