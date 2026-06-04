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
    options?: { model?: string },
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
      `#!/bin/sh
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "${argsPath}"
done
cat > /dev/null
printf '{"is_error":false,"result":"{\\"version\\":1}","structured_output":{"version":1}}'
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

test('surfaces a helpful message when Claude Code is not logged in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-claude-'));
  const fakeClaudePath = join(directory, 'claude');
  const previousClaudePath = process.env.CODIFF_CLAUDE_PATH;

  try {
    await writeFile(
      fakeClaudePath,
      `#!/bin/sh
cat > /dev/null
printf '{"is_error":true,"result":"Not logged in · Please run /login"}'
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
