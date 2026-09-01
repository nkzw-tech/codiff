import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import type {
  AgentBackend,
  AgentFeedbackDeliveryRequest,
  AgentFeedbackDeliveryResponse,
  AgentReviewFeedback,
} from '../../core/types.ts';

const require = createRequire(import.meta.url);
const { createAgentFeedbackAdapters } = require('../agent-feedback-adapters.cjs') as {
  createAgentFeedbackAdapters: (options: {
    bridgeProbe?: (identity: DeliveryIdentity) => Promise<{ available: boolean; reason?: string }>;
    spawnProcess: SpawnProcess;
  }) => Record<
    AgentBackend,
    {
      deliver: (request: AgentFeedbackDeliveryRequest) => Promise<AgentFeedbackDeliveryResponse>;
      probe: (identity: DeliveryIdentity) => Promise<{ available: boolean; reason?: string }>;
    }
  >;
};
const { formatAgentFeedbackMessage } = require('../agent-feedback-delivery.cjs') as {
  formatAgentFeedbackMessage: (request: AgentFeedbackDeliveryRequest) => string;
};

type DeliveryIdentity = Pick<
  AgentFeedbackDeliveryRequest,
  'backend' | 'repositoryRoot' | 'sessionId'
>;
type SpawnProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: Record<string, unknown>,
) => ChildProcess;

class ChildProcess extends EventEmitter {
  kill = vi.fn();
  stderr = new PassThrough();
  stdout = new PassThrough();
}

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
  backend: 'codex',
  deliveryId: 'delivery-1',
  feedback,
  repositoryRoot: '/repo',
  sessionId: '12345678-1234-1234-1234-123456789abc',
  version: 1,
};

const createSpawn = ({
  code = 0,
  error,
  signal = null,
  stderr = '',
  stdout = '',
}: {
  code?: number | null;
  error?: Error;
  signal?: NodeJS.Signals | null;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
} = {}) => {
  const children: Array<ChildProcess> = [];
  const spawnProcess = vi.fn<SpawnProcess>(() => {
    const child = new ChildProcess();
    children.push(child);
    queueMicrotask(() => {
      if (error) {
        child.emit('error', error);
        return;
      }
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.emit('close', code, signal);
    });
    return child;
  });
  return { children, spawnProcess };
};

afterEach(() => {
  vi.useRealTimers();
});

test('creates adapters for all supported backends', () => {
  const { spawnProcess } = createSpawn();
  const adapters = createAgentFeedbackAdapters({ spawnProcess });

  expect(Object.keys(adapters).sort()).toEqual(['claude', 'codex', 'opencode', 'pi']);
});

test.each(['claude', 'opencode', 'pi'] as const)(
  '%s probes the authenticated resident bridge for the exact identity',
  async (backend) => {
    const { spawnProcess } = createSpawn();
    const bridgeProbe = vi.fn(async () => ({ available: true }));
    const adapter = createAgentFeedbackAdapters({ bridgeProbe, spawnProcess })[backend];
    const identity = { backend, repositoryRoot: '/repo', sessionId: 'session-1' };

    await expect(adapter.probe(identity)).resolves.toEqual({ available: true });
    expect(bridgeProbe).toHaveBeenCalledWith(identity);
  },
);

test('probes Codex native queue support without a shell', async () => {
  const { spawnProcess } = createSpawn({ stdout: 'Usage: codex queue --thread ID --message TEXT' });
  const adapter = createAgentFeedbackAdapters({ spawnProcess }).codex;

  await expect(adapter.probe(request)).resolves.toEqual({ available: true });
  expect(spawnProcess).toHaveBeenCalledWith(
    'codex',
    ['queue', '--help'],
    expect.objectContaining({ shell: false }),
  );
});

test('reports Codex queue unavailable unless help documents both required flags', async () => {
  const { spawnProcess } = createSpawn({ stdout: 'Usage: codex queue --thread ID' });
  const adapter = createAgentFeedbackAdapters({ spawnProcess }).codex;

  await expect(adapter.probe(request)).resolves.toMatchObject({
    available: false,
    reason: expect.stringMatching(/--thread.*--message|queue capability/i),
  });
});

test('reports a missing Codex executable as unavailable', async () => {
  const error = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
  const { spawnProcess } = createSpawn({ error });
  const adapter = createAgentFeedbackAdapters({ spawnProcess }).codex;

  await expect(adapter.probe(request)).resolves.toMatchObject({
    available: false,
    reason: expect.stringMatching(/not found|unavailable/i),
  });
});

test('queues the exact formatted message and validates the echoed thread', async () => {
  const { spawnProcess } = createSpawn({
    stdout: `Queued message msg-1 for thread ${request.sessionId}.\n`,
  });
  const adapter = createAgentFeedbackAdapters({ spawnProcess }).codex;

  await expect(adapter.deliver(request)).resolves.toEqual({
    assurance: 'queue-command',
    deliveryId: request.deliveryId,
    status: 'queued',
  });
  expect(spawnProcess).toHaveBeenCalledWith(
    'codex',
    ['queue', '--thread', request.sessionId, '--message', formatAgentFeedbackMessage(request)],
    expect.objectContaining({ shell: false }),
  );
});

test('rejects Codex feedback over 24 KiB before spawning', async () => {
  const { spawnProcess } = createSpawn();
  const adapter = createAgentFeedbackAdapters({ spawnProcess }).codex;
  const oversized = {
    ...request,
    feedback: { ...feedback, markdown: '🙂'.repeat(24 * 1024) },
  };

  await expect(adapter.deliver(oversized)).rejects.toThrow('exceeds 24 KiB');
  expect(spawnProcess).not.toHaveBeenCalled();
});

