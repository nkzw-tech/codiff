import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);

const { parseReviewUrl } = require('../review-source.cjs') as {
  parseReviewUrl: (value: string) => {
    host: string;
    number: number;
    owner?: string;
    projectPath: string;
    provider: 'github' | 'gitlab';
    repo?: string;
    url: string;
  } | null;
};

test('parseReviewUrl reads canonical GitHub pull request URLs', () => {
  expect(parseReviewUrl('https://github.com/nkzw-tech/codiff/pull/1728')).toEqual({
    host: 'github.com',
    number: 1728,
    owner: 'nkzw-tech',
    projectPath: 'nkzw-tech/codiff',
    provider: 'github',
    repo: 'codiff',
    url: 'https://github.com/nkzw-tech/codiff/pull/1728',
  });
});

test('parseReviewUrl ignores GitHub tab segments, queries and fragments', () => {
  for (const value of [
    'https://github.com/nkzw-tech/codiff/pull/1728/',
    'https://github.com/nkzw-tech/codiff/pull/1728/changes#r2231',
    'https://github.com/nkzw-tech/codiff/pull/1728/files',
    'https://github.com/nkzw-tech/codiff/pull/1728/files#diff-8a1b2c',
    'https://github.com/nkzw-tech/codiff/pull/1728/commits/0f1e2d3c',
    'https://github.com/nkzw-tech/codiff/pull/1728?diff=split&w=1',
    'https://github.com/nkzw-tech/codiff/pull/1728#issuecomment-4412',
  ]) {
    expect(parseReviewUrl(value)).toMatchObject({
      number: 1728,
      provider: 'github',
      url: 'https://github.com/nkzw-tech/codiff/pull/1728',
    });
  }
});

test('parseReviewUrl accepts GitHub URLs pasted without a scheme or with `www`', () => {
  for (const value of [
    'github.com/nkzw-tech/codiff/pull/1728/changes',
    'www.github.com/nkzw-tech/codiff/pull/1728',
    'https://www.github.com/nkzw-tech/codiff/pull/1728/files',
    'HTTPS://GitHub.com/nkzw-tech/codiff/pull/1728',
    '<https://github.com/nkzw-tech/codiff/pull/1728>',
    '  https://github.com/nkzw-tech/codiff/pull/1728/files  ',
  ]) {
    expect(parseReviewUrl(value)).toMatchObject({
      host: 'github.com',
      number: 1728,
      owner: 'nkzw-tech',
      repo: 'codiff',
      url: 'https://github.com/nkzw-tech/codiff/pull/1728',
    });
  }
});

test('parseReviewUrl strips a `.git` suffix from GitHub repositories', () => {
  expect(parseReviewUrl('https://github.com/nkzw-tech/codiff.git/pull/1728')).toMatchObject({
    projectPath: 'nkzw-tech/codiff',
    repo: 'codiff',
    url: 'https://github.com/nkzw-tech/codiff/pull/1728',
  });
});

test('parseReviewUrl reads GitLab merge request URLs on arbitrary hosts', () => {
  expect(
    parseReviewUrl('https://gitlab.example.com/group/subgroup/project/-/merge_requests/23'),
  ).toEqual({
    host: 'gitlab.example.com',
    number: 23,
    projectPath: 'group/subgroup/project',
    provider: 'gitlab',
    url: 'https://gitlab.example.com/group/subgroup/project/-/merge_requests/23',
  });
});

test('parseReviewUrl ignores GitLab tab segments, queries and fragments', () => {
  for (const value of [
    'https://gitlab.example.com/group/project/-/merge_requests/23/',
    'https://gitlab.example.com/group/project/-/merge_requests/23/diffs',
    'https://gitlab.example.com/group/project/-/merge_requests/23/diffs#note_9182',
    'https://gitlab.example.com/group/project/-/merge_requests/23/commits',
    'https://gitlab.example.com/group/project/-/merge_requests/23/pipelines',
    'https://gitlab.example.com/group/project/-/merge_requests/23?commit_id=0f1e2d3c',
    'gitlab.example.com/group/project/-/merge_requests/23/diffs',
  ]) {
    expect(parseReviewUrl(value)).toMatchObject({
      number: 23,
      projectPath: 'group/project',
      provider: 'gitlab',
      url: 'https://gitlab.example.com/group/project/-/merge_requests/23',
    });
  }
});

test('parseReviewUrl reads legacy GitLab merge request URLs without the `/-/` segment', () => {
  expect(
    parseReviewUrl('https://gitlab.example.com/group/project/merge_requests/23/diffs'),
  ).toMatchObject({
    number: 23,
    projectPath: 'group/project',
    provider: 'gitlab',
    url: 'https://gitlab.example.com/group/project/-/merge_requests/23',
  });
});

test('parseReviewUrl rejects values that are not review URLs', () => {
  for (const value of [
    '',
    'main',
    'feature/pull/1',
    'https://github.com/nkzw-tech/codiff',
    'https://github.com/nkzw-tech/codiff/pull/0',
    'https://github.com/nkzw-tech/codiff/pull/abc',
    'https://github.com/nkzw-tech/codiff/issues/1728',
    'https://example.com/nkzw-tech/codiff/pull/1728',
    'some/local/path/merge_requests/23',
  ]) {
    expect(parseReviewUrl(value)).toBe(null);
  }
});
