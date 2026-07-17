import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, vi } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';
import { createCommandTransport } from './helpers/command-transport.ts';

type CommandTransport = ReturnType<typeof createCommandTransport>['transport'];

const require = createRequire(import.meta.url);
const {
  CLAUDE_NOT_FOUND_CODE,
  DEFAULT_CLAUDE_MODEL,
  getClaudeCommand,
  normalizeClaudeModel,
  runClaude,
} = require('../claude.cjs') as {
  CLAUDE_NOT_FOUND_CODE: string;
  DEFAULT_CLAUDE_MODEL: string;
  getClaudeCommand: () => string;
  normalizeClaudeModel: (value: unknown) => string;
  runClaude: (
    repoRoot: string,
    prompt: string,
    schema: unknown,
    outputName?: string,
    timeoutMessage?: string,
    options?: {
      commandTransport?: CommandTransport;
      model?: string;
      onProgress?: (phase: string) => void;
      timeoutMs?: number;
    },
  ) => Promise<string>;
};

test('normalizes Claude Code model preferences to known models', () => {
  expect(normalizeClaudeModel('claude-opus-4-8')).toBe('claude-opus-4-8');
  expect(normalizeClaudeModel('gpt-4o')).toBe(DEFAULT_CLAUDE_MODEL);
});

test('rejects invalid explicit Claude CLI overrides', async () => {
  await using _environment = createTemporaryEnvironment({
    CODIFF_CLAUDE_PATH: '/tmp/codiff-missing-claude',
  });

  expect(() => getClaudeCommand()).toThrow('CODIFF_CLAUDE_PATH');
  try {
    getClaudeCommand();
  } catch (error) {
    expect(error).toMatchObject({ code: CLAUDE_NOT_FOUND_CODE });
  }
});

test('runs Claude Code headless as a read-only structured-output call', async () => {
  await using directory = await createTemporaryDirectory('codiff-claude-');
  const fakeClaudePath = join(directory.path, 'claude');
  const argsPath = join(directory.path, 'args.txt');
  await using _environment = createTemporaryEnvironment({ CODIFF_CLAUDE_PATH: fakeClaudePath });

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

  await expect(
    runClaude(directory.path, 'prompt', { type: 'object' }, 'walkthrough.json', 'Timed out.'),
  ).resolves.toBe('{"version":1}');

  const args = (await readFile(argsPath, 'utf8')).trim().split('\n');
  expect(args).toContain('-p');
  expect(args).toContain('json');
  expect(args).not.toContain('stream-json');
  expect(args).not.toContain('--include-partial-messages');
  expect(args).toContain('--json-schema');
  expect(args).toContain('--add-dir');
  expect(args).toContain(directory.path);
  expect(args).toContain('--no-session-persistence');
});

test('maps Claude thinking and text deltas to semantic walkthrough progress', async () => {
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
  const { calls, transport } = createCommandTransport(({ close, stdin, stdout }) => {
    stdin.on('finish', () => {
      stdout(events.map((event) => JSON.stringify(event)).join('\n'));
      close();
    });
  });
  const phases: Array<string> = [];

  await expect(
    runClaude('/repo', 'prompt', { type: 'object' }, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
      onProgress: (phase) => phases.push(phase),
    }),
  ).resolves.toBe('{"version":1}');

  expect(phases).toEqual(['agent-generation', 'response-received']);
  expect(calls[0].args).toContain('stream-json');
  expect(calls[0].args).toContain('--verbose');
  expect(calls[0].args).toContain('--include-partial-messages');
});

test('maps Claude structured output deltas to response progress', async () => {
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
  const { transport } = createCommandTransport(({ close, stdin, stdout }) => {
    stdin.on('finish', () => {
      stdout(events.map((event) => JSON.stringify(event)).join('\n'));
      close();
    });
  });
  const phases: Array<string> = [];

  await expect(
    runClaude('/repo', 'prompt', { type: 'object' }, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
      onProgress: (phase) => phases.push(phase),
    }),
  ).resolves.toBe('{"version":1}');

  expect(phases).toEqual([
    'agent-generation',
    'agent-generation',
    'response-received',
    'response-received',
  ]);
});

test('supports per-call Claude Code timeouts', async () => {
  const { transport } = createCommandTransport(() => {});
  vi.useFakeTimers();
  using _timers = {
    [Symbol.dispose]() {
      vi.useRealTimers();
    },
  };

  const result = runClaude('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
    commandTransport: transport,
    timeoutMs: 10,
  });
  const rejection = expect(result).rejects.toThrow('Timed out.');
  await vi.advanceTimersByTimeAsync(10);
  await rejection;
});

test('surfaces a helpful message when Claude Code is not logged in', async () => {
  const { transport } = createCommandTransport(({ close, stdin, stdout }) => {
    stdin.on('finish', () => {
      stdout(
        JSON.stringify({
          is_error: true,
          result: 'Not logged in · Please run /login',
        }),
      );
      close();
    });
  });

  await expect(
    runClaude('/repo', 'prompt', { type: 'object' }, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
    }),
  ).rejects.toThrow(/not logged in/i);
});
