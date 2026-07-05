// @ts-check

// Create a git commit from a walkthrough's staging set. The renderer hands in the
// human-written subject, the agent-drafted body, and the repo-relative paths the
// reviewer chose to include. Only those paths are committed — any other staged
// changes are left untouched — so a reviewer can land part of a working tree.

const { spawn } = require('node:child_process');

const { git, validateRepositoryPath } = require('./git-state/common.cjs');

/**
 * @typedef {import('../core/types.ts').WalkthroughCommitRequest} WalkthroughCommitRequest
 * @typedef {import('../core/types.ts').WalkthroughCommitResult} WalkthroughCommitResult
 */

/**
 * Run `git commit`, forwarding stdout and stderr chunks as they arrive so the
 * renderer can show pre-commit hook output live. On failure the rejection
 * carries the full combined output — hooks write their diagnostics to stdout,
 * which stderr-only capture would drop.
 *
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @param {string} input
 * @param {((chunk: string) => void) | undefined} onOutput
 * @returns {Promise<void>}
 */
const gitStreaming = (repoPath, args, input, onOutput) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** @type {Array<Buffer>} */
    const combined = [];
    /** @param {Buffer} chunk */
    const forward = (chunk) => {
      combined.push(chunk);
      onOutput?.(chunk.toString('utf8'));
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const output = Buffer.concat(combined).toString('utf8').trim();
        reject(new Error(output || `git exited with status ${code}`));
      }
    });
    child.stdin.end(input);
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
    await gitStreaming(repoPath, ['commit', '-F', '-', '--', ...paths], message, onOutput);
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
