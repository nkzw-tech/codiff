import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { readCommitDiffStats } = require('../git-state/commit-metadata.cjs') as {
  readCommitDiffStats: (
    repoRoot: string,
    commits: ReadonlyArray<string>,
  ) => Promise<Map<string, { additions: number; deletions: number; filesChanged: number }>>;
};

const git = (repo: string, args: ReadonlyArray<string>) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

test('reads immutable diff stats for several history commits in one batch', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'codiff-history-stats-'));
  git(repo, ['init', '--quiet']);
  git(repo, ['config', 'user.name', 'Codiff Test']);
  git(repo, ['config', 'user.email', 'codiff@example.com']);

  await writeFile(join(repo, 'first.txt'), 'one\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '--quiet', '-m', 'Add first file']);
  const first = git(repo, ['rev-parse', 'HEAD']);

  await writeFile(join(repo, 'first.txt'), 'one\ntwo\n', 'utf8');
  await writeFile(join(repo, 'second.txt'), 'three\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '--quiet', '-m', 'Expand files']);
  const second = git(repo, ['rev-parse', 'HEAD']);

  const stats = await readCommitDiffStats(repo, [second, 'f'.repeat(40), first, second]);

  expect(stats.get(first)).toEqual({ additions: 1, deletions: 0, filesChanged: 1 });
  expect(stats.get(second)).toEqual({ additions: 2, deletions: 0, filesChanged: 2 });
  expect(stats.has('f'.repeat(40))).toBe(false);
});
