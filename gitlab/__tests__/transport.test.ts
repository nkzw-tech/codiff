import { expect, test } from 'vite-plus/test';
import { createFakeGitLabTransport } from '../../test/fake-provider-transports.ts';

test('routes host-injected requests by method, path, and normalized query', async () => {
  const transport = createFakeGitLabTransport([
    {
      method: 'POST',
      path: '/api/v4/projects/example/merge_requests',
      query: { page: 2, state: 'opened' },
      response: { id: 7 },
    },
  ]);

  await expect(
    transport.request({
      method: 'POST',
      path: '/api/v4/projects/example/merge_requests',
      query: { page: 2, state: 'opened' },
    }),
  ).resolves.toEqual({ id: 7 });
  expect(transport.calls).toEqual([
    {
      method: 'POST',
      path: '/api/v4/projects/example/merge_requests',
      query: { page: 2, state: 'opened' },
    },
  ]);
});

test('collects paginated responses until GitLab returns a short page', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => index);
  const transport = createFakeGitLabTransport([
    {
      path: '/api/v4/projects/example/repository/commits',
      query: { page: 1, per_page: 100, ref_name: 'main' },
      response: firstPage,
    },
    {
      path: '/api/v4/projects/example/repository/commits',
      query: { page: 2, per_page: 100, ref_name: 'main' },
      response: [100],
    },
  ]);

  await expect(
    transport.requestPages?.({
      path: '/api/v4/projects/example/repository/commits',
      query: { ref_name: 'main' },
    }),
  ).resolves.toEqual([...firstPage, 100]);
  expect(transport.calls).toHaveLength(2);
});

test('reads raw repository text without exposing host authentication', async () => {
  const transport = createFakeGitLabTransport([
    {
      path: '/api/v4/projects/example/repository/files/readme/raw',
      query: { ref: 'main' },
      response: null,
      text: '# Example',
    },
  ]);

  await expect(
    transport.requestText?.({
      path: '/api/v4/projects/example/repository/files/readme/raw',
      query: { ref: 'main' },
    }),
  ).resolves.toBe('# Example');
});

test('reads immutable repository blob bytes without text coercion', async () => {
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const transport = createFakeGitLabTransport([
    {
      bytes,
      path: '/api/v4/projects/example/repository/blobs/deadbeef/raw',
      response: null,
    },
  ]);

  await expect(
    transport.requestBuffer?.({
      path: '/api/v4/projects/example/repository/blobs/deadbeef/raw',
    }),
  ).resolves.toEqual(bytes);
});

test('cancels in-flight host requests through the shared transport signal', async () => {
  const controller = new AbortController();
  const transport = createFakeGitLabTransport([
    {
      path: '/api/v4/projects/example/repository/commits/slow/diff',
      response: () => new Promise((resolve) => setTimeout(() => resolve([]), 1000)),
    },
  ]);
  const request = transport.request({
    path: '/api/v4/projects/example/repository/commits/slow/diff',
    signal: controller.signal,
  });
  controller.abort(new DOMException('Superseded', 'AbortError'));
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
});
