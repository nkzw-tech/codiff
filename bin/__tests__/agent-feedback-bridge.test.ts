import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
  options: Record<string, unknown> = {},
) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-bridge-test-'));
  const bridge = await createAgentFeedbackBridge({
    backend: 'pi',
    deliver,
    getIdentity: () => ({ repositoryRoot: '/repo', sessionId: 'session-1' }),
    registrationRoot: path.join(root, 'registry'),
    socketDirectory: root,
    ...options,
  });
  bridges.push(bridge);
  return { bridge, deliver, root };
};

const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 500;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
  ['repository root', { repositoryRoot: ' ', sessionId: 'session-1', version: 1 }],
  ['session', { repositoryRoot: '/repo', sessionId: 'other', version: 1 }],
  ['version', { repositoryRoot: '/repo', sessionId: 'session-1', version: 2 }],
])('rejects delivery with an invalid %s', async (_field, identity) => {
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

test('shares one dispatch for concurrent duplicate delivery IDs', async () => {
  let release!: () => void;
  const deliver = vi.fn(
    ({ deliveryId }) =>
      new Promise<Record<string, string>>((resolve) => {
        release = () => resolve({ assurance: 'dispatch-started', deliveryId, status: 'accepted' });
      }),
  );
  const { bridge } = await createBridge(deliver);
  const body = {
    deliveryId: 'delivery-concurrent',
    message: 'feedback',
    repositoryRoot: '/repo',
    sessionId: 'session-1',
    version: 1,
  };

  const first = post(bridge.registration.endpoint, '/v1/deliver', body, bridge.registration.token);
  const second = post(bridge.registration.endpoint, '/v1/deliver', body, bridge.registration.token);
  await waitFor(() => deliver.mock.calls.length === 1);
  release();

  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  expect(deliver).toHaveBeenCalledOnce();
});

test('evicts the oldest terminal response after 1,000 delivery IDs', async () => {
  const { bridge, deliver } = await createBridge();
  const send = (deliveryId: string) =>
    post(
      bridge.registration.endpoint,
      '/v1/deliver',
      {
        deliveryId,
        message: 'feedback',
        repositoryRoot: '/repo',
        sessionId: 'session-1',
        version: 1,
      },
      bridge.registration.token,
    );

  for (let index = 0; index <= 1_000; index += 1) await send(`delivery-${index}`);
  await expect(send('delivery-0')).resolves.toMatchObject({ body: { status: 'accepted' } });
  expect(deliver).toHaveBeenCalledTimes(1_002);
});

test.each(['../outside', 'pi/other', 'unknown', ''])(
  'rejects invalid backend %j before path use',
  async (backend) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-backend-test-'));
    const getIdentity = vi.fn(() => ({ repositoryRoot: '/repo', sessionId: 'session-1' }));

    await expect(
      createAgentFeedbackBridge({
        backend,
        deliver: vi.fn(),
        getIdentity,
        registrationRoot: path.join(root, 'registry'),
        socketDirectory: root,
      }),
    ).rejects.toThrow(/backend/i);
    expect(getIdentity).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  },
);

test.each(['root symlink', 'backend symlink'])(
  'rejects an existing %s without chmod-following it',
  async (kind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-registry-test-'));
    const target = path.join(root, 'target');
    const registrationRoot = path.join(root, 'registry');
    await mkdir(target, { mode: 0o755 });
    await chmod(target, 0o755);
    if (kind === 'root symlink') {
      await symlink(target, registrationRoot, 'dir');
    } else {
      await mkdir(registrationRoot, { mode: 0o700 });
      await symlink(target, path.join(registrationRoot, 'pi'), 'dir');
    }

    await expect(
      createAgentFeedbackBridge({
        backend: 'pi',
        deliver: vi.fn(),
        getIdentity: () => ({ repositoryRoot: '/repo', sessionId: 'session-1' }),
        registrationRoot,
        socketDirectory: root,
      }),
    ).rejects.toThrow(/registry|directory/i);
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  },
);

test('rejects an existing registration root with the wrong owner or type', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-owner-test-'));
  const registrationRoot = path.join(root, 'registry');
  await writeFile(registrationRoot, 'hostile');

  await expect(
    createAgentFeedbackBridge({
      backend: 'pi',
      deliver: vi.fn(),
      getIdentity: () => ({ repositoryRoot: '/repo', sessionId: 'session-1' }),
      registrationRoot,
      socketDirectory: root,
    }),
  ).rejects.toThrow(/registry|directory/i);

  await import('node:fs/promises').then(({ rm }) => rm(registrationRoot));
  await mkdir(registrationRoot, { mode: 0o700 });
  await expect(
    createAgentFeedbackBridge({
      backend: 'pi',
      deliver: vi.fn(),
      getIdentity: () => ({ repositoryRoot: '/repo', sessionId: 'session-1' }),
      getuid: () => (process.getuid?.() ?? 0) + 1,
      registrationRoot,
      socketDirectory: root,
    }),
  ).rejects.toThrow(/owner/i);
});

test('continues refreshing after a failed serialized registration write', async () => {
  let writes = 0;
  const diagnostic = vi.fn();
  const writeRegistrationFile = vi.fn(async (registrationPath, registration) => {
    writes += 1;
    if (writes === 2) throw new Error(`secret ${registration.token}`);
    await writeFile(registrationPath, JSON.stringify(registration), { mode: 0o600 });
  });
  const { bridge } = await createBridge(undefined, {
    onDiagnostic: diagnostic,
    refreshIntervalMs: 10,
    writeRegistrationFile,
  });

  await waitFor(() => writes >= 3);

  expect(writeRegistrationFile).toHaveBeenCalledTimes(3);
  expect(diagnostic).toHaveBeenCalledWith('Agent feedback bridge registration refresh failed.');
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(bridge.registration.token);
});

test('rolls back the listening socket when registration initialization fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-rollback-test-'));
  const registrationRoot = path.join(root, 'registry');

  await expect(
    createAgentFeedbackBridge({
      backend: 'pi',
      deliver: vi.fn(),
      getIdentity: () => ({ repositoryRoot: '/repo', sessionId: 'session-1' }),
      registrationRoot,
      socketDirectory: root,
      writeRegistrationFile: async () => {
        throw new Error('registration failed');
      },
    }),
  ).rejects.toThrow('registration failed');

  expect((await readdir(root)).filter((name) => name.endsWith('.sock'))).toEqual([]);
  await expect(lstat(path.join(registrationRoot, 'pi'))).resolves.toBeDefined();
  expect(
    (await readdir(path.join(registrationRoot, 'pi'))).filter((name) => name.endsWith('.json')),
  ).toEqual([]);
});

test('concurrent close callers share complete cleanup', async () => {
  const { bridge } = await createBridge();
  const first = bridge.close();
  const second = bridge.close();

  expect(second).toBe(first);
  await Promise.all([first, second]);
  bridges.splice(bridges.indexOf(bridge), 1);
  await expect(stat(bridge.registrationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(bridge.registration.endpoint)).rejects.toMatchObject({ code: 'ENOENT' });
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
