import { access, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const forge = require('../../forge.config.cjs') as {
  hooks: {
    packageAfterCopy: (_config: unknown, buildPath: string) => Promise<void>;
  };
  packagerConfig: {
    ignore: ReadonlyArray<RegExp>;
  };
};

const isIgnored = (path: string) =>
  forge.packagerConfig.ignore.some((pattern) => pattern.test(path));

test('Forge excludes provider sources and retains application entry points', () => {
  expect(isIgnored('/github/src/index.ts')).toBe(true);
  expect(isIgnored('/gitlab/src/index.ts')).toBe(true);
  expect(isIgnored('/electron/main.cjs')).toBe(false);
  expect(isIgnored('/dist/index.html')).toBe(false);
});

test('Forge restores built provider runtime artifacts after copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-forge-runtime-'));
  try {
    await forge.hooks.packageAfterCopy({}, directory);
    for (const path of [
      'core/lib/narrative-walkthrough-diff.cjs',
      'github/dist/index.mjs',
      'gitlab/dist/index.mjs',
    ]) {
      await expect(access(join(directory, path))).resolves.toBeUndefined();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
