import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

type Delivery = {
  deliveryId: string;
  message: string;
  repositoryRoot: string;
  sessionId: string;
  version: number;
};

const { bridges, createAgentFeedbackBridge } = vi.hoisted(() => {
  const bridges: Array<{
    close: ReturnType<typeof vi.fn>;
    options: {
      backend: string;
      deliver: (delivery: Delivery) => Promise<Record<string, unknown>>;
      getIdentity: () => { repositoryRoot: string; sessionId: string };
    };
  }> = [];
  return {
    bridges,
    createAgentFeedbackBridge: vi.fn(async (options) => {
      const bridge = { close: vi.fn(async () => {}), options };
      bridges.push(bridge);
      return bridge;
    }),
  };
});

vi.mock('../../../../bin/agent-feedback-bridge.mjs', () => ({ createAgentFeedbackBridge }));

import codiffExtension from '../index.ts';

const delivery: Delivery = {
  deliveryId: 'delivery-1',
  message: 'Review feedback',
  repositoryRoot: '/repository',
  sessionId: 'session-1',
  version: 1,
};

const setup = (options?: {
  cwd?: string;
  idle?: boolean;
  repositoryRoot?: string;
  sessionId?: string;
}) => {
  const handlers: Record<string, (event: unknown, context: unknown) => Promise<void>> = {};
  const pi = {
    exec: vi.fn(async () => ({
      code: 0,
      stderr: '',
      stdout: `${options?.repositoryRoot ?? '/repository'}\n`,
    })),
    on: vi.fn((event: string, handler: (event: unknown, context: unknown) => Promise<void>) => {
      handlers[event] = handler;
    }),
    sendUserMessage: vi.fn(),
  };
  const context = {
    isIdle: () => options?.idle ?? true,
    sessionManager: {
      getCwd: () => options?.cwd ?? '/repository/subdirectory',
      getSessionId: () => options?.sessionId ?? 'session-1',
    },
  };

  codiffExtension(pi as never);
  return { context, handlers, pi };
};

beforeEach(() => {
  bridges.length = 0;
  createAgentFeedbackBridge.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('registers lifecycle handlers without starting a bridge during factory evaluation', () => {
  const { handlers, pi } = setup();

  expect(pi.on.mock.calls.map(([event]) => event)).toEqual(['session_start', 'session_shutdown']);
  expect(Object.keys(handlers)).toEqual(['session_start', 'session_shutdown']);
  expect(createAgentFeedbackBridge).not.toHaveBeenCalled();
});

test('registers the exact Pi session and repository identity at session start', async () => {
  const { context, handlers, pi } = setup({
    cwd: '/repository/nested',
    repositoryRoot: '/repository',
    sessionId: 'session-exact',
  });

  await handlers.session_start({ reason: 'startup' }, context);

  expect(pi.exec).toHaveBeenCalledWith('git', ['rev-parse', '--show-toplevel'], {
    cwd: '/repository/nested',
    timeout: 5000,
  });
  expect(createAgentFeedbackBridge).toHaveBeenCalledWith(
    expect.objectContaining({ backend: 'pi' }),
  );
  expect(bridges[0].options.getIdentity()).toEqual({
    repositoryRoot: '/repository',
    sessionId: 'session-exact',
  });
});

test('dispatches idle feedback into the current Pi session before assuring acceptance', async () => {
  const { context, handlers, pi } = setup();
  await handlers.session_start({ reason: 'startup' }, context);

  await expect(bridges[0].options.deliver(delivery)).resolves.toEqual({
    assurance: 'dispatch-started',
    deliveryId: 'delivery-1',
    status: 'accepted',
  });
  expect(pi.sendUserMessage).toHaveBeenCalledWith('Review feedback');
});

test('queues busy feedback as a follow-up in the same Pi session', async () => {
  const { context, handlers, pi } = setup({ idle: false });
  await handlers.session_start({ reason: 'resume' }, context);

  await expect(bridges[0].options.deliver(delivery)).resolves.toMatchObject({
    assurance: 'dispatch-started',
    status: 'accepted',
  });
  expect(pi.sendUserMessage).toHaveBeenCalledWith('Review feedback', {
    deliverAs: 'followUp',
  });
});

test('rejects delivery without assurance when Pi synchronously rejects dispatch', async () => {
  const { context, handlers, pi } = setup();
  pi.sendUserMessage.mockImplementation(() => {
    throw new Error('dispatch rejected with secret-token');
  });
  await handlers.session_start({ reason: 'startup' }, context);

  await expect(bridges[0].options.deliver(delivery)).rejects.toThrow(
    'dispatch rejected with secret-token',
  );
});

test('fails conservatively with a static error when repository identity is unavailable', async () => {
  const { context, handlers, pi } = setup();
  pi.exec.mockResolvedValue({ code: 128, stderr: 'fatal secret-token', stdout: '' });

  await expect(handlers.session_start({ reason: 'startup' }, context)).rejects.toThrow(
    'Codiff could not resolve the Pi session repository.',
  );
  expect(createAgentFeedbackBridge).not.toHaveBeenCalled();
});

test('closes the previous bridge before registering a replacement session', async () => {
  const first = setup({ sessionId: 'session-1' });
  await first.handlers.session_start({ reason: 'startup' }, first.context);
  const firstBridge = bridges[0];
  const replacementContext = {
    ...first.context,
    sessionManager: {
      ...first.context.sessionManager,
      getSessionId: () => 'session-2',
    },
  };

  await first.handlers.session_start({ reason: 'resume' }, replacementContext);

  expect(firstBridge.close).toHaveBeenCalledOnce();
  expect(bridges).toHaveLength(2);
  expect(bridges[1].options.getIdentity().sessionId).toBe('session-2');
});

test('closes the active bridge once across repeated session shutdown', async () => {
  const { context, handlers } = setup();
  await handlers.session_start({ reason: 'startup' }, context);

  await handlers.session_shutdown({ reason: 'quit' }, context);
  await handlers.session_shutdown({ reason: 'quit' }, context);

  expect(bridges[0].close).toHaveBeenCalledOnce();
});
