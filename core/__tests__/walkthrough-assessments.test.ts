import { expect, test, vi } from 'vite-plus/test';
import {
  buildWalkthroughAssessmentPrompt,
  createAssessmentDemand,
  createAssessmentDemandsFromSelections,
  createAssessmentGenerationProfile,
  generateAssessmentCollection,
  normalizeAssessmentInput,
  sanitizeAssessmentError,
} from '../lib/walkthrough-assessments.ts';
import type {
  AssessmentComponent,
  GenerationMetadata,
  GitSha,
  PullRequestExistingReviewComment,
  WalkthroughCapturedContext,
} from '../types.ts';

const sha = (value: string) => value.repeat(40) as GitSha;
const scope = { type: 'single-diff' as const };
const context: WalkthroughCapturedContext = {
  branch: 'feature',
  files: [
    {
      fingerprint: 'router',
      path: 'src/router.ts',
      sections: [
        {
          binary: false,
          id: 'src/router.ts:commit',
          kind: 'commit',
          patch: '@@ -1 +1 @@\n-oldPath();\n+newPath();\n',
          range: {
            base: { label: { kind: 'commit', text: 'base' }, sha: sha('b') },
            head: { label: { kind: 'commit', text: 'head' }, sha: sha('a') },
          },
        },
      ],
      status: 'modified',
    },
  ],
  source: { sha: sha('a'), type: 'commit' },
};
const comment = (
  threadId: string,
  body: string,
  isThreadResolved = false,
): PullRequestExistingReviewComment => ({
  author: { login: 'reviewer', name: 'Reviewer' },
  body,
  filePath: 'src/router.ts',
  id: `${threadId}:1`,
  isThreadResolved,
  lineNumber: 1,
  side: 'additions',
  threadId,
});
const profile = createAssessmentGenerationProfile({
  agent: 'codex',
  modelCandidates: ['primary', 'fallback'],
});
const metadata = (model = 'primary'): GenerationMetadata => ({
  agent: 'codex',
  generatedAt: '2026-07-28T00:00:00.000Z',
  model,
  profile,
});

test('normalizes authoritative thread input without presentation or provider state', () => {
  const input = normalizeAssessmentInput({
    codeScope: scope,
    comments: [
      {
        ...comment('thread-1', 'Please preserve the fallback.', true),
        canEdit: true,
        isOutdated: true,
        url: 'https://provider.example/thread-1',
      },
    ],
  });
  const serialized = JSON.stringify(input);

  expect(input.thread.id).toBe('thread-1');
  expect(serialized).not.toContain('isThreadResolved');
  expect(serialized).not.toContain('isOutdated');
  expect(serialized).not.toContain('canEdit');
  expect(serialized).not.toContain('provider.example');
});

test('treats replies as one thread and inherits the root anchor and resolution', () => {
  const root = {
    ...comment('thread-1', 'Please preserve the fallback.', true),
    submittedAt: '2026-07-28T00:00:00.000Z',
  };
  const reply = {
    ...comment('thread-1', 'Agreed.'),
    filePath: '',
    id: 'thread-1:2',
    lineNumber: undefined,
    side: undefined,
    submittedAt: '2026-07-28T00:01:00.000Z',
  };

  const input = normalizeAssessmentInput({ codeScope: scope, comments: [reply, root] });
  const demand = createAssessmentDemand({ codeScope: scope, comments: [reply, root] });

  expect(input.thread.comments).toHaveLength(2);
  expect(input.thread.comments[1]?.anchor).toEqual(input.thread.comments[0]?.anchor);
  expect(demand.capturedPresentationState.threadState).toBe('resolved');
});

test('keeps captured thread state separate from prompt and semantic input', () => {
  const demand = createAssessmentDemand({
    codeScope: scope,
    comments: [comment('thread-1', 'Please preserve the fallback.', true)],
  });
  const prompt = buildWalkthroughAssessmentPrompt(demand.input, context);

  expect(demand.capturedPresentationState.threadState).toBe('resolved');
  expect(prompt).toContain('Please preserve the fallback.');
  expect(prompt).not.toContain('resolved');
  expect(prompt).not.toContain('isThreadResolved');
});

