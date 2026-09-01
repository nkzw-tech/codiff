#!/usr/bin/env node

// Launcher for the Codiff `codiff` skill (Pi). The agent has already authored a
// narrative walkthrough JSON file; this just opens Codiff pointed at it, passing the
// Pi session id so follow-up questions reuse the conversation.
//
// Usage:
//   node scripts/open-codiff.mjs --file <path> [target]
//   node scripts/open-codiff.mjs --plan <path> [repository]
//
// `--file <path>` is forwarded to Codiff as `--walkthrough-file`. Any non-flag target
// (commit, HEAD, PR number, or repository path) is forwarded verbatim; when no repository
// path is given the session's working directory is used.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { runAgentReviewLauncher } from '../../../../bin/agent-review-launch.js';

const threadId = process.env.PI_SESSION_ID || '';
const skillRoot = resolve(import.meta.dirname, '..');
const codiffRoot = resolve(skillRoot, '../../..');
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const getPiSessionId = () => (sessionIdPattern.test(threadId) ? threadId : '');

const getFallbackSessionCwd = () => {
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

// `--guide`: print Codiff's current walkthrough authoring guide and exit. The
// guidance lives in Codiff (not this skill), so it stays current across updates.
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

// Pull `--file <path>` (or `--file=<path>`) out of the forwarded arguments.
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

const sessionCwd = getFallbackSessionCwd();

if (planFile && shareWalkthrough) {
  const planFilePath = resolve(sessionCwd, planFile);
  if (!existsSync(planFilePath) || !/\.md$/i.test(planFilePath)) {
    process.stderr.write(`open-codiff: plan file not found at ${planFilePath}.\n`);
    process.exit(1);
  }
  const resolvedSessionId = getPiSessionId();
  const shareCommand = getShareCommand();
  const shareResult = spawnSync(
    shareCommand.command,
    [
      ...shareCommand.args,
      '--plan',
      planFilePath,
      '--agent',
      'pi',
      ...(resolvedSessionId ? ['--pi-session', resolvedSessionId] : []),
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
  const resolvedSessionId = getPiSessionId();
  const codiffCommand = getCodiffCommand();
  const result = spawnSync(
    codiffCommand.command,
    [
      ...codiffCommand.args,
      '--plan',
      planFilePath,
      '--agent',
      'pi',
      ...(resolvedSessionId ? ['--pi-session', resolvedSessionId] : []),
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
      'pi',
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

const resolvedSessionId = getPiSessionId();
if (!resolvedSessionId) {
  process.stderr.write(
    'open-codiff: exact Pi session identity is unavailable; restart Pi after installing the Codiff integration.\n',
  );
  process.exit(1);
}
const codiffCommand = getCodiffCommand();
const args = [
  ...codiffCommand.args,
  '-w',
  '--agent',
  'pi',
  '--walkthrough-file',
  walkthroughFilePath,
  ...(resolvedSessionId ? ['--pi-session', resolvedSessionId] : []),
  ...forwardedArgs,
  ...(hasRepositoryTarget ? [] : [sessionCwd]),
];
let exitCode = 0;
try {
  process.stdout.write(
    runAgentReviewLauncher({
      args,
      command: codiffCommand.command,
    }),
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}

process.exitCode = exitCode;
