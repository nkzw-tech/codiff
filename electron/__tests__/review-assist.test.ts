import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { readReviewAssistantReply } = require('../review-assist.cjs') as {
  readReviewAssistantReply: (
    state: unknown,
    request: unknown,
    agent: unknown,
    agentOptions: unknown,
  ) => Promise<{ reply?: string; status: string }>;
};

const readReply = async (
  state: unknown,
  request: unknown,
  response: unknown = { reply: 'Done.', version: 1 },
  label = 'Codex',
) => {
  const run = vi.fn(async () => JSON.stringify(response));
  const result = await readReviewAssistantReply(
    state,
    request,
    {
      isNotFoundError: () => false,
      label,
      notFoundCode: 'NOT_FOUND',
      run,
    },
    {},
  );
  const prompt = run.mock.calls[0]?.[1] as string;
  const digest = JSON.parse(prompt.split('Repository change digest:\n')[1] ?? '{}') as {
    comment: {
      anchor?: 'file' | 'line';
      body: string;
      filePath: string;
      lineNumber?: number;
      side?: string;
    };
    focus: {
      patchExcerpt: string;
    } | null;
    source: Record<string, unknown>;
    walkthroughNote: unknown;
  };
  return { digest, prompt, result };
};

const createPullRequestAssistantState = (description: string) => ({
  files: [
    {
      path: 'src/state.ts',
      sections: [
        {
          binary: false,
          id: 'src/state.ts:pull-request:42',
          kind: 'pull-request',
          patch: '+const synchronized = true;',
        },
      ],
      status: 'modified',
    },
  ],
  root: '/repo',
  source: {
    description,
    number: 42,
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/42',
  },
});

const pullRequestAssistantRequest = {
  comment: {
    body: 'why?',
    filePath: 'src/state.ts',
    lineNumber: 1,
    sectionId: 'src/state.ts:pull-request:42',
    side: 'additions',
  },
};

test('builds focused inline review assistant context', async () => {
  const { digest } = await readReply(
    {
      files: [
        {
          path: 'src/state.ts',
          sections: [
            {
              binary: false,
              id: 'src/state.ts:unstaged',
              kind: 'unstaged',
              patch: '+const duplicated = true;',
              summary: {
                reason: 'State handling changed.',
              },
            },
          ],
          status: 'modified',
        },
      ],
      root: '/repo',
      source: {
        type: 'working-tree',
      },
    },
    {
      comment: {
        body: 'this feels risky, why is this needed?',
        filePath: 'src/state.ts',
        lineNumber: 1,
        sectionId: 'src/state.ts:unstaged',
        side: 'additions',
      },
      walkthroughNote: {
        action: 'review',
        context: 'Check whether state stays synchronized.',
        groupReason: 'Shared state first.',
        groupTitle: 'Review carefully',
        impact: 'wide',
        reason: 'State contract affects multiple paths.',
      },
    },
  );

  expect(digest.comment.body).toBe('this feels risky, why is this needed?');
  expect(digest.focus?.patchExcerpt).toContain('+const duplicated = true;');
  expect(digest.walkthroughNote).toMatchObject({
    context: 'Check whether state stays synchronized.',
  });
});

test('builds file-level review assistant context without inventing a line', async () => {
  const { digest } = await readReply(
    {
      files: [
        {
          path: 'src/state.ts',
          sections: [
            {
              binary: false,
              id: 'src/state.ts:unstaged',
              kind: 'unstaged',
              patch: '+const synchronized = true;',
            },
          ],
          status: 'modified',
        },
      ],
      root: '/repo',
      source: { type: 'working-tree' },
    },
    {
      comment: {
        anchor: 'file',
        body: 'Why is this file organized this way?',
        filePath: 'src/state.ts',
        sectionId: 'src/state.ts:unstaged',
      },
    },
  );

  expect(digest.comment).toMatchObject({
    anchor: 'file',
    body: 'Why is this file organized this way?',
    filePath: 'src/state.ts',
  });
  expect(digest.comment.lineNumber).toBeUndefined();
  expect(digest.comment.side).toBeUndefined();
  expect(digest.focus?.patchExcerpt).toContain('+const synchronized = true;');
});

test('builds review assistant context with PR descriptions as orientation only', async () => {
  const state = {
    ...createPullRequestAssistantState('## Intent\n\nKeep reviewers oriented.'),
    descriptionAssetUrls: {
      '013867d7-8788-4446-9c66-75d6ba74a91a':
        'https://private-user-images.githubusercontent.com/1/2-013867d7-8788-4446-9c66-75d6ba74a91a.webm?jwt=preview-only',
    },
  };

  const { digest, prompt } = await readReply(state, pullRequestAssistantRequest);

  expect(digest.source.description).toBe('## Intent\n\nKeep reviewers oriented.');
  expect(prompt).not.toContain('jwt=');
  expect(prompt).toContain('author-written PR/MR intent and orientation');
  expect(prompt).toContain('not proof of behavior');
  expect(prompt).toContain(
    'The changed files and patch excerpt remain the source of truth for what changed.',
  );
});

test('truncates long PR descriptions in review assistant prompts', async () => {
  const state = createPullRequestAssistantState(`${'A'.repeat(4100)}UNTRUNCATED_TAIL`);

  const { digest, prompt } = await readReply(state, pullRequestAssistantRequest);

  expect(digest.source.description).toContain('...[truncated]');
  expect(prompt).toContain('...[truncated]');
  expect(prompt).not.toContain('UNTRUNCATED_TAIL');
});

test('normalizes review assistant markdown without flattening it', async () => {
  const { result } = await readReply(
    createPullRequestAssistantState(''),
    pullRequestAssistantRequest,
    {
      reply: 'Likely reason:\n\n- Keep state local\n\nSuggested comment: **Why here?**',
      version: 1,
    },
  );

  expect(result).toEqual({
    reply: 'Likely reason:\n\n- Keep state local\n\nSuggested comment: **Why here?**',
    status: 'ready',
  });
});

test('normalizes malformed review assistant replies without exposing raw payloads', async () => {
  const { result } = await readReply(
    createPullRequestAssistantState(''),
    pullRequestAssistantRequest,
    { text: 'raw model text', version: 1 },
    'Pi',
  );

  expect(result).toEqual({
    reply: 'Pi could not produce a useful reply.',
    status: 'ready',
  });
});
