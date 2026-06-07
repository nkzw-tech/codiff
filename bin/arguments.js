import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const flagDefinitions = [
  {
    argument: '<codex|claude>',
    description: 'Override the agent backend for this session.',
    name: 'agent',
    type: 'string',
  },
  {
    argument: '<ref>',
    description: 'Review the current branch against a target branch.',
    name: 'branch',
    type: 'string',
  },
  {
    argument: '<id>',
    description: 'Attach Claude Code session metadata to a walkthrough.',
    name: 'claude-session',
    type: 'string',
  },
  { argument: '<ref>', description: 'Review a specific commit.', name: 'commit', type: 'string' },
  {
    argument: '<id>',
    description: 'Attach Codex session metadata to a walkthrough.',
    name: 'codex-session',
    type: 'string',
  },
  { description: 'Show this help message and exit.', name: 'help', short: 'h', type: 'boolean' },
  {
    description: 'Show version number and exit.',
    name: 'version',
    short: 'v',
    type: 'boolean',
  },
  {
    description: 'Start with an LLM-generated narrative walkthrough.',
    name: 'walkthrough',
    short: 'w',
    type: 'boolean',
  },
  {
    argument: '<file>',
    description: 'Seed a walkthrough with Codex conversation context JSON.',
    name: 'walkthrough-context',
    type: 'string',
  },
  {
    argument: '<file>',
    description: 'Open a pre-authored narrative walkthrough JSON file.',
    name: 'walkthrough-file',
    type: 'string',
  },
  {
    description: 'Print the narrative walkthrough authoring guide and schema, then exit.',
    name: 'walkthrough-guide',
    type: 'boolean',
  },
];

export const usageExamples = [
  { command: 'codiff', description: 'Review staged and unstaged changes.' },
  { command: 'codiff /path/to/repo', description: 'Review changes in a specific repository.' },
  { command: 'codiff main', description: 'Review the current branch against main.' },
  { command: 'codiff a1b2c3d', description: 'Review a specific commit.' },
  { command: "codiff '#75'", description: 'Review pull request #75.' },
  { command: 'codiff pr 75', description: 'Review pull request #75 (alternate syntax).' },
  { command: 'codiff -w', description: 'Start with an LLM narrative walkthrough.' },
  { command: 'codiff -w a1b2c3d', description: 'Generate a narrative walkthrough for a commit.' },
];

const parseArgsOptions = Object.fromEntries(
  flagDefinitions.map(({ name, short, type }) => [name, { type, ...(short ? { short } : {}) }]),
);

const ansi = {
  blueBold: '\u001b[1;34m',
  gray: '\u001b[90m',
  reset: '\u001b[0m',
};

const blueBold = (text) => `${ansi.blueBold}${text}${ansi.reset}`;
const gray = (text) => `${ansi.gray}${text}${ansi.reset}`;

