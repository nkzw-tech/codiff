import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { comparisonCacheKey } = require('../git-state/review-history.cjs') as {
  comparisonCacheKey: (
    kind: 'aggregate' | 'evolution',
    source: {
      host: string;
      number: number;
      projectPath: string;
      provider: 'gitlab';
    },
    coordinates: {
      from: { baseSha: string; headSha: string };
      to: { baseSha: string; headSha: string };
    },
  ) => Promise<Record<string, unknown>>;
};
const {
  MAX_RECORD_BYTES,
  cachePath,
  loadReviewHistoryCached,
  readReviewHistoryCache,
  writeReviewHistoryCache,
} = require('../review-history-cache.cjs') as {
  MAX_RECORD_BYTES: number;
  cachePath: (key: unknown) => string;
  loadReviewHistoryCached: <T>(
    key: unknown,
    load: () => Promise<T>,
    options?: { shareInFlight?: boolean },
  ) => Promise<T>;
  readReviewHistoryCache: (key: unknown) => Promise<unknown | null>;
  writeReviewHistoryCache: (key: unknown, value: unknown) => Promise<boolean>;
};

const previousDirectory = process.env.CODIFF_REVIEW_HISTORY_CACHE_DIR;

afterEach(() => {
  if (previousDirectory == null) delete process.env.CODIFF_REVIEW_HISTORY_CACHE_DIR;
  else process.env.CODIFF_REVIEW_HISTORY_CACHE_DIR = previousDirectory;
});

const useTemporaryCache = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-review-history-'));
  process.env.CODIFF_REVIEW_HISTORY_CACHE_DIR = directory;
  return directory;
};

test('writes immutable records atomically and falls back after corruption', async () => {
  await useTemporaryCache();
  const key = {
    algorithmVersion: 'test-v1',
    fromHeadSha: 'a'.repeat(40),
    kind: 'aggregate',
    provider: 'gitlab',
    toHeadSha: 'b'.repeat(40),
  };

  await expect(writeReviewHistoryCache(key, { files: ['src/app.ts'] })).resolves.toBe(true);
  await expect(readReviewHistoryCache(key)).resolves.toEqual({ files: ['src/app.ts'] });
  expect(JSON.parse(await readFile(cachePath(key), 'utf8')).formatVersion).toBe(1);

  await writeFile(cachePath(key), '{broken', 'utf8');
  await expect(readReviewHistoryCache(key)).resolves.toBeNull();
});

test('keys persistent comparisons by every Core-derived algorithm contract', async () => {
  const key = await comparisonCacheKey(
    'aggregate',
    {
      host: 'gitlab.example.com',
      number: 7,
      projectPath: 'group/project',
      provider: 'gitlab',
    },
    {
      from: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
      to: { baseSha: 'c'.repeat(40), headSha: 'd'.repeat(40) },
    },
  );

  expect(key).toMatchObject({
    algorithmVersion: 'review-comparison-cache-v2',
    artifactSchemaVersion: 'review-artifact-v1',
    matcherVersion: 'range-diff-lap-jv-v2',
    projectionVersion: 'region-aware-projection-v1',
    replayVersion: 'region-aware-replay-v1:conflict-only-anchors',
  });
});

test('deduplicates concurrent misses and reuses the persisted result', async () => {
  await useTemporaryCache();
  const key = { algorithmVersion: 'test-v1', kind: 'evolution', provider: 'github' };
  let calls = 0;
  const load = async () => {
    calls += 1;
    await Promise.resolve();
    return { units: [1, 2, 3] };
  };

  const [first, second] = await Promise.all([
    loadReviewHistoryCached(key, load),
    loadReviewHistoryCached(key, load),
  ]);
  const warm = await loadReviewHistoryCached(key, load);

  expect(first).toEqual(second);
  expect(warm).toEqual(first);
  expect(calls).toBe(1);
});

test('an abortable reopen runs independently and later reuses the persisted value', async () => {
  await useTemporaryCache();
  const key = { algorithmVersion: 'test-v1', kind: 'evolution', provider: 'gitlab' };
  const firstController = new AbortController();
  let resolveSecond!: (value: { request: string }) => void;
  const loads: Array<string> = [];
  const first = loadReviewHistoryCached(
    key,
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

  const second = loadReviewHistoryCached(
    key,
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
  await expect(loadReviewHistoryCached(key, laterLoad)).resolves.toEqual({ request: 'R2' });
  expect(laterLoad).not.toHaveBeenCalled();
});

test('reuses persisted immutable work after a module restart', async () => {
  await useTemporaryCache();
  const key = {
    algorithmVersion: 'commit-fingerprint-v3:bulk-diff-tree-v1',
    commitSha: 'a'.repeat(40),
    kind: 'commit-fingerprint',
    project: 'example/project',
    provider: 'gitlab',
  };
  let calls = 0;
  const expected = { commitSha: key.commitSha, exactChangeId: 'immutable' };
  await loadReviewHistoryCached(key, async () => {
    calls += 1;
    return expected;
  });

  const moduleId = require.resolve('../review-history-cache.cjs');
  delete require.cache[moduleId];
  const fresh = require(moduleId) as {
    loadReviewHistoryCached: <T>(cacheKey: unknown, load: () => Promise<T>) => Promise<T>;
  };
  const result = await fresh.loadReviewHistoryCached(key, async () => {
    calls += 1;
    return { commitSha: key.commitSha, normalizedPatchHash: 'recomputed' };
  });

  expect(result).toEqual(expected);
  expect(calls).toBe(1);
});

test('rejects records larger than eight MiB', async () => {
  await useTemporaryCache();
  await expect(
    writeReviewHistoryCache({ kind: 'aggregate' }, 'x'.repeat(MAX_RECORD_BYTES)),
  ).resolves.toBe(false);
});

test('discards a cache record that grows after its size check', async () => {
  await useTemporaryCache();
  const key = { algorithmVersion: 'test-v1', kind: 'aggregate', provider: 'gitlab' };
  await expect(writeReviewHistoryCache(key, { files: ['src/app.ts'] })).resolves.toBe(true);

  const path = cachePath(key);
  const nodeFs = require('node:fs') as typeof import('node:fs');
  const mutablePromises = nodeFs.promises as { open: typeof nodeFs.promises.open };
  const originalOpen = mutablePromises.open;
  let grew = false;
  mutablePromises.open = async (...args: Parameters<typeof originalOpen>) => {
    if (!grew && args[0] === path && args[1] === 'r') {
      grew = true;
      const writer = await originalOpen(path, 'a');
      try {
        await writer.write(Buffer.alloc(MAX_RECORD_BYTES, 'x'));
      } finally {
        await writer.close();
      }
    }
    return originalOpen(...args);
  };

  try {
    await expect(readReviewHistoryCache(key)).resolves.toBeNull();
  } finally {
    mutablePromises.open = originalOpen;
  }

  expect(grew).toBe(true);
  await expect(readFile(path, 'utf8')).rejects.toThrow();
});
