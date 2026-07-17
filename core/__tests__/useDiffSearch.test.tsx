/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test } from 'vite-plus/test';
import { useDiffSearch } from '../app/hooks/useDiffSearch.ts';
import type { ChangedFile } from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact } from './helpers/react.tsx';

type DiffSearchState = ReturnType<typeof useDiffSearch>;

function DiffSearchHarness({
  files,
  fileSearchQuery = '',
  onState,
  showWhitespace = false,
}: {
  files: ReadonlyArray<ChangedFile>;
  fileSearchQuery?: string;
  onState: (state: DiffSearchState) => void;
  showWhitespace?: boolean;
}) {
  const state = useDiffSearch({
    files,
    fileSearchQuery,
    showWhitespace,
  });
  onState(state);
  return null;
}

const renderDiffSearch = async (files: ReadonlyArray<ChangedFile>, fileSearchQuery = '') => {
  const stateRef: { current: DiffSearchState | null } = { current: null };
  const getState = () => {
    if (!stateRef.current) {
      throw new Error('Diff search did not render.');
    }
    return stateRef.current;
  };
  const renderHarness = (
    nextFiles: ReadonlyArray<ChangedFile>,
    nextFileSearchQuery = fileSearchQuery,
  ) => (
    <DiffSearchHarness
      files={nextFiles}
      fileSearchQuery={nextFileSearchQuery}
      onState={(state) => (stateRef.current = state)}
    />
  );
  const view = await renderReact(renderHarness(files));

  return {
    getState,
    rerender: (nextFiles: ReadonlyArray<ChangedFile>, nextFileSearchQuery?: string) =>
      view.rerender(renderHarness(nextFiles, nextFileSearchQuery)),
    async [Symbol.asyncDispose]() {
      await view[Symbol.asyncDispose]();
    },
  };
};

test('diff search filters files by file query, visible diffs, and diff matches', async () => {
  const matchingFile = createChangedFile('src/needle-one.ts');
  const otherFile = createChangedFile('docs/guide.md');
  const emptyFile = createChangedFile('src/empty.ts', { patch: '' });
  await using view = await renderDiffSearch([matchingFile, otherFile, emptyFile], 'sno');
  const { getState, rerender } = view;

  expect(getState().fileFilteredFiles.map((file) => file.path)).toEqual(['src/needle-one.ts']);
  expect(getState().visibleFiles).toEqual(getState().fileFilteredFiles);
  await rerender([matchingFile, otherFile, emptyFile], '');
  expect(getState().fileFilteredFiles.map((file) => file.path)).toEqual([
    'src/needle-one.ts',
    'docs/guide.md',
  ]);
  await act(async () => {
    getState().updateQuery('needle');
  });
  expect(getState().hasQuery).toBe(true);
  expect(getState().matchPathSet).toEqual(new Set(['src/needle-one.ts']));
  expect(getState().visibleFiles.map((file) => file.path)).toEqual(['src/needle-one.ts']);
  expect(getState().activeMatch?.filePath).toBe('src/needle-one.ts');
});

test('diff search navigation wraps and clamps the active match when results shrink', async () => {
  const files = [
    createChangedFile('src/needle-a.ts'),
    createChangedFile('src/needle-b.ts'),
    createChangedFile('src/needle-c.ts'),
  ];
  await using view = await renderDiffSearch(files);
  const { getState, rerender } = view;

  await act(async () => {
    getState().updateQuery('needle');
  });
  await act(async () => {
    getState().moveMatch(-1);
  });
  expect(getState().matches).toHaveLength(3);
  expect(getState().activeMatchIndex).toBe(2);
  expect(getState().activeMatch?.filePath).toBe('src/needle-c.ts');
  await act(async () => {
    getState().moveMatch(1);
  });
  expect(getState().activeMatchIndex).toBe(0);
  expect(getState().activeMatch?.filePath).toBe('src/needle-a.ts');
  await act(async () => {
    getState().moveMatch(-1);
  });
  await rerender(files.slice(0, 1));
  expect(getState().activeMatchIndex).toBe(0);
  expect(getState().activeMatch?.filePath).toBe('src/needle-a.ts');
});

test('diff search open, close, and reset preserve the existing panel lifecycle', async () => {
  await using view = await renderDiffSearch([createChangedFile('src/needle.ts')]);
  const { getState } = view;

  expect(getState().visible).toBe(false);
  expect(getState().focusRequest).toBe(0);
  await act(async () => {
    getState().openSearch();
    getState().openSearch();
  });
  expect(getState().visible).toBe(true);
  expect(getState().focusRequest).toBe(2);
  await act(async () => {
    getState().updateQuery('needle');
    getState().resetSearch();
  });
  expect(getState().query).toBe('');
  expect(getState().visible).toBe(true);
  await act(async () => {
    getState().updateQuery('needle');
    getState().closeSearch();
  });
  expect(getState().query).toBe('');
  expect(getState().activeMatchIndex).toBe(0);
  expect(getState().visible).toBe(false);
});
