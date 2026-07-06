import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const {
  CLAUDE_NOT_FOUND_CODE,
  DEFAULT_CLAUDE_MODEL,
  getClaudeCommand,
  isClaudeModelAvailabilityError,
  isClaudeNotLoggedInError,
  normalizeClaudeModel,
  runClaude,
} = require('../claude.cjs') as {
  CLAUDE_NOT_FOUND_CODE: string;
  DEFAULT_CLAUDE_MODEL: string;
  getClaudeCommand: () => string;
  isClaudeModelAvailabilityError: (value: string) => boolean;
  isClaudeNotLoggedInError: (value: string) => boolean;
  normalizeClaudeModel: (value: unknown) => string;
  runClaude: (
    repoRoot: string,
    prompt: string,
    schema: unknown,
    outputName?: string,
    timeoutMessage?: string,
    options?: { model?: string; onOutput?: (chunk: string) => void; timeoutMs?: number },
  ) => Promise<string>;
};

test('normalizes Claude Code model preferences to known models', () => {
  expect(normalizeClaudeModel('claude-opus-4-8')).toBe('claude-opus-4-8');
  expect(normalizeClaudeModel('gpt-4o')).toBe(DEFAULT_CLAUDE_MODEL);
});

test('detects selected Claude model availability failures', () => {
  expect(isClaudeModelAvailabilityError('model_not_found: claude-opus-4-8')).toBe(true);
  expect(isClaudeModelAvailabilityError('Rate limit reached, please try again later.')).toBe(false);
});

test('detects Claude Code login failures', () => {
  expect(isClaudeNotLoggedInError('Not logged in · Please run /login')).toBe(true);
  expect(isClaudeNotLoggedInError('Walkthrough is ready.')).toBe(false);
});

test('rejects invalid explicit Claude CLI overrides', () => {
  const previousClaudePath = process.env.CODIFF_CLAUDE_PATH;
  process.env.CODIFF_CLAUDE_PATH = '/tmp/codiff-missing-claude';

  try {
    expect(() => getClaudeCommand()).toThrow('CODIFF_CLAUDE_PATH');
    try {
      getClaudeCommand();
    } catch (error) {
      expect(error).toMatchObject({ code: CLAUDE_NOT_FOUND_CODE });
    }
  } finally {
    if (previousClaudePath == null) {
      delete process.env.CODIFF_CLAUDE_PATH;
    } else {
      process.env.CODIFF_CLAUDE_PATH = previousClaudePath;
    }
  }
});

