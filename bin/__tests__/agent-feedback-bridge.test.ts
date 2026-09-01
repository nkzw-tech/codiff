import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { createAgentFeedbackBridge } from '../agent-feedback-bridge.mjs';

const bridges: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

const createBridge = async (
  deliver = vi.fn(async ({ deliveryId }) => ({
    assurance: 'dispatch-started',
    deliveryId,
    status: 'accepted',
  })),
) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-bridge-test-'));
  const bridge = await createAgentFeedbackBridge({
    backend: 'pi',
    deliver,
    getIdentity: () => ({ repositoryRoot: '/repo', sessionId: 'session-1' }),
    registrationRoot: path.join(root, 'registry'),
    socketDirectory: root,
  });
  bridges.push(bridge);
  return { bridge, deliver, root };
};

const post = (
  socketPath: string,
  pathname: string,
  body: unknown,
  token?: string,
): Promise<{ body: Record<string, unknown>; status: number }> =>
  new Promise((resolve, reject) => {
    const request = http.request(
      {
        headers: {
          authorization: token ? `Bearer ${token}` : '',
          'content-type': 'application/json',
        },
        method: 'POST',
        path: pathname,
        socketPath,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          resolve({
            body: text ? JSON.parse(text) : {},
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });

test('creates private registry, registration, and socket entries', async () => {
  const { bridge } = await createBridge();

  expect((await stat(bridge.registrationDirectory)).mode & 0o777).toBe(0o700);
  expect((await stat(bridge.registrationPath)).mode & 0o777).toBe(0o600);
  expect((await stat(bridge.registration.endpoint)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(bridge.registrationPath, 'utf8'))).toEqual(bridge.registration);
});

test('authenticates and echoes exact identity plus challenge', async () => {
  const { bridge } = await createBridge();

  const result = await post(
    bridge.registration.endpoint,
    '/v1/identity',
    { nonce: 'nonce-1', version: 1 },
    bridge.registration.token,
  );

  expect(result).toEqual({
    body: {
      backend: 'pi',
      nonce: 'nonce-1',
      repositoryRoot: '/repo',
      sessionId: 'session-1',
      version: 1,
    },
    status: 200,
  });
});

test('rejects missing and incorrect bearer tokens', async () => {
  const { bridge } = await createBridge();

  await expect(
    post(bridge.registration.endpoint, '/v1/identity', { nonce: 'n', version: 1 }),
  ).resolves.toMatchObject({ status: 401 });
  await expect(
    post(
      bridge.registration.endpoint,
      '/v1/identity',
      { nonce: 'n', version: 1 },
      `${bridge.registration.token}x`,
    ),
  ).resolves.toMatchObject({ status: 401 });
});

test.each([
  ['repository', { repositoryRoot: '/other', sessionId: 'session-1', version: 1 }],
  ['session', { repositoryRoot: '/repo', sessionId: 'other', version: 1 }],
  ['version', { repositoryRoot: '/repo', sessionId: 'session-1', version: 2 }],
])('rejects delivery with a mismatched %s', async (_field, identity) => {
  const { bridge, deliver } = await createBridge();
  const result = await post(
    bridge.registration.endpoint,
    '/v1/deliver',
    { deliveryId: randomUUID(), message: 'feedback', ...identity },
    bridge.registration.token,
  );

  expect(result.status).toBe(409);
  expect(deliver).not.toHaveBeenCalled();
});

test('rejects request bodies larger than 1 MiB without dispatching', async () => {
  const { bridge, deliver } = await createBridge();
  const result = await post(
    bridge.registration.endpoint,
    '/v1/deliver',
    {
      deliveryId: randomUUID(),
      message: 'x'.repeat(1024 * 1024),
      repositoryRoot: '/repo',
      sessionId: 'session-1',
      version: 1,
    },
    bridge.registration.token,
  );

  expect(result.status).toBe(413);
  expect(deliver).not.toHaveBeenCalled();
});

test('deduplicates terminal delivery IDs', async () => {
  const { bridge, deliver } = await createBridge();
  const body = {
    deliveryId: 'delivery-1',
    message: 'feedback',
    repositoryRoot: '/repo',
    sessionId: 'session-1',
    version: 1,
  };

  await expect(
    post(bridge.registration.endpoint, '/v1/deliver', body, bridge.registration.token),
  ).resolves.toMatchObject({ body: { status: 'accepted' }, status: 200 });
  await expect(
    post(bridge.registration.endpoint, '/v1/deliver', body, bridge.registration.token),
  ).resolves.toMatchObject({ body: { status: 'already-accepted' }, status: 200 });
  expect(deliver).toHaveBeenCalledOnce();
});

test('refreshes registration atomically and removes only its files on close', async () => {
  const { bridge } = await createBridge();
  const unrelated = path.join(bridge.registrationDirectory, 'unrelated.json');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(unrelated, '{}'));
  const registrationPath = bridge.registrationPath;
  const socketPath = bridge.registration.endpoint;

  await bridge.close();
  bridges.splice(bridges.indexOf(bridge), 1);

  await expect(stat(registrationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(unrelated)).resolves.toBeDefined();
});
