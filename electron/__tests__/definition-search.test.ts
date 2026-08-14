import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import type { DefinitionSearchRequest, DefinitionSearchResult } from '../../core/types.ts';
import { createDefinitionNavigationRepository } from '../../examples/definition-navigation/create-repository.mjs';

const require = createRequire(import.meta.url);
const {
  classifyDefinition,
  createDefinitionSearchCoordinator,
  findDefinitions,
  parseGrepOutput,
  runBoundedGitGrep,
} = require('../definition-search.cjs') as {
  classifyDefinition: (
    identifier: string,
    path: string,
    line: string,
  ) => { kind: string; strength: number } | null;
  createDefinitionSearchCoordinator: (searchDefinitions?: typeof findDefinitions) => {
    cancel: (key: number) => void;
    find: (
      key: number,
      repositoryPath: string,
      request: DefinitionSearchRequest,
    ) => Promise<DefinitionSearchResult>;
  };
  findDefinitions: (
    repositoryPath: string,
    request: DefinitionSearchRequest,
  ) => Promise<DefinitionSearchResult>;
  parseGrepOutput: (
    output: string,
    revision: string | null,
  ) => Array<{ line: string; lineNumber: number; path: string }>;
  runBoundedGitGrep: (
    repositoryPath: string,
    args: ReadonlyArray<string>,
    options?: {
      maxMatches?: number;
      maxOutputBytes?: number;
      signal?: AbortSignal;
      spawnProcess?: typeof import('node:child_process').spawn;
      timeoutMs?: number;
    },
  ) => Promise<string>;
};

const request = {
  identifier: 'formatGreeting',
  kind: 'unstaged',
  lineNumber: 3,
  path: 'src/main.ts',
  side: 'additions',
  source: { type: 'working-tree' },
} satisfies DefinitionSearchRequest;

test('finds a likely definition in the deterministic example repository', async () => {
  await using directory = await createTemporaryDirectory('codiff-definitions-');
  createDefinitionNavigationRepository(directory.path);

  const result = await findDefinitions(directory.path, request);

  expect(result).toEqual({
    candidates: [
      {
        canOpenInEditor: true,
        kind: 'function',
        line: 'export function formatGreeting(name: string) {',
        lineNumber: 1,
        path: 'src/greeting.ts',
        side: 'additions',
      },
    ],
    identifier: 'formatGreeting',
    status: 'ready',
  });
});

test('marks historical snapshot candidates as unsafe for editor fallback', async () => {
  await using directory = await createTemporaryDirectory('codiff-definitions-history-');
  createDefinitionNavigationRepository(directory.path);

  const result = await findDefinitions(directory.path, {
    ...request,
    kind: 'commit',
    source: { ref: 'HEAD', type: 'commit' },
  });

  expect(result.status).toBe('ready');
  if (result.status === 'ready') {
    expect(result.candidates[0]).toMatchObject({
      canOpenInEditor: false,
      path: 'src/greeting.ts',
    });
  }
});

test('parses revision-prefixed git grep records', () => {
  expect(
    parseGrepOutput('HEAD:src/value.ts\u00001\u0000export const value = 1;\n', 'HEAD'),
  ).toEqual([{ line: 'export const value = 1;', lineNumber: 1, path: 'src/value.ts' }]);
});

test('recognizes declarations but not ordinary call sites', () => {
  expect(
    classifyDefinition('renderPage', 'src/page.ts', 'export const renderPage = () => {}'),
  ).toMatchObject({ kind: 'variable' });
  expect(classifyDefinition('renderPage', 'src/main.ts', 'renderPage();')).toBeNull();
});

