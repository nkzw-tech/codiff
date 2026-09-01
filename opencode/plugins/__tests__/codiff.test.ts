import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

const bridges: Array<{
  close: ReturnType<typeof vi.fn>;
  options: {
    backend: string;
    deliver: (item: Delivery) => Promise<Record<string, unknown>>;
    getIdentity: () => { repositoryRoot: string; sessionId: string };
  };
}> = [];

vi.mock('../../../bin/agent-feedback-bridge.mjs', () => ({
  createAgentFeedbackBridge: vi.fn(async (options) => {
    const bridge = { close: vi.fn(async () => {}), options };
    bridges.push(bridge);
    return bridge;
  }),
}));

import { CodiffPlugin } from '../codiff.js';

type Delivery = {
  deliveryId: string;
  message: string;
  repositoryRoot: string;
  sessionId: string;
  version: number;
};

const delivery = (deliveryId: string, sessionId = 'ses_1'): Delivery => ({
  deliveryId,
  message: `Feedback ${deliveryId}`,
  repositoryRoot: '/repo',
  sessionId,
  version: 1,
});

const setup = async (overrides?: {
  promptAsync?: (input: {
    body: { messageID: string; parts: Array<{ text: string; type: string }> };
    path: { id: string };
  }) => Promise<{ error?: unknown; response?: { status: number } }>;
  status?: () => Promise<{ data?: Record<string, { type: string }>; error?: unknown }>;
}) => {
  const statuses = new Map<string, { type: string }>();
  const client = {
    session: {
      promptAsync: vi.fn(overrides?.promptAsync ?? (async () => ({ response: { status: 204 } }))),
      status: vi.fn(overrides?.status ?? (async () => ({ data: Object.fromEntries(statuses) }))),
    },
  };
  const hooks = await CodiffPlugin({ client, worktree: '/repo' });
  return { client, hooks, statuses };
};

const promptMessageID = (client: Awaited<ReturnType<typeof setup>>['client'], index = 0) => {
  const call = client.session.promptAsync.mock.calls[index]?.[0];
  if (!call) {
    throw new Error(`Missing promptAsync call ${index}.`);
  }
  return call.body.messageID;
};

const correlate = async (
  hooks: Awaited<ReturnType<typeof setup>>['hooks'],
  messageID: string,
  sessionID = 'ses_1',
) =>
  hooks.event({
    event: {
      properties: { info: { id: messageID, role: 'user', sessionID } },
      type: 'message.updated',
    },
  });

const deferred = <T>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
};

beforeEach(() => {
  bridges.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('registers each chat session with its exact OpenCode identity', async () => {
  const { hooks } = await setup();

  await hooks['chat.message']({ sessionID: 'ses_1' }, {});
  await hooks['chat.message']({ sessionID: 'ses_2' }, {});
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});

  expect(bridges).toHaveLength(2);
  expect(bridges.map(({ options }) => options.backend)).toEqual(['opencode', 'opencode']);
  expect(bridges.map(({ options }) => options.getIdentity())).toEqual([
    { repositoryRoot: '/repo', sessionId: 'ses_1' },
    { repositoryRoot: '/repo', sessionId: 'ses_2' },
  ]);
});

