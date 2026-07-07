// @ts-check

// Create a git commit from a walkthrough's staging set. The renderer hands in the
// human-written subject, the agent-drafted body, and the repo-relative paths the
// reviewer chose to include. Only those paths are committed — any other staged
// changes are left untouched — so a reviewer can land part of a working tree.

const { accessSync, chmodSync, constants, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');

const pty = require('node-pty');

const { git, validateRepositoryPath } = require('./git-state/common.cjs');

/**
 * @typedef {import('../core/types.ts').WalkthroughCommitRequest} WalkthroughCommitRequest
 * @typedef {import('../core/types.ts').WalkthroughCommitResult} WalkthroughCommitResult
 */

// Cols must match the xterm instance in
// core/app/components/walkthrough/CommitView.tsx so hook output wraps where the
// renderer's terminal does.
const TERMINAL_COLS = 80;
const TERMINAL_ROWS = 24;

// pnpm drops the executable bit on node-pty's prebuilt macOS spawn-helper,
// which makes every pty.spawn fail with `posix_spawnp failed`.
const ensureSpawnHelperIsExecutable = () => {
  if (process.platform !== 'darwin') {
    return;
  }
  const helper = join(
    dirname(require.resolve('node-pty/package.json')),
    'prebuilds',
    `darwin-${process.arch}`,
    'spawn-helper',
  );
  try {
    accessSync(helper, constants.X_OK);
  } catch {
    try {
      chmodSync(helper, 0o755);
    } catch {
      // Fall through to pty.spawn, which reports the real failure.
    }
  }
};

/** Remove ANSI escape sequences (colors, cursor movement, OSC) from text. */
/** @param {string} text */
const stripAnsi = (text) =>
  text.replaceAll(
    // eslint-disable-next-line no-control-regex
    /\u001B(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[@-Z\\^_])/g,
    '',
  );

/** @param {string} text */
const normalizeTerminalOutput = (text) =>
  stripAnsi(text).replaceAll('\r\n', '\n').replaceAll('\r', '\n');

/**
 * Run `git commit` inside a pseudo-terminal, forwarding output chunks as they
 * arrive so the renderer can show pre-commit hook output live. The PTY makes
 * git and its hooks believe they are attached to a real terminal, so they emit
 * the same colors and progress output they would in a shell.
 *
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @param {((chunk: string) => void) | undefined} onOutput
 * @returns {Promise<void>}
 */
const gitStreaming = (repoPath, args, onOutput) =>
  new Promise((resolve, reject) => {
    ensureSpawnHelperIsExecutable();
    /** @type {import('node-pty').IPty} */
    let child;
    try {
      child = pty.spawn('git', ['-C', repoPath, ...args], {
        cols: TERMINAL_COLS,
        cwd: repoPath,
        env: process.env,
        name: 'xterm-256color',
        rows: TERMINAL_ROWS,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let combined = '';
    child.onData((chunk) => {
      combined += chunk;
      onOutput?.(chunk);
    });
    child.onExit(({ exitCode }) => {
      if (exitCode === 0) {
        resolve();
      } else {
        const output = normalizeTerminalOutput(combined).trim();
        reject(new Error(output || `git exited with status ${exitCode}`));
      }
    });
  });

/**
 * @param {string} repoPath Absolute repository root.
 * @param {WalkthroughCommitRequest} request
 * @param {(chunk: string) => void} [onOutput] Receives commit output (hook
 *   output included) as it is produced.
 * @returns {Promise<WalkthroughCommitResult>}
 */
const createWalkthroughCommit = async (repoPath, request, onOutput) => {
  const subject = typeof request?.subject === 'string' ? request.subject.trim() : '';
  if (!subject) {
    return { reason: 'A commit subject is required.', status: 'failed' };
  }

  // Each path is repo-relative; validateRepositoryPath rejects absolute paths and
  // `..` traversal, so a malformed document can't reach outside the repository.
  let paths;
  try {
    paths = [...new Set((Array.isArray(request?.paths) ? request.paths : []).map(String))]
      .filter(Boolean)
      .map((path) => validateRepositoryPath(path));
  } catch {
    return { reason: 'A selected file path is invalid.', status: 'failed' };
  }
  if (paths.length === 0) {
    return { reason: 'Select at least one file to commit.', status: 'failed' };
  }

  const body = typeof request?.body === 'string' ? request.body.trim() : '';
  const message = body ? `${subject}\n\n${body}\n` : `${subject}\n`;

  try {
    // Stage exactly the chosen paths (covers untracked files too), then commit
    // only those paths so previously-staged work on other files stays staged.
    await git(repoPath, ['add', '--', ...paths]);
    const tempDirectory = mkdtempSync(join(tmpdir(), 'codiff-commit-message-'));
    const messagePath = join(tempDirectory, 'message.txt');
    try {
      writeFileSync(messagePath, message);
      await gitStreaming(repoPath, ['commit', '-F', messagePath, '--', ...paths], onOutput);
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
    const hash = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    return { hash, status: 'committed' };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: 'failed',
    };
  }
};

module.exports = { createWalkthroughCommit };
