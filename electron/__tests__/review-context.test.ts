import { expect, test, vi } from 'vite-plus/test';
import type { GitSha, ReviewContextRequest } from '../../core/types.ts';

type ReviewContextResolver = ((
  repoRoot: string,
  request: ReviewContextRequest,
) => Promise<unknown>) & { getCacheStats: () => { bytes: number; entries: number } };
type BlobArtifact = {
  bytes: Uint8Array;
  objectId: string;
  provenance: Record<string, unknown>;
};
type ReadFileBlobs = (
  repoRoot: string,
  request: ReviewContextRequest,
  files: ReadonlyArray<{ maxBytes: number; path: string; ref: string }>,
) => Promise<ReadonlyMap<string, BlobArtifact>>;
const {
  MAX_REVIEW_CONTEXT_CACHE_BYTES,
  MAX_REVIEW_CONTEXT_CACHE_ENTRIES,
  createReviewContextResolver,
} = require('../review-context.cjs') as {
  MAX_REVIEW_CONTEXT_CACHE_BYTES: number;
  MAX_REVIEW_CONTEXT_CACHE_ENTRIES: number;
  createReviewContextResolver: (dependencies: {
    maxCacheBytes?: number;
    maxCacheEntries?: number;
    readFileBlobs: ReadFileBlobs;
  }) => ReviewContextResolver;
};
const { runWithCommandSignal } = require('../git-state/common.cjs') as {
  runWithCommandSignal: <Value>(signal: AbortSignal, callback: () => Value) => Value;
};

const sha = (character: string) => character.repeat(40) as GitSha;

const createAddedRequest = (index: number): ReviewContextRequest => {
  const baseSha = index.toString(16).padStart(40, '0') as GitSha;
  const headSha = (index + 1).toString(16).padStart(40, '0') as GitSha;
  const filePath = `src/context-${index}.ts`;
  return {
    baseSha,
    filePath,
    headSha,
    range: {
      base: { label: { kind: 'commit', text: 'base' }, sha: baseSha },
      head: { label: { kind: 'commit', text: 'head' }, sha: headSha },
    },
    source: {
      owner: 'example',
      provider: 'github',
      repo: 'repo',
      type: 'pull-request',
      url: 'https://github.com/example/repo/pull/1',
    },
    status: 'added',
  };
};

const createBlobMap = (
  files: ReadonlyArray<{ path: string; ref: string }>,
  contents = Buffer.from('context\n'),
) =>
  new Map(
    files.map(({ path, ref }) => [
      `${ref}:${path}`,
      { bytes: contents, objectId: ref, provenance: { kind: 'test' } },
    ]),
  );

test('missing Apollo review SHAs resolve both renamed sides through GitLab and stay cached', async () => {
  const artifactReads: Array<{
    files: ReadonlyArray<{ maxBytes: number; path: string; ref: string }>;
    repoRoot: string;
  }> = [];
  const providerContents = new Map([
    [`${sha('a')}:packages/apollo-client/src/v10/cache.ts`, 'before v10\n'],
    [`${sha('b')}:packages/apollo-client/src/cache.ts`, 'after v25\n'],
  ]);
  const resolveReviewContext = createReviewContextResolver({
    readFileBlobs: async (repoRoot, _request, files) => {
      artifactReads.push({ files, repoRoot });
      return new Map(
        files.flatMap((file) => {
          const contents = providerContents.get(`${file.ref}:${file.path}`);
          return contents == null
            ? []
            : [
                [
                  `${file.ref}:${file.path}`,
                  {
                    bytes: Buffer.from(contents),
                    objectId: file.ref,
                    provenance: { kind: 'gitlab-api' },
                  },
                ] as const,
              ];
        }),
      );
    },
  });
  const request = {
    baseSha: sha('a'),
    filePath: 'packages/apollo-client/src/cache.ts',
    headSha: sha('b'),
    oldPath: 'packages/apollo-client/src/v10/cache.ts',
    range: {
      base: { label: { kind: 'version', text: 'v10' }, sha: sha('a') },
      head: { label: { kind: 'version', text: 'v25' }, sha: sha('b') },
    },
    source: {
      host: 'gitlab.example.com',
      number: 2382,
      projectPath: 'apollo/client',
      provider: 'gitlab',
      type: 'pull-request',
      url: 'https://gitlab.example.com/apollo/client/-/merge_requests/2382',
    },
    status: 'renamed',
  } satisfies ReviewContextRequest;

  const [first, concurrent] = await Promise.all([
    resolveReviewContext('/repo', request),
    resolveReviewContext('/repo', request),
  ]);
  const warm = await resolveReviewContext('/repo', request);

  expect(first).toEqual({
    newFile: expect.objectContaining({
      contents: 'after v25\n',
      name: 'packages/apollo-client/src/cache.ts',
    }),
    oldFile: expect.objectContaining({
      contents: 'before v10\n',
      name: 'packages/apollo-client/src/v10/cache.ts',
    }),
    status: 'ready',
  });
  expect(concurrent).toEqual(first);
  expect(warm).toEqual(first);
  expect(artifactReads).toEqual([
    {
      files: [
        {
          maxBytes: 2 * 1024 * 1024,
          path: 'packages/apollo-client/src/v10/cache.ts',
          ref: sha('a'),
        },
        {
          maxBytes: 2 * 1024 * 1024,
          path: 'packages/apollo-client/src/cache.ts',
          ref: sha('b'),
        },
      ],
      repoRoot: '/repo',
    },
  ]);
});

