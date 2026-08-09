import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import type { DefinitionSearchRequest, DefinitionSearchResult } from '../../core/types.ts';
import { createDefinitionNavigationRepository } from '../../examples/definition-navigation/create-repository.mjs';

const require = createRequire(import.meta.url);
const { classifyDefinition, findDefinitions, parseGrepOutput } =
  require('../definition-search.cjs') as {
    classifyDefinition: (
      identifier: string,
      path: string,
      line: string,
    ) => { kind: string; strength: number } | null;
    findDefinitions: (
      repositoryPath: string,
      request: DefinitionSearchRequest,
    ) => Promise<DefinitionSearchResult>;
    parseGrepOutput: (
      output: string,
      revision: string | null,
    ) => Array<{ line: string; lineNumber: number; path: string }>;
  };

test('finds a likely definition in the deterministic example repository', async () => {
  await using directory = await createTemporaryDirectory('codiff-definitions-');
  createDefinitionNavigationRepository(directory.path);

  const result = await findDefinitions(directory.path, {
    identifier: 'formatGreeting',
    kind: 'unstaged',
    lineNumber: 3,
    path: 'src/main.ts',
    side: 'additions',
    source: { type: 'working-tree' },
  });

  expect(result).toEqual({
    candidates: [
      {
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
