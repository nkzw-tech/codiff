import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { createAgentFeedbackBridge } from '../../bin/agent-feedback-bridge.mjs';
import type { AgentFeedbackDeliveryRequest, AgentReviewFeedback } from '../../core/types.ts';

const require = createRequire(import.meta.url);
const { createAgentFeedbackBridgeClient } = require('../agent-feedback-bridge.cjs') as {
  createAgentFeedbackBridgeClient: (options: {
    getuid?: () => number;
    isPidAlive?: (pid: number) => boolean;
    now?: () => number;
    registrationRoot: string;
    timeoutMs?: number;
  }) => {
    deliverToAgentFeedbackBridge: (
      request: AgentFeedbackDeliveryRequest,
    ) => Promise<Record<string, unknown>>;
    probeAgentFeedbackBridge: (
      identity: Pick<AgentFeedbackDeliveryRequest, 'backend' | 'repositoryRoot' | 'sessionId'>,
    ) => Promise<{ available: boolean; reason?: string }>;
  };
};

const resources: Array<{ close: () => Promise<void> | void }> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});

const feedback: AgentReviewFeedback = {
  comments: [
    {
      anchor: 'file',
      body: 'Fix this.',
      context: 'context',
      filePath: 'src/a.ts',
      order: 1,
      sectionId: 'src/a.ts',
    },
  ],
  markdown: '# Feedback\n\nFix this.',
  repository: { root: '/repo', source: { type: 'working-tree' } },
  version: 1,
};

const request: AgentFeedbackDeliveryRequest = {
  backend: 'pi',
  deliveryId: 'delivery-1',
  feedback,
  repositoryRoot: '/repo',
  sessionId: 'session-1',
  version: 1,
};

const setup = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-client-test-'));
  const registrationRoot = path.join(root, 'registry');
  const deliver = vi.fn(async ({ deliveryId }) => ({
    assurance: 'dispatch-started',
    deliveryId,
    status: 'accepted',
  }));
  const bridge = await createAgentFeedbackBridge({
    backend: 'pi',
    deliver,
    getIdentity: () => ({ repositoryRoot: '/repo', sessionId: 'session-1' }),
    registrationRoot,
    socketDirectory: root,
  });
  resources.push(bridge);
  return { bridge, deliver, registrationRoot, root };
};

const createRawServer = async (root: string, handler: Parameters<typeof http.createServer>[0]) => {
  const server = http.createServer(handler);
  const socketPath = path.join(root, `s-${randomUUID().slice(0, 8)}.sock`);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  resources.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return { server, socketPath };
};

const writeRegistration = async (
  registrationRoot: string,
  values: Partial<Record<string, unknown>>,
) => {
  const directory = path.join(registrationRoot, 'pi');
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  const registration = {
    backend: 'pi',
    endpoint: '/missing.sock',
    instanceId: randomUUID(),
    pid: process.pid,
    protocolVersion: 1,
    repositoryRoot: '/repo',
    sessionId: 'session-1',
    token: randomBytes(32).toString('base64url'),
    updatedAt: new Date().toISOString(),
    ...values,
  };
  const file = path.join(directory, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(registration), { mode: 0o600 });
  await chmod(file, 0o600);
  return { file, registration };
};

test('probe authenticates the exact resident identity without delivering', async () => {
  const { deliver, registrationRoot } = await setup();
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await expect(client.probeAgentFeedbackBridge(request)).resolves.toEqual({ available: true });
  expect(deliver).not.toHaveBeenCalled();
});

test('probe reports a missing resident registration as unavailable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-missing-probe-test-'));
  const client = createAgentFeedbackBridgeClient({ registrationRoot: path.join(root, 'registry') });

  await expect(client.probeAgentFeedbackBridge(request)).resolves.toMatchObject({
    available: false,
    reason: expect.stringMatching(/no authenticated.*bridge/i),
  });
});

test('probe ignores stale resident registrations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-stale-probe-test-'));
  const registrationRoot = path.join(root, 'registry');
  await writeRegistration(registrationRoot, {
    updatedAt: new Date(Date.now() - 45_001).toISOString(),
  });
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await expect(client.probeAgentFeedbackBridge(request)).resolves.toMatchObject({
    available: false,
    reason: expect.stringMatching(/no authenticated.*bridge/i),
  });
});