test('queues busy deliveries FIFO and dispatches one item per idle boundary', async () => {
  const { client, hooks, statuses } = await setup();
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});
  statuses.set('ses_1', { type: 'busy' });

  await expect(bridges[0].options.deliver(delivery('delivery-1'))).resolves.toMatchObject({
    assurance: 'bridge-queue',
    deliveryId: 'delivery-1',
    status: 'queued',
  });
  await expect(bridges[0].options.deliver(delivery('delivery-2'))).resolves.toMatchObject({
    assurance: 'bridge-queue',
    deliveryId: 'delivery-2',
    status: 'queued',
  });
  expect(client.session.promptAsync).not.toHaveBeenCalled();

  statuses.set('ses_1', { type: 'idle' });
  const firstIdle = hooks.event({
    event: { properties: { sessionID: 'ses_1' }, type: 'session.idle' },
  });
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
  expect(client.session.promptAsync).toHaveBeenLastCalledWith({
    body: {
      messageID: expect.stringMatching(/^msg_codiff_[a-f\d]{64}$/),
      parts: [{ text: 'Feedback delivery-1', type: 'text' }],
    },
    path: { id: 'ses_1' },
  });
  await hooks.event({
    event: {
      properties: {
        info: { id: promptMessageID(client), role: 'user', sessionID: 'ses_1' },
      },
      type: 'message.updated',
    },
  });
  await firstIdle;
  expect(client.session.promptAsync).toHaveBeenCalledTimes(1);

  const secondIdle = hooks.event({
    event: { properties: { sessionID: 'ses_1' }, type: 'session.idle' },
  });
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2));
  expect(promptMessageID(client, 1)).not.toBe(promptMessageID(client));
  await hooks.event({
    event: {
      properties: {
        info: { id: promptMessageID(client, 1), role: 'user', sessionID: 'ses_1' },
      },
      type: 'message.updated',
    },
  });
  await secondIdle;
});

test('acknowledges idle delivery only after exact user message correlation', async () => {
  const { client, hooks, statuses } = await setup();
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});
  statuses.set('ses_1', { type: 'idle' });
  let settled = false;
  const result = bridges[0].options.deliver(delivery('delivery-1')).then((receipt) => {
    settled = true;
    return receipt;
  });
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce());

  for (const info of [
    { id: 'msg_codiff_wrong', role: 'user', sessionID: 'ses_1' },
    { id: promptMessageID(client), role: 'assistant', sessionID: 'ses_1' },
    { id: promptMessageID(client), role: 'user', sessionID: 'ses_2' },
  ]) {
    await hooks.event({ event: { properties: { info }, type: 'message.updated' } });
    await Promise.resolve();
    expect(settled).toBe(false);
  }

  await hooks.event({
    event: {
      properties: {
        info: { id: promptMessageID(client), role: 'user', sessionID: 'ses_1' },
      },
      type: 'message.updated',
    },
  });
  await expect(result).resolves.toEqual({
    assurance: 'message-created',
    deliveryId: 'delivery-1',
    status: 'accepted',
  });
});

test('keeps queues independent per session', async () => {
  const { hooks, statuses } = await setup();
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});
  await hooks['chat.message']({ sessionID: 'ses_2' }, {});
  statuses.set('ses_1', { type: 'busy' });
  statuses.set('ses_2', { type: 'busy' });

  await expect(bridges[0].options.deliver(delivery('same-id', 'ses_1'))).resolves.toMatchObject({
    status: 'queued',
  });
  await expect(bridges[1].options.deliver(delivery('same-id', 'ses_2'))).resolves.toMatchObject({
    status: 'queued',
  });
});

test('coalesces concurrent duplicate IDs into one OpenCode message', async () => {
  const { client, hooks, statuses } = await setup();
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});
  statuses.set('ses_1', { type: 'idle' });

  const first = bridges[0].options.deliver(delivery('same-id'));
  const duplicate = bridges[0].options.deliver(delivery('same-id'));
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalled());
  expect(client.session.promptAsync).toHaveBeenCalledOnce();

  await correlate(hooks, promptMessageID(client));
  await expect(Promise.all([first, duplicate])).resolves.toEqual([
    { assurance: 'message-created', deliveryId: 'same-id', status: 'accepted' },
    { assurance: 'message-created', deliveryId: 'same-id', status: 'accepted' },
  ]);
});

test('serializes distinct concurrent delivery decisions and queues later work', async () => {
  const statusResult = deferred<{ data: Record<string, { type: string }> }>();
  const { client, hooks } = await setup({ status: () => statusResult.promise });
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});

  const first = bridges[0].options.deliver(delivery('delivery-1'));
  await vi.waitFor(() => expect(client.session.status).toHaveBeenCalledOnce());
  const second = bridges[0].options.deliver(delivery('delivery-2'));
  await Promise.resolve();
  expect(client.session.status).toHaveBeenCalledOnce();
  expect(client.session.promptAsync).not.toHaveBeenCalled();

  statusResult.resolve({ data: { ses_1: { type: 'idle' } } });
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce());
  await expect(second).resolves.toMatchObject({ assurance: 'bridge-queue', status: 'queued' });
  expect(client.session.status).toHaveBeenCalledOnce();
  await correlate(hooks, promptMessageID(client));
  await expect(first).resolves.toMatchObject({ assurance: 'message-created' });
});

