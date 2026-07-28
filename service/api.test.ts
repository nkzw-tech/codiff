import { expect, test } from 'vite-plus/test';
import {
  handleSharingApiRequest,
  parseShareUpload,
  readRequestText,
  type SharingEnv,
} from './api.ts';

test('reads request bodies within a byte limit', async () => {
  const request = new Request('https://codiff.dev/api/uploads', {
    body: new Uint8Array([0x61, 0xe2, 0x82, 0xac]),
    method: 'POST',
  });

  expect(await readRequestText(request, 4)).toBe('a€');
});

test('rejects request bodies that exceed declared or streamed byte limits', async () => {
  const declared = new Request('https://codiff.dev/api/uploads', {
    body: 'small',
    headers: { 'content-length': '100' },
    method: 'POST',
  });
  expect(await readRequestText(declared, 5)).toBeNull();

  let cancelled = false;
  const streamed = new Request('https://codiff.dev/api/uploads', {
    body: new ReadableStream({
      cancel() {
        cancelled = true;
        throw new Error('Cancellation failed.');
      },
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
    }),
    duplex: 'half',
    method: 'POST',
  } as RequestInit);
  expect(await readRequestText(streamed, 5)).toBeNull();
  expect(cancelled).toBe(true);
});

test('creates anonymous upload intents without touching persistent storage', async () => {
  let databaseAccesses = 0;
  const failOnDatabaseAccess = () => {
    databaseAccesses += 1;
    throw new Error('Anonymous intent creation must not access D1.');
  };
  const env = {
    BETTER_AUTH_SECRET: 'test-secret-with-at-least-thirty-two-characters',
    DB: {
      batch: failOnDatabaseAccess,
      prepare: failOnDatabaseAccess,
    } as unknown as SharingEnv['DB'],
    PUBLIC_ORIGIN: 'https://codiff.dev',
    WALKTHROUGH_BUCKET: {
      delete: async () => {
        throw new Error('Anonymous intent creation must not access R2.');
      },
      get: async () => {
        throw new Error('Anonymous intent creation must not access R2.');
      },
      put: async () => {
        throw new Error('Anonymous intent creation must not access R2.');
      },
    },
  } satisfies SharingEnv;

  const response = await handleSharingApiRequest(
    new Request('https://codiff.dev/api/upload-intents', { method: 'POST' }),
    env,
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    claimUrl: expect.stringMatching(/^https:\/\/codiff\.dev\/connect\/.+\?secret=.+/),
    code: expect.any(String),
    pollUrl: expect.stringMatching(/^https:\/\/codiff\.dev\/api\/upload-intents\/.+\?secret=.+/),
    secret: expect.any(String),
    status: 'pending',
  });
  expect(databaseAccesses).toBe(0);
});

for (const [name, reviewScope] of [
  ['net change', { kind: 'merge-request', structure: 'net-change' }],
  ['commit-by-commit merge request', { kind: 'merge-request', structure: 'commit-by-commit' }],
] as const) {
  test(`preserves ${name} scope metadata in version 1 walkthrough uploads`, () => {
    const parsed = parseShareUpload(
      JSON.stringify({
        branch: 'feature',
        codiffVersion: 'test',
        exportedAt: '2026-07-22T00:00:00.000Z',
        files: [],
        kind: 'codiff-walkthrough-share',
        repository: { source: { type: 'working-tree' } },
        reviewScope,
        version: 1,
        walkthrough: { title: 'Walkthrough' },
      }),
    );

    expect(parsed.kind).toBe('walkthrough');
    expect(parsed.snapshot.reviewScope).toEqual(reviewScope);
  });
}
