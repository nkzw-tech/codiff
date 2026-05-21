// @ts-check

const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { parseArgs } = require('node:util');

/**
 * @typedef {import('../../src/types.ts').CodiffLaunchOptions} CodiffLaunchOptions
 * @typedef {{direction: string; name: string; owner: string; repo: string}} GitHubRemote
 * @typedef {{launchOptions: CodiffLaunchOptions; pullRequestNumber: number | null; repositoryPath: string | null}} ParsedCommandLineArguments
 */

const commitHashPattern = /^[0-9a-f]{4,64}$/i;
const headCommitRefPattern = /^(?:HEAD|@)(?:(?:[~^]\d*)|\^\{[^}]+\}|@\{[^}]+\})*$/;
const pullRequestNumberPattern = /^#([1-9]\d*)$/;
const revisionSyntaxPattern = /(?:\^|~|@\{[^}]+\})/;

/** @param {string} arg */
const isCommitRefArgument = (arg) =>
  !existsSync(resolve(arg)) &&
  (commitHashPattern.test(arg) ||
    headCommitRefPattern.test(arg) ||
    revisionSyntaxPattern.test(arg));

/** @param {string} arg */
const parsePullRequestNumberArgument = (arg) => {
  const match = arg.match(pullRequestNumberPattern);
  return match ? Number(match[1]) : null;
};

/** @param {string} value */
const parsePullRequestNumberValue = (value) => {
  const normalized = value.startsWith('#') ? value : `#${value}`;
  return parsePullRequestNumberArgument(normalized);
};

/** @param {string} arg */
const isPullRequestMarkerArgument = (arg) => /^(?:pr|pull-request)$/i.test(arg);

/** @param {string} arg */
const isPullRequestUrlArgument = (arg) => {
  try {
    const url = new URL(arg);
    return (
      url.hostname.toLowerCase() === 'github.com' &&
      /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
};

/** @param {string} value @returns {{owner: string; repo: string} | null} */
const parseGitHubRemoteUrl = (value) => {
  const trimmed = value.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2].replace(/\.git$/i, ''),
    };
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== 'github.com') {
      return null;
    }

    const match = url.pathname.match(/^\/([^/]+)\/(.+?)(?:\.git)?$/);
    return match
      ? {
          owner: match[1],
          repo: match[2].replace(/\.git$/i, ''),
        }
      : null;
  } catch {
    return null;
  }
};