test.each([
  ['retry', { data: { ses_1: { type: 'retry' } } }],
  ['another non-idle state', { data: { ses_1: { type: 'cooldown' } } }],
  ['status API error', { error: new Error('unavailable') }],
] as const)('queues when status is %s', async (_label, statusResult) => {
  const { client, hooks } = await setup({ status: async () => statusResult });
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});

  await expect(bridges[0].options.deliver(delivery('delivery-1'))).resolves.toMatchObject({
    assurance: 'bridge-queue',
    status: 'queued',
  });
  expect(client.session.promptAsync).not.toHaveBeenCalled();
});

test('treats a successful status response without the exact session as idle', async () => {
  const { client, hooks } = await setup({
    status: async () => ({ data: { ses_other: { type: 'busy' } } }),
  });
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});

  const pending = bridges[0].options.deliver(delivery('delivery-1'));
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce());
  await correlate(hooks, promptMessageID(client));

  await expect(pending).resolves.toMatchObject({ assurance: 'message-created' });
});

test('queues when the status request throws', async () => {
  const { client, hooks } = await setup({
    status: async () => {
      throw new Error('status transport unavailable');
    },
  });
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});

  await expect(bridges[0].options.deliver(delivery('delivery-1'))).resolves.toMatchObject({
    assurance: 'bridge-queue',
    status: 'queued',
  });
  expect(client.session.promptAsync).not.toHaveBeenCalled();
});

test('rechecks status during idle drain and retains work when human input races', async () => {
  const statuses = [
    { data: { ses_1: { type: 'busy' } } },
    { data: { ses_1: { type: 'retry' } } },
    { data: { ses_1: { type: 'idle' } } },
  ];
  const { client, hooks } = await setup({ status: async () => statuses.shift() ?? { data: {} } });
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});
  await bridges[0].options.deliver(delivery('delivery-1'));

  await hooks.event({ event: { properties: { sessionID: 'ses_1' }, type: 'session.idle' } });
  expect(client.session.promptAsync).not.toHaveBeenCalled();

  const idle = hooks.event({
    event: { properties: { sessionID: 'ses_1' }, type: 'session.idle' },
  });
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce());
  await correlate(hooks, promptMessageID(client));
  await idle;
  expect(client.session.status).toHaveBeenCalledTimes(3);
});

test('hashes session and delivery identity without normalization collisions', async () => {
  const { client, hooks, statuses } = await setup();
  statuses.set('ses_1', { type: 'idle' });
  statuses.set('ses_2', { type: 'idle' });
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});
  await hooks['chat.message']({ sessionID: 'ses_2' }, {});

  const sessionOne = bridges[0].options.deliver(delivery('same-id', 'ses_1'));
  const sessionTwo = bridges[1].options.deliver(delivery('same-id', 'ses_2'));
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2));
  const firstID = promptMessageID(client);
  const secondID = promptMessageID(client, 1);
  expect(firstID).not.toBe(secondID);
  expect(firstID).toMatch(/^msg_codiff_[a-f\d]{64}$/);
  expect(secondID).toMatch(/^msg_codiff_[a-f\d]{64}$/);
  await correlate(hooks, firstID, 'ses_1');
  await correlate(hooks, secondID, 'ses_2');
  await Promise.all([sessionOne, sessionTwo]);

  const hyphenated = bridges[0].options.deliver(delivery('a-b'));
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(3));
  const hyphenatedID = promptMessageID(client, 2);
  await correlate(hooks, hyphenatedID);
  await hyphenated;
  const plain = bridges[0].options.deliver(delivery('ab'));
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(4));
  const plainID = promptMessageID(client, 3);
  expect(hyphenatedID).not.toBe(plainID);
  await correlate(hooks, plainID);
  await plain;
});

