import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const {
  DEFAULT_PI_MODEL,
  FALLBACK_PI_MODEL,
  PI_MODELS,
  PI_NOT_FOUND_CODE,
  getPiCommand,
  isPiNotFoundError,
  normalizePiModel,
  runPi,
} = require('../pi.cjs') as {
  DEFAULT_PI_MODEL: string;
  FALLBACK_PI_MODEL: string;
  PI_MODELS: ReadonlyArray<{ id: string; label: string }>;
  PI_NOT_FOUND_CODE: string;
  getPiCommand: () => string;
  isPiNotFoundError: (error: unknown) => boolean;
  normalizePiModel: (value: unknown) => string;
  runPi: (
    repoRoot: string,
    prompt: string,
    schema: unknown,
    outputName?: string,
    timeoutMessage?: string,
    options?: { model?: string },
  ) => Promise<string>;
};

test('exposes the Pi default model identifier', () => {
  expect(DEFAULT_PI_MODEL).toBe('pi-default');
  expect(FALLBACK_PI_MODEL).toBe('pi-default');
  expect(PI_NOT_FOUND_CODE).toBe('PI_NOT_FOUND');
});

test('exposes a static Pi model list', () => {
  expect(PI_MODELS).toEqual([{ id: DEFAULT_PI_MODEL, label: 'Pi default' }]);
});

test('normalizes Pi model preferences to known models', () => {
  expect(normalizePiModel(DEFAULT_PI_MODEL)).toBe(DEFAULT_PI_MODEL);
  expect(normalizePiModel('openai/gpt-5')).toBe(DEFAULT_PI_MODEL);
  expect(normalizePiModel(undefined)).toBe(DEFAULT_PI_MODEL);
});

test('detects Pi-not-found errors by code', () => {
  expect(isPiNotFoundError({ code: PI_NOT_FOUND_CODE })).toBe(true);
  expect(isPiNotFoundError({ code: 'ENOENT' })).toBe(true);
  expect(isPiNotFoundError({ code: 'MODULE_NOT_FOUND' })).toBe(false);
  expect(isPiNotFoundError(new Error('other'))).toBe(false);
  expect(isPiNotFoundError(null)).toBe(false);
});

test('rejects invalid explicit Pi CLI overrides', async () => {
  await using _environment = createTemporaryEnvironment({
    CODIFF_PI_PATH: '/tmp/codiff-missing-pi',
  });

  expect(() => getPiCommand()).toThrow('CODIFF_PI_PATH');
  try {
    getPiCommand();
  } catch (error) {
    expect(error).toMatchObject({ code: PI_NOT_FOUND_CODE });
  }
});

test('runs Pi as an external read-only ephemeral CLI call', async () => {
  await using directory = await createTemporaryDirectory('codiff-pi-');
  const fakePiPath = join(directory.path, 'pi');
  const argsPath = join(directory.path, 'args.txt');
  const stdinPath = join(directory.path, 'stdin.txt');
  await using _environment = createTemporaryEnvironment({ CODIFF_PI_PATH: fakePiPath });

  await writeFile(
    fakePiPath,
    `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const argsPath = ${JSON.stringify(argsPath)};
const stdinPath = ${JSON.stringify(stdinPath)};
for (const arg of process.argv.slice(2)) {
  appendFileSync(argsPath, arg + '\\n');
}
let stdin = '';
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  writeFileSync(stdinPath, stdin);
  process.stdout.write('{"version":1}');
});
`,
  );
  await chmod(fakePiPath, 0o755);

  await expect(
    runPi(directory.path, 'prompt', { required: ['version'], type: 'object' }, 'walkthrough.json'),
  ).resolves.toBe('{"version":1}');

  const args = (await readFile(argsPath, 'utf8')).trim().split('\n');
  expect(args).toContain('--print');
  expect(args).toContain('--no-session');
  expect(args).toContain('--no-skills');
  expect(args).toContain('--no-prompt-templates');
  expect(args).toContain('--no-context-files');
  expect(args).toContain('--tools');
  expect(args).toContain('read,grep,find,ls');
  expect(args).not.toContain('--model');
  const stdin = await readFile(stdinPath, 'utf8');
  expect(stdin).toContain('prompt');
  expect(stdin).toContain('Follow this JSON Schema exactly');
});
