import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { findClaudeSessionFile, readClaudeSessionContext, readSessionMessages } =
  require('../claude-session-context.cjs') as {
    findClaudeSessionFile: (root: string, sessionId: string) => string | null;
    readClaudeSessionContext: (sessionId?: string) => {
      messages?: ReadonlyArray<{ role: 'assistant' | 'user'; text: string }>;
      risks?: ReadonlyArray<string>;
      source: { threadId?: string; type: string };
      version: 1;
    } | null;
    readSessionMessages: (
      path: string,
    ) => ReadonlyArray<{ role: 'assistant' | 'user'; text: string }>;
  };

const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';

test('extracts bounded readable messages from Claude Code session jsonl', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-claude-session-'));
  const sessionPath = join(directory, `${sessionId}.jsonl`);

  try {
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

    expect(readSessionMessages(sessionPath)).toEqual([
      { role: 'user', text: 'Implement walkthrough session handoff.' },
      { role: 'assistant', text: 'Updated the CLI and skill handoff.' },
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('finds the active Claude Code session under CLAUDE_CONFIG_DIR', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-claude-home-'));
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

  try {
    const projectDirectory = join(directory, 'projects', '-home-reviewer-repo');
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
    process.env.CLAUDE_CONFIG_DIR = directory;

    expect(findClaudeSessionFile(join(directory, 'projects'), sessionId)).toBe(sessionPath);
    expect(readClaudeSessionContext(sessionId)).toMatchObject({
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
  } finally {
    if (previousClaudeConfigDir == null) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    await rm(directory, { force: true, recursive: true });
  }
});
