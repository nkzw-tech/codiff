import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, vi } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import type { AgentReviewFeedback, AgentReviewResult } from '../../core/types.ts';

const require = createRequire(import.meta.url);
const { createAgentReviewHandoffController, validateAgentReviewRepository } =
  require('../agent-review-handoff.cjs') as {
    createAgentReviewHandoffController: (options?: {
      writeResult?: (path: string, result: AgentReviewResult) => void;
    }) => {
      clear: (webContentsId: number) => void;
      close: (
        webContentsId: number,
        path: string,
        repository: AgentReviewFeedback['repository'],
      ) => void;
      complete: (webContentsId: number, path: string, feedback: AgentReviewFeedback) => void;
      hasCompleted: (webContentsId: number) => boolean;
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
      order: 0,
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

test.each([
  ['version 1', { ...feedback, version: 2 }, 'version'],
  ['at least one comment', { ...feedback, comments: [] }, 'comment'],
  ['non-empty Markdown', { ...feedback, markdown: '  \n' }, 'Markdown'],
  [
    'trimmed comment bodies',
    { ...feedback, comments: [{ ...feedback.comments[0]!, body: ' trailing ' }] },
    'trimmed',
  ],
])('requires %s', (_requirement, value, message) => {
  const controller = createAgentReviewHandoffController({ writeResult: vi.fn() });

  expect(() => controller.complete(7, '/tmp/result.json', value as AgentReviewFeedback)).toThrow(
    message,
  );
  expect(controller.hasCompleted(7)).toBe(false);
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
