#!/usr/bin/env node

// Launcher for the Codiff `codiff` skill (OpenCode). The agent has already
// authored a narrative walkthrough JSON file; this opens Codiff pointed at it.
//
// Usage:
//   node scripts/open-codiff.mjs --file <path> [target]
//   node scripts/open-codiff.mjs --plan <path> [repository]
//
// `--file <path>` is forwarded to Codiff as `--walkthrough-file`. Any non-flag
// target is forwarded verbatim; when no repository path is given, the current
// OpenCode working directory is used.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const skillRoot = resolve(import.meta.dirname, '..');
const codiffRoot = resolve(skillRoot, '../../..');
const sessionIdPattern = /^ses_[a-z0-9]{8,}$/i;

const getCodiffCommand = () => {
  if (process.env.CODIFF_COMMAND) {
    return { args: [], command: process.env.CODIFF_COMMAND };
  }

  const appCli = join(codiffRoot, 'bin/codiff-app');
  if (
    process.platform === 'darwin' &&
    codiffRoot.includes('.app/Contents/Resources/app') &&
    existsSync(appCli)
  ) {
    return { args: [], command: appCli };
  }

  const devCli = join(codiffRoot, 'bin/codiff.js');
  if (existsSync(devCli)) {
    return { args: [devCli], command: process.execPath };
  }

  if (process.platform === 'darwin' && existsSync(appCli)) {
    return { args: [], command: appCli };
  }

  return { args: [], command: 'codiff' };
};

const getShareCommand = () =>
  process.env.CODIFF_SHARE_COMMAND
    ? { args: [], command: process.env.CODIFF_SHARE_COMMAND }
    : { args: [join(codiffRoot, 'bin/share-codiff.mjs')], command: process.execPath };

const isExecutableFile = (path) => {
  try {
    return statSync(path).isFile() && (accessSync(path, constants.X_OK), true);
  } catch {
    return false;
  }
};

const getExecutableNames = (command) => {
  if (process.platform !== 'win32') {
    return [command];
  }

  const extensions = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
};

const findExecutableOnPath = (command) => {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) {
      continue;
    }

    for (const executable of getExecutableNames(command)) {
      const candidate = join(directory, executable);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
};

const getOpenCodeCommand = () => {
  const override = process.env.CODIFF_OPENCODE_PATH?.trim();
  if (override) {
    return override;
  }

  return (
    findExecutableOnPath('opencode') ||
    [
      join(homedir(), '.opencode/bin/opencode'),
      '/opt/homebrew/bin/opencode',
      '/usr/local/bin/opencode',
    ].find(isExecutableFile) ||
    'opencode'
  );
};

