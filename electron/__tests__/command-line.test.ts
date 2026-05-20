import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { parseCommandLineArguments, parseGitHubRemoteUrl } = require('../main/command-line.cjs') as {
  parseCommandLineArguments: (commandLine: ReadonlyArray<string>) => {
    launchOptions: {
      repositoryPathProvided: boolean;
      source?: { ref: string; type: 'commit' } | { type: 'pull-request'; url: string };
      walkthrough: boolean;
    };
    pullRequestNumber: number | null;
    repositoryPath: string | null;
  };
  parseGitHubRemoteUrl: (value: string) => { owner: string; repo: string } | null;
};

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
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/11',
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