test('does not submit after disposal wins a paused status check', async () => {
  const statusResult = deferred<{ data: Record<string, { type: string }> }>();
  const { client, hooks } = await setup({ status: () => statusResult.promise });
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});
  const pending = bridges[0].options.deliver(delivery('delivery-1'));
  await vi.waitFor(() => expect(client.session.status).toHaveBeenCalledOnce());

  const disposing = hooks.dispose();
  statusResult.resolve({ data: { ses_1: { type: 'idle' } } });

  await expect(pending).rejects.toThrow('OpenCode feedback plugin was disposed.');
  await disposing;
  expect(client.session.promptAsync).not.toHaveBeenCalled();
});

test('requeues an explicit non-204 rejection for the next idle boundary', async () => {
  let promptCalls = 0;
  const { client, hooks, statuses } = await setup({
    promptAsync: async () => {
      promptCalls++;
      if (promptCalls === 1) {
        return { response: { status: 409 } };
      }
      return { response: { status: 204 } };
    },
  });
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});
  statuses.set('ses_1', { type: 'idle' });

  await expect(bridges[0].options.deliver(delivery('delivery-1'))).resolves.toMatchObject({
    assurance: 'bridge-queue',
    status: 'queued',
  });
  expect(client.session.promptAsync).toHaveBeenCalledOnce();

  const idle = hooks.event({
    event: { properties: { sessionID: 'ses_1' }, type: 'session.idle' },
  });
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2));
  await correlate(hooks, promptMessageID(client, 1));
  await idle;
});

test('bounds explicit non-204 retries and emits a static exhaustion diagnostic', async () => {
  const diagnostic = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const { client, hooks, statuses } = await setup({
    promptAsync: async () => ({ response: { status: 503 } }),
  });
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});
  statuses.set('ses_1', { type: 'idle' });
  await bridges[0].options.deliver(delivery('delivery-1'));

  await hooks.event({ event: { properties: { sessionID: 'ses_1' }, type: 'session.idle' } });
  await hooks.event({ event: { properties: { sessionID: 'ses_1' }, type: 'session.idle' } });
  await hooks.event({ event: { properties: { sessionID: 'ses_1' }, type: 'session.idle' } });

  expect(client.session.promptAsync).toHaveBeenCalledTimes(3);
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(diagnostic).toHaveBeenCalledWith(
    'Codiff OpenCode feedback delivery exhausted pre-acceptance retries.\n',
  );
});

test.each([
  [
    'transport exception',
    async () => {
      throw new Error('transport failed with token secret');
    },
  ],
  ['SDK error without response', async () => ({ error: new Error('SDK token secret') })],
  ['response loss', async () => ({})],
] as const)('marks %s ambiguous and never retries it on idle', async (_label, promptAsync) => {
  const diagnostic = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const { client, hooks, statuses } = await setup({ promptAsync });
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});
  statuses.set('ses_1', { type: 'idle' });

  await expect(bridges[0].options.deliver(delivery('delivery-1'))).rejects.toThrow('ambiguous');
  expect(diagnostic).toHaveBeenCalledWith(
    'Codiff OpenCode feedback delivery became ambiguous after prompt acceptance.\n',
  );

  await hooks.event({ event: { properties: { sessionID: 'ses_1' }, type: 'session.idle' } });
  await expect(bridges[0].options.deliver(delivery('delivery-1'))).rejects.toThrow('ambiguous');
  expect(client.session.promptAsync).toHaveBeenCalledOnce();
});

