import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';
import type {
  AgentBackend,
  AgentFeedbackAssurance,
  AgentFeedbackDeliveryRequest,
  AgentFeedbackDeliveryResponse,
  AgentReviewFeedback,
} from '../../core/types.ts';

const require = createRequire(import.meta.url);
const {
  createAgentFeedbackDeliveryController,
  formatAgentFeedbackMessage,
  validateAgentReviewRepository,
} = require('../agent-feedback-delivery.cjs') as {
  createAgentFeedbackDeliveryController: (options: {
    deliver: (request: AgentFeedbackDeliveryRequest) => Promise<AgentFeedbackDeliveryResponse>;
    probe?: (identity: DeliveryIdentity) => Promise<DeliveryCapability>;
  }) => DeliveryController;
  formatAgentFeedbackMessage: (
    request: Pick<AgentFeedbackDeliveryRequest, 'deliveryId' | 'feedback'>,
  ) => string;
  validateAgentReviewRepository: (
    feedbackRepository: AgentReviewFeedback['repository'],
    stateRepository: AgentReviewFeedback['repository'],
  ) => void;
};
const { createAgentFeedbackAdapterRegistry } = require('../agent-feedback-adapters.cjs') as {
  createAgentFeedbackAdapterRegistry: () => {
    deliver: (request: AgentFeedbackDeliveryRequest) => Promise<AgentFeedbackDeliveryResponse>;
    probe: (identity: DeliveryIdentity) => Promise<DeliveryCapability>;
    register: (
      backend: AgentBackend,
      adapter: {
        deliver: (request: AgentFeedbackDeliveryRequest) => Promise<AgentFeedbackDeliveryResponse>;
        probe: (identity: DeliveryIdentity) => Promise<DeliveryCapability>;
      },
    ) => void;
  };
};

type DeliveryCapability = { available: boolean; reason?: string };
type DeliveryIdentity = {
  backend: AgentBackend;
  repositoryRoot: string;
  sessionId: string;
};
type DeliveryController = {
  clear: (webContentsId: number) => void;
  deliver: (
    webContentsId: number,
    feedback: AgentReviewFeedback,
  ) => Promise<AgentFeedbackDeliveryResponse>;
  prepare: (webContentsId: number) => Promise<DeliveryCapability>;
  register: (
    webContentsId: number,
    binding: {
      backend: AgentBackend;
      deliveryId: string;
      repository: Promise<AgentReviewFeedback['repository']>;
      sessionId: string;
    },
  ) => void;
  setRepository: (webContentsId: number, repository: AgentReviewFeedback['repository']) => void;
};

const feedback: AgentReviewFeedback = {
  comments: [
    {
      anchor: 'line',
      body: 'Handle the error before returning.',
      context: 'return result;',
      filePath: 'src/example.ts',
      lineNumber: 7,
      order: 1,
      sectionId: 'src/example.ts:7',
      side: 'additions',
    },
  ],
  markdown: '# Review feedback\n\nHandle the error before returning.',
  repository: { root: '/tmp/repository', source: { type: 'working-tree' } },
  version: 1,
};

const assuranceByBackend = [
  ['claude', 'transport-write'],
  ['codex', 'queue-command'],
  ['opencode', 'bridge-queue'],
  ['opencode', 'message-created'],
  ['pi', 'dispatch-started'],
] as const satisfies ReadonlyArray<readonly [AgentBackend, AgentFeedbackAssurance]>;

const register = (controller: DeliveryController, backend: AgentBackend = 'claude') => {
  controller.register(7, {
    backend,
    deliveryId: 'delivery-1',
    repository: Promise.resolve(feedback.repository),
    sessionId: 'session-1',
  });
};

test.each(assuranceByBackend)('%s accepts its %s assurance', async (backend, assurance) => {
  const deliver = vi.fn(async (request: AgentFeedbackDeliveryRequest) => ({
    assurance,
    deliveryId: request.deliveryId,
    status: 'accepted' as const,
  }));
  const controller = createAgentFeedbackDeliveryController({ deliver });
  register(controller, backend);

  await expect(controller.deliver(7, feedback)).resolves.toMatchObject({ assurance });
});

