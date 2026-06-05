#!/usr/bin/env node

// Launcher for the Codiff `walkthrough` skill (Codex). The agent has already authored a
// narrative walkthrough JSON file; this just opens Codiff pointed at it, passing the
// Codex thread id so follow-up questions reuse the conversation.
//
// Usage:
//   node scripts/open-codiff.mjs --file <path> [target]
//
// `--file <path>` is forwarded to Codiff as `--walkthrough-file`. Any non-flag target
// (commit, HEAD, PR number, or repository path) is forwarded verbatim; when no repository
// path is given the session's working directory is used.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const threadId = process.env.CODEX_THREAD_ID || '';
const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const codiffRoot = resolve(skillRoot, '../../..');
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxSessionScanFiles = 20_000;

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

const getCodexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex');

const findCodexSessionFile = (sessionId) => {
  if (!sessionIdPattern.test(sessionId)) {
    return null;
  }

  const root = join(getCodexHome(), 'sessions');
  if (!existsSync(root)) {
    return null;
  }

  const stack = [root];
  let scanned = 0;
  while (stack.length > 0 && scanned < maxSessionScanFiles) {
    const directory = stack.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        b.name.localeCompare(a.name),
      );
    } catch {
      continue;
    }

    for (const entry of entries) {
      scanned += 1;
      const path = join(directory, entry.name);
      if (
        entry.isFile() &&
        path.endsWith('.jsonl') &&
        path.toLowerCase().includes(sessionId.toLowerCase())
      ) {
        return path;
      }
      if (entry.isDirectory()) {
        stack.push(path);
      }
      if (scanned >= maxSessionScanFiles) {
        break;
      }
    }
  }

  return null;
};

const readSessionCwd = (sessionId) => {
  const sessionPath = findCodexSessionFile(sessionId);
  if (!sessionPath) {
    return null;
  }

  let cwd = null;
  for (const line of readFileSync(sessionPath, 'utf8').split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const item = JSON.parse(line);
      const value = item?.payload?.cwd || item?.cwd;
      if (item?.type === 'turn_context' && typeof value === 'string' && value) {
        cwd = value;
      }
    } catch {
      // Ignore future-format or malformed session records.
    }
  }

  return cwd;
};

const rawArgs = process.argv.slice(2);

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
  forwardedArgs.push(arg);
}

if (!walkthroughFile) {
  process.stderr.write('open-codiff: missing --file <path> to the walkthrough JSON.\n');
  process.exit(1);
}

const sessionCwd = process.env.CODEX_SESSION_CWD || readSessionCwd(threadId) || process.cwd();
const walkthroughFilePath = resolve(sessionCwd, walkthroughFile);
if (!existsSync(walkthroughFilePath)) {
  process.stderr.write(`open-codiff: walkthrough file not found at ${walkthroughFilePath}.\n`);
  process.exit(1);
}

const hasRepositoryTarget = forwardedArgs.some(
  (arg) => !arg.startsWith('-') && existsSync(resolve(sessionCwd, arg)),
);

const codiffCommand = getCodiffCommand();
const args = [
  ...codiffCommand.args,
  '-w',
  '--walkthrough-file',
  walkthroughFilePath,
  ...(threadId ? ['--codex-session', threadId] : []),
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