test('runs Claude Code headless as a read-only structured-output call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-claude-'));
  const fakeClaudePath = join(directory, 'claude');
  const argsPath = join(directory, 'args.txt');
  const previousClaudePath = process.env.CODIFF_CLAUDE_PATH;

  try {
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const argsPath = ${JSON.stringify(argsPath)};
for (const arg of process.argv.slice(2)) {
  appendFileSync(argsPath, arg + '\\n');
}
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(${JSON.stringify(
    '{"is_error":false,"result":"{\\"version\\":1}","structured_output":{"version":1}}',
  )});
});
`,
    );
    await chmod(fakeClaudePath, 0o755);
    process.env.CODIFF_CLAUDE_PATH = fakeClaudePath;

    await expect(
      runClaude(directory, 'prompt', { type: 'object' }, 'walkthrough.json', 'Timed out.'),
    ).resolves.toBe('{"version":1}');

    const args = (await readFile(argsPath, 'utf8')).trim().split('\n');
    expect(args).toContain('-p');
    expect(args).toContain('--json-schema');
    expect(args).toContain('--add-dir');
    expect(args).toContain(directory);
    expect(args).toContain('--no-session-persistence');
  } finally {
    if (previousClaudePath == null) {
      delete process.env.CODIFF_CLAUDE_PATH;
    } else {
      process.env.CODIFF_CLAUDE_PATH = previousClaudePath;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('streams thinking and text from the stream-json trace and returns the result envelope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-claude-stream-'));
  const fakeClaudePath = join(directory, 'claude');
  const argsPath = join(directory, 'args.txt');
  const previousClaudePath = process.env.CODIFF_CLAUDE_PATH;

  const lines = [
    { subtype: 'init', type: 'system' },
    {
      event: { content_block: { type: 'thinking' }, type: 'content_block_start' },
      type: 'stream_event',
    },
    {
      event: {
        delta: { thinking: 'Weighing the diff…', type: 'thinking_delta' },
        type: 'content_block_delta',
      },
      type: 'stream_event',
    },
    {
      event: { content_block: { type: 'text' }, type: 'content_block_start' },
      type: 'stream_event',
    },
    {
      event: {
        delta: { text: '{"version":1}', type: 'text_delta' },
        type: 'content_block_delta',
      },
      type: 'stream_event',
    },
    {
      is_error: false,
      result: '{"version":1}',
      structured_output: { version: 1 },
      type: 'result',
    },
  ];

  try {
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const argsPath = ${JSON.stringify(argsPath)};
for (const arg of process.argv.slice(2)) {
  appendFileSync(argsPath, arg + '\\n');
}
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(${JSON.stringify(lines.map((line) => JSON.stringify(line)).join('\n'))});
});
`,
    );
    await chmod(fakeClaudePath, 0o755);
    process.env.CODIFF_CLAUDE_PATH = fakeClaudePath;

    let output = '';
    await expect(
      runClaude(directory, 'prompt', { type: 'object' }, 'walkthrough.json', 'Timed out.', {
        onOutput: (chunk) => {
          output += chunk;
        },
      }),
    ).resolves.toBe('{"version":1}');

    expect(output).toContain('Weighing the diff…');
    expect(output).toContain('{"version":1}');

    const args = (await readFile(argsPath, 'utf8')).trim().split('\n');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--include-partial-messages');
  } finally {
    if (previousClaudePath == null) {
      delete process.env.CODIFF_CLAUDE_PATH;
    } else {
      process.env.CODIFF_CLAUDE_PATH = previousClaudePath;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('supports per-call Claude Code timeouts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-claude-timeout-'));
  const fakeClaudePath = join(directory, 'claude');
  const previousClaudePath = process.env.CODIFF_CLAUDE_PATH;

  try {
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1_000);
`,
    );
    await chmod(fakeClaudePath, 0o755);
    process.env.CODIFF_CLAUDE_PATH = fakeClaudePath;

    await expect(
      runClaude(directory, 'prompt', {}, 'walkthrough.json', 'Timed out.', { timeoutMs: 10 }),
    ).rejects.toThrow('Timed out.');
  } finally {
    if (previousClaudePath == null) {
      delete process.env.CODIFF_CLAUDE_PATH;
    } else {
      process.env.CODIFF_CLAUDE_PATH = previousClaudePath;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('surfaces a helpful message when Claude Code is not logged in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-claude-'));
  const fakeClaudePath = join(directory, 'claude');
  const previousClaudePath = process.env.CODIFF_CLAUDE_PATH;

  try {
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(${JSON.stringify(
    '{"is_error":true,"result":"Not logged in · Please run /login"}',
  )});
});
`,
    );
    await chmod(fakeClaudePath, 0o755);
    process.env.CODIFF_CLAUDE_PATH = fakeClaudePath;

    await expect(
      runClaude(directory, 'prompt', { type: 'object' }, 'walkthrough.json', 'Timed out.'),
    ).rejects.toThrow(/not logged in/i);
  } finally {
    if (previousClaudePath == null) {
      delete process.env.CODIFF_CLAUDE_PATH;
    } else {
      process.env.CODIFF_CLAUDE_PATH = previousClaudePath;
    }
    await rm(directory, { force: true, recursive: true });
  }
});
