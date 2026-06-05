// @ts-check

// Create a git commit from a walkthrough's staging set. The renderer hands in the
// human-written subject, the agent-drafted body, and the repo-relative paths the
// reviewer chose to include. Only those paths are committed — any other staged
// changes are left untouched — so a reviewer can land part of a working tree.

const { git, gitBufferWithInput, validateRepositoryPath } = require('./git-state/common.cjs');

/**
 * @typedef {import('../src/types.ts').WalkthroughCommitRequest} WalkthroughCommitRequest
 * @typedef {import('../src/types.ts').WalkthroughCommitResult} WalkthroughCommitResult
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
    // Stage exactly the chosen paths (covers untracked files too), then commit
    // only those paths so previously-staged work on other files stays staged.
    await git(repoPath, ['add', '--', ...paths]);
    await gitBufferWithInput(repoPath, ['commit', '-F', '-', '--', ...paths], message);
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