test('treats an acknowledgement for another thread as ambiguous', async () => {
  const { spawnProcess } = createSpawn({
    stdout: 'Queued message msg-1 for thread aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.\n',
  });
  const adapter = createAgentFeedbackAdapters({ spawnProcess }).codex;

  await expect(adapter.deliver(request)).rejects.toMatchObject({
    ambiguous: true,
    message: 'Codex returned an unexpected queue acknowledgement.',
  });
});

test('treats malformed acknowledgement output as ambiguous', async () => {
  const { spawnProcess } = createSpawn({ stdout: `Queued for thread ${request.sessionId}` });
  const adapter = createAgentFeedbackAdapters({ spawnProcess }).codex;

  await expect(adapter.deliver(request)).rejects.toMatchObject({ ambiguous: true });
});

test('reports a nonzero rejection with stderr as definite', async () => {
  const { spawnProcess } = createSpawn({ code: 2, stderr: 'thread is closed' });
  const adapter = createAgentFeedbackAdapters({ spawnProcess }).codex;

  try {
    await adapter.deliver(request);
    throw new Error('Expected delivery to fail.');
  } catch (error) {
    expect(error).toMatchObject({ message: 'thread is closed' });
    expect(error).not.toHaveProperty('ambiguous');
  }
});

test('treats a nonzero exit without diagnostic output as ambiguous', async () => {
  const { spawnProcess } = createSpawn({ code: 2 });
  const adapter = createAgentFeedbackAdapters({ spawnProcess }).codex;

  await expect(adapter.deliver(request)).rejects.toMatchObject({ ambiguous: true });
});

test('treats termination by signal as ambiguous', async () => {
  const { spawnProcess } = createSpawn({ code: null, signal: 'SIGTERM' });
  const adapter = createAgentFeedbackAdapters({ spawnProcess }).codex;

  await expect(adapter.deliver(request)).rejects.toMatchObject({ ambiguous: true });
});

test('treats output beyond one MiB as ambiguous and terminates the process', async () => {
  const { children, spawnProcess } = createSpawn({ stdout: Buffer.alloc(1_048_577, 97) });
  const adapter = createAgentFeedbackAdapters({ spawnProcess }).codex;

  await expect(adapter.deliver(request)).rejects.toMatchObject({
    ambiguous: true,
    message: 'Codex queue output exceeded its limit.',
  });
  expect(children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
});

test('applies an absolute ten-second timeout and treats it as ambiguous', async () => {
  vi.useFakeTimers();
  const child = new ChildProcess();
  const spawnProcess = vi.fn<SpawnProcess>(() => child);
  const adapter = createAgentFeedbackAdapters({ spawnProcess }).codex;
  const delivery = adapter.deliver(request);
  const rejection = expect(delivery).rejects.toMatchObject({
    ambiguous: true,
    message: 'Codex queue timed out.',
  });

  await vi.advanceTimersByTimeAsync(10_000);
  child.emit('close', null, 'SIGTERM');

  await rejection;
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
});

test('waits for a timed-out Codex process to close and escalates termination', async () => {
  vi.useFakeTimers();
  const child = new ChildProcess();
  const spawnProcess = vi.fn<SpawnProcess>(() => child);
  const adapter = createAgentFeedbackAdapters({ spawnProcess }).codex;
  const delivery = adapter.deliver(request);
  let settled = false;
  void delivery.catch(() => {
    settled = true;
  });

  await vi.advanceTimersByTimeAsync(10_000);
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(settled).toBe(false);

  await vi.advanceTimersByTimeAsync(1_000);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(settled).toBe(false);

  child.emit('close', null, 'SIGKILL');
  await expect(delivery).rejects.toMatchObject({
    ambiguous: true,
    message: 'Codex queue timed out.',
  });
});

test('keeps escalating when a timed-out Codex process emits a signal error', async () => {
  vi.useFakeTimers();
  const child = new ChildProcess();
  const spawnProcess = vi.fn<SpawnProcess>(() => child);
  const delivery = createAgentFeedbackAdapters({ spawnProcess }).codex.deliver(request);
  const rejection = expect(delivery).rejects.toMatchObject({ message: 'Codex queue timed out.' });

  await vi.advanceTimersByTimeAsync(10_000);
  child.emit('error', new Error('SIGTERM failed'));
  await vi.advanceTimersByTimeAsync(1_000);

  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  child.emit('close', null, 'SIGKILL');
  await rejection;
});

test('settles ambiguously when a killed Codex process never emits close', async () => {
  vi.useFakeTimers();
  const child = new ChildProcess();
  const spawnProcess = vi.fn<SpawnProcess>(() => child);
  const delivery = createAgentFeedbackAdapters({ spawnProcess }).codex.deliver(request);
  let settled = false;
  void delivery.catch(() => {
    settled = true;
  });

  await vi.advanceTimersByTimeAsync(12_000);

  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(settled).toBe(true);
  await expect(delivery).rejects.toMatchObject({
    ambiguous: true,
    message: 'Codex queue timed out.',
  });
});

test('treats ENOENT during delivery as a definite failure', async () => {
  const error = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
  const { spawnProcess } = createSpawn({ error });
  const adapter = createAgentFeedbackAdapters({ spawnProcess }).codex;

  try {
    await adapter.deliver(request);
    throw new Error('Expected delivery to fail.');
  } catch (caught) {
    expect(caught).toBe(error);
    expect(caught).not.toHaveProperty('ambiguous');
  }
});
