import { expect, test } from 'vite-plus/test';
import {
  decodeResolvedReviewSource,
  decodeReviewSource,
  formatResolvedSourceIdentity,
  formatReviewSourceIdentity,
} from '../lib/review-source-codec.ts';

test('decodes and formats every local review source kind', () => {
  const values = [
    { type: 'working-tree' },
    { ref: 'HEAD~2', type: 'commit' },
    { ref: 'main', type: 'branch' },
    { baseSha: 'A'.repeat(40), headSha: 'B'.repeat(40), ref: 'main', type: 'branch-diff' },
    {
      baseSha: 'A'.repeat(40),
      headSha: 'B'.repeat(40),
      ref: 'main',
      type: 'branch-working-tree',
    },
    { base: 'main', head: 'feature', symmetric: true, type: 'range' },
  ] as const;

  expect(values.map((value) => formatReviewSourceIdentity(decodeReviewSource(value)!))).toEqual([
    'working-tree',
    'commit:HEAD~2',
    'branch:main',
    `branch-diff:main:${'a'.repeat(40)}:${'b'.repeat(40)}`,
    `branch-working-tree:main:${'a'.repeat(40)}:${'b'.repeat(40)}`,
    'range:main...feature',
  ]);
});

test('distinguishes unresolved and resolved revision identities', () => {
  const unresolvedCommit = decodeReviewSource({ ref: 'HEAD', type: 'commit' })!;
  const resolvedCommit = decodeResolvedReviewSource({ sha: 'A'.repeat(40), type: 'commit' })!;
  const unresolvedBranchWorkingTree = decodeReviewSource({
    ref: 'main',
    type: 'branch-working-tree',
  })!;

  expect(formatReviewSourceIdentity(unresolvedCommit)).toBe('commit:HEAD');
  expect(formatResolvedSourceIdentity(resolvedCommit)).toBe(`commit:${'a'.repeat(40)}`);
  expect(formatReviewSourceIdentity(unresolvedBranchWorkingTree)).toBe(
    'branch-working-tree:main:unresolved',
  );
  expect(
    decodeReviewSource({ baseSha: 'a'.repeat(40), ref: 'main', type: 'branch-working-tree' }),
  ).toBeNull();
});

test('canonicalizes GitHub and GitLab review URLs and changes exact identity at a new head', () => {
  const github = decodeReviewSource({
    type: 'pull-request',
    url: 'https://GitHub.com/NKZW-Tech/Codiff.git/pull/8/changes#r42',
  })!;
  const gitlab = decodeReviewSource({
    type: 'pull-request',
    url: 'https://gitlab.example.com/Group/Subgroup/Project.git/-/merge_requests/9/diffs',
  })!;
  const firstHead = decodeResolvedReviewSource({ ...github, headSha: 'A'.repeat(40) })!;
  const secondHead = decodeResolvedReviewSource({ ...github, headSha: 'B'.repeat(40) })!;

  expect(github).toMatchObject({
    number: 8,
    owner: 'NKZW-Tech',
    projectPath: 'NKZW-Tech/Codiff',
    provider: 'github',
    repo: 'Codiff',
    url: 'https://github.com/NKZW-Tech/Codiff/pull/8',
  });
  expect(formatReviewSourceIdentity(github)).toBe(
    'pull-request:github:github.com:nkzw-tech/codiff#8',
  );
  expect(formatReviewSourceIdentity(gitlab)).toBe(
    'pull-request:gitlab:gitlab.example.com:group/subgroup/project#9',
  );
  expect(formatReviewSourceIdentity(firstHead)).toBe(formatReviewSourceIdentity(secondHead));
  expect(formatResolvedSourceIdentity(firstHead)).not.toBe(
    formatResolvedSourceIdentity(secondHead),
  );
});

test('rejects malformed source coordinates', () => {
  expect(decodeReviewSource(null)).toBeNull();
  expect(decodeReviewSource({ type: 'commit' })).toBeNull();
  expect(decodeReviewSource({ base: 'main', head: 'feature', type: 'range' })).toBeNull();
  expect(
    decodeReviewSource({ type: 'pull-request', url: 'https://example.com/review/1' }),
  ).toBeNull();
  expect(decodeResolvedReviewSource({ ref: 'main', type: 'branch' })).toBeNull();
});