test('probe removes an owned stale resident registration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-stale-cleanup-test-'));
  const registrationRoot = path.join(root, 'registry');
  const stale = await writeRegistration(registrationRoot, {
    updatedAt: new Date(Date.now() - 45_001).toISOString(),
  });
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await client.probeAgentFeedbackBridge(request);

  await expect(stat(stale.file)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('probe preserves an atomic registration refresh that races stale cleanup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-stale-race-test-'));
  const registrationRoot = path.join(root, 'registry');
  const stale = await writeRegistration(registrationRoot, {
    updatedAt: new Date(Date.now() - 45_001).toISOString(),
  });
  const refreshed = { ...stale.registration, updatedAt: new Date().toISOString() };
  const renameSync = fs.renameSync.bind(fs);
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (source === stale.file && String(destination).includes('.stale-')) {
      const temporary = `${stale.file}.refreshed`;
      fs.writeFileSync(temporary, JSON.stringify(refreshed), { mode: 0o600 });
      renameSync(temporary, stale.file);
    }
    renameSync(source, destination);
  });
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  try {
    await client.probeAgentFeedbackBridge(request);
  } finally {
    rename.mockRestore();
  }

  await expect(readFile(stale.file, 'utf8')).resolves.toBe(JSON.stringify(refreshed));
});

test.each([
  ['malformed', { backend: undefined }],
  ['non-string timestamp', { updatedAt: 0 }],
  ['unsupported protocol', { protocolVersion: 2 }],
])('probe preserves a stale %s registration artifact', async (_name, override) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-invalid-cleanup-test-'));
  const registrationRoot = path.join(root, 'registry');
  const registration = await writeRegistration(registrationRoot, {
    updatedAt: new Date(Date.now() - 45_001).toISOString(),
    ...override,
  });
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await client.probeAgentFeedbackBridge(request);

  await expect(stat(registration.file)).resolves.toBeDefined();
});

test('probe preserves a stale registration that is not private', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-permission-cleanup-test-'));
  const registrationRoot = path.join(root, 'registry');
  const registration = await writeRegistration(registrationRoot, {
    updatedAt: new Date(Date.now() - 45_001).toISOString(),
  });
  await chmod(registration.file, 0o640);
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await client.probeAgentFeedbackBridge(request);

  await expect(stat(registration.file)).resolves.toBeDefined();
});

test('probe reports an unauthenticated resident endpoint as unavailable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-auth-probe-test-'));
  const registrationRoot = path.join(root, 'registry');
  const { socketPath } = await createRawServer(root, (_incoming, response) => {
    response.writeHead(401);
    response.end(JSON.stringify({ error: 'Invalid bearer token.' }));
  });
  await writeRegistration(registrationRoot, { endpoint: socketPath });
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await expect(client.probeAgentFeedbackBridge(request)).resolves.toMatchObject({
    available: false,
    reason: expect.stringMatching(/no authenticated.*bridge/i),
  });
});

test('probe reports an unavailable resident endpoint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-endpoint-probe-test-'));
  const registrationRoot = path.join(root, 'registry');
  await writeRegistration(registrationRoot, { endpoint: path.join(root, 'missing.sock') });
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await expect(client.probeAgentFeedbackBridge(request)).resolves.toMatchObject({
    available: false,
    reason: expect.stringMatching(/no authenticated.*bridge/i),
  });
});

test.each([
  ['backend', { backend: 'claude' }],
  ['session', { sessionId: 'other' }],
  ['repository', { repositoryRoot: '/other' }],
])('probe rejects an identity challenge with mismatched %s', async (_field, override) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-mismatch-probe-test-'));
  const registrationRoot = path.join(root, 'registry');
  const { socketPath } = await createRawServer(root, (incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      response.end(
        JSON.stringify({
          backend: 'pi',
          nonce: body.nonce,
          repositoryRoot: '/repo',
          sessionId: 'session-1',
          version: 1,
          ...override,
        }),
      );
    });
  });
  await writeRegistration(registrationRoot, { endpoint: socketPath });
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await expect(client.probeAgentFeedbackBridge(request)).resolves.toMatchObject({
    available: false,
    reason: expect.stringMatching(/no authenticated.*bridge/i),
  });
});