test('rejects an assurance unsupported by the bound backend', async () => {
  const controller = createAgentFeedbackDeliveryController({
    deliver: vi.fn(async () => ({
      assurance: 'queue-command',
      deliveryId: 'delivery-1',
      status: 'accepted',
    })),
  });
  register(controller, 'claude');

  await expect(controller.deliver(7, feedback)).rejects.toThrow('invalid for this backend');
});

test.each([
  [null, 'delivery ID'],
  [{ assurance: 'transport-write', deliveryId: 'other', status: 'accepted' }, 'delivery ID'],
  [{ deliveryId: 'delivery-1', reason: ' ', status: 'rejected' }, 'reason'],
])('rejects malformed acknowledgement %#', async (response, message) => {
  const controller = createAgentFeedbackDeliveryController({
    deliver: vi.fn(async () => response),
  });
  register(controller);
  await expect(controller.deliver(7, feedback)).rejects.toThrow(message);
});

test('does not retry after an invalid acknowledgement leaves delivery ambiguous', async () => {
  const deliver = vi.fn(async () => ({
    assurance: 'transport-write' as const,
    deliveryId: 'other',
    status: 'accepted' as const,
  }));
  const controller = createAgentFeedbackDeliveryController({ deliver });
  register(controller);

  await expect(controller.deliver(7, feedback)).rejects.toThrow(/delivery ID.*verify the session/i);
  await expect(controller.deliver(7, feedback)).rejects.toThrow(/delivery ID.*verify the session/i);
  expect(deliver).toHaveBeenCalledOnce();
});

test('returns an accepted delivery idempotently without dispatching twice', async () => {
  const deliver = vi.fn(async () => ({
    assurance: 'queue-command' as const,
    deliveryId: 'delivery-1',
    status: 'queued' as const,
  }));
  const controller = createAgentFeedbackDeliveryController({ deliver });
  register(controller, 'codex');

  await expect(controller.deliver(7, feedback)).resolves.toMatchObject({ status: 'queued' });
  await expect(controller.deliver(7, feedback)).resolves.toMatchObject({
    status: 'already-accepted',
  });
  expect(deliver).toHaveBeenCalledOnce();
});

test('evicts the oldest terminal response after 1,000 delivery IDs', async () => {
  const deliver = vi.fn(async (deliveryRequest: AgentFeedbackDeliveryRequest) => ({
    assurance: 'transport-write' as const,
    deliveryId: deliveryRequest.deliveryId,
    status: 'accepted' as const,
  }));
  const controller = createAgentFeedbackDeliveryController({ deliver });
  for (let index = 0; index <= 1_000; index += 1) {
    controller.register(7, {
      backend: 'claude',
      deliveryId: `delivery-${index}`,
      repository: Promise.resolve(feedback.repository),
      sessionId: 'session-1',
    });
    await controller.deliver(7, feedback);
  }
  controller.register(7, {
    backend: 'claude',
    deliveryId: 'delivery-0',
    repository: Promise.resolve(feedback.repository),
    sessionId: 'session-1',
  });

  await expect(controller.deliver(7, feedback)).resolves.toMatchObject({ status: 'accepted' });
  expect(deliver).toHaveBeenCalledTimes(1_002);
});

test('does not retry an active ambiguous delivery after terminal ledger eviction', async () => {
  const ambiguous = Object.assign(new Error('connection closed'), { ambiguous: true });
  const deliver = vi
    .fn<(request: AgentFeedbackDeliveryRequest) => Promise<AgentFeedbackDeliveryResponse>>()
    .mockRejectedValueOnce(ambiguous)
    .mockImplementation(async (deliveryRequest) => ({
      assurance: 'transport-write',
      deliveryId: deliveryRequest.deliveryId,
      status: 'accepted',
    }));
  const controller = createAgentFeedbackDeliveryController({ deliver });
  register(controller);
  await expect(controller.deliver(7, feedback)).rejects.toThrow(/verify the session/i);
  for (let index = 0; index < 1_001; index += 1) {
    controller.register(index + 100, {
      backend: 'claude',
      deliveryId: `new-delivery-${index}`,
      repository: Promise.resolve(feedback.repository),
      sessionId: 'session-1',
    });
    await controller.deliver(index + 100, feedback);
  }

  await expect(controller.deliver(7, feedback)).rejects.toThrow(/verify the session/i);
  expect(deliver).toHaveBeenCalledTimes(1_002);
});