test('blocks a distinct delivery after transport ambiguity until a later idle boundary', async () => {
  const firstPrompt = deferred<{ response: { status: number } }>();
  const context: { hooks?: Awaited<ReturnType<typeof setup>>['hooks'] } = {};
  let promptCalls = 0;
  const configured = await setup({
    promptAsync: async (input) => {
      promptCalls++;
      if (promptCalls === 1) {
        return firstPrompt.promise;
      }
      queueMicrotask(() => void correlate(context.hooks!, input.body.messageID));
      return { response: { status: 204 } };
    },
  });
  const { client, hooks } = configured;
  context.hooks = hooks;
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});

  const first = bridges[0].options.deliver(delivery('delivery-1'));
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce());
  const second = bridges[0].options.deliver(delivery('delivery-2'));
  firstPrompt.reject(new Error('transport outcome unknown'));

  await expect(first).rejects.toThrow('ambiguous');
  await expect(second).resolves.toMatchObject({ assurance: 'bridge-queue', status: 'queued' });
  expect(client.session.promptAsync).toHaveBeenCalledOnce();

  const idle = hooks.event({
    event: { properties: { sessionID: 'ses_1' }, type: 'session.idle' },
  });
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2));
  await idle;
});

test('consumes one idle boundary that arrives while an ambiguous prompt is pending', async () => {
  const firstPrompt = deferred<{ response: { status: number } }>();
  const context: { hooks?: Awaited<ReturnType<typeof setup>>['hooks'] } = {};
  let promptCalls = 0;
  const configured = await setup({
    promptAsync: async (input) => {
      promptCalls++;
      if (promptCalls === 1) {
        return firstPrompt.promise;
      }
      queueMicrotask(() => void correlate(context.hooks!, input.body.messageID));
      return { response: { status: 204 } };
    },
  });
  const { client, hooks } = configured;
  context.hooks = hooks;
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});

  const first = bridges[0].options.deliver(delivery('delivery-1'));
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce());
  const second = bridges[0].options.deliver(delivery('delivery-2'));
  const idle = hooks.event({
    event: { properties: { sessionID: 'ses_1' }, type: 'session.idle' },
  });
  const third = bridges[0].options.deliver(delivery('delivery-3'));
  await Promise.resolve();
  expect(client.session.promptAsync).toHaveBeenCalledOnce();

  firstPrompt.reject(new Error('transport outcome unknown'));
  await expect(first).rejects.toThrow('ambiguous');
  await expect(second).resolves.toMatchObject({ assurance: 'bridge-queue', status: 'queued' });
  await expect(third).resolves.toMatchObject({ assurance: 'bridge-queue', status: 'queued' });
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2));
  await idle;
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2));

  const nextIdle = hooks.event({
    event: { properties: { sessionID: 'ses_1' }, type: 'session.idle' },
  });
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(3));
  await nextIdle;
});

test('marks post-acceptance correlation timeout ambiguous without retrying', async () => {
  vi.useFakeTimers();
  const diagnostic = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const { client, hooks, statuses } = await setup();
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});
  statuses.set('ses_1', { type: 'idle' });
  const pending = bridges[0].options.deliver(delivery('delivery-1'));
  await vi.advanceTimersByTimeAsync(0);
  expect(client.session.promptAsync).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(10_000);
  await expect(pending).rejects.toThrow('Timed out waiting for OpenCode');
  expect(diagnostic).toHaveBeenCalledWith(
    'Codiff OpenCode feedback delivery became ambiguous after prompt acceptance.\n',
  );

  await hooks.event({ event: { properties: { sessionID: 'ses_1' }, type: 'session.idle' } });
  await expect(bridges[0].options.deliver(delivery('delivery-1'))).rejects.toThrow('ambiguous');
  expect(client.session.promptAsync).toHaveBeenCalledOnce();
});

test('disposal closes bridges and rejects outstanding message waiters', async () => {
  const { client, hooks, statuses } = await setup();
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});
  statuses.set('ses_1', { type: 'idle' });
  const pending = bridges[0].options.deliver(delivery('delivery-1'));
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce());

  await hooks.dispose();

  await expect(pending).rejects.toThrow('OpenCode feedback plugin was disposed.');
  expect(bridges[0].close).toHaveBeenCalledOnce();
  await expect(
    hooks.event({ event: { properties: { sessionID: 'ses_1' }, type: 'session.idle' } }),
  ).resolves.toBeUndefined();
});
