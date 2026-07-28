import type { GitSha } from '@nkzw/codiff-core/types';
import { expect, test } from 'vite-plus/test';
import {
  classifyGitLabCommit,
  classifyGitLabTargetComparisonReviewStructure,
  orderGitLabCommitsTopologically,
  overrideGitLabTargetComparisonReviewStructure,
  type GitLabReviewStructureCommitInput,
} from '../src/review-strategy.ts';

const gitSha = (value: string) => value as GitSha;

const commit = (
  overrides: Partial<GitLabReviewStructureCommitInput> &
    Pick<GitLabReviewStructureCommitInput, 'sha' | 'title'>,
): GitLabReviewStructureCommitInput => ({
  authoredDate: '2026-07-01T00:00:00.000Z',
  authorName: 'Ada',
  message: overrides.title,
  parentShas: [gitSha('parent')],
  shortSha: overrides.sha.slice(0, 8),
  ...overrides,
});

test('maps GitLab commit fields into Core classification', () => {
  const classified = classifyGitLabCommit(
    commit({
      authoredDate: '2026-07-02T03:04:05.000Z',
      parentShas: [gitSha('base')],
      sha: gitSha('aaaaaaaa'),
      title: 'fixup! add gate',
    }),
  );

  expect(classified).toMatchObject({
    authoredAt: '2026-07-02T03:04:05.000Z',
    parentShas: ['base'],
    role: 'fixup',
    sha: 'aaaaaaaa',
  });
  expect(
    classifyGitLabCommit(commit({ sha: gitSha('bbbbbbbb'), title: 'Address review comments' }))
      .role,
  ).toBe('review-response');
});

test('selects net change for single commits and fixup-heavy histories', () => {
  expect(
    classifyGitLabTargetComparisonReviewStructure({
      commits: [commit({ sha: gitSha('aaaaaaaa'), title: 'Add one endpoint' })],
    }),
  ).toMatchObject({ reason: 'single-commit', structure: 'net-change' });

  expect(
    classifyGitLabTargetComparisonReviewStructure({
      commits: [
        commit({ sha: gitSha('aaaaaaaa'), title: 'Add request model' }),
        commit({ sha: gitSha('bbbbbbbb'), title: 'fixup! request model' }),
        commit({ sha: gitSha('cccccccc'), title: 'Address review comments' }),
        commit({ sha: gitSha('dddddddd'), title: 'nits' }),
      ],
    }),
  ).toMatchObject({ reason: 'fixup-style', structure: 'net-change' });
});

test('detects explicit commit-by-commit requests and chapter-shaped stacks', () => {
  expect(
    classifyGitLabTargetComparisonReviewStructure({
      commits: [
        commit({ sha: gitSha('aaaaaaaa'), title: 'Add request model' }),
        commit({ sha: gitSha('bbbbbbbb'), title: 'Test request model' }),
      ],
      description: 'Please review commit by commit.',
    }),
  ).toMatchObject({ reason: 'explicit-description', structure: 'commit-by-commit' });

  expect(
    classifyGitLabTargetComparisonReviewStructure({
      commits: [
        commit({ sha: gitSha('aaaaaaaa'), title: 'Add endpoint' }),
        commit({ sha: gitSha('bbbbbbbb'), title: 'Test endpoint' }),
        commit({ sha: gitSha('cccccccc'), title: 'Document endpoint' }),
      ],
    }),
  ).toMatchObject({ structure: 'commit-by-commit' });
});

test('treats a short distinct descriptive history as commit-by-commit', () => {
  expect(
    classifyGitLabTargetComparisonReviewStructure({
      commits: [
        commit({ sha: gitSha('aaaaaaaa'), title: 'Add the request path' }),
        commit({ sha: gitSha('bbbbbbbb'), title: 'Handle retries' }),
      ],
    }),
  ).toMatchObject({ reason: 'chapter-shaped', structure: 'commit-by-commit' });
});

test('honors explicit net-change language over chapter shape', () => {
  expect(
    classifyGitLabTargetComparisonReviewStructure({
      commits: [
        commit({ sha: gitSha('aaaaaaaa'), title: 'Add request parsing' }),
        commit({ sha: gitSha('bbbbbbbb'), title: 'Add response parsing' }),
      ],
      description: 'Please review as a whole; squash on merge.',
    }),
  ).toMatchObject({ reason: 'explicit-whole', structure: 'net-change' });
});

test('supports explicit target-comparison structure overrides', () => {
  const sourceCommits = [commit({ sha: gitSha('aaaaaaaa'), title: 'Add routing' })];
  const automatic = classifyGitLabTargetComparisonReviewStructure({ commits: sourceCommits });

  expect(overrideGitLabTargetComparisonReviewStructure(automatic, 'net-change')).toMatchObject({
    reason: 'user-override',
    structure: 'net-change',
  });
  expect(
    overrideGitLabTargetComparisonReviewStructure(
      { confidence: 1, reason: 'default', structure: 'net-change' },
      'commit-by-commit',
      sourceCommits,
    ),
  ).toMatchObject({
    commits: [expect.objectContaining({ sha: 'aaaaaaaa' })],
    reason: 'user-override',
    structure: 'commit-by-commit',
  });
});

test('orders GitLab commits from the comparison base toward its head', () => {
  const oldest = commit({
    authoredDate: '2026-07-01T00:00:00.000Z',
    parentShas: [gitSha('base')],
    sha: gitSha('aaaaaaaa'),
    title: 'Add model',
  });
  const middle = commit({
    authoredDate: '2026-07-02T00:00:00.000Z',
    parentShas: [oldest.sha],
    sha: gitSha('bbbbbbbb'),
    title: 'Use model',
  });
  const newest = commit({
    authoredDate: '2026-07-03T00:00:00.000Z',
    parentShas: [middle.sha],
    sha: gitSha('cccccccc'),
    title: 'Test model',
  });

  expect(orderGitLabCommitsTopologically([newest, middle, oldest])).toEqual([
    oldest,
    middle,
    newest,
  ]);
});
