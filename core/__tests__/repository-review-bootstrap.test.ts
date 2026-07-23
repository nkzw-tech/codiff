import { expect, test } from 'vite-plus/test';
import type { ReloadSelection } from '../lib/reload-selection.ts';
import {
  resolveReloadSourceForLaunch,
  resolveRepositoryReviewBootstrap,
} from '../lib/repository-review-bootstrap.ts';
import type {
  CodiffLaunchOptions,
  GitSha,
  RepositoryState,
  ResolvedReviewSource,
} from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';

const gitSha = (character: string) => character.repeat(40) as GitSha;
const launchOptions = {
  repositoryPathProvided: true,
  walkthrough: false,
} satisfies CodiffLaunchOptions;

const stateFor = (
  source: ResolvedReviewSource,
  files: RepositoryState['files'] = [],
): RepositoryState => ({
  branch: 'main',
  files,
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source,
});

const selectionFor = (
  state: RepositoryState,
  overrides: Partial<ReloadSelection> = {},
): ReloadSelection => ({
  files: state.files.map(({ fingerprint, path, status }) => ({ fingerprint, path, status })),
  mainMode: 'review',
  root: state.root,
  selectedPath: state.files[0]?.path ?? null,
  source: state.source,
  ...overrides,
});

test('resolves clean and changed working-tree startup modes', () => {
  const cleanState = stateFor({ type: 'working-tree' });
  expect(
    resolveRepositoryReviewBootstrap({
      launchOptions,
      reloadSelection: null,
      state: cleanState,
    }),
  ).toMatchObject({
    historySource: null,
    mainMode: 'review',
    selectedPath: null,
    sidebarMode: 'history',
    source: { type: 'working-tree' },
  });

  const changedState = stateFor({ type: 'working-tree' }, [
    createChangedFile('src/changed.ts', { fingerprint: 'after' }),
  ]);
  const previous = selectionFor(changedState, {
    files: [{ fingerprint: 'before', path: 'src/changed.ts', status: 'modified' }],
  });
  const bootstrap = resolveRepositoryReviewBootstrap({
    launchOptions,
    reloadSelection: previous,
    state: changedState,
  });
  expect(bootstrap.sidebarMode).toBe('tree');
  expect(bootstrap.reloadDeltaPaths).toEqual(new Set(['src/changed.ts']));
});

test('restores a valid working-tree commit view and one-shot instant scroll target', () => {
  const state = stateFor({ type: 'working-tree' }, [
    createChangedFile('src/first.ts'),
    createChangedFile('src/restored.ts'),
  ]);
  const bootstrap = resolveRepositoryReviewBootstrap({
    launchOptions,
    reloadSelection: selectionFor(state, {
      mainMode: 'commit',
      selectedPath: 'src/restored.ts',
    }),
    state,
  });

  expect(bootstrap.mainMode).toBe('commit');
  expect(bootstrap.selectedPath).toBe('src/restored.ts');
  expect(bootstrap.initialScrollTarget).toEqual({
    behavior: 'instant',
    path: 'src/restored.ts',
    request: 1,
  });
});

test('rejects commit mode for empty and non-working-tree sources', () => {
  const emptyState = stateFor({ type: 'working-tree' });
  expect(
    resolveRepositoryReviewBootstrap({
      launchOptions,
      reloadSelection: selectionFor(emptyState, { mainMode: 'commit' }),
      state: emptyState,
    }).mainMode,
  ).toBe('review');

  const commitState = stateFor({ sha: gitSha('c'), type: 'commit' }, [
    createChangedFile('src/commit.ts'),
  ]);
  expect(
    resolveRepositoryReviewBootstrap({
      launchOptions,
      reloadSelection: selectionFor(commitState, { mainMode: 'commit' }),
      state: commitState,
    }).mainMode,
  ).toBe('review');
});

test('restores branch History scope for branch-diff and branch-working-tree reviews', () => {
  const branchSource = {
    baseSha: gitSha('a'),
    headSha: gitSha('b'),
    ref: 'feature',
    type: 'branch-diff',
  } as const;
  const branchState = stateFor(branchSource, [createChangedFile('src/branch.ts')]);
  const workingTreeSource = { ...branchSource, type: 'branch-working-tree' } as const;

  expect(
    resolveRepositoryReviewBootstrap({
      launchOptions,
      reloadSelection: selectionFor(branchState, { historySource: branchSource }),
      state: branchState,
    }).historySource,
  ).toEqual(branchSource);
  expect(
    resolveRepositoryReviewBootstrap({
      launchOptions,
      reloadSelection: selectionFor(stateFor(workingTreeSource), {
        historySource: branchSource,
        source: workingTreeSource,
      }),
      state: stateFor(workingTreeSource),
    }).historySource,
  ).toEqual(branchSource);
});

test('lets an explicit launch source override stale reload state', () => {
  const state = stateFor({ type: 'working-tree' });
  const selection = selectionFor(state);
  expect(
    resolveReloadSourceForLaunch(selection, {
      ...launchOptions,
      source: { ref: 'abc', type: 'commit' },
    }),
  ).toBeUndefined();
  expect(resolveReloadSourceForLaunch(selection, launchOptions)).toEqual({
    type: 'working-tree',
  });
});

test('walkthrough-file startup selects Walkthrough without forcing regeneration', () => {
  const state = stateFor({ type: 'working-tree' }, [
    createChangedFile('src/walkthrough.ts', { fingerprint: 'after' }),
  ]);
  const bootstrap = resolveRepositoryReviewBootstrap({
    launchOptions: { ...launchOptions, walkthroughFile: '/tmp/walkthrough.json' },
    reloadSelection: selectionFor(state, {
      files: [{ fingerprint: 'before', path: 'src/walkthrough.ts', status: 'modified' }],
    }),
    state,
  });

  expect(bootstrap.sidebarMode).toBe('walkthrough');
  expect(bootstrap.forceInitialWalkthrough).toBe(false);
});
