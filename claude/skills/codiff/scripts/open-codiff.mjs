#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const threadId = process.env.CLAUDE_SESSION_ID || '';
const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const codiffRoot = resolve(skillRoot, '../../..');
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxSessionScanFiles = 20_000;

const getCodiffCommand = () => {
  if (process.env.CODIFF_COMMAND) {
    return {
      args: [],
      command: process.env.CODIFF_COMMAND,
    };
  }

  const appCli = join(codiffRoot, 'bin/codiff-app');
  if (
    process.platform === 'darwin' &&
    codiffRoot.includes('.app/Contents/Resources/app') &&
    existsSync(appCli)
  ) {
    return {
      args: [],
      command: appCli,
    };
  }

  const devCli = join(codiffRoot, 'bin/codiff.js');
  if (existsSync(devCli)) {
    return {
      args: [devCli],
      command: process.execPath,
    };
  }

  if (process.platform === 'darwin' && existsSync(appCli)) {
    return {
      args: [],
      command: appCli,
    };
  }

  return {
    args: [],
    command: 'codiff',
  };
};

const getClaudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

const findClaudeSessionFile = (sessionId) => {
  if (!sessionIdPattern.test(sessionId)) {
    return null;
  }

  const root = join(getClaudeHome(), 'projects');
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
      if (entry.isFile() && path.toLowerCase().endsWith(`${sessionId.toLowerCase()}.jsonl`)) {
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
  const sessionPath = findClaudeSessionFile(sessionId);
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
      if (typeof item?.cwd === 'string' && item.cwd) {
        cwd = item.cwd;
      }
    } catch {
      // Ignore future-format or malformed session records.
    }
  }

  return cwd;
};

const isPullRequestMarker = (arg) => /^(?:pr|pull-request)$/i.test(arg);

const isReviewSource = (arg) => {
  if (/^#?[1-9]\d*$/.test(arg)) {
    return true;
  }

  if (/^(?:HEAD|@)(?:(?:[~^]\d*)|\^\{[^}]+\}|@\{[^}]+\})*$/.test(arg)) {
    return true;
  }

  if (/^[0-9a-f]{4,64}$/i.test(arg)) {
    return true;
  }

  try {
    const url = new URL(arg);
    return (
      url.hostname.toLowerCase() === 'github.com' &&
      /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)
    );
  } catch {
    return /(?:\^|~|@\{[^}]+\})/.test(arg);
  }
};

const hasRepositoryTarget = (argv, baseCwd) => {
  const optionsWithValues = new Set([
    '--agent',
    '--claude-session',
    '--codex-session',
    '--commit',
    '--walkthrough-context',
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (optionsWithValues.has(arg)) {
      index += 1;
      continue;
    }

    if (arg.startsWith('-')) {
      continue;
    }

    if (isPullRequestMarker(arg)) {
      index += 1;
      continue;
    }

    if (isReviewSource(arg)) {
      continue;
    }

    if (existsSync(resolve(baseCwd, arg))) {
      return true;
    }
  }

  return false;
};

const codiffCommand = getCodiffCommand();
const forwardedArgs = process.argv.slice(2);
const sessionCwd = process.env.CLAUDE_SESSION_CWD || readSessionCwd(threadId) || process.cwd();
const args = [
  ...codiffCommand.args,
  '-w',
  '--agent',
  'claude',
  ...(threadId ? ['--claude-session', threadId] : []),
  ...forwardedArgs,
  ...(hasRepositoryTarget(forwardedArgs, sessionCwd) ? [] : [sessionCwd]),
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
