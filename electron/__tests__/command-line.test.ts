import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { getInitialRepositoryPath, parseCommandLineArguments, parseGitHubRemoteUrl } =
  require('../main/command-line.cjs') as {
    getInitialRepositoryPath: (
      launchPath: string,
      launchOptions: {
        codexSessionId?: string;
        planFile?: string;
        planResultFile?: string;
        repositoryPathProvided: boolean;
        source?:
          | { ref: string; type: 'branch' }
          | { ref: string; type: 'commit' }
          | { base: string; head: string; symmetric: boolean; type: 'range' }
          | { type: 'pull-request'; url: string };
        walkthrough: boolean;
        walkthroughContext?: unknown;
      },
      lastRepositoryPath: string,
      environment?: NodeJS.ProcessEnv,
    ) => string;
    parseCommandLineArguments: (commandLine: ReadonlyArray<string>) => {
      launchOptions: {
        codexSessionId?: string;
        planFile?: string;
        planResultFile?: string;
        repositoryPathProvided: boolean;
        source?:
          | { ref: string; type: 'branch' }
          | { ref: string; type: 'commit' }
          | { base: string; head: string; symmetric: boolean; type: 'range' }
          | { type: 'pull-request'; url: string };
        walkthrough: boolean;
        walkthroughContext?: unknown;
      };
      pullRequestNumber: number | null;
      repositoryPath: string | null;
    };
    parseGitHubRemoteUrl: (value: string) => { owner: string; repo: string } | null;
  };

const execFileAsync = promisify(execFile);

const git = async (repo: string, args: ReadonlyArray<string>) => {
  await execFileAsync('git', ['-C', repo, ...args], { encoding: 'utf8' });
};

const defaultLaunchOptions = {
  repositoryPathProvided: false,
  walkthrough: false,
};

