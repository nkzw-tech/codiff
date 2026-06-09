// @ts-check

const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { parseArgs } = require('node:util');
const { readWalkthroughContext } = require('../walkthrough-context.cjs');

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
const isExplicitPathArgument = (arg) =>
  arg.startsWith('/') || arg.startsWith('./') || arg.startsWith('../');

// `base...head` (symmetric / merge-base) or `base..head` (direct) range syntax.
const rangeArgumentPattern = /^([^.][^\s]*?)(\.\.\.?)([^.][^\s]*)$/;
/** @param {string} arg @returns {{ base: string; head: string; symmetric: boolean } | null} */
const parseRangeArgument = (arg) => {
  if (isExplicitPathArgument(arg)) {
    return null;
  }
  const match = arg.match(rangeArgumentPattern);
  return match ? { base: match[1], head: match[3], symmetric: match[2] === '...' } : null;
};

/** @param {string} repositoryPath @param {ReadonlyArray<string>} args */
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

/** @param {string} repositoryPath @param {string} ref */
const isBranchRef = (repositoryPath, ref) =>
  gitSucceeds(repositoryPath, ['show-ref', '--verify', '--quiet', `refs/heads/${ref}`]) ||
  gitSucceeds(repositoryPath, ['show-ref', '--verify', '--quiet', `refs/remotes/${ref}`]);

/** @param {string} repositoryPath @param {string} ref */
const isCommitRef = (repositoryPath, ref) =>
  gitSucceeds(repositoryPath, ['rev-parse', '--verify', `${ref}^{commit}`]);

