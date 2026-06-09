#!/usr/bin/env node

// Launcher for the Codiff `codiff` skill (Pi). The agent has already authored a
// narrative walkthrough JSON file; this just opens Codiff pointed at it, passing the
// Pi session id so follow-up questions reuse the conversation.
//
// Usage:
//   node scripts/open-codiff.mjs --file <path> [target]
//
// `--file <path>` is forwarded to Codiff as `--walkthrough-file`. Any non-flag target
// (commit, HEAD, PR number, or repository path) is forwarded verbatim; when no repository
// path is given the session's working directory is used.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const threadId = process.env.PI_SESSION_ID || '';
const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const codiffRoot = resolve(skillRoot, '../../..');
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

const getPiHome = () => process.env.PI_HOME || join(homedir(), '.pi');

/**
 * Pi stores sessions at ~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
 * Since Pi does not expose a PI_SESSION_ID env var, we scan the sessions directory
 * and match the cwd from the session header to the current working directory.
 *
 * @param {string} cwd
 * @returns {string | null}
 */
const findPiSessionIdForCwd = (cwd) => {
  const root = join(getPiHome(), 'agent', 'sessions');
  if (!existsSync(root)) {
    return null;
  }

  let scanned = 0;
  /** @type {Array<{sessionId: string; mtime: number}>} */
  const candidates = [];

  /** @type {Array<string>} */
  const stack = [root];
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
      if (entry.isFile() && path.endsWith('.jsonl')) {
        try {
          const firstLine = readFileSync(path, 'utf8').split('\n')[0];
          if (!firstLine) {
            continue;
          }
          const header = JSON.parse(firstLine);
          if (header?.type === 'session' && typeof header?.cwd === 'string' && header.cwd === cwd) {
            const stat = statSync(path);
            candidates.push({ mtime: stat.mtimeMs, sessionId: header.id });
          }
        } catch {
          // Ignore malformed or future-format records.
        }
      }

      if (entry.isDirectory()) {
        stack.push(path);
      }

      if (scanned >= maxSessionScanFiles) {
        break;
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // Pick the most recently modified session matching this cwd.
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].sessionId;
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

const sessionCwd = process.cwd();
const walkthroughFilePath = resolve(sessionCwd, walkthroughFile);
if (!existsSync(walkthroughFilePath)) {
  process.stderr.write(`open-codiff: walkthrough file not found at ${walkthroughFilePath}.\n`);
  process.exit(1);
}

const hasRepositoryTarget = forwardedArgs.some(
  (arg) => !arg.startsWith('-') && existsSync(resolve(sessionCwd, arg)),
);

const resolvedSessionId = threadId || findPiSessionIdForCwd(sessionCwd) || '';
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
const result = spawnSync(codiffCommand.command, args, {
  encoding: 'utf8',
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 0);
