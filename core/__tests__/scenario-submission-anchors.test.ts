import { expect, test } from 'vite-plus/test';
import { resolveSubmissionAnchor } from '../../test-scenarios/submission-anchors.mjs';

test('resolves one fixture marker to its immutable path and line', async () => {
  await expect(
    resolveSubmissionAnchor({
      marker: 'SMOKE: current',
      revision: 'head',
      runGit: async () => 'src/app.ts:12:  // SMOKE: current',
    }),
  ).resolves.toEqual({ line: 12, path: 'src/app.ts', revision: 'head' });
});

test('rejects missing and ambiguous fixture markers', async () => {
  await expect(
    resolveSubmissionAnchor({
      marker: 'SMOKE: missing',
      revision: 'head',
      runGit: async () => {
        throw new Error('git grep failed');
      },
    }),
  ).rejects.toThrow("Submission marker 'SMOKE: missing' was not found");

  await expect(
    resolveSubmissionAnchor({
      marker: 'SMOKE: duplicate',
      revision: 'head',
      runGit: async () => 'src/one.ts:2: // SMOKE: duplicate\nsrc/two.ts:4: // SMOKE: duplicate',
    }),
  ).rejects.toThrow("Submission marker 'SMOKE: duplicate' resolved to 2 lines");
});
