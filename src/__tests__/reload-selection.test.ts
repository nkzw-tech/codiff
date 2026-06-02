/**
 * @vitest-environment jsdom
 */

import { beforeEach, expect, test } from 'vite-plus/test';
import {
  consumeReloadSelection,
  getReloadDeltaPaths,
  getReloadSelectionPath,
  writeReloadSelection,
} from '../lib/reload-selection.ts';
import type { ChangedFile, GitFileStatus, RepositoryState } from '../types.ts';

beforeEach(() => {
  window.sessionStorage.clear();
});

const file = (path: string, fingerprint = `${path}:1`, status: GitFileStatus = 'modified') =>
  ({
    fingerprint,
    path,
    sections: [],
    status,
  }) satisfies ChangedFile;

const state = (files: ReadonlyArray<ChangedFile>) =>
  ({
    branch: 'main',
    files,
    generatedAt: 1,
    launchPath: '/repo',
    root: '/repo',
    source: { type: 'working-tree' },
  }) satisfies RepositoryState;

test('reload selection is consumed once and restored only when the file still exists', () => {
  const firstFile = file('src/first.ts');
  const secondFile = file('src/second.ts');
  const currentState = state([firstFile, secondFile]);

  writeReloadSelection(currentState, secondFile.path);

  const selection = consumeReloadSelection();
  expect(selection?.source).toEqual(currentState.source);
  expect(getReloadSelectionPath(selection, currentState)).toBe(secondFile.path);
  expect(consumeReloadSelection()).toBeNull();
  expect(getReloadSelectionPath(selection, state([firstFile]))).toBeNull();
});

test('reload delta paths include only current files changed since reload', () => {
  const unchangedFile = file('src/unchanged.ts', 'same');
  const changedFile = file('src/changed.ts', 'before');
  const removedFile = file('src/removed.ts', 'old');
  const currentState = state([unchangedFile, changedFile, removedFile]);

  writeReloadSelection(currentState, changedFile.path);

  const selection = consumeReloadSelection();
  expect(
    getReloadDeltaPaths(
      selection,
      state([unchangedFile, file('src/changed.ts', 'after'), file('src/new.ts', 'new', 'added')]),
    ),
  ).toEqual(new Set(['src/changed.ts', 'src/new.ts']));
});

test('reload selection is ignored when it belongs to another repository source', () => {
  const changedFile = file('src/app.ts');
  const workingTreeState = state([changedFile]);
  const commitState = {
    ...workingTreeState,
    source: { ref: 'abc1234', type: 'commit' },
  } satisfies RepositoryState;

  writeReloadSelection(workingTreeState, changedFile.path);

  expect(getReloadSelectionPath(consumeReloadSelection(), commitState)).toBeNull();
});
