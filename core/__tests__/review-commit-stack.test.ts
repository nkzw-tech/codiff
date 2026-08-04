import { expect, test } from 'vite-plus/test';
import {
  isReviewCommitAncestor,
  orderReviewCommitStack,
  reviewCommitRange,
  validateReviewCommitStack,
} from '../lib/review-commit-stack.ts';
import type { GitSha } from '../types.ts';

const gitSha = (value: string) => value as GitSha;
type StackCommit = {
  authoredAt: string;
  parentShas: ReadonlyArray<GitSha>;
  sha: GitSha;
};
const stackCommit = (
  sha: string,
  authoredAt: string,
  parentShas: ReadonlyArray<GitSha> = [],
): StackCommit => ({ authoredAt, parentShas, sha: gitSha(sha) });

test('normalizes reversed linear commit input and validates canonical stacks', () => {
  const first = stackCommit('a', '2026-01-01T00:00:00.000Z', [gitSha('base')]);
  const second = stackCommit('b', '2026-01-02T00:00:00.000Z', [first.sha]);
  const third = stackCommit('c', '2026-01-03T00:00:00.000Z', [second.sha]);
  const ordered = orderReviewCommitStack([third, second, first]);

  expect(ordered.map(({ sha }) => sha)).toEqual(['a', 'b', 'c']);
  expect(validateReviewCommitStack(ordered)).toBe(ordered);
  expect(() => validateReviewCommitStack([third, second, first])).toThrow(
    'not parent-before-child',
  );
});

test('orders merge parents before children and parallel roots deterministically', () => {
  const earlier = stackCommit('a', '2026-01-01T00:00:00.000Z', [gitSha('external')]);
  const later = stackCommit('b', '2026-01-01T00:00:00.000Z', [gitSha('external')]);
  const merge = stackCommit('c', '2026-01-02T00:00:00.000Z', [later.sha, earlier.sha]);

  expect(orderReviewCommitStack([merge, later, earlier]).map(({ sha }) => sha)).toEqual([
    'a',
    'b',
    'c',
  ]);
});

test('rejects duplicate and cyclic commit graphs', () => {
  const duplicate = stackCommit('a', '2026-01-01T00:00:00.000Z');
  expect(() => orderReviewCommitStack([duplicate, { ...duplicate }])).toThrow('duplicate SHA a');
  const first = stackCommit('a', '2026-01-01T00:00:00.000Z', [gitSha('b')]);
  const second = stackCommit('b', '2026-01-02T00:00:00.000Z', [gitSha('a')]);
  expect(() => orderReviewCommitStack([first, second])).toThrow('contains a cycle');
});

test('derives ancestry and first-parent range membership from the commit graph', () => {
  const first = stackCommit('a', '2026-01-01T00:00:00.000Z', [gitSha('base')]);
  const second = stackCommit('b', '2026-01-02T00:00:00.000Z', [first.sha]);
  const parallel = stackCommit('p', '2026-01-02T12:00:00.000Z', [first.sha]);
  const merge = stackCommit('c', '2026-01-03T00:00:00.000Z', [second.sha, parallel.sha]);
  const stack = orderReviewCommitStack([merge, parallel, second, first]);

  expect(isReviewCommitAncestor(stack, first.sha, merge.sha)).toBe(true);
  expect(isReviewCommitAncestor(stack, parallel.sha, second.sha)).toBe(false);
  expect(reviewCommitRange(stack, first.sha, merge.sha)).toMatchObject({
    baseSha: 'base',
    headSha: 'c',
    members: [{ sha: 'a' }, { sha: 'b' }, { sha: 'p' }, { sha: 'c' }],
  });
  expect(() => reviewCommitRange(stack, parallel.sha, second.sha)).toThrow(
    'From must be an ancestor of To',
  );
  expect(() => reviewCommitRange(stack, gitSha('missing'), merge.sha)).toThrow(
    'endpoints must both exist',
  );
});
