import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const {
  CODEX_NOT_FOUND_CODE,
  CODEX_NOT_FOUND_MESSAGE,
  DEFAULT_OPENAI_MODEL,
  getCodexCommand,
  getCodexInstallPaths,
  getCodexLaunchErrorMessage,
  isOpenAIModelAvailabilityError,
  normalizeOpenAIModel,
  runCodex,
} = require('../codex.cjs') as {
  CODEX_NOT_FOUND_CODE: string;
  CODEX_NOT_FOUND_MESSAGE: string;
  DEFAULT_OPENAI_MODEL: string;
  getCodexCommand: () => string;
  getCodexInstallPaths: (platform?: NodeJS.Platform, home?: string) => Array<string>;
  getCodexLaunchErrorMessage: (error: unknown, platform?: NodeJS.Platform) => string;
  isOpenAIModelAvailabilityError: (value: string) => boolean;
  normalizeOpenAIModel: (value: unknown) => string;
  runCodex: (
    repoRoot: string,
    prompt: string,
    schema: unknown,
    outputName?: string,
    timeoutMessage?: string,
    options?: {
      model?: string;
      reasoningEffort?: 'low' | 'medium' | 'high';
      timeoutMs?: number;
    },
  ) => Promise<string>;
};

test('normalizes OpenAI model preferences to known models', () => {
  expect(normalizeOpenAIModel('gpt-5.5')).toBe('gpt-5.5');
  expect(normalizeOpenAIModel('gpt-5.4-mini')).toBe(DEFAULT_OPENAI_MODEL);
  expect(normalizeOpenAIModel('gpt-5.3-codex')).toBe(DEFAULT_OPENAI_MODEL);
  expect(normalizeOpenAIModel('gpt-4o')).toBe(DEFAULT_OPENAI_MODEL);
});

test('detects selected model availability failures', () => {
  expect(
    isOpenAIModelAvailabilityError('You do not have access to model gpt-5.3-codex-spark.'),
  ).toBe(true);
  expect(isOpenAIModelAvailabilityError('Rate limit reached, please try again later.')).toBe(false);
});

test('explains macOS Codex CLI security blocks', () => {
  expect(
    getCodexLaunchErrorMessage(
      new Error('"codex" was not opened because it contains malware.'),
      'darwin',
    ),
  ).toContain('Update Codex CLI');
  expect(
    getCodexLaunchErrorMessage(
      Object.assign(new Error('spawn codex EACCES'), {
        code: 'EACCES',
      }),
      'darwin',
    ),
  ).toContain('Update Codex CLI');
  expect(
    getCodexLaunchErrorMessage(
      {
        message: 'Codex was terminated by SIGKILL.',
        signal: 'SIGKILL',
      },
      'darwin',
    ),
  ).toContain('Update Codex CLI');
  expect(getCodexLaunchErrorMessage(new Error('spawn codex EACCES'), 'linux')).toBe(
    'spawn codex EACCES',
  );
});

test('explains missing Codex CLI launches', () => {
  expect(
    getCodexLaunchErrorMessage(
      Object.assign(new Error('spawn codex ENOENT'), {
        code: 'ENOENT',
      }),
    ),
  ).toBe(CODEX_NOT_FOUND_MESSAGE);
});

test('checks the Codex app embedded CLI on macOS', () => {
  expect(getCodexInstallPaths('darwin', '/Users/reviewer')).toEqual([
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Users/reviewer/Applications/Codex.app/Contents/Resources/codex',
  ]);
  expect(getCodexInstallPaths('linux', '/home/reviewer')).toEqual([
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ]);
});

test('rejects invalid explicit Codex CLI overrides', () => {
  const previousCodexPath = process.env.CODIFF_CODEX_PATH;
  process.env.CODIFF_CODEX_PATH = '/tmp/codiff-missing-codex';

  try {
    expect(() => getCodexCommand()).toThrow('CODIFF_CODEX_PATH');
    try {
      getCodexCommand();
    } catch (error) {
      expect(error).toMatchObject({ code: CODEX_NOT_FOUND_CODE });
    }
  } finally {
    if (previousCodexPath == null) {
      delete process.env.CODIFF_CODEX_PATH;
    } else {
      process.env.CODIFF_CODEX_PATH = previousCodexPath;
    }
  }
});

