import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { loadReviewVersionEvolution } = require('../review-version-evolution-ipc.cjs') as {
  loadReviewVersionEvolution: (
    classify: (...args: ReadonlyArray<unknown>) => Promise<unknown>,
    repoRoot: string,
    source: unknown,
    range: unknown,
    controls: unknown,
  ) => Promise<unknown>;
};

test('passes IPC evolution controls after an explicit undefined versions argument', async () => {
  const expected = { units: [] };
  const classify = vi.fn(async () => expected);
  const source = { number: 42, provider: 'gitlab', type: 'pull-request' };
  const range = { fromVersionId: 'v1', toVersionId: 'v2' };
  const controls = { onProgress: vi.fn(), signal: new AbortController().signal };

  await expect(
    loadReviewVersionEvolution(classify, '/repo', source, range, controls),
  ).resolves.toBe(expected);
  expect(classify).toHaveBeenCalledWith('/repo', source, range, undefined, controls);
});