test('shares one in-flight dispatch between concurrent calls for a delivery ID', async () => {
  let resolveDelivery!: (response: AgentFeedbackDeliveryResponse) => void;
  const deliver = vi.fn(
    () =>
      new Promise<AgentFeedbackDeliveryResponse>((resolve) => {
        resolveDelivery = resolve;
      }),
  );
  const controller = createAgentFeedbackDeliveryController({ deliver });
  register(controller);

  const first = controller.deliver(7, feedback);
  const second = controller.deliver(7, feedback);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(deliver).toHaveBeenCalledOnce();
  resolveDelivery({
    assurance: 'transport-write',
    deliveryId: 'delivery-1',
    status: 'accepted',
  });
  await expect(Promise.all([first, second])).resolves.toEqual([
    expect.objectContaining({ status: 'accepted' }),
    expect.objectContaining({ status: 'accepted' }),
  ]);
});

test('allows retry after a definite delivery failure or rejection', async () => {
  const deliver = vi
    .fn()
    .mockRejectedValueOnce(new Error('bridge closed'))
    .mockResolvedValueOnce({
      deliveryId: 'delivery-1',
      reason: 'session busy',
      status: 'rejected',
    })
    .mockResolvedValueOnce({
      assurance: 'transport-write',
      deliveryId: 'delivery-1',
      status: 'accepted',
    });
  const controller = createAgentFeedbackDeliveryController({ deliver });
  register(controller);

  await expect(controller.deliver(7, feedback)).rejects.toThrow('bridge closed');
  await expect(controller.deliver(7, feedback)).resolves.toMatchObject({ status: 'rejected' });
  await expect(controller.deliver(7, feedback)).resolves.toMatchObject({ status: 'accepted' });
  expect(deliver).toHaveBeenCalledTimes(3);
});

test('does not retry an ambiguous delivery ID', async () => {
  const deliver = vi.fn().mockRejectedValue(
    Object.assign(new Error('connection closed'), {
      ambiguous: true,
    }),
  );
  const controller = createAgentFeedbackDeliveryController({ deliver });
  register(controller, 'codex');

  await expect(controller.deliver(7, feedback)).rejects.toThrow(/verify the session/i);
  await expect(controller.deliver(7, feedback)).rejects.toThrow(/verify the session/i);
  expect(deliver).toHaveBeenCalledOnce();
});

test('preflights before delivery and does not dispatch while unavailable', async () => {
  const deliver = vi.fn();
  const probe = vi.fn(async () => ({ available: false, reason: 'bridge closed' }));
  const controller = createAgentFeedbackDeliveryController({ deliver, probe });
  register(controller, 'opencode');

  await expect(controller.prepare(7)).resolves.toEqual({
    available: false,
    reason: 'bridge closed',
  });
  await expect(controller.deliver(7, feedback)).rejects.toThrow('bridge closed');
  expect(probe).toHaveBeenCalledTimes(2);
  expect(deliver).not.toHaveBeenCalled();
});

test('uses the latest repository identity for preflight and feedback validation', async () => {
  const repository = {
    root: '/tmp/repository',
    source: { ref: 'abc123', type: 'commit' as const },
  };
  const probe = vi.fn(async () => ({ available: true }));
  const deliver = vi.fn(async () => ({
    assurance: 'dispatch-started' as const,
    deliveryId: 'delivery-1',
    status: 'accepted' as const,
  }));
  const controller = createAgentFeedbackDeliveryController({ deliver, probe });
  register(controller, 'pi');
  controller.setRepository(7, repository);

  await controller.prepare(7);
  await controller.deliver(7, { ...feedback, repository });

  expect(probe).toHaveBeenLastCalledWith({
    backend: 'pi',
    repositoryRoot: repository.root,
    sessionId: 'session-1',
  });
  expect(deliver).toHaveBeenCalledWith(
    expect.objectContaining({ repositoryRoot: repository.root }),
  );
});