test('delivery independently revalidates after a successful probe', async () => {
  const { bridge, deliver, registrationRoot } = await setup();
  const client = createAgentFeedbackBridgeClient({ registrationRoot });
  await expect(client.probeAgentFeedbackBridge(request)).resolves.toEqual({ available: true });

  await bridge.close();
  resources.splice(resources.indexOf(bridge), 1);

  await expect(client.deliverToAgentFeedbackBridge(request)).rejects.toThrow(
    /no authenticated.*bridge/i,
  );
  expect(deliver).not.toHaveBeenCalled();
});

test('challenges the bridge and delivers the stable formatted message', async () => {
  const { deliver, registrationRoot } = await setup();
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await expect(client.deliverToAgentFeedbackBridge(request)).resolves.toMatchObject({
    deliveryId: 'delivery-1',
    status: 'accepted',
  });
  expect(deliver).toHaveBeenCalledWith({
    deliveryId: 'delivery-1',
    message: [
      'CODIFF_DELIVERY_ID delivery-1',
      '',
      feedback.markdown,
      '',
      'Address every Codiff comment in order. Do not automatically reopen Codiff after handling them.',
    ].join('\n'),
    repositoryRoot: '/repo',
    sessionId: 'session-1',
    version: 1,
  });
});

test('ignores stale, dead, symlinked, and broadly-permissioned registrations', async () => {
  const { bridge, registrationRoot } = await setup();
  const stale = await writeRegistration(registrationRoot, {
    endpoint: bridge.registration.endpoint,
    updatedAt: new Date(Date.now() - 45_001).toISOString(),
  });
  const dead = await writeRegistration(registrationRoot, {
    endpoint: bridge.registration.endpoint,
    pid: 999,
  });
  const broad = await writeRegistration(registrationRoot, {
    endpoint: bridge.registration.endpoint,
  });
  await chmod(broad.file, 0o640);
  const linked = path.join(path.dirname(stale.file), 'linked.json');
  await symlink(stale.file, linked);
  await bridge.close();
  resources.splice(resources.indexOf(bridge), 1);

  const client = createAgentFeedbackBridgeClient({
    isPidAlive: (pid) => pid !== 999,
    registrationRoot,
  });
  await expect(client.deliverToAgentFeedbackBridge(request)).rejects.toThrow(
    /no authenticated.*bridge/i,
  );
});

test('rejects registrations not owned by the current user', async () => {
  const { registrationRoot } = await setup();
  const client = createAgentFeedbackBridgeClient({
    getuid: () => (process.getuid?.() ?? 0) + 1,
    registrationRoot,
  });

  await expect(client.deliverToAgentFeedbackBridge(request)).rejects.toThrow(
    /no authenticated.*bridge/i,
  );
});

test('rejects a symlinked registration root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-client-symlink-test-'));
  const target = path.join(root, 'target');
  const registrationRoot = path.join(root, 'registry');
  await mkdir(path.join(target, 'pi'), { mode: 0o700, recursive: true });
  await chmod(target, 0o700);
  await chmod(path.join(target, 'pi'), 0o700);
  await symlink(target, registrationRoot, 'dir');
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await expect(client.deliverToAgentFeedbackBridge(request)).rejects.toThrow(
    /no authenticated.*bridge/i,
  );
});

test('challenges only the freshest live registration for the exact session', async () => {
  const { registrationRoot } = await setup();
  await writeRegistration(registrationRoot, {
    endpoint: '/older-missing.sock',
    updatedAt: new Date(Date.now() - 1_000).toISOString(),
  });
  await writeRegistration(registrationRoot, {
    endpoint: '/other-session.sock',
    sessionId: 'session-2',
    updatedAt: new Date(Date.now() + 1_000).toISOString(),
  });
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await expect(client.deliverToAgentFeedbackBridge(request)).resolves.toMatchObject({
    status: 'accepted',
  });
});

test('ignores unreasonable future timestamps and falls back past an orphaned reused PID', async () => {
  const { registrationRoot } = await setup();
  await writeRegistration(registrationRoot, {
    endpoint: '/future.sock',
    updatedAt: new Date(Date.now() + 45_001).toISOString(),
  });
  await writeRegistration(registrationRoot, {
    endpoint: '/orphaned.sock',
    pid: process.pid,
    updatedAt: new Date(Date.now() + 1_000).toISOString(),
  });
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await expect(client.deliverToAgentFeedbackBridge(request)).resolves.toMatchObject({
    status: 'accepted',
  });
});

