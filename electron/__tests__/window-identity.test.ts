import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { findMatchingWindowIdentity, getWindowIdentity, parseGitHubPullRequestUrl } =
  require('../window-identity.cjs') as {
    findMatchingWindowIdentity: (
      identity: { key: string } | null,
      existingIdentities: ReadonlyMap<number, { key: string } | null>,
    ) => number | null;
    getWindowIdentity: (
      repositoryPath: string,
      launchOptions?: {
        source?:
          | { type: 'working-tree' }
          | { ref: string; type: 'branch' }
          | { baseRef: string; headRef: string; ref: string; type: 'branch-diff' }
          | { ref: string; type: 'commit' }
          | {
              number?: number;
              owner?: string;
              repo?: string;
              type: 'pull-request';
              url: string;
            };
      },
    ) => { key: string; repositoryRoot: string; sourceKey: string } | null;
    parseGitHubPullRequestUrl: (value: string) => {
      number: number;
      owner: string;
      repo: string;
    } | null;
  };

const execFileAsync = promisify(execFile);

const git = async (repo: string, args: ReadonlyArray<string>) => {
  const result = await execFileAsync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return result.stdout.trim();
};

const createRepository = async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'codiff-window-identity-'));
  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['config', 'user.email', 'codiff@example.com']);
  await git(repositoryPath, ['config', 'user.name', 'Codiff Test']);
  await git(repositoryPath, ['commit', '--allow-empty', '-m', 'initial']);
  return repositoryPath;
};

test('window identities match working-tree launches inside the same repository', async () => {
  const repositoryPath = await createRepository();

  try {
    const nestedPath = join(repositoryPath, 'src');
    await mkdir(nestedPath);

    expect(getWindowIdentity(nestedPath)?.key).toBe(getWindowIdentity(repositoryPath)?.key);
  } finally {
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('window identities resolve commit refs to the same commit sha', async () => {
  const repositoryPath = await createRepository();

  try {
    const head = await git(repositoryPath, ['rev-parse', 'HEAD']);

    expect(
      getWindowIdentity(repositoryPath, {
        source: { ref: 'HEAD', type: 'commit' },
      })?.sourceKey,
    ).toBe(`commit:${head}`);
    expect(
      getWindowIdentity(repositoryPath, {
        source: { ref: head.slice(0, 8), type: 'commit' },
      })?.key,
    ).toBe(
      getWindowIdentity(repositoryPath, {
        source: { ref: 'HEAD', type: 'commit' },
      })?.key,
    );
  } finally {
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('window identities distinguish branch history launches', async () => {
  const repositoryPath = await createRepository();

  try {
    await git(repositoryPath, ['checkout', '-b', 'feature']);
    const head = (await git(repositoryPath, ['rev-parse', 'HEAD'])).trim().toLowerCase();

    expect(
      getWindowIdentity(repositoryPath, {
        source: { ref: 'feature', type: 'branch' },
      })?.sourceKey,
    ).toBe(`branch-diff:feature:${head}:${head}`);

    await git(repositoryPath, ['commit', '--allow-empty', '-m', 'feature update']);
    const nextHead = (await git(repositoryPath, ['rev-parse', 'HEAD'])).trim().toLowerCase();

    expect(
      getWindowIdentity(repositoryPath, {
        source: { baseRef: head, headRef: nextHead, ref: 'feature', type: 'branch-diff' },
      })?.sourceKey,
    ).toBe(`branch-diff:feature:${head}:${nextHead}`);
  } finally {
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('window identities normalize GitHub pull request sources', async () => {
  const repositoryPath = await createRepository();

  try {
    expect(
      getWindowIdentity(repositoryPath, {
        source: {
          type: 'pull-request',
          url: 'https://github.com/NKZW-Tech/Codiff/pull/8',
        },
      })?.sourceKey,
    ).toBe('pull-request:nkzw-tech/codiff#8');
    expect(
      getWindowIdentity(repositoryPath, {
        source: {
          number: 8,
          owner: 'nkzw-tech',
          repo: 'codiff',
          type: 'pull-request',
          url: 'https://github.com/nkzw-tech/codiff/pull/8',
        },
      })?.key,
    ).toBe(
      getWindowIdentity(repositoryPath, {
        source: {
          type: 'pull-request',
          url: 'https://github.com/NKZW-Tech/Codiff/pull/8',
        },
      })?.key,
    );
  } finally {
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('window identity matching requires exact identity matches', () => {
  expect(
    findMatchingWindowIdentity(
      { key: 'repo-a\0working-tree' },
      new Map([
        [1, { key: 'repo-a\0commit:abc' }],
        [2, { key: 'repo-a\0working-tree' }],
      ]),
    ),
  ).toBe(2);
  expect(
    findMatchingWindowIdentity(
      { key: 'repo-a\0pull-request:nkzw-tech/codiff#9' },
      new Map([[1, { key: 'repo-a\0pull-request:nkzw-tech/codiff#8' }]]),
    ),
  ).toBeNull();
  expect(findMatchingWindowIdentity(null, new Map([[1, { key: 'repo-a\0working-tree' }]]))).toBe(
    null,
  );
});

test('parseGitHubPullRequestUrl rejects non pull request URLs', () => {
  expect(parseGitHubPullRequestUrl('https://github.com/nkzw-tech/codiff/pull/8')).toEqual({
    number: 8,
    owner: 'nkzw-tech',
    repo: 'codiff',
  });
  expect(parseGitHubPullRequestUrl('https://github.com/nkzw-tech/codiff/issues/8')).toBeNull();
});
