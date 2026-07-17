import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { getGitTestEnvironment } from '../../core/__tests__/helpers/git.ts';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
  createTemporaryWorkingDirectory,
} from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { getCommandLineLaunchOptions, getCommandLineRepositoryPath, getInitialRepositoryPath } =
  require('../main/command-line.cjs') as {
    getCommandLineLaunchOptions: (
      commandLine: ReadonlyArray<string>,
      fallbackPath?: string,
    ) => {
      codexSessionId?: string;
      planFile?: string;
      planResultFile?: string;
      repositoryPathProvided: boolean;
      source?:
        | { ref: string; type: 'branch-working-tree' }
        | { ref: string; type: 'commit' }
        | { base: string; head: string; symmetric: boolean; type: 'range' }
        | { type: 'pull-request'; url: string };
      walkthrough: boolean;
      walkthroughContext?: unknown;
    };
    getCommandLineRepositoryPath: (commandLine: ReadonlyArray<string>) => string | null;
    getInitialRepositoryPath: (
      launchPath: string,
      launchOptions: {
        codexSessionId?: string;
        planFile?: string;
        planResultFile?: string;
        repositoryPathProvided: boolean;
        source?:
          | { ref: string; type: 'branch-working-tree' }
          | { ref: string; type: 'commit' }
          | { base: string; head: string; symmetric: boolean; type: 'range' }
          | { type: 'pull-request'; url: string };
        walkthrough: boolean;
        walkthroughContext?: unknown;
      },
      lastRepositoryPath: string,
      environment?: NodeJS.ProcessEnv,
    ) => string;
  };

const readCommandLine = (commandLine: ReadonlyArray<string>) => ({
  launchOptions: getCommandLineLaunchOptions(commandLine),
  pullRequestNumber: null,
  repositoryPath: getCommandLineRepositoryPath(commandLine),
});

const execFileAsync = promisify(execFile);

const git = async (repo: string, args: ReadonlyArray<string>) => {
  await execFileAsync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: getGitTestEnvironment(),
  });
};

const defaultLaunchOptions = {
  repositoryPathProvided: false,
  walkthrough: false,
};

test('parses the OpenCode agent override', () => {
  expect(
    readCommandLine([
      'codiff',
      '--agent',
      'opencode',
      '--opencode-session',
      'ses_121b4816bffebMr9YE52O4870p',
      '/repo',
    ]),
  ).toMatchObject({
    launchOptions: {
      agentBackend: 'opencode',
      opencodeSessionId: 'ses_121b4816bffebMr9YE52O4870p',
      repositoryPathProvided: true,
    },
  });
});

test.sequential('plan command lines do not inspect Git refs', async () => {
  await using directory = await createTemporaryDirectory('codiff-plan-command-line-');
  const fakeBin = join(directory.path, 'bin');
  const gitMarker = join(directory.path, 'git-invoked');
  const planFile = join(directory.path, 'plan.md');
  await using _environment = createTemporaryEnvironment({
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
  });

  await mkdir(fakeBin);
  await writeFile(planFile, '# Plan\n');
  await writeFile(join(fakeBin, 'git'), `#!/bin/sh\nprintf invoked > "${gitMarker}"\nexit 99\n`);
  await chmod(join(fakeBin, 'git'), 0o755);

  expect(readCommandLine(['codiff', '--plan-file', planFile, 'workspace'])).toMatchObject({
    launchOptions: {
      planFile,
      repositoryPathProvided: true,
    },
    repositoryPath: 'workspace',
  });
  expect(await readFile(gitMarker, 'utf8').catch(() => null)).toBeNull();
});

test('parses commit and walkthrough command-line options', () => {
  expect(readCommandLine(['codiff', '--walkthrough', '--commit', 'HEAD', '/repo'])).toEqual({
    launchOptions: {
      repositoryPathProvided: true,
      source: {
        ref: 'HEAD',
        type: 'commit',
      },
      walkthrough: true,
    },
    pullRequestNumber: null,
    repositoryPath: '/repo',
  });
});

test('parses plan handoff command-line options', () => {
  expect(
    readCommandLine([
      'codiff',
      '--plan-file',
      '/tmp/plan.md',
      '--plan-result-file',
      '/tmp/result.json',
      '/repo',
    ]),
  ).toMatchObject({
    launchOptions: {
      planFile: '/tmp/plan.md',
      planResultFile: '/tmp/result.json',
      repositoryPathProvided: true,
      walkthrough: false,
    },
    repositoryPath: '/repo',
  });
});

test('parses positional HEAD revisions as commit sources', () => {
  expect(readCommandLine(['codiff', 'HEAD'])).toEqual({
    launchOptions: {
      repositoryPathProvided: false,
      source: {
        ref: 'HEAD',
        type: 'commit',
      },
      walkthrough: false,
    },
    pullRequestNumber: null,
    repositoryPath: null,
  });

  expect(readCommandLine(['codiff', 'HEAD^1', '/repo'])).toEqual({
    launchOptions: {
      repositoryPathProvided: true,
      source: {
        ref: 'HEAD^1',
        type: 'commit',
      },
      walkthrough: false,
    },
    pullRequestNumber: null,
    repositoryPath: '/repo',
  });
});

