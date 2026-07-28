import { expect, test } from 'vite-plus/test';
import { orderReviewCommitStack } from '../lib/review-commit-stack.ts';
import {
  classifyReviewCommit,
  classifyTargetComparisonReviewStructure,
  orderCommitsTopologically,
  overrideTargetComparisonReviewStructure,
  type ReviewStructureCommitInput,
} from '../lib/review-strategy.ts';
import type { GitSha } from '../types.ts';

const gitSha = (value: string) => value as GitSha;

type TestCommit = {
  authoredAt: string;
  parentShas: ReadonlyArray<GitSha>;
  sha: GitSha;
};

const commit = (
  sha: string,
  authoredAt: string,
  parentShas: ReadonlyArray<GitSha> = [],
): TestCommit => ({
  authoredAt,
  parentShas,
  sha: gitSha(sha),
});

test('retains the topological compatibility export from the canonical stack module', () => {
  const oldest = commit('a', '2026-01-01T00:00:00.000Z');
  const newest = commit('b', '2026-01-02T00:00:00.000Z', [gitSha('a')]);

  expect(orderCommitsTopologically([newest, oldest]).map((entry) => entry.sha)).toEqual(['a', 'b']);
  expect(orderCommitsTopologically).toBe(orderReviewCommitStack);
});

const reviewCommit = (
  overrides: Partial<ReviewStructureCommitInput> &
    Pick<ReviewStructureCommitInput, 'sha' | 'title'>,
): ReviewStructureCommitInput => ({
  authoredAt: '2026-07-01T00:00:00.000Z',
  authorName: 'Ada',
  message: overrides.title,
  parentShas: [gitSha('parent')],
  shortSha: overrides.sha.slice(0, 8),
  ...overrides,
});

test('classifies commit roles without provider wire types', () => {
  expect(
    classifyReviewCommit(reviewCommit({ sha: gitSha('aaaaaaaa'), title: 'fixup! gate' })).role,
  ).toBe('fixup');
  expect(
    classifyReviewCommit(
      reviewCommit({ sha: gitSha('bbbbbbbb'), title: 'Address review comments' }),
    ).role,
  ).toBe('review-response');
});

test('selects final target-comparison structures', () => {
  expect(
    classifyTargetComparisonReviewStructure({
      commits: [reviewCommit({ sha: gitSha('aaaaaaaa'), title: 'Only change' })],
    }),
  ).toMatchObject({ reason: 'single-commit', structure: 'net-change' });

  expect(
    classifyTargetComparisonReviewStructure({
      commits: [
        reviewCommit({ sha: gitSha('aaaaaaaa'), title: 'Add model' }),
        reviewCommit({ sha: gitSha('bbbbbbbb'), title: 'Test model' }),
      ],
      description: 'Please review commit by commit.',
    }),
  ).toMatchObject({ reason: 'explicit-description', structure: 'commit-by-commit' });
});

test('requires classification input to be a canonical commit stack', () => {
  const first = reviewCommit({
    parentShas: [gitSha('base')],
    sha: gitSha('aaaaaaaa'),
    title: 'Add model',
  });
  const second = reviewCommit({
    parentShas: [first.sha],
    sha: gitSha('bbbbbbbb'),
    title: 'Test model',
  });

  expect(classifyTargetComparisonReviewStructure({ commits: [first, second] })).toMatchObject({
    commits: [{ sha: 'aaaaaaaa' }, { sha: 'bbbbbbbb' }],
    structure: 'commit-by-commit',
  });
  expect(() => classifyTargetComparisonReviewStructure({ commits: [second, first] })).toThrow(
    'not parent-before-child',
  );
});

test('applies target-comparison structure overrides without legacy modes', () => {
  const classification = classifyTargetComparisonReviewStructure({
    commits: [reviewCommit({ sha: gitSha('aaaaaaaa'), title: 'Only change' })],
  });
  expect(
    overrideTargetComparisonReviewStructure(classification, 'commit-by-commit', [
      reviewCommit({ sha: gitSha('aaaaaaaa'), title: 'Only change' }),
    ]),
  ).toMatchObject({
    commits: [expect.objectContaining({ sha: 'aaaaaaaa' })],
    reason: 'user-override',
    structure: 'commit-by-commit',
  });
});