export const formatHelpText = (version) => {
  const flagLines = flagDefinitions.map(({ argument, description, name, short }) => {
    const label = `--${name}${argument ? ` ${argument}` : ''}${short ? `, -${short}` : ''}`;
    return { description, label };
  });
  const flagPad = Math.max(...flagLines.map(({ label }) => label.length)) + 2;

  const examplePad = Math.max(...usageExamples.map(({ command }) => command.length)) + 2;

  const lines = [
    `${blueBold(`codiff v${version}`)} ${gray('A fast local diff viewer.')}`,
    '',
    `${blueBold('Usage:')} ${gray('codiff [options] [<ref> | <pr> | <url>] [path]')}`,
    '',
    blueBold('Options:'),
    ...flagLines.map(
      ({ description, label }) =>
        `  ${label}${' '.repeat(flagPad - label.length)}${gray(description)}`,
    ),
    '',
    blueBold('Examples:'),
    ...usageExamples.map(
      ({ command, description }) =>
        `  ${command}${' '.repeat(examplePad - command.length)}${gray(description)}`,
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

const isExplicitPathArgument = (arg) =>
  arg.startsWith('/') || arg.startsWith('./') || arg.startsWith('../');

// `base...head` (symmetric / merge-base) or `base..head` (direct) range syntax.
const rangeArgumentPattern = /^([^.][^\s]*?)(\.\.\.?)([^.][^\s]*)$/;
const parseRangeArgument = (arg) => {
  if (isExplicitPathArgument(arg)) {
    return null;
  }
  const match = arg.match(rangeArgumentPattern);
  if (!match) {
    return null;
  }
  return { base: match[1], head: match[3], symmetric: match[2] === '...' };
};

const gitSucceeds = (repositoryPath, args) => {
  try {
    execFileSync('git', ['-C', repositoryPath, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
};

const isBranchRef = (repositoryPath, ref) =>
  gitSucceeds(repositoryPath, ['show-ref', '--verify', '--quiet', `refs/heads/${ref}`]) ||
  gitSucceeds(repositoryPath, ['show-ref', '--verify', '--quiet', `refs/remotes/${ref}`]);

const isCommitRef = (repositoryPath, ref) =>
  gitSucceeds(repositoryPath, ['rev-parse', '--verify', `${ref}^{commit}`]);

const resolveSourceCandidate = (repositoryPath, ref) =>
  isCommitRefArgument(ref) && isCommitRef(repositoryPath, ref)
    ? { commitRef: ref }
    : isBranchRef(repositoryPath, ref)
      ? { branchRef: ref }
      : isCommitRef(repositoryPath, ref) || isCommitRefArgument(ref)
        ? { commitRef: ref }
        : null;

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
  let branchRef = typeof values.branch === 'string' ? values.branch : null;
  const codexSessionId =
    typeof values['codex-session'] === 'string' ? values['codex-session'] : null;
  const claudeSessionId =
    typeof values['claude-session'] === 'string' ? values['claude-session'] : null;
  const agentBackend = values.agent === 'codex' || values.agent === 'claude' ? values.agent : null;
  let pullRequestNumber = null;
  let pullRequestUrl = null;
  let requestedPath = null;
  let sourceCandidate = null;
  let rangeCandidate = null;
  const walkthroughContextPath =
    typeof values['walkthrough-context'] === 'string' ? values['walkthrough-context'] : null;
  const walkthroughFilePath =
    typeof values['walkthrough-file'] === 'string' ? values['walkthrough-file'] : null;

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

    if (!rangeCandidate && !commitRef && !branchRef && !sourceCandidate) {
      const range = parseRangeArgument(arg);
      if (range) {
        rangeCandidate = range;
        continue;
      }
    }

    if (!commitRef && !branchRef && !sourceCandidate && !isExplicitPathArgument(arg)) {
      sourceCandidate = arg;
    } else if (requestedPath == null) {
      requestedPath = arg;
    }
  }

  const repositoryPath = resolve(requestedPath ?? process.cwd());
  let range = null;
  if (rangeCandidate) {
    // Only honor the range when both ends resolve in this repository; otherwise
    // fall back so a stray `a..b`-shaped argument isn't silently misread.
    range =
      isCommitRef(repositoryPath, rangeCandidate.base) &&
      isCommitRef(repositoryPath, rangeCandidate.head)
        ? rangeCandidate
        : null;
  }
  if (!range && !commitRef && !branchRef && sourceCandidate) {
    const source = resolveSourceCandidate(repositoryPath, sourceCandidate);
    if (source?.branchRef) {
      branchRef = source.branchRef;
    } else if (source?.commitRef) {
      commitRef = source.commitRef;
    } else if (requestedPath == null) {
      requestedPath = sourceCandidate;
    }
  }

  return {
    ...(agentBackend ? { agentBackend } : {}),
    ...(claudeSessionId ? { claudeSessionId } : {}),
    ...(codexSessionId ? { codexSessionId } : {}),
    ...(branchRef ? { branchRef } : {}),
    ...(range ? { range } : {}),
    commitRef,
    help: values.help === true,
    pullRequestNumber,
    pullRequestUrl,
    requestedPath: resolve(requestedPath ?? process.cwd()),
    version: values.version === true,
    walkthrough: values.walkthrough === true,
    ...(values['walkthrough-guide'] === true ? { walkthroughGuide: true } : {}),
    ...(walkthroughContextPath ? { walkthroughContextPath: resolve(walkthroughContextPath) } : {}),
    ...(walkthroughFilePath ? { walkthroughFilePath: resolve(walkthroughFilePath) } : {}),
  };
};
