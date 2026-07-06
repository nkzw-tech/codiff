/**
 * @vitest-environment jsdom
 */

import { beforeEach, expect, test } from 'vite-plus/test';
import {
  consumeReloadSelection,
  getChangedPaths,
  getReloadDeltaPaths,
  getReloadHistorySource,
  getReloadMainMode,
  getReloadSelectionPath,
  writeReloadSelection,
} from '../lib/reload-selection.ts';
import type { ChangedFile, GitFileStatus, RepositoryState, ReviewSource } from '../types.ts';

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

test('reload selection preserves the branch diff source without a selected file', () => {
  const currentState = {
    ...state([]),
    source: {
      baseRef: 'base123',
      headRef: 'head123',
      ref: 'main',
      type: 'branch-diff',
    },
  } satisfies RepositoryState;

  writeReloadSelection(currentState, null);

  const selection = consumeReloadSelection();
  expect(selection?.source).toEqual(currentState.source);
  expect(getReloadSelectionPath(selection, currentState)).toBeNull();
});

test('reload selection preserves history source for the current source', () => {
  const branchSource = {
    baseRef: 'base123',
    headRef: 'head123',
    ref: 'main',
    type: 'branch-diff',
  } satisfies ReviewSource;
  const currentState = state([]);

  writeReloadSelection(currentState, null, branchSource);

  const selection = consumeReloadSelection();
  expect(selection?.historySource).toEqual(branchSource);
  expect(getReloadHistorySource(selection, currentState)).toEqual(branchSource);
  expect(
    getReloadHistorySource(selection, {
      ...currentState,
      source: { ref: 'abc1234', type: 'commit' },
    }),
  ).toBeNull();
});

test('reload selection preserves the commit view for the current source', () => {
  const changedFile = file('src/app.ts');
  const currentState = state([changedFile]);

  writeReloadSelection(currentState, changedFile.path, null, 'commit');

  const selection = consumeReloadSelection();
  expect(getReloadMainMode(selection, currentState)).toBe('commit');
  expect(
    getReloadMainMode(selection, {
      ...currentState,
      source: { ref: 'abc1234', type: 'commit' },
    }),
  ).toBeNull();
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

test('changed paths cover added, modified, and status-changed files', () => {
  const unchangedFile = file('src/unchanged.ts', 'same');
  const previous = [
    unchangedFile,
    file('src/changed.ts', 'before'),
    file('src/status.ts', 'same-status', 'modified'),
    file('src/removed.ts', 'old'),
  ];
  const next = [
    unchangedFile,
    file('src/changed.ts', 'after'),
    file('src/status.ts', 'same-status', 'added'),
    file('src/new.ts', 'new', 'added'),
  ];

  expect(getChangedPaths(previous, next)).toEqual(
    new Set(['src/changed.ts', 'src/status.ts', 'src/new.ts']),
  );
  expect(getChangedPaths(previous, previous)).toEqual(new Set());
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
