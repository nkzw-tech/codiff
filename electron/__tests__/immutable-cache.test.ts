import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createImmutableCache } = require('../immutable-cache.cjs') as {
  createImmutableCache: () => <T>(
    key: string,
    load: () => Promise<T>,
    options?: { shareInFlight?: boolean },
  ) => Promise<T>;
};

test('an abortable reopen runs independently and later reuses the completed memory value', async () => {
  const read = createImmutableCache();
  const firstController = new AbortController();
  let resolveSecond!: (value: { request: string }) => void;
  const loads: Array<string> = [];
  const first = read(
    'same-range',
    () =>
      new Promise<{ request: string }>((_resolve, reject) => {
        loads.push('R1');
        firstController.signal.addEventListener('abort', () =>
          reject(firstController.signal.reason),
        );
      }),
    { shareInFlight: false },
  );
  await vi.waitFor(() => expect(loads).toEqual(['R1']));

  const second = read(
    'same-range',
    () =>
      new Promise<{ request: string }>((resolve) => {
        loads.push('R2');
        resolveSecond = resolve;
      }),
    { shareInFlight: false },
  );
  await vi.waitFor(() => expect(loads).toEqual(['R1', 'R2']));
  resolveSecond({ request: 'R2' });
  await expect(second).resolves.toEqual({ request: 'R2' });
  firstController.abort(new Error('R1 canceled'));
  await expect(first).rejects.toThrow('R1 canceled');

  const laterLoad = vi.fn(async () => ({ request: 'R3' }));
  await expect(read('same-range', laterLoad)).resolves.toEqual({ request: 'R2' });
  expect(laterLoad).not.toHaveBeenCalled();
});
