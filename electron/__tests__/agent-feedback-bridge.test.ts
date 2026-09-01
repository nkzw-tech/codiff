import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
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