test('joins captured presentation state only after eligibility routing', () => {
  const input = normalizeAssessmentInput({
    codeScope: scope,
    comments: [comment('thread-1', 'Please preserve the fallback.')],
  });
  const candidate = { thread: input.thread };
  const selections = [{ candidate, codeScope: scope, kind: 'eligible' as const }];
  const open = createAssessmentDemandsFromSelections({
    capturedThreadStateById: new Map([['thread-1', 'open' as const]]),
    selections,
  });
  const resolved = createAssessmentDemandsFromSelections({
    capturedThreadStateById: new Map([['thread-1', 'resolved' as const]]),
    selections,
  });

  expect(open[0]?.input).toEqual(resolved[0]?.input);
  expect(open[0]?.capturedPresentationState.threadState).toBe('open');
  expect(resolved[0]?.capturedPresentationState.threadState).toBe('resolved');
});

test('runs exactly one model call per demanded identity and retains sibling failures', async () => {
  const demands = [
    createAssessmentDemand({ codeScope: scope, comments: [comment('thread-1', 'First.')] }),
    createAssessmentDemand({ codeScope: scope, comments: [comment('thread-2', 'Second.')] }),
  ];
  const runModel = vi.fn(async ({ input }: { input: (typeof demands)[number]['input'] }) => {
    if (input.thread.id === 'thread-2') {
      throw new Error('Bearer secret /Users/example/private failed');
    }
    return {
      generationMetadata: metadata('fallback'),
      response: {
        disposition: 'still-applies',
        explanation: 'The changed branch remains relevant.',
      },
    };
  });

  const collection = await generateAssessmentCollection({
    capturedContext: context,
    demands,
    profile,
    runModel,
  });

  expect(runModel).toHaveBeenCalledTimes(2);
  expect(runModel.mock.calls.map(([call]) => call.input.thread.comments)).toEqual([
    [expect.objectContaining({ body: 'First.' })],
    [expect.objectContaining({ body: 'Second.' })],
  ]);
  expect(collection.items[0]?.outcome).toMatchObject({
    generationMetadata: expect.objectContaining({ model: 'fallback' }),
    status: 'ready',
  });
  expect(collection.items[1]?.outcome).toEqual({
    error: '[redacted] [path] failed',
    status: 'failed',
  });
});

test('reuses unchanged assessment input without rerunning for state-only changes', async () => {
  const original = createAssessmentDemand({
    codeScope: scope,
    comments: [comment('thread-1', 'Same content.', false)],
  });
  const stored: AssessmentComponent = {
    ...original,
    outcome: {
      generationMetadata: metadata(),
      result: { disposition: 'still-applies', explanation: 'The branch is unchanged.' },
      status: 'ready',
    },
  };
  const current = createAssessmentDemand({
    codeScope: scope,
    comments: [comment('thread-1', 'Same content.', true)],
  });
  const runModel = vi.fn();
  const collection = await generateAssessmentCollection({
    capturedContext: context,
    demands: [current],
    existing: [stored],
    profile,
    runModel,
  });

  expect(runModel).not.toHaveBeenCalled();
  expect(collection.items).toEqual([stored]);
  expect(collection.items[0]?.capturedPresentationState.threadState).toBe('open');
});

test('records an empty collection when no calls are demanded', async () => {
  const runModel = vi.fn();
  await expect(
    generateAssessmentCollection({
      capturedContext: context,
      demands: [],
      profile,
      runModel,
    }),
  ).resolves.toEqual({ items: [] });
  expect(runModel).not.toHaveBeenCalled();
});

test('bounds and sanitizes failed assessment errors', () => {
  const error = sanitizeAssessmentError(`token=secret ${'/private/path'.repeat(100)} failed`);
  expect(error).not.toContain('secret');
  expect(error).not.toContain('/private');
  expect(error.length).toBeLessThanOrEqual(500);
});
