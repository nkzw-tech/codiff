import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createRetryableModuleLoader } = require('../review-artifact-bridge.cjs') as {
  createRetryableModuleLoader: <T>(load: () => Promise<T>) => () => Promise<T>;
};
const { createComparisonAlgorithmIdentityLoader } = require('../git-state/review-history.cjs') as {
  createComparisonAlgorithmIdentityLoader: (
    loadCore: () => Promise<{
      regionAwareReplayProjectionVersion: string;
      replayCompareAlgorithmVersion: string;
      reviewArtifactSchemaVersion: string;
      versionCommitEvolutionAlgorithmVersion: string;
    }>,
  ) => () => Promise<Record<string, string>>;
};

test('retries a rejected Core dynamic import without duplicating successful reads', async () => {
  const load = vi
    .fn<() => Promise<{ value: string }>>()
    .mockRejectedValueOnce(new Error('Core is still building.'))
    .mockResolvedValue({ value: 'ready' });
  const loadModule = createRetryableModuleLoader(load);

  await expect(loadModule()).rejects.toThrow('Core is still building.');
  await expect(loadModule()).resolves.toEqual({ value: 'ready' });
  await expect(loadModule()).resolves.toEqual({ value: 'ready' });
  expect(load).toHaveBeenCalledTimes(2);
});

test('retries a failed comparison-cache identity after Core becomes available', async () => {
  const loadCore = vi
    .fn<
      () => Promise<{
        regionAwareReplayProjectionVersion: string;
        replayCompareAlgorithmVersion: string;
        reviewArtifactSchemaVersion: string;
        versionCommitEvolutionAlgorithmVersion: string;
      }>
    >()
    .mockRejectedValueOnce(new Error('Core is still building.'))
    .mockResolvedValue({
      regionAwareReplayProjectionVersion: 'projection-v1',
      replayCompareAlgorithmVersion: 'replay-v1',
      reviewArtifactSchemaVersion: 'artifact-v1',
      versionCommitEvolutionAlgorithmVersion: 'matcher-v1',
    });
  const loadIdentity = createComparisonAlgorithmIdentityLoader(loadCore);

  await expect(loadIdentity()).rejects.toThrow('Core is still building.');
  await expect(loadIdentity()).resolves.toEqual({
    artifactSchemaVersion: 'artifact-v1',
    matcherVersion: 'matcher-v1',
    projectionVersion: 'projection-v1',
    replayVersion: 'replay-v1',
  });
  expect(loadCore).toHaveBeenCalledTimes(2);
});