test('parses plain refs as branch sources', async () => {
  await using directory = await createTemporaryDirectory('codiff-branch-ref-');
  await git(directory.path, ['init']);
  await git(directory.path, ['commit', '--allow-empty', '-m', 'initial commit']);
  await git(directory.path, ['checkout', '-b', 'feature']);
  await using _cwd = createTemporaryWorkingDirectory(directory.path);

  expect(readCommandLine(['codiff', 'feature'])).toEqual({
    launchOptions: {
      repositoryPathProvided: false,
      source: {
        ref: 'feature',
        type: 'branch-working-tree',
      },
      walkthrough: false,
    },
    pullRequestNumber: null,
    repositoryPath: null,
  });

  expect(readCommandLine(['codiff', 'feature', directory.path])).toEqual({
    launchOptions: {
      repositoryPathProvided: true,
      source: {
        ref: 'feature',
        type: 'branch-working-tree',
      },
      walkthrough: false,
    },
    pullRequestNumber: null,
    repositoryPath: directory.path,
  });
});

test('parses missing plain refs in Git repositories as branch sources', async () => {
  await using directory = await createTemporaryDirectory('codiff-missing-branch-ref-');
  await git(directory.path, ['init']);
  await git(directory.path, ['commit', '--allow-empty', '-m', 'initial commit']);
  await using _cwd = createTemporaryWorkingDirectory(directory.path);

  expect(readCommandLine(['codiff', 'definitely-missing-branch'])).toEqual({
    launchOptions: {
      repositoryPathProvided: false,
      source: {
        ref: 'definitely-missing-branch',
        type: 'branch-working-tree',
      },
      walkthrough: false,
    },
    pullRequestNumber: null,
    repositoryPath: null,
  });

  expect(readCommandLine(['codiff', 'definitely-missing-branch', directory.path])).toEqual({
    launchOptions: {
      repositoryPathProvided: true,
      source: {
        ref: 'definitely-missing-branch',
        type: 'branch-working-tree',
      },
      walkthrough: false,
    },
    pullRequestNumber: null,
    repositoryPath: directory.path,
  });
});

