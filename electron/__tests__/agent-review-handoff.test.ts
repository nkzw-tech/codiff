import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, vi } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import type { AgentReviewFeedback, AgentReviewResult } from '../../core/types.ts';

const require = createRequire(import.meta.url);
const {
  closeFailedAgentReviewWindow,
  createAgentReviewHandoffController,
  createAgentReviewHandoffLifecycle,
  validateAgentReviewRepository,
} = require('../agent-review-handoff.cjs') as {
  closeFailedAgentReviewWindow: (
    lifecycle: { close: (webContentsId: number) => Promise<string> },
    window: { destroy: () => void; isDestroyed: () => boolean },
    webContentsId: number,
  ) => Promise<void>;
  createAgentReviewHandoffController: (options?: {
    writeResult?: (path: string, result: AgentReviewResult) => void;
  }) => {
    clear: (webContentsId: number) => void;
    close: (
      webContentsId: number,
      path: string,
      repository: AgentReviewFeedback['repository'],
    ) => boolean;
    complete: (webContentsId: number, path: string, feedback: AgentReviewFeedback) => boolean;
    hasCompleted: (webContentsId: number) => boolean;
  };
  createAgentReviewHandoffLifecycle: (options?: {
    controller?: ReturnType<
      typeof createAgentReviewHandoffController extends (...args: never[]) => infer Result
        ? () => Result
        : never
    >;
  }) => {
    clear: (webContentsId: number) => void;
    close: (
      webContentsId: number,
    ) => Promise<'already-completed' | 'closed' | 'repository-unavailable'>;
    complete: (webContentsId: number, feedback: AgentReviewFeedback) => Promise<boolean>;
    register: (
      webContentsId: number,
      resultPath: string,
      repository: Promise<AgentReviewFeedback['repository']>,
    ) => void;
    setRepository: (webContentsId: number, repository: AgentReviewFeedback['repository']) => void;
  };
  validateAgentReviewRepository: (
    feedbackRepository: AgentReviewFeedback['repository'],
    stateRepository: AgentReviewFeedback['repository'],
  ) => void;
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
  repository: {
    root: '/tmp/repository',
    source: { type: 'working-tree' },
  },
  version: 1,
};

test('writes one submitted terminal result atomically', async () => {
  await using directory = await createTemporaryDirectory('codiff-agent-review-');
  const resultPath = join(directory.path, 'result.json');
  const controller = createAgentReviewHandoffController();

  controller.complete(7, resultPath, feedback);
  controller.close(7, resultPath, feedback.repository);

  expect(await readFile(resultPath, 'utf8')).toBe(
    `${JSON.stringify({ ...feedback, status: 'submitted' })}\n`,
  );
  expect(await readdir(directory.path)).toEqual(['result.json']);
  expect(controller.hasCompleted(7)).toBe(true);
});

test('the first closed terminal result wins', () => {
  const writeResult = vi.fn();
  const controller = createAgentReviewHandoffController({ writeResult });

  controller.close(7, '/tmp/result.json', feedback.repository);
  controller.complete(7, '/tmp/result.json', feedback);

  expect(writeResult).toHaveBeenCalledOnce();
  expect(writeResult).toHaveBeenCalledWith('/tmp/result.json', {
    comments: [],
    markdown: '',
    repository: feedback.repository,
    status: 'closed',
    version: 1,
  });
});

test('allows retry when persistence fails', () => {
  const writeResult = vi.fn().mockImplementationOnce(() => {
    throw new Error('disk full');
  });
  const controller = createAgentReviewHandoffController({ writeResult });

  expect(() => controller.complete(7, '/tmp/result.json', feedback)).toThrow('disk full');
  expect(controller.hasCompleted(7)).toBe(false);
  expect(() => controller.complete(7, '/tmp/result.json', feedback)).not.toThrow();
  expect(controller.hasCompleted(7)).toBe(true);
});

test('reports when a submitted result loses to an existing terminal result', () => {
  const controller = createAgentReviewHandoffController({ writeResult: vi.fn() });

  expect(controller.close(7, '/tmp/result.json', feedback.repository)).toBe(true);
  expect(controller.complete(7, '/tmp/result.json', feedback)).toBe(false);
});

