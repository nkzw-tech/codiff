import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import type {
  GenerationProfile,
  GitSha,
  RepositoryState,
  WalkthroughGenerationRequest,
} from '../../core/types.ts';

type CacheInput = {
  generationRequest: WalkthroughGenerationRequest;
  profile: GenerationProfile;
  state: RepositoryState;
};

const require = createRequire(import.meta.url);
const { buildLocalReviewWalkthroughCacheIdentity, getLocalReviewWalkthroughCacheKey } =
  require('../local-review-walkthrough-cache-key.cjs') as {
    buildLocalReviewWalkthroughCacheIdentity: (input: CacheInput) => {
      source: { description: string | null; title: string | null };
    };
    getLocalReviewWalkthroughCacheKey: (input: CacheInput) => string;
  };

const input = (): CacheInput => ({
  generationRequest: {
    customInstructions: 'Review the change.',
    review: { relation: 'single-diff', structure: 'single-diff' },
  },
  profile: {
    agent: 'codex',
    authoringVersion: 'v5-test',
    modelCandidates: ['gpt-5.4'],
  },
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
    launchPath: '/repo',
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

test('local review cache keys include normalized pull request prose', () => {
  const base = input();
  const unchanged = input();
  const titleChanged = input();
  const descriptionChanged = input();
  if (titleChanged.state.source.type === 'pull-request') {
    titleChanged.state.source.title = 'Improve a different cache behavior';
  }
  if (descriptionChanged.state.source.type === 'pull-request') {
    descriptionChanged.state.source.description = 'Explain a different behavior.';
  }

  expect(getLocalReviewWalkthroughCacheKey(unchanged)).toBe(
    getLocalReviewWalkthroughCacheKey(base),
  );
  expect(getLocalReviewWalkthroughCacheKey(titleChanged)).not.toBe(
    getLocalReviewWalkthroughCacheKey(base),
  );
  expect(getLocalReviewWalkthroughCacheKey(descriptionChanged)).not.toBe(
    getLocalReviewWalkthroughCacheKey(base),
  );
  expect(buildLocalReviewWalkthroughCacheIdentity(base).source).toMatchObject({
    description: 'Explain the new behavior.',
    title: 'Improve cache behavior',
  });
});

test('local review cache identities normalize absent pull request prose to null', () => {
  const value = input();
  if (value.state.source.type === 'pull-request') {
    value.state.source.description = '   ';
    delete value.state.source.title;
  }

  expect(buildLocalReviewWalkthroughCacheIdentity(value).source).toMatchObject({
    description: null,
    title: null,
  });
});

test('local review cache identities exclude checkout roots and include generation profiles', () => {
  const base = input();
  const movedCheckout = input();
  movedCheckout.state.root = '/another/checkout';
  const changedProfile = input();
  changedProfile.profile = { ...changedProfile.profile, modelCandidates: ['gpt-5.5'] };

  expect(getLocalReviewWalkthroughCacheKey(movedCheckout)).toBe(
    getLocalReviewWalkthroughCacheKey(base),
  );
  expect(getLocalReviewWalkthroughCacheKey(changedProfile)).not.toBe(
    getLocalReviewWalkthroughCacheKey(base),
  );
});
