import { beforeEach, expect, test, vi } from 'vite-plus/test';

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

const setup = async () => {
  const statuses = new Map<string, { type: string }>();
  const client = {
    session: {
      promptAsync: vi.fn(
        async (_input: {
          body: { messageID: string; parts: Array<{ text: string; type: string }> };
          path: { id: string };
        }) => ({ response: { status: 204 } }),
      ),
      status: vi.fn(async () => ({ data: Object.fromEntries(statuses) })),
    },
  };
  const hooks = await CodiffPlugin({ client, worktree: '/repo' });
  return { client, hooks, statuses };
};

const messageID = (deliveryId: string) => `msg_codiff_${deliveryId.replaceAll('-', '')}`;

beforeEach(() => {
  bridges.length = 0;
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

  const firstIdle = hooks.event({
    event: { properties: { sessionID: 'ses_1' }, type: 'session.idle' },
  });
  await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
  expect(client.session.promptAsync).toHaveBeenLastCalledWith({
    body: {
      messageID: messageID('delivery-1'),
      parts: [{ text: 'Feedback delivery-1', type: 'text' }],
    },
    path: { id: 'ses_1' },
  });
  await hooks.event({
    event: {
      properties: {
        info: { id: messageID('delivery-1'), role: 'user', sessionID: 'ses_1' },
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
  expect(client.session.promptAsync.mock.calls[1]?.[0].body.messageID).toBe(
    messageID('delivery-2'),
  );
  await hooks.event({
    event: {
      properties: {
        info: { id: messageID('delivery-2'), role: 'user', sessionID: 'ses_1' },
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
    { id: messageID('other'), role: 'user', sessionID: 'ses_1' },
    { id: messageID('delivery-1'), role: 'assistant', sessionID: 'ses_1' },
    { id: messageID('delivery-1'), role: 'user', sessionID: 'ses_2' },
  ]) {
    await hooks.event({ event: { properties: { info }, type: 'message.updated' } });
    await Promise.resolve();
    expect(settled).toBe(false);
  }

  await hooks.event({
    event: {
      properties: {
        info: { id: messageID('delivery-1'), role: 'user', sessionID: 'ses_1' },
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

test('keeps queues independent and suppresses duplicate delivery IDs per session', async () => {
  const { hooks, statuses } = await setup();
  await hooks['chat.message']({ sessionID: 'ses_1' }, {});
  await hooks['chat.message']({ sessionID: 'ses_2' }, {});
  statuses.set('ses_1', { type: 'busy' });
  statuses.set('ses_2', { type: 'busy' });

  await expect(bridges[0].options.deliver(delivery('same-id', 'ses_1'))).resolves.toMatchObject({
    status: 'queued',
  });
  await expect(bridges[0].options.deliver(delivery('same-id', 'ses_1'))).resolves.toMatchObject({
    status: 'already-accepted',
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

  await hooks.event({
    event: {
      properties: { info: { id: messageID('same-id'), role: 'user', sessionID: 'ses_1' } },
      type: 'message.updated',
    },
  });
  await expect(Promise.all([first, duplicate])).resolves.toEqual([
    { assurance: 'message-created', deliveryId: 'same-id', status: 'accepted' },
    { assurance: 'message-created', deliveryId: 'same-id', status: 'accepted' },
  ]);
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
