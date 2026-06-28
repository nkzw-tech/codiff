import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { buildReviewAssistantInput, buildReviewAssistantPrompt, normalizeReviewAssistantReply } =
  require('../review-assist.cjs') as {
    buildReviewAssistantInput: (
      state: unknown,
      request: unknown,
    ) => {
      comment: {
        body: string;
        filePath: string;
        lineNumber: number;
        side: string;
      };
      focus: {
        patchExcerpt: string;
      } | null;
      source: Record<string, unknown>;
      walkthroughNote: unknown;
    };
    buildReviewAssistantPrompt: (state: unknown, request: unknown) => string;
    normalizeReviewAssistantReply: (input: unknown) => {
      reply: string;
      version: 1;
    };
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

test('builds focused inline review assistant context', () => {
  const input = buildReviewAssistantInput(
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

  expect(input.comment.body).toBe('this feels risky, why is this needed?');
  expect(input.focus?.patchExcerpt).toContain('+const duplicated = true;');
  expect(input.walkthroughNote).toMatchObject({
    context: 'Check whether state stays synchronized.',
  });
});

test('builds review assistant context with PR descriptions as orientation only', () => {
  const state = createPullRequestAssistantState('## Intent\n\nKeep reviewers oriented.');

  const input = buildReviewAssistantInput(state, pullRequestAssistantRequest);
  const prompt = buildReviewAssistantPrompt(state, pullRequestAssistantRequest);

  expect(input.source.description).toBe('## Intent\n\nKeep reviewers oriented.');
  expect(prompt).toContain('author-written PR/MR intent and orientation');
  expect(prompt).toContain('not proof of behavior');
  expect(prompt).toContain(
    'The changed files and patch excerpt remain the source of truth for what changed.',
  );
});

test('truncates long PR descriptions in review assistant prompts', () => {
  const state = createPullRequestAssistantState(`${'A'.repeat(4100)}UNTRUNCATED_TAIL`);

  const input = buildReviewAssistantInput(state, pullRequestAssistantRequest);
  const prompt = buildReviewAssistantPrompt(state, pullRequestAssistantRequest);

  expect(input.source.description).toContain('...[truncated]');
  expect(prompt).toContain('...[truncated]');
  expect(prompt).not.toContain('UNTRUNCATED_TAIL');
});

test('normalizes review assistant markdown without flattening it', () => {
  expect(
    normalizeReviewAssistantReply({
      reply: 'Likely reason:\n\n- Keep state local\n\nSuggested comment: **Why here?**',
      version: 1,
    }),
  ).toEqual({
    reply: 'Likely reason:\n\n- Keep state local\n\nSuggested comment: **Why here?**',
    version: 1,
  });
});

test('normalizes malformed review assistant replies without exposing raw payloads', () => {
  expect(normalizeReviewAssistantReply({ text: 'raw model text', version: 1 }, 'Pi')).toEqual({
    reply: 'Pi could not produce a useful reply.',
    version: 1,
  });
});
