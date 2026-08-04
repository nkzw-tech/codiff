import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import type { GenerationProfile, GitSha, RepositoryState } from '../../core/types.ts';

type CacheInput = {
  profile: GenerationProfile;
  request: { customInstructions: string; scope: string };
  state: RepositoryState;
};

const require = createRequire(import.meta.url);
const { buildWalkthroughGenerationCacheIdentity, getWalkthroughGenerationCacheKey } =
  require('../walkthrough-generation-cache-key.cjs') as {
    buildWalkthroughGenerationCacheIdentity: (input: CacheInput) => {
      source: { description: string | null; title: string | null };
    };
    getWalkthroughGenerationCacheKey: (input: CacheInput) => string;
  };

const input = (): CacheInput => ({
  profile: {
    agent: 'codex',
    authoringVersion: 'format-neutral-test',
    modelCandidates: ['gpt-5.6-terra'],
  },
  request: { customInstructions: 'Review the change.', scope: 'complete-diff' },
  state: {
    branch: 'feature/cache-key',
    files: [
      {
        fingerprint: 'src/app.ts:1',
        path: 'src/app.ts',
        sections: [
          {
            binary: false,
            id: 'src/app.ts:commit',
            kind: 'commit',
            patch: '@@ -1 +1 @@\n-old\n+new\n',
          },
        ],
        status: 'modified',
      },
    ],
    generatedAt: 1,
    root: '/repo',
    source: {
      description: ' Explain the new behavior. ',
      headSha: 'a'.repeat(40) as GitSha,
      number: 42,
      provider: 'github',
      title: ' Improve cache behavior ',
      type: 'pull-request',
      url: 'https://github.com/nkzw-tech/codiff/pull/42',
    },
  },
});

test('cache identities normalize review prose and exclude checkout roots', () => {
  const base = input();
  const movedCheckout = input();
  movedCheckout.state.root = '/another/checkout';

  expect(getWalkthroughGenerationCacheKey(movedCheckout)).toBe(
    getWalkthroughGenerationCacheKey(base),
  );
  expect(buildWalkthroughGenerationCacheIdentity(base).source).toMatchObject({
    description: 'Explain the new behavior.',
    title: 'Improve cache behavior',
  });
});

test('cache keys include semantic requests, profiles, and review identity', () => {
  const base = input();
  const changedRequest = input();
  changedRequest.request.customInstructions = 'Focus on cancellation.';
  const changedProfile = input();
  changedProfile.profile = { ...changedProfile.profile, modelCandidates: ['gpt-5.6-sol'] };
  const changedReview = input();
  if (changedReview.state.source.type === 'pull-request') {
    changedReview.state.source.title = 'Different review';
  }

  expect(getWalkthroughGenerationCacheKey(changedRequest)).not.toBe(
    getWalkthroughGenerationCacheKey(base),
  );
  expect(getWalkthroughGenerationCacheKey(changedProfile)).not.toBe(
    getWalkthroughGenerationCacheKey(base),
  );
  expect(getWalkthroughGenerationCacheKey(changedReview)).not.toBe(
    getWalkthroughGenerationCacheKey(base),
  );
});
