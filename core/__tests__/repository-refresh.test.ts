import { expect, test } from 'vite-plus/test';
import { reconcileRepositoryRefresh } from '../lib/repository-refresh.ts';
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
    createChangedFile('src/changed.ts', { fingerprint: 'before' }),
    createChangedFile('src/unchanged.ts', { fingerprint: 'stable' }),
    createChangedFile('src/removed.ts'),
  ]);
  const nextState = stateFor([
    createChangedFile('src/changed.ts', { fingerprint: 'after' }),
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
