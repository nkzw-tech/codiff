import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { readComparisonPatchFallbacks } = require('../git-state/comparison.cjs') as {
  readComparisonPatchFallbacks: (
    paths: ReadonlyArray<string>,
    readPatch: (path: string) => Promise<string>,
  ) => Promise<Map<string, string>>;
};

test('bounds per-file comparison patch fallback reads', async () => {
  const paths = Array.from({ length: 20 }, (_, index) => `src/${index}.ts`);
  let active = 0;
  let peak = 0;

  const patches = await readComparisonPatchFallbacks(paths, async (path) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return `patch for ${path}`;
  });

  expect(peak).toBe(8);
  expect(Object.fromEntries(patches)).toEqual(
    Object.fromEntries(paths.map((path) => [path, `patch for ${path}`])),
  );
});