/** @param {string} repositoryPath @returns {Array<GitHubRemote>} */
const readGitHubRemotes = (repositoryPath) => {
  const repoRoot = execFileSync('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const raw = execFileSync('git', ['-C', repoRoot, 'remote', '-v'], { encoding: 'utf8' });
  /** @type {Array<GitHubRemote>} */
  const remotes = [];

  for (const line of raw.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    const remote = match ? parseGitHubRemoteUrl(match[2]) : null;
    if (remote && match) {
      remotes.push({
        direction: match[3],
        name: match[1],
        ...remote,
      });
    }
  }

  return remotes;
};

/** @param {ReadonlyArray<GitHubRemote>} remotes */
const selectGitHubRemote = (remotes) =>
  [...remotes].sort((left, right) => {
    /** @param {GitHubRemote} remote */
    const getPriority = (remote) =>
      remote.name === 'origin'
        ? remote.direction === 'fetch'
          ? 0
          : 1
        : remote.direction === 'fetch'
          ? 2
          : 3;
    return getPriority(left) - getPriority(right);
  })[0] ?? null;

/** @param {string} repositoryPath @param {number} number */
const resolvePullRequestUrl = (repositoryPath, number) => {
  let remotes;
  try {
    remotes = readGitHubRemotes(repositoryPath);
  } catch {
    throw new Error(
      `Could not resolve PR #${number}. Run codiff from inside a GitHub repository or pass a full GitHub pull request URL.`,
    );
  }

  const remote = selectGitHubRemote(remotes);
  if (!remote) {
    throw new Error(
      `Could not resolve PR #${number} because this repository has no GitHub remote.`,
    );
  }

  return `https://github.com/${remote.owner}/${remote.repo}/pull/${number}`;
};

/** @param {ReadonlyArray<string>} [commandLine] @returns {ParsedCommandLineArguments} */
const parseCommandLineArguments = (commandLine = process.argv) => {
  const args = commandLine.slice(process.defaultApp ? 2 : 1);
  const useEnvironment = commandLine === process.argv;
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      commit: {
        type: 'string',
      },
      walkthrough: {
        short: 'w',
        type: 'boolean',
      },
    },
    strict: false,
  });

  let commitRef = typeof values.commit === 'string' ? values.commit : null;
  let pullRequestNumber = null;
  let pullRequestUrl = null;
  let repositoryPath = null;

  for (let index = 0; index < positionals.length; index += 1) {
    const arg = positionals[index];
    if (!pullRequestUrl && isPullRequestUrlArgument(arg)) {
      pullRequestUrl = arg;
      continue;
    }

    if (!pullRequestUrl && pullRequestNumber == null) {
      const number = parsePullRequestNumberArgument(arg);
      if (number != null) {
        pullRequestNumber = number;
        continue;
      }

      const nextNumber = isPullRequestMarkerArgument(arg)
        ? parsePullRequestNumberValue(positionals[index + 1] ?? '')
        : null;
      if (nextNumber != null) {
        pullRequestNumber = nextNumber;
        index += 1;
        continue;
      }
    }

    if (!commitRef && isCommitRefArgument(arg)) {
      commitRef = arg;
    } else if (repositoryPath == null) {
      repositoryPath = arg;
    }
  }

  const envCommitRef = useEnvironment ? process.env.CODIFF_COMMIT_REF || '' : '';
  const envPullRequestNumber = useEnvironment
    ? parsePullRequestNumberValue(process.env.CODIFF_PULL_REQUEST_NUMBER || '')
    : null;
  const envPullRequestUrl = useEnvironment ? process.env.CODIFF_PULL_REQUEST_URL || '' : '';
  const sourcePullRequestNumber = envPullRequestNumber ?? pullRequestNumber;
  const sourceRef = envCommitRef || commitRef;
  const sourcePullRequestUrl = envPullRequestUrl || pullRequestUrl;
  const repositoryPathProvided = Boolean(
    repositoryPath || (useEnvironment && process.env.CODIFF_REPOSITORY_PATH),
  );
  return {
    launchOptions: {
      repositoryPathProvided,
      source: sourcePullRequestUrl
        ? {
            type: 'pull-request',
            url: sourcePullRequestUrl,
          }
        : sourceRef && sourcePullRequestNumber == null
          ? {
              ref: sourceRef,
              type: 'commit',
            }
          : undefined,
      walkthrough:
        (useEnvironment && process.env.CODIFF_WALKTHROUGH === '1') || values.walkthrough === true,
    },
    pullRequestNumber: sourcePullRequestNumber,
    repositoryPath,
  };
};

/** @param {ReadonlyArray<string>} [commandLine] */
const getCommandLineRepositoryPath = (commandLine = process.argv) =>
  parseCommandLineArguments(commandLine).repositoryPath;

/** @param {ReadonlyArray<string>} [commandLine] @param {string} [fallbackPath] @returns {CodiffLaunchOptions} */
const getCommandLineLaunchOptions = (commandLine = process.argv, fallbackPath = process.cwd()) => {
  const { launchOptions, pullRequestNumber, repositoryPath } =
    parseCommandLineArguments(commandLine);
  if (pullRequestNumber == null || launchOptions.source) {
    return launchOptions;
  }

  return {
    ...launchOptions,
    source: {
      type: 'pull-request',
      url: resolvePullRequestUrl(
        resolve(
          (commandLine === process.argv ? process.env.CODIFF_REPOSITORY_PATH : '') ||
            repositoryPath ||
            fallbackPath,
        ),
        pullRequestNumber,
      ),
    },
  };
};

const getLaunchPath = () =>
  resolve(process.env.CODIFF_REPOSITORY_PATH || getCommandLineRepositoryPath() || process.cwd());

/**
 * @param {string} launchPath
 * @param {CodiffLaunchOptions} launchOptions
 * @param {string} lastRepositoryPath
 * @param {NodeJS.ProcessEnv} [environment]
 */
const getInitialRepositoryPath = (
  launchPath,
  launchOptions,
  lastRepositoryPath,
  environment = process.env,
) => {
  if (
    lastRepositoryPath &&
    existsSync(lastRepositoryPath) &&
    !environment.CODIFF_REPOSITORY_PATH &&
    !launchOptions.repositoryPathProvided &&
    !launchOptions.source &&
    !launchOptions.walkthrough
  ) {
    return resolve(lastRepositoryPath);
  }

  return launchPath;
};

const getLaunchOptions = () => getCommandLineLaunchOptions();

module.exports = {
  getInitialRepositoryPath,
  getCommandLineLaunchOptions,
  getCommandLineRepositoryPath,
  getLaunchOptions,
  getLaunchPath,
  parseCommandLineArguments,
  parseGitHubRemoteUrl,
  resolvePullRequestUrl,
};