test('context failures report the first required side deterministically', async () => {
  const resolveReviewContext = createReviewContextResolver({
    readFileBlobs: vi.fn(async () => new Map()),
  });
  const request = {
    baseSha: sha('c'),
    filePath: 'src/new.ts',
    headSha: sha('d'),
    oldPath: 'src/old.ts',
    range: {
      base: { label: { kind: 'commit', text: 'before' }, sha: sha('c') },
      head: { label: { kind: 'commit', text: 'after' }, sha: sha('d') },
    },
    source: {
      host: 'gitlab.example.com',
      projectPath: 'example/project',
      provider: 'gitlab',
      type: 'pull-request',
      url: 'https://gitlab.example.com/example/project/-/merge_requests/1',
    },
    status: 'renamed',
  } satisfies ReviewContextRequest;

  await expect(resolveReviewContext('/repo', request)).resolves.toEqual({
    reason: `Full review context is unavailable for 'src/new.ts': could not load before contents at ${sha('c').slice(0, 12)}:src/old.ts. GitLab Blob Artifact source did not return this immutable file.`,
    status: 'unavailable',
  });
});

test('GitHub context Artifact Source bounds content and hides provider output-limit errors', async () => {
  const limitError = new Error('gh api response exceeded the 2097152-byte safety limit.');
  limitError.name = 'ProviderOutputLimitError';
  const readFileBlobs = vi.fn(async () => Promise.reject(limitError));
  const resolveReviewContext = createReviewContextResolver({ readFileBlobs });
  const request = {
    baseSha: sha('a'),
    filePath: 'src/large.ts',
    headSha: sha('b'),
    range: {
      base: { label: { kind: 'commit', text: 'before' }, sha: sha('a') },
      head: { label: { kind: 'commit', text: 'after' }, sha: sha('b') },
    },
    source: {
      owner: 'nkzw-tech',
      provider: 'github',
      repo: 'codiff',
      type: 'pull-request',
      url: 'https://github.com/nkzw-tech/codiff/pull/1',
    },
    status: 'added',
  } satisfies ReviewContextRequest;

  await expect(resolveReviewContext('/repo', request)).resolves.toEqual({
    reason: `Full review context is unavailable for 'src/large.ts': could not load after contents at ${sha('b').slice(0, 12)}:src/large.ts. Full review context is limited to 2.0 MiB per file.`,
    status: 'unavailable',
  });
  expect(readFileBlobs).toHaveBeenCalledWith('/repo', request, [
    { maxBytes: 2 * 1024 * 1024, path: 'src/large.ts', ref: sha('b') },
  ]);
});

test('aborted review context reads reject and never populate the cache', async () => {
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  let callCount = 0;
  const readFileBlobs = vi.fn<ReadFileBlobs>(async (_repoRoot, _request, files) => {
    callCount += 1;
    if (callCount === 1) {
      await new Promise<void>((resolve) => {
        release = resolve;
        markStarted();
      });
    }
    return createBlobMap(files);
  });
  const resolveReviewContext = createReviewContextResolver({ readFileBlobs });
  const request = createAddedRequest(40);
  const controller = new AbortController();
  const pending = runWithCommandSignal(controller.signal, () =>
    resolveReviewContext('/repo', request),
  );
  await started;
  controller.abort(new DOMException('Review source changed.', 'AbortError'));
  release();

  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(resolveReviewContext.getCacheStats()).toEqual({ bytes: 0, entries: 0 });
  await expect(resolveReviewContext('/repo', request)).resolves.toMatchObject({ status: 'ready' });
  expect(readFileBlobs).toHaveBeenCalledTimes(2);
});

test('canceling one context consumer preserves another concurrent consumer', async () => {
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const readFileBlobs = vi.fn<ReadFileBlobs>(async (_repoRoot, _request, files) => {
    await new Promise<void>((resolve) => {
      release = resolve;
      markStarted();
    });
    return createBlobMap(files);
  });
  const resolveReviewContext = createReviewContextResolver({ readFileBlobs });
  const request = createAddedRequest(45);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = runWithCommandSignal(firstController.signal, () =>
    resolveReviewContext('/repo', request),
  );
  const second = runWithCommandSignal(secondController.signal, () =>
    resolveReviewContext('/repo', request),
  );
  await started;
  firstController.abort(new DOMException('First consumer left.', 'AbortError'));
  release();

  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  await expect(second).resolves.toMatchObject({ status: 'ready' });
  expect(readFileBlobs).toHaveBeenCalledOnce();
  expect(resolveReviewContext.getCacheStats()).toEqual({ bytes: 8, entries: 1 });
});

test('successful review context cache entries are bounded by count and bytes', async () => {
  const contents = Buffer.alloc(32 * 1024, 'x');
  const readFileBlobs = vi.fn<ReadFileBlobs>(async (_repoRoot, _request, files) =>
    createBlobMap(files, contents),
  );
  const resolveReviewContext = createReviewContextResolver({
    maxCacheBytes: 64 * 1024,
    maxCacheEntries: 3,
    readFileBlobs,
  });
  const requests = Array.from({ length: 5 }, (_, index) => createAddedRequest(index + 50));
  for (const request of requests) {
    await resolveReviewContext('/repo', request);
  }

  expect(MAX_REVIEW_CONTEXT_CACHE_BYTES).toBeGreaterThan(0);
  expect(MAX_REVIEW_CONTEXT_CACHE_ENTRIES).toBeGreaterThan(0);
  expect(resolveReviewContext.getCacheStats()).toEqual({ bytes: 64 * 1024, entries: 2 });
  await resolveReviewContext('/repo', requests[0]!);
  expect(readFileBlobs).toHaveBeenCalledTimes(6);
  expect(resolveReviewContext.getCacheStats()).toEqual({ bytes: 64 * 1024, entries: 2 });
});