test.each([
  ['TypeScript', 'formatGreeting', 'src/greeting.ts', 'export function formatGreeting() {}'],
  ['Python', 'format_greeting', 'src/greeting.py', 'def format_greeting():'],
  ['Go', 'FormatGreeting', 'src/greeting.go', 'func FormatGreeting() string {'],
  ['Rust', 'format_greeting', 'src/greeting.rs', 'pub fn format_greeting() -> String {'],
  ['Java', 'Greeting', 'src/Greeting.java', 'public class Greeting {'],
  ['Kotlin', 'formatGreeting', 'src/Greeting.kt', 'fun formatGreeting(): String {'],
  ['C', 'Greeting', 'src/greeting.h', 'typedef struct Greeting {'],
  ['C++', 'formatGreeting', 'src/greeting.cc', 'std::string formatGreeting() {'],
  ['C#', 'Greeting', 'src/Greeting.cs', 'public record Greeting(string Value);'],
  ['Ruby', 'format_greeting', 'src/greeting.rb', 'def format_greeting'],
  ['Swift', 'formatGreeting', 'src/Greeting.swift', 'public func formatGreeting() -> String {'],
  ['PHP', 'formatGreeting', 'src/greeting.php', 'function formatGreeting(): string {'],
  ['shell', 'format_greeting', 'src/greeting.sh', 'format_greeting() {'],
])('recognizes a likely %s definition', (_language, identifier, path, line) => {
  expect(classifyDefinition(identifier, path, line)).not.toBeNull();
});

test('rejects non-identifiers before searching', async () => {
  const result = await findDefinitions('/does/not/matter', {
    identifier: 'not an identifier',
    kind: 'unstaged',
    lineNumber: 1,
    path: 'src/main.ts',
    side: 'additions',
    source: { type: 'working-tree' },
  });
  expect(result.status).toBe('unavailable');
});

const createFakeGitProcess = () => {
  const child = Object.assign(new EventEmitter(), {
    kill: () => {
      queueMicrotask(() => child.emit('close', null));
      return true;
    },
    stderr: new PassThrough(),
    stdout: new PassThrough(),
  });
  return child;
};

test('stops git grep after the global result limit', async () => {
  const child = createFakeGitProcess();
  const kill = vi.spyOn(child, 'kill');
  const output = runBoundedGitGrep('/repo', ['grep'], {
    maxMatches: 2,
    maxOutputBytes: 1024,
    spawnProcess: (() => child) as unknown as typeof import('node:child_process').spawn,
    timeoutMs: 1000,
  });
  child.stdout.write(
    'src/a.ts\u00001\u0000function value() {}\n' +
      'src/b.ts\u00001\u0000function value() {}\n' +
      'src/c.ts\u00001\u0000function value() {}\n',
  );

  expect(parseGrepOutput(await output, null)).toHaveLength(2);
  expect(kill).toHaveBeenCalledOnce();
});

test('stops git grep at the global output byte limit', async () => {
  const child = createFakeGitProcess();
  const kill = vi.spyOn(child, 'kill');
  const output = runBoundedGitGrep('/repo', ['grep'], {
    maxMatches: 100,
    maxOutputBytes: 32,
    spawnProcess: (() => child) as unknown as typeof import('node:child_process').spawn,
    timeoutMs: 1000,
  });
  child.stdout.write('src/large.ts\u00001\u0000' + 'x'.repeat(100) + '\n');

  expect(Buffer.byteLength(await output)).toBeLessThanOrEqual(32);
  expect(kill).toHaveBeenCalledOnce();
});

test('kills git grep when the search times out', async () => {
  const child = createFakeGitProcess();
  const kill = vi.spyOn(child, 'kill');
  const output = runBoundedGitGrep('/repo', ['grep'], {
    spawnProcess: (() => child) as unknown as typeof import('node:child_process').spawn,
    timeoutMs: 1,
  });

  await expect(output).rejects.toThrow('timed out');
  expect(kill).toHaveBeenCalledOnce();
});

test('coalesces repeated searches by cancelling the previous process signal', async () => {
  const pending: Array<{
    resolve: (result: DefinitionSearchResult) => void;
    signal: AbortSignal;
  }> = [];
  const searchDefinitions = vi.fn(
    (
      _repositoryPath: string,
      _request: DefinitionSearchRequest,
      options: { signal?: AbortSignal } = {},
    ) =>
      new Promise<DefinitionSearchResult>((resolve) => {
        pending.push({ resolve, signal: options.signal as AbortSignal });
      }),
  );
  const coordinator = createDefinitionSearchCoordinator(searchDefinitions);
  const first = coordinator.find(1, '/repo', request);
  const second = coordinator.find(1, '/repo', request);

  expect(pending[0]?.signal.aborted).toBe(true);
  pending[0]?.resolve({ reason: 'Cancelled.', status: 'unavailable' });
  pending[1]?.resolve({ candidates: [], identifier: request.identifier, status: 'ready' });
  await expect(first).resolves.toMatchObject({ status: 'unavailable' });
  await expect(second).resolves.toMatchObject({ status: 'ready' });
});
