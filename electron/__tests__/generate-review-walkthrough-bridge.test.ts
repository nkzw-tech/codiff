import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import type { GitSha, ReviewCommitSummary, ReviewCommitUnit } from '../../core/types.ts';

const require = createRequire(import.meta.url);
const { createCommitWalkthroughUnits } =
  require('../walkthrough-generation-bridge.cjs') as typeof import('../walkthrough-generation-bridge.cjs');

const commit = (name: string): ReviewCommitSummary => ({
  authoredAt: `2026-01-0${name.charCodeAt(0) - 64}T00:00:00.000Z`,
  authorName: 'Ada',
  diffStat: { additions: name.charCodeAt(0) - 64, deletions: 1, filesChanged: 1 },
  parentShas: name === 'A' ? ['0'.repeat(40) as GitSha] : [],
  sha: name.toLowerCase().repeat(40) as GitSha,
  shortSha: name.toLowerCase().repeat(8),
  subject: `Commit ${name}`,
  webUrl: `https://example.com/commit/${name.toLowerCase()}`,
});

test('converts canonical commits into ordered target-comparison units', () => {
  const commits = [commit('A'), commit('B'), commit('C')];
  const units: ReadonlyArray<ReviewCommitUnit> = createCommitWalkthroughUnits(commits);

  expect(units.map((unit) => [unit.commit.subject, unit.order])).toEqual([
    ['Commit A', 0],
    ['Commit B', 1],
    ['Commit C', 2],
  ]);
  expect(units.map((unit) => unit.commit)).toEqual(commits);
});
