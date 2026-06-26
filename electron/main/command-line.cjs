// @ts-check

const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { parseArgs } = require('node:util');
const { shouldUseArcRepository } = require('../arc-detection.cjs');
const { readWalkthroughContext } = require('../walkthrough-context.cjs');
const { parseArcReviewUrl, parseReviewUrl, resolveReviewUrl } = require('../review-source.cjs');

/**
 * @typedef {import('../../core/types.ts').CodiffLaunchOptions} CodiffLaunchOptions
 * @typedef {{direction: string; name: string; owner: string; repo: string}} GitHubRemote
 * @typedef {{launchOptions: CodiffLaunchOptions; pullRequestNumber: number | null; pullRequestProvider?: 'github' | 'gitlab'; repositoryPath: string | null}} ParsedCommandLineArguments
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
const getReviewProviderMarker = (arg) =>
  /^(?:pr|pull-request)$/i.test(arg)
    ? 'github'
    : /^(?:mr|merge-request)$/i.test(arg)
      ? 'gitlab'
      : null;

/** @param {string} arg */
const isPullRequestUrlArgument = (arg) => parseReviewUrl(arg) != null;

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

/** @param {string} repositoryPath @param {number} number @param {'github' | 'gitlab'} [provider] */
const resolvePullRequestUrl = (repositoryPath, number, provider) =>
  resolveReviewUrl(repositoryPath, number, provider);

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
      arc: {
        type: 'boolean',
      },
      'arc-base': {
        type: 'string',
      },
      'claude-session': {
        type: 'string',
      },
      'codex-session': {
        type: 'string',
      },
      'opencode-session': {
        type: 'string',
      },
      'pi-session': {
        type: 'string',
      },
      'plan-file': {
        type: 'string',
      },
      'plan-result-file': {
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
  let arcBase = typeof values['arc-base'] === 'string' ? values['arc-base'] : null;
  let arc = values.arc === true || arcBase != null;
  let arcCommitRef = null;
  let arcPullRequestNumber = null;
  let arcPullRequestUrl = null;
  let arcRange = null;
  let pullRequestNumber = null;
  let pullRequestProvider = null;
  let pullRequestUrl = null;
  let repositoryPath = null;
  let sourceCandidate = null;
  let rangeCandidate = null;
  const requestedPlanFilePath =
    (typeof values['plan-file'] === 'string' ? values['plan-file'] : '') ||
    (useEnvironment ? process.env.CODIFF_PLAN_FILE || '' : '');

  for (let index = 0; index < positionals.length; index += 1) {
    const arg = positionals[index];
    if (requestedPlanFilePath) {
      repositoryPath ??= arg;
      continue;
    }
    if (arcPullRequestNumber == null) {
      const arcReview = parseArcReviewUrl(arg);
      if (arcReview) {
        arc = true;
        arcPullRequestNumber = arcReview.number;
        arcPullRequestUrl = arcReview.url;
        continue;
      }
    }
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

      const markerProvider = getReviewProviderMarker(arg);
      const nextNumber = markerProvider
        ? parsePullRequestNumberValue(positionals[index + 1] ?? '')
        : null;
      if (nextNumber != null) {
        pullRequestNumber = nextNumber;
        pullRequestProvider = markerProvider;
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
  const commandRepositoryPath = resolve(repositoryPath || process.cwd());
  const canUseArcRepository = !requestedPlanFilePath && !pullRequestUrl;
  const canInferSource = canUseArcRepository && pullRequestNumber == null;
  const useArcRepository =
    canUseArcRepository && (arc || shouldUseArcRepository(commandRepositoryPath));
  if (rangeCandidate) {
    range =
      isCommitRef(commandRepositoryPath, rangeCandidate.base) &&
      isCommitRef(commandRepositoryPath, rangeCandidate.head)
        ? rangeCandidate
        : null;
    if (!range && useArcRepository) {
      arc = true;
      arcRange = rangeCandidate;
    }
  }

  if (!range && !commitRef && !branchRef && sourceCandidate) {
    const source = resolveSourceCandidate(commandRepositoryPath, sourceCandidate);
    if (source?.branchRef) {
      branchRef = source.branchRef;
    } else if (source?.commitRef) {
      commitRef = source.commitRef;
    } else if (
      useArcRepository &&
      !existsSync(resolve(sourceCandidate)) &&
      !isExplicitPathArgument(sourceCandidate)
    ) {
      arc = true;
      if (isCommitRefArgument(sourceCandidate)) {
        arcCommitRef = sourceCandidate;
      } else {
        arcBase ??= sourceCandidate;
      }
    } else if (repositoryPath == null) {
      repositoryPath = sourceCandidate;
    }
  }
  if (useArcRepository && commitRef && !branchRef && !range && !arcRange) {
    arc = true;
    arcCommitRef = commitRef;
    commitRef = null;
  }
  if (useArcRepository && pullRequestNumber != null && !pullRequestUrl) {
    arc = true;
    arcPullRequestNumber = pullRequestNumber;
    pullRequestNumber = null;
    pullRequestProvider = null;
  }
  if (
    canInferSource &&
    !arc &&
    !arcBase &&
    !range &&
    !commitRef &&
    !branchRef &&
    !sourceCandidate &&
    shouldUseArcRepository(commandRepositoryPath)
  ) {
    arc = true;
  }

  const envCommitRef = useEnvironment ? process.env.CODIFF_COMMIT_REF || '' : '';
  const envArc = useEnvironment ? process.env.CODIFF_ARC === '1' : false;
  const envArcBase = useEnvironment ? process.env.CODIFF_ARC_BASE || '' : '';
  const envArcCommitRef = useEnvironment ? process.env.CODIFF_ARC_COMMIT_REF || '' : '';
  const envArcPullRequestNumber = useEnvironment
    ? parsePullRequestNumberValue(process.env.CODIFF_ARC_PULL_REQUEST_NUMBER || '')
    : null;
  const envArcPullRequestUrl = useEnvironment ? process.env.CODIFF_ARC_PULL_REQUEST_URL || '' : '';
  const envArcRange = useEnvironment
    ? parseRangeArgument(process.env.CODIFF_ARC_RANGE || '')
    : null;
  const envBranchRef = useEnvironment ? process.env.CODIFF_BRANCH_REF || '' : '';
  const envRange = useEnvironment ? parseRangeArgument(process.env.CODIFF_RANGE || '') : null;
  const envPullRequestNumber = useEnvironment
    ? parsePullRequestNumberValue(process.env.CODIFF_PULL_REQUEST_NUMBER || '')
    : null;
  const envPullRequestUrl = useEnvironment ? process.env.CODIFF_PULL_REQUEST_URL || '' : '';
  const envReviewProvider = useEnvironment ? process.env.CODIFF_REVIEW_PROVIDER || '' : '';
  const envCodexSessionId = useEnvironment ? process.env.CODIFF_CODEX_SESSION_ID || '' : '';
  const envClaudeSessionId = useEnvironment ? process.env.CODIFF_CLAUDE_SESSION_ID || '' : '';
  const envOpenCodeSessionId = useEnvironment ? process.env.CODIFF_OPENCODE_SESSION_ID || '' : '';
  const envPiSessionId = useEnvironment ? process.env.CODIFF_PI_SESSION_ID || '' : '';
  const envPlanFilePath = useEnvironment ? process.env.CODIFF_PLAN_FILE || '' : '';
  const envPlanResultFilePath = useEnvironment ? process.env.CODIFF_PLAN_RESULT_FILE || '' : '';
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
  const opencodeSessionId =
    (typeof values['opencode-session'] === 'string' ? values['opencode-session'] : '') ||
    envOpenCodeSessionId ||
    undefined;
  const piSessionId =
    (typeof values['pi-session'] === 'string' ? values['pi-session'] : '') ||
    envPiSessionId ||
    undefined;
  const planFilePath = requestedPlanFilePath || envPlanFilePath || undefined;
  const planResultFilePath =
    (typeof values['plan-result-file'] === 'string' ? values['plan-result-file'] : '') ||
    envPlanResultFilePath ||
    undefined;
  const rawAgentBackend =
    (typeof values.agent === 'string' ? values.agent : '') || envAgentBackend || '';
  const agentBackend =
    rawAgentBackend === 'codex' ||
    rawAgentBackend === 'claude' ||
    rawAgentBackend === 'opencode' ||
    rawAgentBackend === 'pi'
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
  const sourceReviewProvider =
    envReviewProvider === 'github' || envReviewProvider === 'gitlab'
      ? envReviewProvider
      : pullRequestProvider;
  const sourceRef = envCommitRef || commitRef;
  const sourceArcBase = envArcBase || arcBase;
  const sourceArcCommitRef = envArcCommitRef || arcCommitRef;
  const sourceArcPullRequestNumber = envArcPullRequestNumber ?? arcPullRequestNumber;
  const sourceArcPullRequestUrl = envArcPullRequestUrl || arcPullRequestUrl;
  const sourceArcRange = envArcRange || arcRange;
  const sourceArc =
    envArc ||
    arc ||
    Boolean(sourceArcBase || sourceArcCommitRef || sourceArcRange) ||
    sourceArcPullRequestNumber != null;
  const sourceBranchRef = envBranchRef || branchRef;
  const sourceRange = envRange || range;
  const sourcePullRequestUrl = envPullRequestUrl || pullRequestUrl;
  const parsedPullRequest = sourcePullRequestUrl ? parseReviewUrl(sourcePullRequestUrl) : null;
  const repositoryPathProvided = Boolean(
    repositoryPath || (useEnvironment && process.env.CODIFF_REPOSITORY_PATH),
  );
  return {
    launchOptions: {
      ...(agentBackend ? { agentBackend } : {}),
      ...(claudeSessionId ? { claudeSessionId } : {}),
      ...(codexSessionId ? { codexSessionId } : {}),
      ...(opencodeSessionId ? { opencodeSessionId } : {}),
      ...(piSessionId ? { piSessionId } : {}),
      ...(planFilePath ? { planFile: resolve(planFilePath) } : {}),
      ...(planResultFilePath ? { planResultFile: resolve(planResultFilePath) } : {}),
      repositoryPathProvided,
      source: sourceArc
        ? sourceArcRange
          ? {
              base: sourceArcRange.base,
              head: sourceArcRange.head,
              symmetric: sourceArcRange.symmetric,
              type: 'arc-range',
            }
          : sourceArcCommitRef
            ? {
                ref: sourceArcCommitRef,
                type: 'arc-commit',
              }
            : sourceArcPullRequestNumber != null
              ? {
                  number: sourceArcPullRequestNumber,
                  type: 'arc-pull-request',
                  ...(sourceArcPullRequestUrl ? { url: sourceArcPullRequestUrl } : {}),
                }
              : sourceArcBase
                ? {
                    base: sourceArcBase,
                    type: 'arc-branch',
                  }
                : {
                    type: 'arc-working-tree',
                  }
        : sourceRange && sourcePullRequestNumber == null
          ? {
              base: sourceRange.base,
              head: sourceRange.head,
              symmetric: sourceRange.symmetric,
              type: 'range',
            }
          : sourcePullRequestUrl
            ? {
                ...(parsedPullRequest?.provider ? { provider: parsedPullRequest.provider } : {}),
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
    ...(sourceReviewProvider ? { pullRequestProvider: sourceReviewProvider } : {}),
    repositoryPath,
  };
};

/** @param {ReadonlyArray<string>} [commandLine] */
const getCommandLineRepositoryPath = (commandLine = process.argv) =>
  parseCommandLineArguments(commandLine).repositoryPath;

/** @param {ReadonlyArray<string>} [commandLine] @param {string} [fallbackPath] @returns {CodiffLaunchOptions} */
const getCommandLineLaunchOptions = (commandLine = process.argv, fallbackPath = process.cwd()) => {
  const { launchOptions, pullRequestNumber, pullRequestProvider, repositoryPath } =
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
        pullRequestProvider ?? undefined,
      ),
      ...(pullRequestProvider ? { provider: pullRequestProvider } : {}),
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
    !launchOptions.walkthrough &&
    !launchOptions.planFile
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