test('falls back after a fresher identity mismatch without delivering to it', async () => {
  const { registrationRoot, root } = await setup();
  let incorrectDeliveries = 0;
  const { socketPath } = await createRawServer(root, (incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      if (incoming.url === '/v1/deliver') incorrectDeliveries += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString());
      response.end(
        JSON.stringify({
          backend: 'pi',
          nonce: body.nonce,
          repositoryRoot: '/wrong',
          sessionId: 'session-1',
          version: 1,
        }),
      );
    });
  });
  await writeRegistration(registrationRoot, {
    endpoint: socketPath,
    updatedAt: new Date(Date.now() + 1_000).toISOString(),
  });
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await expect(client.deliverToAgentFeedbackBridge(request)).resolves.toMatchObject({
    status: 'accepted',
  });
  expect(incorrectDeliveries).toBe(0);
});

test.each([
  ['backend', { backend: 'claude' }],
  ['session', { sessionId: 'other' }],
  ['repository', { repositoryRoot: '/other' }],
  ['nonce', { nonce: 'wrong' }],
])('rejects an identity challenge with mismatched %s as definite', async (_field, override) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-identity-test-'));
  const registrationRoot = path.join(root, 'registry');
  const { socketPath } = await createRawServer(root, (incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      response.end(
        JSON.stringify({
          backend: 'pi',
          nonce: body.nonce,
          repositoryRoot: '/repo',
          sessionId: 'session-1',
          version: 1,
          ...override,
        }),
      );
    });
  });
  await writeRegistration(registrationRoot, { endpoint: socketPath });
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  try {
    await client.deliverToAgentFeedbackBridge(request);
    expect.unreachable('identity mismatch should fail');
  } catch (error) {
    expect(error).not.toHaveProperty('ambiguous');
  }
});

test('rejects a response body larger than 64 KiB after dispatch as ambiguous', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-response-test-'));
  const registrationRoot = path.join(root, 'registry');
  const { socketPath } = await createRawServer(root, (incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      if (incoming.url === '/v1/identity') {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        response.end(
          JSON.stringify({
            backend: 'pi',
            nonce: body.nonce,
            repositoryRoot: '/repo',
            sessionId: 'session-1',
            version: 1,
          }),
        );
      } else {
        response.end('x'.repeat(65_537));
      }
    });
  });
  await writeRegistration(registrationRoot, { endpoint: socketPath });
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await expect(client.deliverToAgentFeedbackBridge(request)).rejects.toMatchObject({
    ambiguous: true,
  });
});

test('classifies a delivery HTTP 500 response after dispatch as ambiguous', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-server-error-test-'));
  const registrationRoot = path.join(root, 'registry');
  const { socketPath } = await createRawServer(root, (incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      if (incoming.url === '/v1/identity') {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        response.end(
          JSON.stringify({
            backend: 'pi',
            nonce: body.nonce,
            repositoryRoot: '/repo',
            sessionId: 'session-1',
            version: 1,
          }),
        );
      } else {
        response.writeHead(500);
        response.end(JSON.stringify({ error: 'Delivery failed.' }));
      }
    });
  });
  await writeRegistration(registrationRoot, { endpoint: socketPath });
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await expect(client.deliverToAgentFeedbackBridge(request)).rejects.toMatchObject({
    ambiguous: true,
    message: 'Delivery failed.',
  });
});

test('classifies a delivery HTTP 400 validation response as definite', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-validation-error-test-'));
  const registrationRoot = path.join(root, 'registry');
  const { socketPath } = await createRawServer(root, (incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      if (incoming.url === '/v1/identity') {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        response.end(
          JSON.stringify({
            backend: 'pi',
            nonce: body.nonce,
            repositoryRoot: '/repo',
            sessionId: 'session-1',
            version: 1,
          }),
        );
      } else {
        response.writeHead(400);
        response.end(JSON.stringify({ error: 'Invalid delivery request.' }));
      }
    });
  });
  await writeRegistration(registrationRoot, { endpoint: socketPath });
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  try {
    await client.deliverToAgentFeedbackBridge(request);
    expect.unreachable('validation failure should reject');
  } catch (error) {
    expect(error).toMatchObject({ message: 'Invalid delivery request.' });
    expect(error).not.toHaveProperty('ambiguous');
  }
});

