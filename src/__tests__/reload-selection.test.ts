/**
 * @vitest-environment jsdom
 */

import { expect, test } from 'vite-plus/test';
import {
  consumeReloadSelection,
  getReloadSelectionPath,
  writeReloadSelection,
} from '../lib/reload-selection.ts';
import type { ChangedFile, RepositoryState } from '../types.ts';

const file = (path: string) =>
  ({
    fingerprint: `${path}:1`,
    path,
    sections: [],
    status: 'modified',
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
  expect(getReloadSelectionPath(selection, currentState)).toBe(secondFile.path);
  expect(consumeReloadSelection()).toBeNull();
  expect(getReloadSelectionPath(selection, state([firstFile]))).toBeNull();
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
