import { expect, test } from 'vite-plus/test';
import { hasReviewedCodeChanged, reconcileRepositoryRefresh } from '../lib/repository-refresh.ts';
import type { GitSha, RepositoryState } from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';

const gitSha = (character: string) => character.repeat(40) as GitSha;
const stateFor = (
  files: RepositoryState['files'],
  source: RepositoryState['source'] = { type: 'working-tree' },
): RepositoryState => ({
  branch: 'main',
  files,
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source,
});

test('reconciles changed paths, selection, collapsed state, and walkthrough refresh together', () => {
  const previousState = stateFor([
    createChangedFile('src/changed.ts', { fingerprint: 'before', patch: 'before' }),
    createChangedFile('src/unchanged.ts', { fingerprint: 'stable' }),
    createChangedFile('src/removed.ts'),
  ]);
  const nextState = stateFor([
    createChangedFile('src/changed.ts', { fingerprint: 'after', patch: 'after' }),
    createChangedFile('src/unchanged.ts', { fingerprint: 'stable' }),
  ]);

  expect(
    reconcileRepositoryRefresh({
      collapsed: new Set(['src/changed.ts', 'src/unchanged.ts']),
      historySource: null,
      mainMode: 'review',
      nextState,
      previousState,
      selectedPath: 'src/removed.ts',
    }),
  ).toEqual({
    changedPaths: new Set(['src/changed.ts']),
    collapsed: new Set(['src/unchanged.ts']),
    historySource: null,
    mainMode: 'review',
    selectedPath: 'src/changed.ts',
    walkthroughNeedsRefresh: true,
  });
});

test('repairs commit mode after the working tree becomes empty', () => {
  const previousState = stateFor([createChangedFile('src/committed.ts')]);
  const nextState = stateFor([]);

  expect(
    reconcileRepositoryRefresh({
      collapsed: new Set(),
      historySource: null,
      mainMode: 'commit',
      nextState,
      previousState,
      selectedPath: 'src/committed.ts',
    }),
  ).toMatchObject({ mainMode: 'review', selectedPath: null });
});

test('retains the active History scope when refreshed state has no replacement', () => {
  const historySource = {
    baseSha: gitSha('a'),
    headSha: gitSha('b'),
    ref: 'feature',
    type: 'branch-diff',
  } as const;
  const previousState = stateFor([], {
    ...historySource,
    type: 'branch-working-tree',
  });
  const nextState = stateFor([], { type: 'working-tree' });

  expect(
    reconcileRepositoryRefresh({
      collapsed: new Set(),
      historySource,
      mainMode: 'review',
      nextState,
      previousState,
      selectedPath: null,
    }).historySource,
  ).toEqual(historySource);
});

test('compares canonical reviewed code without provider order or revision metadata', () => {
  const original = createChangedFile('src/reviewed.ts', {
    fingerprint: 'provider-state-a',
    patch: 'diff --git a/src/reviewed.ts b/src/reviewed.ts\n@@ -1 +1 @@\n-old\n+new\n',
  });
  const withRange = {
    ...original,
    sections: original.sections.map((section) => ({
      ...section,
      range: {
        base: {
          label: { kind: 'commit' as const, text: 'base' },
          sha: gitSha('a'),
        },
        head: {
          label: { kind: 'commit' as const, text: 'head' },
          sha: gitSha('b'),
        },
      },
    })),
  };
  const refreshed = {
    ...withRange,
    fingerprint: 'provider-state-b',
    generated: true,
    sections: withRange.sections.map((section) => ({
      ...section,
      id: 'provider-order-2',
      kind: 'pull-request' as const,
      loadState: 'ready' as const,
      newFile: { cacheKey: 'new-head:path', contents: 'new\n', name: 'src/reviewed.ts' },
      oldFile: { cacheKey: 'old-base:path', contents: 'old\n', name: 'src/reviewed.ts' },
      range: {
        base: {
          label: { kind: 'commit' as const, text: 'rebased' },
          sha: gitSha('c'),
        },
        head: {
          label: { kind: 'commit' as const, text: 'updated' },
          sha: gitSha('d'),
        },
      },
      summary: { canLoad: false, reason: 'Hydrated after refresh.' },
    })),
  };
  const other = createChangedFile('src/other.ts');

  expect(hasReviewedCodeChanged([withRange, other], [other, refreshed])).toBe(false);
});

test('detects reviewed patch, blob, path, rename, and status changes', () => {
  const file = createChangedFile('src/reviewed.ts');
  const binary = {
    ...file,
    sections: file.sections.map((section) => ({
      ...section,
      binary: true,
      patch: '',
      summary: { fingerprint: 'blob-a', reason: 'Binary file changed.' },
    })),
  };

  expect(
    hasReviewedCodeChanged(
      [file],
      [createChangedFile('src/reviewed.ts', { patch: `${file.sections[0].patch}+another\n` })],
    ),
  ).toBe(true);
  expect(
    hasReviewedCodeChanged(
      [binary],
      [
        {
          ...binary,
          sections: binary.sections.map((section) => ({
            ...section,
            summary: { fingerprint: 'blob-b', reason: 'Different provider wording.' },
          })),
        },
      ],
    ),
  ).toBe(true);
  expect(hasReviewedCodeChanged([file], [{ ...file, path: 'src/moved.ts' }])).toBe(true);
  expect(hasReviewedCodeChanged([file], [{ ...file, oldPath: 'src/old.ts' }])).toBe(true);
  expect(hasReviewedCodeChanged([file], [{ ...file, status: 'renamed' }])).toBe(true);
});
