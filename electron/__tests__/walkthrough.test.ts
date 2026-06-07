import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { buildPrompt, normalizeWalkthrough } = require('../walkthrough.cjs') as {
  buildPrompt: (
    state: unknown,
    context?: {
      messages?: ReadonlyArray<{ role: 'assistant' | 'user'; text: string }>;
      objective?: string;
      source: { generatedAt: string; threadId?: string; type: string };
      version: 1;
    },
    agentLabel?: string,
    customPrompt?: string,
  ) => string;
  normalizeWalkthrough: (
    input: unknown,
    files: ReadonlyArray<{ path: string }>,
  ) => {
    groups: ReadonlyArray<{
      files: ReadonlyArray<{
        action: string;
        context: string;
        impact: string;
        path: string;
        reason: string;
      }>;
      reason: string;
      title: string;
    }>;
    summary: {
      focus: string;
      skim: string;
    };
    version: 1;
  };
};

test('includes Codex conversation context in walkthrough prompts', () => {
  const prompt = buildPrompt(
    {
      files: [
        {
          fingerprint: 'abc',
          path: 'src/types.ts',
          sections: [],
          status: 'modified',
        },
      ],
      generatedAt: 1,
      root: '/repo',
      source: { type: 'working-tree' },
    },
    {
      objective: 'Make Codiff walkthroughs reuse the creating Codex session.',
      messages: [
        {
          role: 'user',
          text: 'The skill should only pass the session id to Codiff.',
        },
      ],
      source: {
        generatedAt: '2026-05-25T00:00:00.000Z',
        threadId: '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
        type: 'codex-session',
      },
      version: 1,
    },
  );

  expect(prompt).toContain('Codex conversation context:');
  expect(prompt).toContain('Make Codiff walkthroughs reuse the creating Codex session.');
  expect(prompt).toContain('The skill should only pass the session id to Codiff.');
  expect(prompt).toContain('Treat the repository change digest as the source of truth');
});

test('includes custom walkthrough prompt guidance without replacing core constraints', () => {
  const prompt = buildPrompt(
    {
      files: [
        {
          fingerprint: 'abc',
          path: 'README.md',
          sections: [],
          status: 'modified',
        },
      ],
      generatedAt: 1,
      root: '/repo',
      source: { type: 'working-tree' },
    },
    null,
    'Claude Code',
    'Answer in Japanese and use concise reviewer-facing explanations.',
  );

  expect(prompt).toContain('Custom walkthrough instructions:');
  expect(prompt).toContain('Answer in Japanese and use concise reviewer-facing explanations.');
  expect(prompt).toContain('Return JSON only.');
  expect(prompt).toContain('Repository change digest:');
});

test('normalizes review leverage walkthrough fields', () => {
  const walkthrough = normalizeWalkthrough(
    {
      groups: [
        {
          files: [
            {
              action: 'review',
              context: 'Check the IPC contract before renderer usage.',
              impact: 'wide',
              path: 'electron/walkthrough.cjs',
              reason: 'Prompt and schema shape drive review order.',
            },
          ],
          reason: 'Contracts and review strategy come first.',
          title: 'Review carefully',
        },
        {
          files: [
            {
              action: 'skim',
              context: 'Documentation only; skim wording after core review.',
              impact: 'mechanical',
              path: 'README.md',
              reason: 'Low-risk docs update.',
            },
          ],
          reason: 'Unlikely to affect behavior.',
          title: 'Low value / skim',
        },
      ],
      summary: {
        focus: 'Review the walkthrough contract and renderer consumption first.',
        skim: 'Skim documentation after the high-leverage files.',
      },
      version: 1,
    },
    [{ path: 'electron/walkthrough.cjs' }, { path: 'README.md' }],
  );

  expect(walkthrough.summary).toEqual({
    focus: 'Review the walkthrough contract and renderer consumption first.',
    skim: 'Skim documentation after the high-leverage files.',
  });
  expect(walkthrough.groups[0].files[0]).toEqual({
    action: 'review',
    context: 'Check the IPC contract before renderer usage.',
    impact: 'wide',
    path: 'electron/walkthrough.cjs',
    reason: 'Prompt and schema shape drive review order.',
  });
  expect(walkthrough.groups[1].files[0].action).toBe('skim');
});

test('adds missing files after the ranked walkthrough', () => {
  const walkthrough = normalizeWalkthrough(
    {
      groups: [
        {
          files: [
            {
              action: 'review',
              context: 'Review the shared type contract.',
              impact: 'wide',
              path: 'src/types.ts',
              reason: 'Shared renderer contract.',
            },
          ],
          reason: 'Shared contracts first.',
          title: 'Review carefully',
        },
      ],
      summary: {
        focus: 'Review shared contracts first.',
        skim: 'Scan anything Codex could not classify after that.',
      },
      version: 1,
    },
    [{ path: 'src/types.ts' }, { path: 'src/App.css' }],
  );

  expect(walkthrough.groups.at(-1)).toEqual({
    files: [
      {
        action: 'scan',
        context: 'Codex did not place this file; scan it after the ranked walkthrough.',
        impact: 'contained',
        path: 'src/App.css',
        reason: 'Review after the primary walkthrough; Codex did not place this file.',
      },
    ],
    reason: 'Files not included in the Codex walkthrough response.',
    title: 'Other changed files',
  });
});
