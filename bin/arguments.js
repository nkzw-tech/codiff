import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import reviewSource from '../electron/review-source.cjs';

const { parseReviewUrl, resolveReviewUrl } = reviewSource;

export const flagDefinitions = [
  {
    argument: '<codex|claude|opencode|pi>',
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
    argument: '<id>',
    description: 'Attach OpenCode session metadata to a walkthrough.',
    name: 'opencode-session',
    type: 'string',
  },
  {
    argument: '<id>',
    description: 'Attach Pi session metadata to a walkthrough.',
    name: 'pi-session',
    type: 'string',
  },
  {
    argument: '<file>',
    description: 'Edit a Markdown plan and wait until it is handed back.',
    name: 'plan',
    type: 'string',
  },
  {
    description: 'Share a walkthrough or a --plan file, then print its URL.',
    name: 'share',
    type: 'boolean',
  },
  {
    description: 'Show version number and exit.',
    name: 'version',
    short: 'v',
    type: 'boolean',
  },
  {
    description: 'Start an LLM walkthrough; use HEAD when there are no local changes.',
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
  { command: 'codiff mr 75', description: 'Review GitLab merge request !75.' },
  { command: 'codiff --plan plan.md', description: 'Edit a plan and wait for handoff.' },
  { command: 'codiff --plan plan.md --share', description: 'Share a Markdown plan.' },
  { command: 'codiff -w', description: 'Walk through local changes, or HEAD when clean.' },
  { command: 'codiff -w a1b2c3d', description: 'Generate a narrative walkthrough for a commit.' },
  { command: 'codiff --share', description: 'Share local changes, or HEAD when clean.' },
  { command: 'codiff --share HEAD', description: 'Share a walkthrough for a commit.' },
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

const isGitRepository = (repositoryPath) =>
  gitSucceeds(repositoryPath, ['rev-parse', '--show-toplevel']);

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

const getReviewProviderMarker = (arg) =>
  /^(?:pr|pull-request)$/i.test(arg)
    ? 'github'
    : /^(?:mr|merge-request)$/i.test(arg)
      ? 'gitlab'
      : null;

const isPullRequestUrlArgument = (arg) => parseReviewUrl(arg) != null;

export const resolvePullRequestUrl = (repositoryPath, number, provider) =>
  resolveReviewUrl(repositoryPath, number, provider);

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
  const opencodeSessionId =
    typeof values['opencode-session'] === 'string' ? values['opencode-session'] : null;
  const piSessionId = typeof values['pi-session'] === 'string' ? values['pi-session'] : null;
  const planFilePath = typeof values.plan === 'string' ? values.plan : null;
  const agentBackend =
    values.agent === 'codex' ||
    values.agent === 'claude' ||
    values.agent === 'opencode' ||
    values.agent === 'pi'
      ? values.agent
      : null;
  let pullRequestNumber = null;
  let pullRequestProvider = null;
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
    if (planFilePath) {
      requestedPath ??= arg;
      continue;
    }
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
    } else if (requestedPath == null && existsSync(resolve(sourceCandidate))) {
      requestedPath = sourceCandidate;
    } else if (isGitRepository(repositoryPath)) {
      branchRef = sourceCandidate;
    } else if (requestedPath == null) {
      requestedPath = sourceCandidate;
    }
  }

  return {
    ...(agentBackend ? { agentBackend } : {}),
    ...(claudeSessionId ? { claudeSessionId } : {}),
    ...(codexSessionId ? { codexSessionId } : {}),
    ...(opencodeSessionId ? { opencodeSessionId } : {}),
    ...(piSessionId ? { piSessionId } : {}),
    ...(planFilePath ? { planFilePath: resolve(planFilePath) } : {}),
    ...(branchRef ? { branchRef } : {}),
    ...(range ? { range } : {}),
    commitRef,
    help: values.help === true,
    pullRequestNumber,
    ...(pullRequestProvider ? { pullRequestProvider } : {}),
    pullRequestUrl,
    requestedPath: resolve(requestedPath ?? process.cwd()),
    ...(values.share === true ? { share: true } : {}),
    version: values.version === true,
    walkthrough: values.walkthrough === true || (values.share === true && !planFilePath),
    ...(values['walkthrough-guide'] === true ? { walkthroughGuide: true } : {}),
    ...(walkthroughContextPath ? { walkthroughContextPath: resolve(walkthroughContextPath) } : {}),
    ...(walkthroughFilePath ? { walkthroughFilePath: resolve(walkthroughFilePath) } : {}),
  };
};
