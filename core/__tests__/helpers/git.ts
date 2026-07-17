import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTemporaryEnvironment } from './resources.ts';

const emptyGitHooksPath = mkdtempSync(join(tmpdir(), 'codiff-empty-git-hooks-'));

export const getGitTestEnvironment = (
  overrides: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_EMAIL: 'codiff@example.com',
  GIT_AUTHOR_NAME: 'Codiff Test',
  GIT_COMMITTER_EMAIL: 'codiff@example.com',
  GIT_COMMITTER_NAME: 'Codiff Test',
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'core.excludesfile',
  GIT_CONFIG_KEY_1: 'commit.gpgSign',
  GIT_CONFIG_KEY_2: 'tag.gpgSign',
  GIT_CONFIG_KEY_3: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_CONFIG_VALUE_2: 'false',
  GIT_CONFIG_VALUE_3: emptyGitHooksPath,
  ...overrides,
});

export const removeGitTestDirectory = (path: string) =>
  rm(path, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 50,
  });

export const withGitTestEnvironment = async <T>(
  callback: () => Promise<T>,
  overrides: Readonly<Record<string, string | undefined>> = {},
) => {
  const environment = getGitTestEnvironment(overrides);
  const scopedEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        key.startsWith('GIT_AUTHOR_') ||
        key.startsWith('GIT_COMMITTER_') ||
        key.startsWith('GIT_CONFIG_'),
    ),
  );
  await using _environment = createTemporaryEnvironment(scopedEnvironment);
  return await callback();
};
