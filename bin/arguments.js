import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const commitHashPattern = /^[0-9a-f]{4,64}$/i;
const pullRequestNumberPattern = /^#([1-9]\d*)$/;

const isCommitHashArgument = (arg) => commitHashPattern.test(arg) && !existsSync(resolve(arg));

const parsePullRequestNumberArgument = (arg) => {
  const match = arg.match(pullRequestNumberPattern);
  return match ? Number(match[1]) : null;
};

const parsePullRequestNumberValue = (arg) =>
  parsePullRequestNumberArgument(arg.startsWith('#') ? arg : `#${arg}`);

const isPullRequestMarkerArgument = (arg) => /^(?:pr|pull-request)$/i.test(arg);

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

const readGitHubRemotes = (repositoryPath) => {
  const repoRoot = execFileSync('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const raw = execFileSync('git', ['-C', repoRoot, 'remote', '-v'], { encoding: 'utf8' });
  const remotes = [];

  for (const line of raw.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    const remote = match ? parseGitHubRemoteUrl(match[2]) : null;
    if (remote) {
      remotes.push({
        direction: match[3],
        name: match[1],
        ...remote,
      });
    }
  }

  return remotes;
};

const selectGitHubRemote = (remotes) =>
  [...remotes].sort((left, right) => {
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

export const resolvePullRequestUrl = (repositoryPath, number) => {
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

export const parseArguments = (args) => {
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
  let requestedPath = null;

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

    if (!commitRef && isCommitHashArgument(arg)) {
      commitRef = arg;
    } else if (requestedPath == null) {
      requestedPath = arg;
    }
  }

  return {
    commitRef,
    pullRequestNumber,
    pullRequestUrl,
    requestedPath: resolve(requestedPath ?? process.cwd()),
    walkthrough: values.walkthrough === true,
  };
};