/** @param {string} repositoryPath @param {string} ref */
const resolveSourceCandidate = (repositoryPath, ref) =>
  isCommitRefArgument(ref) && isCommitRef(repositoryPath, ref)
    ? { commitRef: ref }
    : isBranchRef(repositoryPath, ref)
      ? { branchRef: ref }
      : isCommitRef(repositoryPath, ref) || isCommitRefArgument(ref)
        ? { commitRef: ref }
        : null;

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
      branch: {
        type: 'string',
      },
      walkthrough: {
        short: 'w',
        type: 'boolean',
      },
      agent: {
        type: 'string',
      },
      'claude-session': {
        type: 'string',
      },
      'codex-session': {
        type: 'string',
      },
      'pi-session': {
        type: 'string',
      },
      'walkthrough-context': {
        type: 'string',
      },
      'walkthrough-file': {
        type: 'string',
      },
    },
    strict: false,
  });

  let commitRef = typeof values.commit === 'string' ? values.commit : null;
  let branchRef = typeof values.branch === 'string' ? values.branch : null;
  let pullRequestNumber = null;
  let pullRequestUrl = null;
  let repositoryPath = null;
  let sourceCandidate = null;
  let rangeCandidate = null;

  for (let index = 0; index < positionals.length; index += 1) {
    const arg = positionals[index];
    if (!pullRequestUrl && isPullRequestUrlArgument(arg)) {
      pullRequestUrl = arg;
      continue;
    }

    if (!rangeCandidate && !commitRef && !branchRef && !sourceCandidate) {
      const parsedRange = parseRangeArgument(arg);
      if (parsedRange) {
        rangeCandidate = parsedRange;
        continue;
      }
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

    if (!commitRef && !branchRef && !sourceCandidate && !isExplicitPathArgument(arg)) {
      sourceCandidate = arg;
    } else if (repositoryPath == null) {
      repositoryPath = arg;
    }
  }

  let range = null;
  if (rangeCandidate) {
    const rangeRepo = resolve(repositoryPath || process.cwd());
    range =
      isCommitRef(rangeRepo, rangeCandidate.base) && isCommitRef(rangeRepo, rangeCandidate.head)
        ? rangeCandidate
        : null;
  }

  if (!range && !commitRef && !branchRef && sourceCandidate) {
    const source = resolveSourceCandidate(
      resolve(repositoryPath || process.cwd()),
      sourceCandidate,
    );
    if (source?.branchRef) {
      branchRef = source.branchRef;
    } else if (source?.commitRef) {
      commitRef = source.commitRef;
    } else if (repositoryPath == null) {
      repositoryPath = sourceCandidate;
    }
  }

  const envCommitRef = useEnvironment ? process.env.CODIFF_COMMIT_REF || '' : '';
  const envBranchRef = useEnvironment ? process.env.CODIFF_BRANCH_REF || '' : '';
  const envRange = useEnvironment ? parseRangeArgument(process.env.CODIFF_RANGE || '') : null;
  const envPullRequestNumber = useEnvironment
    ? parsePullRequestNumberValue(process.env.CODIFF_PULL_REQUEST_NUMBER || '')
    : null;
  const envPullRequestUrl = useEnvironment ? process.env.CODIFF_PULL_REQUEST_URL || '' : '';
  const envCodexSessionId = useEnvironment ? process.env.CODIFF_CODEX_SESSION_ID || '' : '';
  const envClaudeSessionId = useEnvironment ? process.env.CODIFF_CLAUDE_SESSION_ID || '' : '';
  const envPiSessionId = useEnvironment ? process.env.CODIFF_PI_SESSION_ID || '' : '';
  const envAgentBackend = useEnvironment ? process.env.CODIFF_AGENT_BACKEND || '' : '';
  const envWalkthroughContextPath = useEnvironment
    ? process.env.CODIFF_WALKTHROUGH_CONTEXT || ''
    : '';
  const envWalkthroughFilePath = useEnvironment ? process.env.CODIFF_WALKTHROUGH_FILE || '' : '';
  const codexSessionId =
    (typeof values['codex-session'] === 'string' ? values['codex-session'] : '') ||
    envCodexSessionId ||
    undefined;
  const claudeSessionId =
    (typeof values['claude-session'] === 'string' ? values['claude-session'] : '') ||
    envClaudeSessionId ||
    undefined;
  const piSessionId =
    (typeof values['pi-session'] === 'string' ? values['pi-session'] : '') ||
    envPiSessionId ||
    undefined;
  const rawAgentBackend =
    (typeof values.agent === 'string' ? values.agent : '') || envAgentBackend || '';
  const agentBackend =
    rawAgentBackend === 'codex' || rawAgentBackend === 'claude' || rawAgentBackend === 'pi'
      ? rawAgentBackend
      : undefined;
  const walkthroughContextPath =
    (typeof values['walkthrough-context'] === 'string' ? values['walkthrough-context'] : '') ||
    envWalkthroughContextPath ||
    undefined;
  const walkthroughFilePath =
    (typeof values['walkthrough-file'] === 'string' ? values['walkthrough-file'] : '') ||
    envWalkthroughFilePath ||
    undefined;
  const sourcePullRequestNumber = envPullRequestNumber ?? pullRequestNumber;
  const sourceRef = envCommitRef || commitRef;
  const sourceBranchRef = envBranchRef || branchRef;
  const sourceRange = envRange || range;
  const sourcePullRequestUrl = envPullRequestUrl || pullRequestUrl;
  const repositoryPathProvided = Boolean(
    repositoryPath || (useEnvironment && process.env.CODIFF_REPOSITORY_PATH),
  );
  return {
    launchOptions: {
      ...(agentBackend ? { agentBackend } : {}),
      ...(claudeSessionId ? { claudeSessionId } : {}),
      ...(codexSessionId ? { codexSessionId } : {}),
      ...(piSessionId ? { piSessionId } : {}),
      repositoryPathProvided,
      source:
        sourceRange && sourcePullRequestNumber == null
          ? {
              base: sourceRange.base,
              head: sourceRange.head,
              symmetric: sourceRange.symmetric,
              type: 'range',
            }
          : sourcePullRequestUrl
            ? {
                type: 'pull-request',
                url: sourcePullRequestUrl,
              }
            : sourceRef && sourcePullRequestNumber == null
              ? {
                  ref: sourceRef,
                  type: 'commit',
                }
              : sourceBranchRef && sourcePullRequestNumber == null
                ? {
                    ref: sourceBranchRef,
                    type: 'branch',
                  }
                : undefined,
      walkthrough:
        (useEnvironment && process.env.CODIFF_WALKTHROUGH === '1') || values.walkthrough === true,
      ...(walkthroughContextPath
        ? { walkthroughContext: readWalkthroughContext(walkthroughContextPath, codexSessionId) }
        : {}),
      ...(walkthroughFilePath ? { walkthroughFile: resolve(walkthroughFilePath) } : {}),
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