test('runs Codex walkthroughs as fresh ephemeral repository-scoped calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-codex-'));
  const fakeCodexPath = join(directory, 'codex');
  const argsPath = join(directory, 'args.txt');
  const cwdPath = join(directory, 'cwd.txt');
  const previousCodexPath = process.env.CODIFF_CODEX_PATH;

  try {
    const repoPath = join(directory, 'repo');
    await mkdir(repoPath);
    await writeFile(
      fakeCodexPath,
      `#!/bin/sh
pwd > "${cwdPath}"
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "${argsPath}"
done
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    printf '{"version":1}' > "$1"
    exit 0
  fi
  shift
done
exit 1
`,
    );
    await chmod(fakeCodexPath, 0o755);
    process.env.CODIFF_CODEX_PATH = fakeCodexPath;

    await expect(runCodex(repoPath, 'prompt', {}, 'walkthrough.json', 'Timed out.')).resolves.toBe(
      '{"version":1}',
    );

    const args = (await readFile(argsPath, 'utf8')).trim().split('\n');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--cd');
    expect(args).toContain(repoPath);
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).not.toContain('resume');
    await expect(readFile(cwdPath, 'utf8')).resolves.toBe(`${await realpath(repoPath)}\n`);
  } finally {
    if (previousCodexPath == null) {
      delete process.env.CODIFF_CODEX_PATH;
    } else {
      process.env.CODIFF_CODEX_PATH = previousCodexPath;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('forwards per-call Codex reasoning effort overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-codex-'));
  const fakeCodexPath = join(directory, 'codex');
  const argsPath = join(directory, 'args.txt');
  const previousCodexPath = process.env.CODIFF_CODEX_PATH;

  try {
    const repoPath = join(directory, 'repo');
    await mkdir(repoPath);
    await writeFile(
      fakeCodexPath,
      `#!/bin/sh
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "${argsPath}"
done
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    printf '{"version":1}' > "$1"
    exit 0
  fi
  shift
done
exit 1
`,
    );
    await chmod(fakeCodexPath, 0o755);
    process.env.CODIFF_CODEX_PATH = fakeCodexPath;

    await expect(
      runCodex(repoPath, 'prompt', {}, 'walkthrough.json', 'Timed out.', {
        reasoningEffort: 'low',
      }),
    ).resolves.toBe('{"version":1}');

    const args = (await readFile(argsPath, 'utf8')).trim().split('\n');
    expect(args).toContain('model_reasoning_effort="low"');
  } finally {
    if (previousCodexPath == null) {
      delete process.env.CODIFF_CODEX_PATH;
    } else {
      process.env.CODIFF_CODEX_PATH = previousCodexPath;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('supports per-call Codex timeouts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-codex-timeout-'));
  const fakeCodexPath = join(directory, 'codex');
  const previousCodexPath = process.env.CODIFF_CODEX_PATH;

  try {
    const repoPath = join(directory, 'repo');
    await mkdir(repoPath);
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1_000);
`,
    );
    await chmod(fakeCodexPath, 0o755);
    process.env.CODIFF_CODEX_PATH = fakeCodexPath;

    await expect(
      runCodex(repoPath, 'prompt', {}, 'walkthrough.json', 'Timed out.', { timeoutMs: 10 }),
    ).rejects.toThrow('Timed out.');
  } finally {
    if (previousCodexPath == null) {
      delete process.env.CODIFF_CODEX_PATH;
    } else {
      process.env.CODIFF_CODEX_PATH = previousCodexPath;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('surfaces structured Codex CLI errors without the full prompt stream', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-codex-'));
  const fakeCodexPath = join(directory, 'codex');
  const previousCodexPath = process.env.CODIFF_CODEX_PATH;

  try {
    const repoPath = join(directory, 'repo');
    await mkdir(repoPath);
    await writeFile(
      fakeCodexPath,
      `#!/bin/sh
printf '%s\\n' 'user very long prompt that should not be shown'
printf '%s\\n' 'ERROR: {"type":"error","error":{"message":"Invalid schema for response_format."}}' >&2
exit 1
`,
    );
    await chmod(fakeCodexPath, 0o755);
    process.env.CODIFF_CODEX_PATH = fakeCodexPath;

    let message = '';
    try {
      await runCodex(repoPath, 'prompt', {}, 'walkthrough.json', 'Timed out.');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('Invalid schema for response_format.');
    expect(message).not.toContain('very long prompt');
  } finally {
    if (previousCodexPath == null) {
      delete process.env.CODIFF_CODEX_PATH;
    } else {
      process.env.CODIFF_CODEX_PATH = previousCodexPath;
    }
    await rm(directory, { force: true, recursive: true });
  }
});