const findOpenCodeSessionIdForCwd = (cwd) => {
  const result = spawnSync(
    getOpenCodeCommand(),
    ['session', 'list', '--format', 'json', '--max-count', '20', '--pure'],
    {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  if (result.error || result.status !== 0) {
    return null;
  }

  try {
    const sessions = JSON.parse(result.stdout);
    if (!Array.isArray(sessions)) {
      return null;
    }

    const resolvedCwd = resolve(cwd);
    const session = sessions.find((candidate) => {
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        typeof candidate.id !== 'string' ||
        !sessionIdPattern.test(candidate.id) ||
        typeof candidate.directory !== 'string'
      ) {
        return false;
      }

      const relativeCwd = relative(resolve(candidate.directory), resolvedCwd);
      return (
        relativeCwd === '' ||
        (!isAbsolute(relativeCwd) && relativeCwd !== '..' && !relativeCwd.startsWith(`..${sep}`))
      );
    });
    return session?.id || null;
  } catch {
    return null;
  }
};

const getSessionCwd = () => {
  const cwd = process.cwd();
  const isRunningFromSourceSkill = cwd === skillRoot || cwd.startsWith(`${skillRoot}/`);
  if (isRunningFromSourceSkill && existsSync(join(codiffRoot, 'bin/codiff.js'))) {
    return codiffRoot;
  }

  return cwd;
};

const rawArgs = process.argv.slice(2);

if (rawArgs[0] === '--resolve-plan-comments') {
  const reviewPath = rawArgs[1] ? resolve(rawArgs[1]) : '';
  const threadIds = rawArgs.slice(2).filter(Boolean);
  if (!reviewPath || threadIds.length === 0) {
    process.stderr.write(
      'open-codiff: expected --resolve-plan-comments <review-path> <thread-id>... .\n',
    );
    process.exit(1);
  }
  const require = createRequire(import.meta.url);
  const { resolvePlanReviewThreadsAtPath } = require(join(codiffRoot, 'electron/plan-review.cjs'));
  try {
    const { missingIds, resolvedIds } = await resolvePlanReviewThreadsAtPath(
      reviewPath,
      threadIds,
      'agent-handled',
    );
    process.stdout.write(
      `CODIFF_PLAN_COMMENTS_RESOLVED ${JSON.stringify({ missingIds, resolvedIds })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (rawArgs.includes('--guide')) {
  const binEntry = join(codiffRoot, 'bin/codiff.js');
  const guide = existsSync(binEntry)
    ? { args: [binEntry, '--walkthrough-guide'], command: process.execPath }
    : (() => {
        const resolved = getCodiffCommand();
        return { args: [...resolved.args, '--walkthrough-guide'], command: resolved.command };
      })();
  const guideResult = spawnSync(guide.command, guide.args, { encoding: 'utf8', stdio: 'inherit' });
  if (guideResult.error) {
    process.stderr.write(`${guideResult.error.message}\n`);
    process.exit(1);
  }
  process.exit(guideResult.status ?? 0);
}

const forwardedArgs = [];
let openSharedWalkthrough = false;
let planFile = '';
let shareWalkthrough = false;
let walkthroughFile = '';
for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index];
  if (arg === '--file') {
    walkthroughFile = rawArgs[index + 1] || '';
    index += 1;
    continue;
  }
  if (arg.startsWith('--file=')) {
    walkthroughFile = arg.slice('--file='.length);
    continue;
  }
  if (arg === '--plan') {
    planFile = rawArgs[index + 1] || '';
    index += 1;
    continue;
  }
  if (arg.startsWith('--plan=')) {
    planFile = arg.slice('--plan='.length);
    continue;
  }
  if (arg === '--share') {
    shareWalkthrough = true;
    continue;
  }
  if (arg === '--open') {
    openSharedWalkthrough = true;
    continue;
  }
  forwardedArgs.push(arg);
}

const sessionCwd = getSessionCwd();

if (planFile && shareWalkthrough) {
  const planFilePath = resolve(sessionCwd, planFile);
  if (!existsSync(planFilePath) || !/\.md$/i.test(planFilePath)) {
    process.stderr.write(`open-codiff: plan file not found at ${planFilePath}.\n`);
    process.exit(1);
  }
  const environmentSessionId = process.env.OPENCODE_SESSION_ID || '';
  const sessionId =
    (sessionIdPattern.test(environmentSessionId) ? environmentSessionId : '') ||
    findOpenCodeSessionIdForCwd(sessionCwd) ||
    '';
  const shareCommand = getShareCommand();
  const shareResult = spawnSync(
    shareCommand.command,
    [
      ...shareCommand.args,
      '--plan',
      planFilePath,
      '--agent',
      'opencode',
      ...(sessionId ? ['--opencode-session', sessionId] : []),
      ...(openSharedWalkthrough ? ['--open'] : []),
      ...forwardedArgs,
    ],
    { cwd: sessionCwd, encoding: 'utf8' },
  );
  if (shareResult.stdout) {
    process.stdout.write(shareResult.stdout);
  }
  if (shareResult.stderr) {
    process.stderr.write(shareResult.stderr);
  }
  if (shareResult.error) {
    process.stderr.write(`${shareResult.error.message}\n`);
    process.exit(1);
  }
  process.exit(shareResult.status ?? 0);
}

if (planFile) {
  const planFilePath = resolve(sessionCwd, planFile);
  if (!existsSync(planFilePath) || !/\.md$/i.test(planFilePath)) {
    process.stderr.write(`open-codiff: plan file not found at ${planFilePath}.\n`);
    process.exit(1);
  }
  const environmentSessionId = process.env.OPENCODE_SESSION_ID || '';
  const sessionId =
    (sessionIdPattern.test(environmentSessionId) ? environmentSessionId : '') ||
    findOpenCodeSessionIdForCwd(sessionCwd) ||
    '';
  const codiffCommand = getCodiffCommand();
  const result = spawnSync(
    codiffCommand.command,
    [
      ...codiffCommand.args,
      '--plan',
      planFilePath,
      '--agent',
      'opencode',
      ...(sessionId ? ['--opencode-session', sessionId] : []),
      ...forwardedArgs,
    ],
    { cwd: sessionCwd, encoding: 'utf8', stdio: 'inherit' },
  );
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

if (!walkthroughFile) {
  process.stderr.write('open-codiff: missing --file <path> to the walkthrough JSON.\n');
  process.exit(1);
}

const walkthroughFilePath = resolve(sessionCwd, walkthroughFile);
if (!existsSync(walkthroughFilePath)) {
  process.stderr.write(`open-codiff: walkthrough file not found at ${walkthroughFilePath}.\n`);
  process.exit(1);
}

if (shareWalkthrough) {
  const shareCommand = getShareCommand();
  const shareResult = spawnSync(
    shareCommand.command,
    [
      ...shareCommand.args,
      '--file',
      walkthroughFilePath,
      '--agent',
      'opencode',
      ...(openSharedWalkthrough ? ['--open'] : []),
      ...forwardedArgs,
    ],
    {
      cwd: sessionCwd,
      encoding: 'utf8',
    },
  );
  if (shareResult.stdout) {
    process.stdout.write(shareResult.stdout);
  }
  if (shareResult.stderr) {
    process.stderr.write(shareResult.stderr);
  }
  if (shareResult.error) {
    process.stderr.write(`${shareResult.error.message}\n`);
    process.exit(1);
  }
  process.exit(shareResult.status ?? 0);
}

const hasRepositoryTarget = forwardedArgs.some(
  (arg) => !arg.startsWith('-') && existsSync(resolve(sessionCwd, arg)),
);

const environmentSessionId = process.env.OPENCODE_SESSION_ID || '';
const sessionId =
  (sessionIdPattern.test(environmentSessionId) ? environmentSessionId : '') ||
  findOpenCodeSessionIdForCwd(sessionCwd) ||
  '';
const codiffCommand = getCodiffCommand();
const args = [
  ...codiffCommand.args,
  '-w',
  '--agent',
  'opencode',
  '--walkthrough-file',
  walkthroughFilePath,
  ...(sessionId ? ['--opencode-session', sessionId] : []),
  ...forwardedArgs,
  ...(hasRepositoryTarget ? [] : [sessionCwd]),
];
const result = spawnSync(codiffCommand.command, args, {
  encoding: 'utf8',
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 0);