test('uses a repository update that arrives while the initial repository is resolving', async () => {
  let resolveInitial!: (repository: AgentReviewFeedback['repository']) => void;
  const initialRepository = new Promise<AgentReviewFeedback['repository']>((resolve) => {
    resolveInitial = resolve;
  });
  const latestRepository = {
    root: '/tmp/latest-repository',
    source: { ref: 'def456', type: 'commit' as const },
  };
  const probe = vi.fn(async () => ({ available: true }));
  const controller = createAgentFeedbackDeliveryController({ deliver: vi.fn(), probe });
  controller.register(7, {
    backend: 'claude',
    deliveryId: 'delivery-1',
    repository: initialRepository,
    sessionId: 'session-1',
  });

  const preparation = controller.prepare(7);
  controller.setRepository(7, latestRepository);
  resolveInitial(feedback.repository);
  await preparation;

  expect(probe).toHaveBeenCalledWith({
    backend: 'claude',
    repositoryRoot: latestRepository.root,
    sessionId: 'session-1',
  });
});

test('clear unregisters a window', async () => {
  const controller = createAgentFeedbackDeliveryController({ deliver: vi.fn() });
  register(controller);
  controller.clear(7);
  await expect(controller.deliver(7, feedback)).rejects.toThrow('not registered');
});

test.each([
  ['version 1', { ...feedback, version: 2 }, 'version'],
  ['at least one comment', { ...feedback, comments: [] }, 'comment'],
  [
    'at most 500 comments',
    {
      ...feedback,
      comments: Array.from({ length: 501 }, (_, index) => ({
        ...feedback.comments[0]!,
        order: index + 1,
      })),
    },
    '500',
  ],
  ['non-empty Markdown', { ...feedback, markdown: '  \n' }, 'Markdown'],
  [
    'trimmed comment bodies',
    { ...feedback, comments: [{ ...feedback.comments[0]!, body: ' trailing ' }] },
    'trimmed',
  ],
  ['comment objects', { ...feedback, comments: [null] }, 'comment'],
  [
    'valid comment anchors',
    { ...feedback, comments: [{ ...feedback.comments[0]!, anchor: 'range' }] },
    'anchor',
  ],
  [
    'required filePath',
    { ...feedback, comments: [{ ...feedback.comments[0]!, filePath: '' }] },
    'filePath',
  ],
  [
    'required context',
    { ...feedback, comments: [{ ...feedback.comments[0]!, context: 7 }] },
    'context',
  ],
  [
    'required sectionId',
    { ...feedback, comments: [{ ...feedback.comments[0]!, sectionId: '  ' }] },
    'sectionId',
  ],
  ['positive order', { ...feedback, comments: [{ ...feedback.comments[0]!, order: 0 }] }, 'order'],
  [
    'contiguous order',
    { ...feedback, comments: [feedback.comments[0], { ...feedback.comments[0], order: 1 }] },
    'order',
  ],
  [
    'array order',
    { ...feedback, comments: [{ ...feedback.comments[0], order: 2 }, feedback.comments[0]] },
    'order',
  ],
  [
    'finite line values',
    { ...feedback, comments: [{ ...feedback.comments[0]!, lineNumber: Number.POSITIVE_INFINITY }] },
    'lineNumber',
  ],
  [
    'valid line sides',
    { ...feedback, comments: [{ ...feedback.comments[0]!, side: 'context' }] },
    'side',
  ],
  [
    'line fields',
    { ...feedback, comments: [{ ...feedback.comments[0]!, lineNumber: undefined }] },
    'lineNumber',
  ],
  [
    'no file-anchor line fields',
    { ...feedback, comments: [{ ...feedback.comments[0]!, anchor: 'file' }] },
    'file anchor',
  ],
  [
    'start line for start side',
    { ...feedback, comments: [{ ...feedback.comments[0]!, startSide: 'deletions' }] },
    'startLineNumber',
  ],
  [
    'valid start sides',
    {
      ...feedback,
      comments: [{ ...feedback.comments[0]!, startLineNumber: 3, startSide: 'context' }],
    },
    'startSide',
  ],
  [
    'valid optional line fields',
    { ...feedback, comments: [{ ...feedback.comments[0]!, startLineNumber: null }] },
    'startLineNumber',
  ],
  [
    'valid source types',
    { ...feedback, repository: { ...feedback.repository, source: { type: 'unknown' } } },
    'source type',
  ],
  [
    'source required strings',
    { ...feedback, repository: { ...feedback.repository, source: { type: 'commit' } } },
    'source ref',
  ],
])('requires %s', async (_requirement, value, message) => {
  const deliver = vi.fn();
  const controller = createAgentFeedbackDeliveryController({ deliver });
  register(controller);
  await expect(controller.deliver(7, value as AgentReviewFeedback)).rejects.toThrow(message);
  expect(deliver).not.toHaveBeenCalled();
});

