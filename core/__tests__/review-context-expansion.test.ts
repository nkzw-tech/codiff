import { expect, test } from 'vite-plus/test';
import {
  getReviewContextExpansionState,
  reviewContextExpansionDigest,
  reviewContextExpansionProjectionKey,
} from '../lib/review-context-expansion.ts';

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
