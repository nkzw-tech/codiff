import { execFile } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { getGitTestEnvironment, removeGitTestDirectory } from '../../core/__tests__/helpers/git.ts';

const require = createRequire(import.meta.url);

const { selectPullRequestRemote } = require('../git-state/pull-request.cjs') as {
  selectPullRequestRemote: (
    repoRoot: string,
    pullRequest: {
      number: number;
      owner: string;
      repo: string;
      url: string;
    },
    expectedHeadSha?: string,
  ) => Promise<{
    direction: 'fetch';
    name: string;
    owner: string;
    repo: string;
  }>;
};

const execFileAsync = promisify(execFile);
const pullRequest = {
  number: 42,
  owner: 'acme',
  repo: 'widgets',
  url: 'https://github.com/acme/widgets/pull/42',
};

const git = async (repo: string, args: ReadonlyArray<string>) => {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: getGitTestEnvironment(),
  });
  return stdout.trim();
};

const createRepository = async (path: string) => {
  await mkdir(path, { recursive: true });
  await git(path, ['init']);
};

const createPullRequestRemote = async (source: string, remote: string, headSha: string) => {
  await mkdir(remote, { recursive: true });
  await git(remote, ['init', '--bare']);
  await git(source, ['push', remote, `${headSha}:refs/pull/${pullRequest.number}/head`]);
};

const configureAlias = async (repo: string, aliasPrefix: string, remoteDirectory: string) => {
  const filePrefix = pathToFileURL(`${remoteDirectory}/`).href;
  await git(repo, ['config', `url.${filePrefix}.insteadOf`, aliasPrefix]);
};

test('matches GitHub organization SSH certificate remotes without probing them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-pull-request-remote-'));
  const repo = join(directory, 'repo');

  try {
    await createRepository(repo);
    await git(repo, ['remote', 'add', 'origin', 'org-12345@github.com:acme/widgets.git']);

    await expect(
      selectPullRequestRemote(repo, pullRequest, '0123456789abcdef0123456789abcdef01234567'),
    ).resolves.toEqual({
      direction: 'fetch',
      name: 'origin',
      owner: 'acme',
      repo: 'widgets',
    });
  } finally {
    await removeGitTestDirectory(directory);
  }
});

test('reads the configured GitHub URL before insteadOf rewrites hide its host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-pull-request-remote-'));
  const repo = join(directory, 'repo');

  try {
    await createRepository(repo);
    await git(repo, ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
    await git(repo, ['config', 'url.git@github-work:.insteadOf', 'git@github.com:']);

    await expect(
      selectPullRequestRemote(repo, pullRequest, '0123456789abcdef0123456789abcdef01234567'),
    ).resolves.toMatchObject({ name: 'origin' });
  } finally {
    await removeGitTestDirectory(directory);
  }
});

test('uses Git to verify a pull request through an opaque remote alias', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-pull-request-remote-'));
  const source = join(directory, 'source');
  const repo = join(directory, 'repo');
  const remotes = join(directory, 'remotes');
  const remote = join(remotes, 'widgets.git');

  try {
    await Promise.all([createRepository(source), createRepository(repo)]);
    await git(source, ['commit', '--allow-empty', '-m', 'pull request head']);
    const headSha = await git(source, ['rev-parse', 'HEAD']);
    await createPullRequestRemote(source, remote, headSha);
    await git(repo, ['remote', 'add', 'origin', 'git@github-work:acme/widgets.git']);
    await configureAlias(repo, 'git@github-work:acme/', remotes);

    await expect(selectPullRequestRemote(repo, pullRequest, headSha)).resolves.toMatchObject({
      name: 'origin',
    });
  } finally {
    await removeGitTestDirectory(directory);
  }
});

test('skips a mismatching origin alias and selects the remote with the exact PR head', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-pull-request-remote-'));
  const source = join(directory, 'source');
  const repo = join(directory, 'repo');
  const originRemotes = join(directory, 'origin-remotes');
  const upstreamRemotes = join(directory, 'upstream-remotes');

  try {
    await Promise.all([createRepository(source), createRepository(repo)]);
    await git(source, ['commit', '--allow-empty', '-m', 'old pull request head']);
    const oldHeadSha = await git(source, ['rev-parse', 'HEAD']);
    await git(source, ['commit', '--allow-empty', '-m', 'current pull request head']);
    const headSha = await git(source, ['rev-parse', 'HEAD']);
    await Promise.all([
      createPullRequestRemote(source, join(originRemotes, 'widgets.git'), oldHeadSha),
      createPullRequestRemote(source, join(upstreamRemotes, 'widgets.git'), headSha),
    ]);
    await git(repo, ['remote', 'add', 'origin', 'git@origin-work:acme/widgets.git']);
    await git(repo, ['remote', 'add', 'upstream', 'git@upstream-work:acme/widgets.git']);
    await configureAlias(repo, 'git@origin-work:acme/', originRemotes);
    await configureAlias(repo, 'git@upstream-work:acme/', upstreamRemotes);

    await expect(selectPullRequestRemote(repo, pullRequest, headSha)).resolves.toMatchObject({
      name: 'upstream',
    });
  } finally {
    await removeGitTestDirectory(directory);
  }
}, 15_000);

test('rejects opaque remotes that do not match both the repository path and PR head', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-pull-request-remote-'));
  const source = join(directory, 'source');
  const repo = join(directory, 'repo');
  const wrongHeadRemotes = join(directory, 'wrong-head-remotes');
  const wrongRepoRemotes = join(directory, 'wrong-repo-remotes');

  try {
    await Promise.all([createRepository(source), createRepository(repo)]);
    await git(source, ['commit', '--allow-empty', '-m', 'wrong pull request head']);
    const wrongHeadSha = await git(source, ['rev-parse', 'HEAD']);
    await git(source, ['commit', '--allow-empty', '-m', 'expected pull request head']);
    const headSha = await git(source, ['rev-parse', 'HEAD']);
    await Promise.all([
      createPullRequestRemote(source, join(wrongHeadRemotes, 'widgets.git'), wrongHeadSha),
      createPullRequestRemote(source, join(wrongRepoRemotes, 'other.git'), headSha),
    ]);
    await git(repo, ['remote', 'add', 'origin', 'git@wrong-head:acme/widgets.git']);
    await git(repo, ['remote', 'add', 'other', 'git@wrong-repo:acme/other.git']);
    await configureAlias(repo, 'git@wrong-head:acme/', wrongHeadRemotes);
    await configureAlias(repo, 'git@wrong-repo:acme/', wrongRepoRemotes);

    await expect(selectPullRequestRemote(repo, pullRequest, headSha)).rejects.toThrow(
      'Pull request acme/widgets does not match a GitHub remote in this repository.',
    );
  } finally {
    await removeGitTestDirectory(directory);
  }
}, 15_000);