test('parses hex-like refs as commits before branches', async () => {
  await using directory = await createTemporaryDirectory('codiff-hex-ref-');
  await git(directory.path, ['init']);
  await git(directory.path, ['commit', '--allow-empty', '-m', 'initial commit']);
  const { stdout } = await execFileAsync('git', ['-C', directory.path, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  const shortHash = stdout.trim().slice(0, 8);
  await git(directory.path, ['branch', shortHash]);
  await using _cwd = createTemporaryWorkingDirectory(directory.path);

  expect(readCommandLine(['codiff', shortHash]).launchOptions.source).toEqual({
    ref: shortHash,
    type: 'commit',
  });

  expect(readCommandLine(['codiff', '--branch', shortHash]).launchOptions.source).toEqual({
    ref: shortHash,
    type: 'branch-working-tree',
  });
});

test('parses Codex walkthrough seed command-line options', async () => {
  await using directory = await createTemporaryDirectory('codiff-context-');
  const contextPath = join(directory.path, 'seed.json');

  await writeFile(
    contextPath,
    JSON.stringify({
      objective: 'Make walkthroughs reuse the creating Codex session.',
      messages: [
        {
          role: 'user',
          text: 'Open Codiff with the context from this implementation session.',
        },
        {
          role: 'developer',
          text: 'Internal instruction that should not be included.',
        },
        {
          role: 'assistant',
          text: 'I wired the skill handoff through launch options.',
        },
      ],
      source: {
        generatedAt: '2026-05-25T00:00:00.000Z',
        threadId: 'context-file-thread',
      },
      version: 1,
    }),
  );

  expect(
    readCommandLine([
      'codiff',
      '--walkthrough',
      '--codex-session',
      'cli-thread',
      '--walkthrough-context',
      contextPath,
      '/repo',
    ]).launchOptions,
  ).toEqual({
    codexSessionId: 'cli-thread',
    repositoryPathProvided: true,
    walkthrough: true,
    walkthroughContext: {
      messages: [
        {
          role: 'user',
          text: 'Open Codiff with the context from this implementation session.',
        },
        {
          role: 'assistant',
          text: 'I wired the skill handoff through launch options.',
        },
      ],
      objective: 'Make walkthroughs reuse the creating Codex session.',
      source: {
        generatedAt: '2026-05-25T00:00:00.000Z',
        threadId: 'context-file-thread',
        type: 'codex-session',
      },
      version: 1,
    },
  });
});

test('parses Codex session ids without creating walkthrough context', () => {
  expect(
    readCommandLine([
      'codiff',
      '--walkthrough',
      '--codex-session',
      '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
      '/repo',
    ]).launchOptions,
  ).toEqual({
    codexSessionId: '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
    repositoryPathProvided: true,
    walkthrough: true,
  });
});

test('parses full GitHub pull request URLs as launch sources', () => {
  expect(
    readCommandLine(['codiff', 'https://github.com/nkzw-tech/codiff/pull/11', '/repo'])
      .launchOptions.source,
  ).toEqual({
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/11',
  });
});

test('resolves GitHub and GitLab review markers through repository remotes', async () => {
  await using directory = await createTemporaryDirectory('codiff-review-markers-');
  const githubRepo = join(directory.path, 'github');
  const gitlabRepo = join(directory.path, 'gitlab');

  await Promise.all([mkdir(githubRepo), mkdir(gitlabRepo)]);
  await git(githubRepo, ['init']);
  await git(githubRepo, ['remote', 'add', 'origin', 'git@github.com:nkzw-tech/codiff.git']);
  await git(gitlabRepo, ['init']);
  await git(gitlabRepo, [
    'remote',
    'add',
    'origin',
    'ssh://git@gitlab.example.com/group/subgroup/project.git',
  ]);

  expect(getCommandLineLaunchOptions(['codiff', 'pr', '12', githubRepo]).source).toEqual({
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/12',
  });
  expect(getCommandLineLaunchOptions(['codiff', 'pr', '#12', githubRepo]).source).toEqual({
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/12',
  });
  expect(getCommandLineLaunchOptions(['codiff', 'mr', '23', gitlabRepo]).source).toEqual({
    provider: 'gitlab',
    type: 'pull-request',
    url: 'https://gitlab.example.com/group/subgroup/project/-/merge_requests/23',
  });
});

test('parses GitLab merge request markers and nested URLs', () => {
  expect(
    readCommandLine([
      'codiff',
      'https://gitlab.example.com/group/subgroup/project/-/merge_requests/23',
      '/repo',
    ]).launchOptions.source,
  ).toEqual({
    provider: 'gitlab',
    type: 'pull-request',
    url: 'https://gitlab.example.com/group/subgroup/project/-/merge_requests/23',
  });
});

test('restores the last repository for plain app launches', async () => {
  await using directory = await createTemporaryDirectory('codiff-last-repo-');

  expect(getInitialRepositoryPath('/fallback', defaultLaunchOptions, directory.path, {})).toBe(
    directory.path,
  );
});

test('does not restore missing last repositories', () => {
  expect(
    getInitialRepositoryPath('/fallback', defaultLaunchOptions, '/missing/codiff-repo', {}),
  ).toBe('/fallback');
});

test('does not restore over explicit launch intent', async () => {
  await using directory = await createTemporaryDirectory('codiff-last-repo-');

  expect(
    getInitialRepositoryPath(
      '/fallback',
      {
        repositoryPathProvided: true,
        walkthrough: false,
      },
      directory.path,
      {},
    ),
  ).toBe('/fallback');
  expect(
    getInitialRepositoryPath(
      '/fallback',
      {
        repositoryPathProvided: false,
        source: {
          ref: 'HEAD',
          type: 'commit',
        },
        walkthrough: false,
      },
      directory.path,
      {},
    ),
  ).toBe('/fallback');
  expect(
    getInitialRepositoryPath(
      '/fallback',
      {
        repositoryPathProvided: false,
        walkthrough: true,
      },
      directory.path,
      {},
    ),
  ).toBe('/fallback');
  expect(
    getInitialRepositoryPath(
      '/fallback',
      {
        planFile: '/tmp/plan.md',
        repositoryPathProvided: false,
        walkthrough: false,
      },
      directory.path,
      {},
    ),
  ).toBe('/fallback');
  expect(
    getInitialRepositoryPath('/fallback', defaultLaunchOptions, directory.path, {
      CODIFF_REPOSITORY_PATH: '/explicit',
    }),
  ).toBe('/fallback');
});

test('reads base...head and base..head positionals as a range source', async () => {
  await using directory = await createTemporaryDirectory('codiff-range-');

  await git(directory.path, ['init']);
  await git(directory.path, ['commit', '--allow-empty', '-m', 'first']);
  await git(directory.path, ['branch', 'base']);
  await git(directory.path, ['commit', '--allow-empty', '-m', 'second']);
  await git(directory.path, ['branch', 'head']);

  expect(readCommandLine(['codiff', 'base...head', directory.path]).launchOptions.source).toEqual({
    base: 'base',
    head: 'head',
    symmetric: true,
    type: 'range',
  });

  expect(readCommandLine(['codiff', 'base..head', directory.path]).launchOptions.source).toEqual({
    base: 'base',
    head: 'head',
    symmetric: false,
    type: 'range',
  });

  // A range whose ends don't resolve is not treated as a source.
  expect(
    readCommandLine(['codiff', 'nope...nada', directory.path]).launchOptions.source,
  ).toBeUndefined();
});
