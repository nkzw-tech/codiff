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
    options?: {
      model?: string;
      onProgress?: (phase: string) => void;
      onSessionId?: (sessionId: string) => void;
      persistSession?: boolean;
      resumeSessionId?: string;
      timeoutMs?: number;
    },
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
    expect(args).toContain('json');
    expect(args).not.toContain('stream-json');
    expect(args).not.toContain('--include-partial-messages');
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

test('resumes a persisted Claude session and captures its session id', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-claude-resume-'));
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
    '{"is_error":false,"session_id":"sess-123","result":"{\\"version\\":1}","structured_output":{"version":1}}',
  )});
});
`,
    );
    await chmod(fakeClaudePath, 0o755);
    process.env.CODIFF_CLAUDE_PATH = fakeClaudePath;
    const sessionIds: Array<string> = [];

    await expect(
      runClaude(directory, 'prompt', { type: 'object' }, 'walkthrough.json', 'Timed out.', {
        onSessionId: (sessionId) => sessionIds.push(sessionId),
        persistSession: true,
        resumeSessionId: 'sess-abc',
      }),
    ).resolves.toBe('{"version":1}');

    const args = (await readFile(argsPath, 'utf8')).trim().split('\n');
    expect(args).toContain('--resume');
    expect(args).toContain('sess-abc');
    expect(args).not.toContain('--no-session-persistence');
    expect(sessionIds).toEqual(['sess-123']);
  } finally {
    if (previousClaudePath == null) {
      delete process.env.CODIFF_CLAUDE_PATH;
    } else {
      process.env.CODIFF_CLAUDE_PATH = previousClaudePath;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('maps Claude thinking and text deltas to semantic walkthrough progress', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-claude-progress-'));
  const fakeClaudePath = join(directory, 'claude');
  const argsPath = join(directory, 'args.txt');
  const previousClaudePath = process.env.CODIFF_CLAUDE_PATH;
  const events = [
    {
      event: {
        delta: { thinking: 'Planning', type: 'thinking_delta' },
        type: 'content_block_delta',
      },
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
require('node:fs').writeFileSync(
  ${JSON.stringify(argsPath)},
  process.argv.slice(2).join('\\n'),
);
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join('\n'))});
});
`,
    );
    await chmod(fakeClaudePath, 0o755);
    process.env.CODIFF_CLAUDE_PATH = fakeClaudePath;
    const phases: Array<string> = [];

    await expect(
      runClaude(directory, 'prompt', { type: 'object' }, 'walkthrough.json', 'Timed out.', {
        onProgress: (phase) => phases.push(phase),
      }),
    ).resolves.toBe('{"version":1}');

    expect(phases).toEqual(['agent-generation', 'response-received']);
    const args = (await readFile(argsPath, 'utf8')).split('\n');
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

test('maps Claude structured output deltas to response progress', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-claude-structured-progress-'));
  const fakeClaudePath = join(directory, 'claude');
  const previousClaudePath = process.env.CODIFF_CLAUDE_PATH;
  const events = [
    {
      event: {
        content_block: { signature: '', thinking: '', type: 'thinking' },
        type: 'content_block_start',
      },
      type: 'stream_event',
    },
    {
      event: {
        delta: { thinking: 'Planning', type: 'thinking_delta' },
        type: 'content_block_delta',
      },
      type: 'stream_event',
    },
    {
      event: {
        content_block: {
          id: 'toolu_1',
          input: {},
          name: 'StructuredOutput',
          type: 'tool_use',
        },
        type: 'content_block_start',
      },
      type: 'stream_event',
    },
    {
      event: {
        delta: { partial_json: '{"version":1}', type: 'input_json_delta' },
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
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join('\n'))});
});
`,
    );
    await chmod(fakeClaudePath, 0o755);
    process.env.CODIFF_CLAUDE_PATH = fakeClaudePath;
    const phases: Array<string> = [];

    await expect(
      runClaude(directory, 'prompt', { type: 'object' }, 'walkthrough.json', 'Timed out.', {
        onProgress: (phase) => phases.push(phase),
      }),
    ).resolves.toBe('{"version":1}');

    expect(phases).toEqual([
      'agent-generation',
      'agent-generation',
      'response-received',
      'response-received',
    ]);
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