test('validates repository roots and deeply equal sources without key-order assumptions', () => {
  const source = {
    baseRef: 'main',
    headRef: 'feature',
    ref: 'feature',
    type: 'branch-diff' as const,
  };
  const reorderedSource = {
    type: 'branch-diff' as const,
    ref: 'feature',
    headRef: 'feature',
    baseRef: 'main',
  };

  expect(() =>
    validateAgentReviewRepository(
      { root: '/tmp/repository', source },
      { root: '/tmp/repository', source: reorderedSource },
    ),
  ).not.toThrow();
  expect(() =>
    validateAgentReviewRepository(
      { root: '/tmp/other', source },
      { root: '/tmp/repository', source },
    ),
  ).toThrow('repository');
});

test('formats a stable feedback message without interpolation', () => {
  expect(formatAgentFeedbackMessage({ deliveryId: 'delivery-1', feedback })).toBe(
    [
      'CODIFF_DELIVERY_ID delivery-1',
      '',
      feedback.markdown,
      '',
      'Address every Codiff comment in order. Do not automatically reopen Codiff after handling them.',
    ].join('\n'),
  );
});

test('unregistered adapters preflight as unavailable and do not dispatch', async () => {
  const registry = createAgentFeedbackAdapterRegistry();
  const identity = {
    backend: 'claude' as const,
    repositoryRoot: '/tmp/repository',
    sessionId: 'session-1',
  };

  await expect(registry.probe(identity)).resolves.toEqual({
    available: false,
    reason: 'The claude feedback adapter is unavailable.',
  });
  expect(() =>
    registry.deliver({ ...identity, deliveryId: 'delivery-1', feedback, version: 1 }),
  ).toThrow('unavailable');
});

test('registered adapters receive probes and deliveries', async () => {
  const registry = createAgentFeedbackAdapterRegistry();
  const adapter = {
    deliver: vi.fn(async (request: AgentFeedbackDeliveryRequest) => ({
      assurance: 'transport-write' as const,
      deliveryId: request.deliveryId,
      status: 'accepted' as const,
    })),
    probe: vi.fn(async () => ({ available: true })),
  };
  registry.register('claude', adapter);
  const request: AgentFeedbackDeliveryRequest = {
    backend: 'claude',
    deliveryId: 'delivery-1',
    feedback,
    repositoryRoot: feedback.repository.root,
    sessionId: 'session-1',
    version: 1,
  };

  await expect(registry.probe(request)).resolves.toEqual({ available: true });
  await expect(registry.deliver(request)).resolves.toMatchObject({ status: 'accepted' });
  expect(adapter.probe).toHaveBeenCalledOnce();
  expect(adapter.deliver).toHaveBeenCalledOnce();
});
