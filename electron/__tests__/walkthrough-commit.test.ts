import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createWalkthroughCommit } = require('../walkthrough-commit.cjs') as {
  createWalkthroughCommit: (
    repoPath: string,
    request: { body?: string; paths?: ReadonlyArray<string>; subject?: string },
  ) => Promise<{ hash: string; status: 'committed' } | { reason: string; status: 'failed' }>;
};

test('rejects a commit with no subject before touching git', async () => {
  const result = await createWalkthroughCommit('/repo', {
    paths: ['src/App.tsx'],
    subject: '   ',
  });
  expect(result.status).toBe('failed');
});

test('rejects a commit with no selected files', async () => {
  const result = await createWalkthroughCommit('/repo', { paths: [], subject: 'Fix it' });
  expect(result.status).toBe('failed');
});

test('rejects a path that escapes the repository', async () => {
  const result = await createWalkthroughCommit('/repo', {
    paths: ['../../etc/passwd'],
    subject: 'Fix it',
  });
  expect(result).toEqual({ reason: 'A selected file path is invalid.', status: 'failed' });
});
