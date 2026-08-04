import { expect, test } from 'vite-plus/test';
import {
  getReviewContextExpansionState,
  getReviewContextRequest,
  reviewContextExpansionDigest,
  reviewContextExpansionProjectionKey,
} from '../lib/review-context-expansion.ts';
import type { DiffSection, GitSha, RepositoryState } from '../types.ts';

test('progressive context expansion accumulates independently per separator', () => {
  let state = getReviewContextExpansionState(undefined, 1, 'up', 100, false);
  state = getReviewContextExpansionState(state, 1, 'down', 100, false);
  state = getReviewContextExpansionState(state, 2, 'both', 100, false);

  expect([...state.entries()]).toEqual([
    [1, { fromEnd: 100, fromStart: 100 }],
    [2, { fromEnd: 100, fromStart: 100 }],
  ]);
});

test('show all records unbounded expansion without changing other separators', () => {
  const state = getReviewContextExpansionState(
    getReviewContextExpansionState(undefined, 1, 'up', 100, false),
    1,
    'both',
    100,
    true,
  );

  expect(state.get(1)).toEqual({
    fromEnd: Number.POSITIVE_INFINITY,
    fromStart: Number.POSITIVE_INFINITY,
  });
  expect(reviewContextExpansionDigest(state)).toBe('1:Infinity:Infinity');
});

test('projection identity follows rendered code, not post-generation materialization', () => {
  const key = reviewContextExpansionProjectionKey('target', 'file-a', 'section-a');
  expect(key).toBe(reviewContextExpansionProjectionKey('target', 'file-a', 'section-a'));
  expect(key).not.toBe(reviewContextExpansionProjectionKey('version', 'file-a', 'section-a'));
  expect(key).not.toBe(reviewContextExpansionProjectionKey('target', 'file-b', 'section-a'));
});

test('host resolution uses exact immutable section coordinates when available', () => {
  const source = {
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/example/repo/pull/1',
  } satisfies RepositoryState['source'];
  const section = {
    binary: false,
    id: 'section',
    kind: 'pull-request',
    patch: '',
    range: {
      base: {
        label: { kind: 'commit', text: 'base' },
        sha: 'a'.repeat(40) as GitSha,
      },
      head: {
        label: { kind: 'commit', text: 'head' },
        sha: 'b'.repeat(40) as GitSha,
      },
    },
  } satisfies DiffSection;

  const file = {
    fingerprint: 'file',
    oldPath: 'src/old.ts',
    path: 'src/new.ts',
    sections: [section],
    status: 'renamed' as const,
  };
  expect(getReviewContextRequest(source, file, section)).toEqual({
    baseSha: 'a'.repeat(40),
    filePath: 'src/new.ts',
    headSha: 'b'.repeat(40),
    oldPath: 'src/old.ts',
    range: section.range,
    source,
    status: 'renamed',
  });
  expect(getReviewContextRequest(source, file, { ...section, range: undefined })).toBeNull();
});
