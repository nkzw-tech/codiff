// @ts-check

// Create a commit from a walkthrough's staging set. The renderer hands in the
// human-written subject, the agent-drafted body, and the repo-relative paths the
// reviewer chose to include. Only those paths are committed — any other staged
// changes are left untouched — so a reviewer can land part of a working tree.

const { execFile } = require('node:child_process');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');
const { git, gitBufferWithInput, validateRepositoryPath } = require('./git-state/common.cjs');

const execFileAsync = promisify(execFile);

/**
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @returns {Promise<string>}
 */
const arc = async (repoPath, args) => {
  const { stdout } = await execFileAsync('arc', args, {
    cwd: repoPath,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
};

/** @param {string} raw */
const parseArcHead = (raw) => {
  const parsed = JSON.parse(raw);
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  return typeof first?.commit === 'string' ? first.commit : '';
};

/**
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} paths
 * @param {string} message
 * @returns {Promise<WalkthroughCommitResult>}
 */
const createArcWalkthroughCommit = async (repoPath, paths, message) => {
  const messageDirectory = await mkdtemp(join(tmpdir(), 'codiff-arc-commit-'));
  const messagePath = join(messageDirectory, 'message.txt');
  try {
    await writeFile(messagePath, message, 'utf8');
    await arc(repoPath, ['add', '--', ...paths]);
    await arc(repoPath, ['commit', '-F', messagePath, '--', ...paths]);
    const hash = parseArcHead(await arc(repoPath, ['log', '-n', '1', '--json']));
    return hash
      ? { hash, status: 'committed' }
      : { reason: 'Arc committed the change but did not return a commit hash.', status: 'failed' };
  } finally {
    await rm(messageDirectory, { force: true, recursive: true });
  }
};

/**
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} paths
 * @param {string} message
 * @returns {Promise<WalkthroughCommitResult>}
 */
const createGitWalkthroughCommit = async (repoPath, paths, message) => {
  await git(repoPath, ['add', '--', ...paths]);
  await gitBufferWithInput(repoPath, ['commit', '-F', '-', '--', ...paths], message);
  const hash = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  return { hash, status: 'committed' };
};

/**
 * @typedef {import('../core/types.ts').WalkthroughCommitRequest} WalkthroughCommitRequest
 * @typedef {import('../core/types.ts').WalkthroughCommitResult} WalkthroughCommitResult
 */

/**
 * @param {string} repoPath Absolute repository root.
 * @param {WalkthroughCommitRequest} request
 * @returns {Promise<WalkthroughCommitResult>}
 */
const createWalkthroughCommit = async (repoPath, request) => {
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
    if (request?.source?.type === 'arc-working-tree') {
      return await createArcWalkthroughCommit(repoPath, paths, message);
    }

    return await createGitWalkthroughCommit(repoPath, paths, message);
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: 'failed',
    };
  }
};

module.exports = { createWalkthroughCommit };