test.each([
  ['version 1', { ...feedback, version: 2 }, 'version'],
  ['at least one comment', { ...feedback, comments: [] }, 'comment'],
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
    'required comment strings',
    { ...feedback, comments: [{ ...feedback.comments[0]!, filePath: '' }] },
    'filePath',
  ],
  [
    'required comment strings',
    { ...feedback, comments: [{ ...feedback.comments[0]!, context: 7 }] },
    'context',
  ],
  [
    'required comment strings',
    { ...feedback, comments: [{ ...feedback.comments[0]!, sectionId: '  ' }] },
    'sectionId',
  ],
  [
    'positive integer order values',
    { ...feedback, comments: [{ ...feedback.comments[0]!, order: 0 }] },
    'order',
  ],
  [
    'contiguous comment order values',
    {
      ...feedback,
      comments: [feedback.comments[0], { ...feedback.comments[0], order: 1 }],
    },
    'order',
  ],
  [
    'contiguous comment order values',
    {
      ...feedback,
      comments: [feedback.comments[0], { ...feedback.comments[0], order: 3 }],
    },
    'order',
  ],
  [
    'array comment order',
    {
      ...feedback,
      comments: [{ ...feedback.comments[0], order: 2 }, feedback.comments[0]],
    },
    'order',
  ],
  [
    'positive finite integer line values',
    { ...feedback, comments: [{ ...feedback.comments[0]!, lineNumber: Number.POSITIVE_INFINITY }] },
    'lineNumber',
  ],
  [
    'valid line sides',
    { ...feedback, comments: [{ ...feedback.comments[0]!, side: 'context' }] },
    'side',
  ],
  [
    'line fields for line anchors',
    { ...feedback, comments: [{ ...feedback.comments[0]!, lineNumber: undefined }] },
    'lineNumber',
  ],
  [
    'no line fields for file anchors',
    { ...feedback, comments: [{ ...feedback.comments[0]!, anchor: 'file' }] },
    'file anchor',
  ],
  [
    'a start line for start sides',
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
    'valid repository source types',
    { ...feedback, repository: { ...feedback.repository, source: { type: 'unknown' } } },
    'source type',
  ],
  [
    'source-specific required strings',
    { ...feedback, repository: { ...feedback.repository, source: { type: 'commit' } } },
    'source ref',
  ],
])('requires %s', (_requirement, value, message) => {
  const controller = createAgentReviewHandoffController({ writeResult: vi.fn() });

  expect(() => controller.complete(7, '/tmp/result.json', value as AgentReviewFeedback)).toThrow(
    message,
  );
  expect(controller.hasCompleted(7)).toBe(false);
});

test('removes the real atomic temporary file when rename fails', async () => {
  await using directory = await createTemporaryDirectory('codiff-agent-review-');
  const resultPath = join(directory.path, 'result.json');
  const controller = createAgentReviewHandoffController();
  await mkdir(resultPath);

  expect(() => controller.complete(7, resultPath, feedback)).toThrow();
  expect(controller.hasCompleted(7)).toBe(false);
  expect(await readdir(directory.path)).toEqual(['result.json']);
});

test('clear releases terminal state for a reused web contents ID', () => {
  const writeResult = vi.fn();
  const controller = createAgentReviewHandoffController({ writeResult });

  controller.close(7, '/tmp/first.json', feedback.repository);
  controller.clear(7);
  controller.complete(7, '/tmp/second.json', feedback);

  expect(writeResult).toHaveBeenCalledTimes(2);
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
  expect(() =>
    validateAgentReviewRepository(
      { root: '/tmp/repository', source: { type: 'working-tree' } },
      { root: '/tmp/repository', source },
    ),
  ).toThrow('repository');
});

const createDeferredRepository = () => {
  let reject!: (error: Error) => void;
  let resolve!: (repository: AgentReviewFeedback['repository']) => void;
  const promise = new Promise<AgentReviewFeedback['repository']>(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    },
  );
  return { promise, reject, resolve };
};

test('writes closed after a close requested before repository resolution', async () => {
  const repository = createDeferredRepository();
  const writeResult = vi.fn();
  const controller = createAgentReviewHandoffController({ writeResult });
  const lifecycle = createAgentReviewHandoffLifecycle({ controller });
  lifecycle.register(7, '/tmp/result.json', repository.promise);

  const close = lifecycle.close(7);
  expect(writeResult).not.toHaveBeenCalled();
  repository.resolve(feedback.repository);

  await expect(close).resolves.toBe('closed');
  expect(writeResult).toHaveBeenCalledOnce();
});

test('close prefers a newer repository set while initial resolution is pending', async () => {
  const initialRepository = createDeferredRepository();
  const writeResult = vi.fn();
  const lifecycle = createAgentReviewHandoffLifecycle({
    controller: createAgentReviewHandoffController({ writeResult }),
  });
  const repository = {
    root: feedback.repository.root,
    source: { ref: 'new-source', type: 'commit' as const },
  };
  lifecycle.register(7, '/tmp/result.json', initialRepository.promise);

  const close = lifecycle.close(7);
  lifecycle.setRepository(7, repository);
  initialRepository.resolve(feedback.repository);

  await expect(close).resolves.toBe('closed');
  expect(writeResult).toHaveBeenCalledWith(
    '/tmp/result.json',
    expect.objectContaining({ repository }),
  );
});

test('publishes the durable owner and updates it to the latest accepted source', async () => {
  await using directory = await createTemporaryDirectory('codiff-agent-review-owner-');
  const resultPath = join(directory.path, 'result.json');
  const lifecycle = createAgentReviewHandoffLifecycle();
  lifecycle.register(7, resultPath, Promise.resolve(feedback.repository));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(JSON.parse(await readFile(`${resultPath}.owner`, 'utf8'))).toMatchObject({
    pid: process.pid,
    repository: feedback.repository,
    status: 'open',
    version: 1,
  });

  const repository = {
    root: feedback.repository.root,
    source: { ref: 'abc123', type: 'commit' as const },
  };
  lifecycle.setRepository(7, repository);
  expect(JSON.parse(await readFile(`${resultPath}.owner`, 'utf8'))).toMatchObject({ repository });
});

