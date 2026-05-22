import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const flagDefinitions = [
  { argument: '<ref>', description: 'Review a specific commit.', name: 'commit', type: 'string' },
  { description: 'Show this help message and exit.', name: 'help', short: 'h', type: 'boolean' },
  {
    description: 'Show version number and exit.',
    name: 'version',
    short: 'v',
    type: 'boolean',
  },
  {
    description: 'Start with an LLM-generated review walkthrough.',
    name: 'walkthrough',
    short: 'w',
    type: 'boolean',
  },
];

export const usageExamples = [
  { command: 'codiff', description: 'Review staged and unstaged changes.' },
  { command: 'codiff /path/to/repo', description: 'Review changes in a specific repository.' },
  { command: 'codiff a1b2c3d', description: 'Review a specific commit.' },
  { command: "codiff '#75'", description: 'Review pull request #75.' },
  { command: 'codiff pr 75', description: 'Review pull request #75 (alternate syntax).' },
  { command: 'codiff -w', description: 'Start with an LLM walkthrough.' },
  { command: 'codiff -w a1b2c3d', description: 'Walkthrough a specific commit.' },
];

const parseArgsOptions = Object.fromEntries(
  flagDefinitions.map(({ name, short, type }) => [name, { type, ...(short ? { short } : {}) }]),
);

export const formatHelpText = (version) => {
  const flagLines = flagDefinitions.map(({ argument, description, name, short }) => {
    const label = `--${name}${argument ? ` ${argument}` : ''}${short ? `, -${short}` : ''}`;
    return { description, label };
  });
  const flagPad = Math.max(...flagLines.map(({ label }) => label.length)) + 2;

  const examplePad = Math.max(...usageExamples.map(({ command }) => command.length)) + 2;

  const lines = [
    `codiff v${version} — A fast local diff viewer.`,
    '',
    'Usage: codiff [options] [<ref> | <pr> | <url>] [path]',
    '',
    'Options:',
    ...flagLines.map(({ description, label }) => `  ${label.padEnd(flagPad)}${description}`),
    '',
    'Examples:',
    ...usageExamples.map(
      ({ command, description }) => `  ${command.padEnd(examplePad)}${description}`,
    ),
    '',
  ];

  return lines.join('\n');
};

const commitHashPattern = /^[0-9a-f]{4,64}$/i;
const headCommitRefPattern = /^(?:HEAD|@)(?:(?:[~^]\d*)|\^\{[^}]+\}|@\{[^}]+\})*$/;
const pullRequestNumberPattern = /^#([1-9]\d*)$/;
const revisionSyntaxPattern = /(?:\^|~|@\{[^}]+\})/;

const isCommitRefArgument = (arg) =>
  !existsSync(resolve(arg)) &&
  (commitHashPattern.test(arg) ||
    headCommitRefPattern.test(arg) ||
    revisionSyntaxPattern.test(arg));

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
    options: parseArgsOptions,
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

    if (!commitRef && isCommitRefArgument(arg)) {
      commitRef = arg;
    } else if (requestedPath == null) {
      requestedPath = arg;
    }
  }

  return {
    commitRef,
    help: values.help === true,
    pullRequestNumber,
    pullRequestUrl,
    requestedPath: resolve(requestedPath ?? process.cwd()),
    version: values.version === true,
    walkthrough: values.walkthrough === true,
  };
};