test('classifies a delivery timeout after dispatch as ambiguous', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-timeout-test-'));
  const registrationRoot = path.join(root, 'registry');
  const { socketPath } = await createRawServer(root, (incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      if (incoming.url === '/v1/identity') {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        response.end(
          JSON.stringify({
            backend: 'pi',
            nonce: body.nonce,
            repositoryRoot: '/repo',
            sessionId: 'session-1',
            version: 1,
          }),
        );
      }
    });
  });
  await writeRegistration(registrationRoot, { endpoint: socketPath });
  const client = createAgentFeedbackBridgeClient({ registrationRoot, timeoutMs: 20 });

  await expect(client.deliverToAgentFeedbackBridge(request)).rejects.toMatchObject({
    ambiguous: true,
  });
});

test('uses an absolute deadline despite trickled response bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-deadline-test-'));
  const registrationRoot = path.join(root, 'registry');
  const { socketPath } = await createRawServer(root, (incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      if (incoming.url === '/v1/identity') {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        response.end(
          JSON.stringify({
            backend: 'pi',
            nonce: body.nonce,
            repositoryRoot: '/repo',
            sessionId: 'session-1',
            version: 1,
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      const interval = setInterval(() => response.write(' '), 5);
      response.on('close', () => clearInterval(interval));
    });
  });
  await writeRegistration(registrationRoot, { endpoint: socketPath });
  const client = createAgentFeedbackBridgeClient({ registrationRoot, timeoutMs: 30 });
  const startedAt = Date.now();

  await expect(client.deliverToAgentFeedbackBridge(request)).rejects.toMatchObject({
    ambiguous: true,
  });
  expect(Date.now() - startedAt).toBeLessThan(200);
});

test.each([
  ['wrong delivery ID', { assurance: 'dispatch-started', deliveryId: 'wrong', status: 'accepted' }],
  [
    'wrong assurance',
    { assurance: 'transport-write', deliveryId: 'delivery-1', status: 'accepted' },
  ],
  ['unknown status', { deliveryId: 'delivery-1', status: 'unknown' }],
  ['empty rejection', { deliveryId: 'delivery-1', reason: ' ', status: 'rejected' }],
  [
    'unexpected field',
    { assurance: 'dispatch-started', deliveryId: 'delivery-1', extra: true, status: 'accepted' },
  ],
])('rejects malformed delivery acknowledgement: %s', async (_name, acknowledgement) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-ack-test-'));
  const registrationRoot = path.join(root, 'registry');
  const { socketPath } = await createRawServer(root, (incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      if (incoming.url === '/v1/identity') {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        response.end(
          JSON.stringify({
            backend: 'pi',
            nonce: body.nonce,
            repositoryRoot: '/repo',
            sessionId: 'session-1',
            version: 1,
          }),
        );
      } else {
        response.end(JSON.stringify(acknowledgement));
      }
    });
  });
  await writeRegistration(registrationRoot, { endpoint: socketPath });
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await expect(client.deliverToAgentFeedbackBridge(request)).rejects.toMatchObject({
    ambiguous: true,
  });
});

test('classifies connection loss after the delivery body completes as ambiguous', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codiff-loss-test-'));
  const registrationRoot = path.join(root, 'registry');
  const { socketPath } = await createRawServer(root, (incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      if (incoming.url === '/v1/identity') {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        response.end(
          JSON.stringify({
            backend: 'pi',
            nonce: body.nonce,
            repositoryRoot: '/repo',
            sessionId: 'session-1',
            version: 1,
          }),
        );
      } else {
        response.socket?.destroy();
      }
    });
  });
  await writeRegistration(registrationRoot, { endpoint: socketPath });
  const client = createAgentFeedbackBridgeClient({ registrationRoot });

  await expect(client.deliverToAgentFeedbackBridge(request)).rejects.toMatchObject({
    ambiguous: true,
  });
});