test('does not let delayed initial resolution overwrite a newer repository', async () => {
  await using directory = await createTemporaryDirectory('codiff-agent-review-owner-generation-');
  const resultPath = join(directory.path, 'result.json');
  const initialRepository = createDeferredRepository();
  const lifecycle = createAgentReviewHandoffLifecycle();
  const repository = {
    root: feedback.repository.root,
    source: { ref: 'new-source', type: 'commit' as const },
  };
  const updatedFeedback = { ...feedback, repository };
  lifecycle.register(7, resultPath, initialRepository.promise);
  lifecycle.setRepository(7, repository);

  initialRepository.resolve(feedback.repository);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(JSON.parse(await readFile(`${resultPath}.owner`, 'utf8'))).toMatchObject({ repository });
  await expect(lifecycle.complete(7, updatedFeedback)).resolves.toBe(true);
  expect(JSON.parse(await readFile(resultPath, 'utf8'))).toMatchObject({ repository });
});

test('finishes a pending close after lifecycle cleanup', async () => {
  const repository = createDeferredRepository();
  const writeResult = vi.fn();
  const lifecycle = createAgentReviewHandoffLifecycle({
    controller: createAgentReviewHandoffController({ writeResult }),
  });
  lifecycle.register(7, '/tmp/result.json', repository.promise);

  const close = lifecycle.close(7);
  lifecycle.clear(7);
  repository.resolve(feedback.repository);

  await expect(close).resolves.toBe('closed');
  expect(writeResult).toHaveBeenCalledOnce();
});

test('allows repository resolution rejection to leave no closed result', async () => {
  const repository = createDeferredRepository();
  const writeResult = vi.fn();
  const lifecycle = createAgentReviewHandoffLifecycle({
    controller: createAgentReviewHandoffController({ writeResult }),
  });
  lifecycle.register(7, '/tmp/result.json', repository.promise);

  const close = lifecycle.close(7);
  repository.reject(new Error('not a repository'));

  await expect(close).resolves.toBe('repository-unavailable');
  expect(writeResult).not.toHaveBeenCalled();
});

test('handles repository rejection before close is requested', async () => {
  const lifecycle = createAgentReviewHandoffLifecycle();
  lifecycle.register(7, '/tmp/result.json', Promise.reject(new Error('not a repository')));

  await new Promise((resolve) => setTimeout(resolve, 0));

  await expect(lifecycle.close(7)).resolves.toBe('repository-unavailable');
});

test('reports a submission that loses after closed persisted', async () => {
  const lifecycle = createAgentReviewHandoffLifecycle({
    controller: createAgentReviewHandoffController({ writeResult: vi.fn() }),
  });
  lifecycle.register(7, '/tmp/result.json', Promise.resolve(feedback.repository));

  await expect(lifecycle.close(7)).resolves.toBe('closed');
  await expect(lifecycle.complete(7, feedback)).resolves.toBe(false);
});

test('preserves close state for retry after a write failure', async () => {
  const writeResult = vi.fn().mockImplementationOnce(() => {
    throw new Error('disk full');
  });
  const lifecycle = createAgentReviewHandoffLifecycle({
    controller: createAgentReviewHandoffController({ writeResult }),
  });
  lifecycle.register(7, '/tmp/result.json', Promise.resolve(feedback.repository));

  await expect(lifecycle.close(7)).rejects.toThrow('disk full');
  await expect(lifecycle.close(7)).resolves.toBe('closed');
  expect(writeResult).toHaveBeenCalledTimes(2);
});

test('rejects completion from an unregistered web contents owner', async () => {
  const lifecycle = createAgentReviewHandoffLifecycle();

  await expect(lifecycle.complete(7, feedback)).rejects.toThrow('registered');
});

test('destroys a renderer-failed window after cancellation persists', async () => {
  const window = { destroy: vi.fn(), isDestroyed: vi.fn(() => false) };
  await closeFailedAgentReviewWindow({ close: vi.fn(async () => 'closed') }, window, 7);

  expect(window.destroy).toHaveBeenCalledOnce();
});

test('keeps a renderer-failed window alive when cancellation persistence fails', async () => {
  const window = { destroy: vi.fn(), isDestroyed: vi.fn(() => false) };

  await expect(
    closeFailedAgentReviewWindow(
      {
        close: vi.fn(async () => {
          throw new Error('disk full');
        }),
      },
      window,
      7,
    ),
  ).rejects.toThrow('disk full');
  expect(window.destroy).not.toHaveBeenCalled();
});

test('keeps a renderer-failed window alive when repository identity is unavailable', async () => {
  const window = { destroy: vi.fn(), isDestroyed: vi.fn(() => false) };

  await closeFailedAgentReviewWindow(
    { close: vi.fn(async () => 'repository-unavailable') },
    window,
    7,
  );

  expect(window.destroy).not.toHaveBeenCalled();
});