test('parses the OpenCode agent override', () => {
  expect(
    parseCommandLineArguments([
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
  const directory = await mkdtemp(join(tmpdir(), 'codiff-plan-command-line-'));
  const fakeBin = join(directory, 'bin');
  const gitMarker = join(directory, 'git-invoked');
  const planFile = join(directory, 'plan.md');
  const previousPath = process.env.PATH;

  try {
    await mkdir(fakeBin);
    await writeFile(planFile, '# Plan\n');
    await writeFile(join(fakeBin, 'git'), `#!/bin/sh\nprintf invoked > "${gitMarker}"\nexit 99\n`);
    await chmod(join(fakeBin, 'git'), 0o755);
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;

    expect(
      parseCommandLineArguments(['codiff', '--plan-file', planFile, 'workspace']),
    ).toMatchObject({
      launchOptions: {
        planFile,
        repositoryPathProvided: true,
      },
      repositoryPath: 'workspace',
    });
    expect(await readFile(gitMarker, 'utf8').catch(() => null)).toBeNull();
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { force: true, recursive: true });
  }
});

test('parses commit and walkthrough command-line options', () => {
  expect(
    parseCommandLineArguments(['codiff', '--walkthrough', '--commit', 'HEAD', '/repo']),
  ).toEqual({
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
    parseCommandLineArguments([
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
  expect(parseCommandLineArguments(['codiff', 'HEAD'])).toEqual({
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

  expect(parseCommandLineArguments(['codiff', 'HEAD^1', '/repo'])).toEqual({
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
  const repositoryPath = await mkdtemp(join(tmpdir(), 'codiff-branch-ref-'));
  const previousCwd = process.cwd();

  try {
    await git(repositoryPath, ['init']);
    await git(repositoryPath, ['config', 'user.email', 'codiff@example.com']);
    await git(repositoryPath, ['config', 'user.name', 'Codiff Test']);
    await git(repositoryPath, ['commit', '--allow-empty', '-m', 'initial commit']);
    await git(repositoryPath, ['checkout', '-b', 'feature']);
    process.chdir(repositoryPath);

    expect(parseCommandLineArguments(['codiff', 'feature'])).toEqual({
      launchOptions: {
        repositoryPathProvided: false,
        source: {
          ref: 'feature',
          type: 'branch',
        },
        walkthrough: false,
      },
      pullRequestNumber: null,
      repositoryPath: null,
    });

    expect(parseCommandLineArguments(['codiff', 'feature', repositoryPath])).toEqual({
      launchOptions: {
        repositoryPathProvided: true,
        source: {
          ref: 'feature',
          type: 'branch',
        },
        walkthrough: false,
      },
      pullRequestNumber: null,
      repositoryPath,
    });
  } finally {
    process.chdir(previousCwd);
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('parses missing plain refs in Git repositories as branch sources', async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'codiff-missing-branch-ref-'));
  const previousCwd = process.cwd();

  try {
    await git(repositoryPath, ['init']);
    await git(repositoryPath, ['config', 'user.email', 'codiff@example.com']);
    await git(repositoryPath, ['config', 'user.name', 'Codiff Test']);
    await git(repositoryPath, ['commit', '--allow-empty', '-m', 'initial commit']);
    process.chdir(repositoryPath);

    expect(parseCommandLineArguments(['codiff', 'definitely-missing-branch'])).toEqual({
      launchOptions: {
        repositoryPathProvided: false,
        source: {
          ref: 'definitely-missing-branch',
          type: 'branch',
        },
        walkthrough: false,
      },
      pullRequestNumber: null,
      repositoryPath: null,
    });

    expect(
      parseCommandLineArguments(['codiff', 'definitely-missing-branch', repositoryPath]),
    ).toEqual({
      launchOptions: {
        repositoryPathProvided: true,
        source: {
          ref: 'definitely-missing-branch',
          type: 'branch',
        },
        walkthrough: false,
      },
      pullRequestNumber: null,
      repositoryPath,
    });
  } finally {
    process.chdir(previousCwd);
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('parses hex-like refs as commits before branches', async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'codiff-hex-ref-'));
  const previousCwd = process.cwd();

  try {
    await git(repositoryPath, ['init']);
    await git(repositoryPath, ['config', 'user.email', 'codiff@example.com']);
    await git(repositoryPath, ['config', 'user.name', 'Codiff Test']);
    await git(repositoryPath, ['commit', '--allow-empty', '-m', 'initial commit']);
    const { stdout } = await execFileAsync('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    });
    const shortHash = stdout.trim().slice(0, 8);
    await git(repositoryPath, ['branch', shortHash]);
    process.chdir(repositoryPath);

    expect(parseCommandLineArguments(['codiff', shortHash]).launchOptions.source).toEqual({
      ref: shortHash,
      type: 'commit',
    });

    expect(
      parseCommandLineArguments(['codiff', '--branch', shortHash]).launchOptions.source,
    ).toEqual({
      ref: shortHash,
      type: 'branch',
    });
  } finally {
    process.chdir(previousCwd);
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('parses Codex walkthrough seed command-line options', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-context-'));
  const contextPath = join(directory, 'seed.json');

  try {
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
      parseCommandLineArguments([
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
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('parses Codex session ids without creating walkthrough context', () => {
  expect(
    parseCommandLineArguments([
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

test('parses pull request markers without resolving the repository remote', () => {
  expect(parseCommandLineArguments(['codiff', 'pr', '12', '/repo'])).toMatchObject({
    launchOptions: {
      repositoryPathProvided: true,
      source: undefined,
      walkthrough: false,
    },
    pullRequestNumber: 12,
    repositoryPath: '/repo',
  });
});

test('parses hash-prefixed pull request marker values', () => {
  expect(parseCommandLineArguments(['codiff', 'pr', '#12', '/repo'])).toMatchObject({
    launchOptions: {
      repositoryPathProvided: true,
      source: undefined,
      walkthrough: false,
    },
    pullRequestNumber: 12,
    repositoryPath: '/repo',
  });
});

test('parses full GitHub pull request URLs as launch sources', () => {
  expect(
    parseCommandLineArguments(['codiff', 'https://github.com/nkzw-tech/codiff/pull/11', '/repo'])
      .launchOptions.source,
  ).toEqual({
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/11',
  });
});

test('parses GitLab merge request markers and nested URLs', () => {
  expect(parseCommandLineArguments(['codiff', 'mr', '23', '/repo'])).toMatchObject({
    pullRequestNumber: 23,
    pullRequestProvider: 'gitlab',
  });
  expect(
    parseCommandLineArguments([
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

test('parses GitHub remotes from ssh and https URLs', () => {
  expect(parseGitHubRemoteUrl('git@github.com:nkzw-tech/codiff.git')).toEqual({
    owner: 'nkzw-tech',
    repo: 'codiff',
  });
  expect(parseGitHubRemoteUrl('https://github.com/nkzw-tech/codiff.git')).toEqual({
    owner: 'nkzw-tech',
    repo: 'codiff',
  });
  expect(parseGitHubRemoteUrl('https://example.com/nkzw-tech/codiff.git')).toBeNull();
});

test('restores the last repository for plain app launches', async () => {
  const lastRepositoryPath = await mkdtemp(join(tmpdir(), 'codiff-last-repo-'));

  try {
    expect(
      getInitialRepositoryPath('/fallback', defaultLaunchOptions, lastRepositoryPath, {}),
    ).toBe(lastRepositoryPath);
  } finally {
    await rm(lastRepositoryPath, { force: true, recursive: true });
  }
});

test('does not restore missing last repositories', () => {
  expect(
    getInitialRepositoryPath('/fallback', defaultLaunchOptions, '/missing/codiff-repo', {}),
  ).toBe('/fallback');
});

test('does not restore over explicit launch intent', async () => {
  const lastRepositoryPath = await mkdtemp(join(tmpdir(), 'codiff-last-repo-'));

  try {
    expect(
      getInitialRepositoryPath(
        '/fallback',
        {
          repositoryPathProvided: true,
          walkthrough: false,
        },
        lastRepositoryPath,
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
        lastRepositoryPath,
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
        lastRepositoryPath,
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
        lastRepositoryPath,
        {},
      ),
    ).toBe('/fallback');
    expect(
      getInitialRepositoryPath('/fallback', defaultLaunchOptions, lastRepositoryPath, {
        CODIFF_REPOSITORY_PATH: '/explicit',
      }),
    ).toBe('/fallback');
  } finally {
    await rm(lastRepositoryPath, { force: true, recursive: true });
  }
});

test('reads base...head and base..head positionals as a range source', async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'codiff-range-'));

  try {
    await git(repositoryPath, ['init']);
    await git(repositoryPath, ['config', 'user.email', 'codiff@example.com']);
    await git(repositoryPath, ['config', 'user.name', 'Codiff Test']);
    await git(repositoryPath, ['commit', '--allow-empty', '-m', 'first']);
    await git(repositoryPath, ['branch', 'base']);
    await git(repositoryPath, ['commit', '--allow-empty', '-m', 'second']);
    await git(repositoryPath, ['branch', 'head']);

    expect(
      parseCommandLineArguments(['codiff', 'base...head', repositoryPath]).launchOptions.source,
    ).toEqual({ base: 'base', head: 'head', symmetric: true, type: 'range' });

    expect(
      parseCommandLineArguments(['codiff', 'base..head', repositoryPath]).launchOptions.source,
    ).toEqual({ base: 'base', head: 'head', symmetric: false, type: 'range' });

    // A range whose ends don't resolve is not treated as a source.
    expect(
      parseCommandLineArguments(['codiff', 'nope...nada', repositoryPath]).launchOptions.source,
    ).toBeUndefined();
  } finally {
    await rm(repositoryPath, { force: true, recursive: true });
  }
});
