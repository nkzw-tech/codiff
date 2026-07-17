import { appendFile, mkdir, truncate, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { readClaudeSessionContext } = require('../claude-session-context.cjs') as {
  readClaudeSessionContext: (sessionId?: string) => Promise<{
    messages?: ReadonlyArray<{ role: 'assistant' | 'user'; text: string }>;
    risks?: ReadonlyArray<string>;
    source: { threadId?: string; type: string };
    version: 1;
  } | null>;
};

const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';

test('extracts bounded readable messages from Claude Code session jsonl', async () => {
  await using directory = await createTemporaryDirectory('codiff-claude-session-');
  const sessionDirectory = join(directory.path, 'projects', 'repo');
  const sessionPath = join(sessionDirectory, `${sessionId}.jsonl`);
  await using _environment = createTemporaryEnvironment({ CLAUDE_CONFIG_DIR: directory.path });

  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    sessionPath,
    [
      JSON.stringify({
        message: {
          content: [{ text: 'Implement walkthrough session handoff.', type: 'text' }],
          role: 'user',
        },
        type: 'user',
      }),
      JSON.stringify({
        message: {
          content: [
            { thinking: 'planning', type: 'thinking' },
            { text: 'Updated the CLI and skill handoff.', type: 'text' },
          ],
          role: 'assistant',
        },
        type: 'assistant',
      }),
      JSON.stringify({
        message: { content: [{ text: '/codiff', type: 'text' }], role: 'user' },
        type: 'user',
      }),
    ].join('\n'),
  );

  await expect(readClaudeSessionContext(sessionId)).resolves.toMatchObject({
    messages: [
      { role: 'user', text: 'Implement walkthrough session handoff.' },
      { role: 'assistant', text: 'Updated the CLI and skill handoff.' },
    ],
  });
});

test('finds the active Claude Code session under CLAUDE_CONFIG_DIR', async () => {
  await using directory = await createTemporaryDirectory('codiff-claude-home-');
  await using _environment = createTemporaryEnvironment({ CLAUDE_CONFIG_DIR: directory.path });

  const projectDirectory = join(directory.path, 'projects', '-home-reviewer-repo');
  const sessionPath = join(projectDirectory, `${sessionId}.jsonl`);
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      cwd: '/home/reviewer/repo',
      message: {
        content: [{ text: 'Keep Codiff in charge of the ephemeral walkthrough.', type: 'text' }],
        role: 'user',
      },
      type: 'user',
    })}\n`,
  );

  await expect(readClaudeSessionContext(sessionId)).resolves.toMatchObject({
    messages: [
      {
        role: 'user',
        text: 'Keep Codiff in charge of the ephemeral walkthrough.',
      },
    ],
    source: {
      threadId: sessionId,
      type: 'claude-session-excerpt',
    },
    version: 1,
  });
});

test('reads recent Claude messages from a large session without loading the whole file', async () => {
  await using directory = await createTemporaryDirectory('codiff-claude-large-session-');
  const sessionDirectory = join(directory.path, 'projects', 'repo');
  const sessionPath = join(sessionDirectory, `${sessionId}.jsonl`);
  await using _environment = createTemporaryEnvironment({ CLAUDE_CONFIG_DIR: directory.path });

  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(sessionPath, '');
  await truncate(sessionPath, 17 * 1024 * 1024);
  await appendFile(
    sessionPath,
    `\n${JSON.stringify({
      message: {
        content: [{ text: 'Newest bounded Claude message.', type: 'text' }],
        role: 'user',
      },
      type: 'user',
    })}\n`,
  );

  await expect(readClaudeSessionContext(sessionId)).resolves.toMatchObject({
    messages: [{ role: 'user', text: 'Newest bounded Claude message.' }],
  });
});
