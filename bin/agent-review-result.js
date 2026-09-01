import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const require = createRequire(import.meta.url);
const { validateFeedback, validateReviewSource } = require('../electron/agent-review-handoff.cjs');
const { getRealPath, resolveRepositoryRoot } = require('../electron/window-identity.cjs');

export const createAgentReviewResultPath = () => {
  const directory = mkdtempSync(join(tmpdir(), 'codiff-review-result-'));
  return { directory, path: join(directory, 'result.json') };
};

export const cleanupAgentReviewResultPath = (directory) => {
  rmSync(directory, { force: true, recursive: true });
};

export const getAgentReviewOwnerPath = (path) => `${path}.owner`;

const invalidResult = (message) =>
  new Error(`Codiff returned an invalid review result: ${message.replace(/\.$/, '')}.`);

const normalizeReviewSource = (source) => {
  switch (source.type) {
    case 'working-tree':
      return { type: source.type };
    case 'branch':
    case 'commit':
      return { ref: source.ref, type: source.type };
    case 'branch-diff':
      return {
        baseRef: source.baseRef,
        headRef: source.headRef,
        ref: source.ref,
        type: source.type,
      };
    case 'branch-working-tree':
      return {
        ...(source.baseRef === undefined ? {} : { baseRef: source.baseRef }),
        ...(source.headRef === undefined ? {} : { headRef: source.headRef }),
        ref: source.ref,
        type: source.type,
      };
    case 'range':
      return {
        base: source.base,
        ...(source.baseSha === undefined ? {} : { baseSha: source.baseSha }),
        head: source.head,
        ...(source.headSha === undefined ? {} : { headSha: source.headSha }),
        symmetric: source.symmetric,
        type: source.type,
      };
    case 'pull-request':
      return {
        ...(source.headSha === undefined ? {} : { headSha: source.headSha }),
        ...(source.host === undefined ? {} : { host: source.host }),
        ...(source.number === undefined ? {} : { number: source.number }),
        ...(source.owner === undefined ? {} : { owner: source.owner }),
        ...(source.projectPath === undefined ? {} : { projectPath: source.projectPath }),
        ...(source.provider === undefined ? {} : { provider: source.provider }),
        ...(source.repo === undefined ? {} : { repo: source.repo }),
        type: source.type,
        url: source.url,
      };
  }
};

const normalizeComment = (comment) => ({
  anchor: comment.anchor,
  body: comment.body,
  context: comment.context,
  filePath: comment.filePath,
  ...(comment.lineNumber === undefined ? {} : { lineNumber: comment.lineNumber }),
  order: comment.order,
  sectionId: comment.sectionId,
  ...(comment.side === undefined ? {} : { side: comment.side }),
  ...(comment.startLineNumber === undefined ? {} : { startLineNumber: comment.startLineNumber }),
  ...(comment.startSide === undefined ? {} : { startSide: comment.startSide }),
});

export const readAgentReviewResult = (path, expectedRoot, expectedSource) => {
  let result;
  try {
    result = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw invalidResult(error instanceof Error ? error.message : 'the result could not be read');
  }

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw invalidResult('expected an object');
  }
  if (result.version !== 1) {
    throw invalidResult('expected version 1');
  }
  if (result.status !== 'submitted' && result.status !== 'closed') {
    throw invalidResult('expected status "submitted" or "closed"');
  }
  const expectedRepositoryRoot = resolveRepositoryRoot(expectedRoot);
  if (!result.repository || typeof result.repository !== 'object') {
    throw invalidResult('expected repository data');
  }
  if (typeof result.repository.root !== 'string') {
    throw invalidResult('expected a repository root');
  }
  const resultRepositoryRoot = getRealPath(result.repository.root);
  if (resultRepositoryRoot !== expectedRepositoryRoot) {
    throw invalidResult('repository root does not match the opened repository');
  }
  if (!Array.isArray(result.comments) || typeof result.markdown !== 'string') {
    throw invalidResult('expected comments and Markdown feedback');
  }
  if (result.status === 'closed' && (result.comments.length !== 0 || result.markdown !== '')) {
    throw invalidResult('closed results must not contain feedback');
  }
  if (
    result.status === 'submitted' &&
    (result.comments.length === 0 || result.markdown.trim().length === 0)
  ) {
    throw invalidResult('submitted results must contain comments and Markdown');
  }

  try {
    if (result.status === 'submitted') {
      validateFeedback(result);
    } else {
      if (typeof result.repository.root !== 'string' || result.repository.root.trim() === '') {
        throw new Error('Agent review feedback repository root must not be empty.');
      }
      validateReviewSource(result.repository.source);
    }
  } catch (error) {
    throw invalidResult(error instanceof Error ? error.message : 'validation failed');
  }

  const normalizedSource = normalizeReviewSource(result.repository.source);
  if (
    expectedSource !== undefined &&
    !isDeepStrictEqual(normalizedSource, normalizeReviewSource(expectedSource))
  ) {
    throw invalidResult('repository source does not match the opened review');
  }

  return {
    comments: result.comments.map(normalizeComment),
    markdown: result.markdown,
    repository: {
      root: expectedRepositoryRoot,
      source: normalizedSource,
    },
    status: result.status,
    version: 1,
  };
};

export const readAgentReviewOwner = (resultPath, expectedRoot) => {
  let owner;
  try {
    owner = JSON.parse(readFileSync(getAgentReviewOwnerPath(resultPath), 'utf8'));
  } catch (error) {
    throw invalidResult(error instanceof Error ? error.message : 'the owner could not be read');
  }
  if (
    owner?.version !== 1 ||
    owner.status !== 'open' ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.repository?.root !== 'string'
  ) {
    throw invalidResult('expected a live review owner');
  }
  const root = getRealPath(owner.repository.root);
  if (root !== resolveRepositoryRoot(expectedRoot)) {
    throw invalidResult('owner repository root does not match the opened repository');
  }
  try {
    validateReviewSource(owner.repository.source);
  } catch (error) {
    throw invalidResult(error instanceof Error ? error.message : 'owner validation failed');
  }
  return {
    pid: owner.pid,
    repository: { root, source: normalizeReviewSource(owner.repository.source) },
    status: 'open',
    version: 1,
  };
};

export const formatAgentReviewResult = (result) =>
  `CODIFF_REVIEW_RESULT ${JSON.stringify(result)}\n`;

export const runAgentReviewLauncher = ({ args, command, forwardedArgs, sessionCwd }) => {
  const reviewResultPath = createAgentReviewResultPath();
  try {
    const result = spawnSync(command, [...args, '--review-result-file', reviewResultPath.path], {
      encoding: 'utf8',
      stdio: ['inherit', 'ignore', 'inherit'],
    });
    if (result.error) {
      throw new Error(`Could not launch Codiff: ${result.error.message}`);
    }
    if (result.signal) {
      throw new Error(
        `Codiff terminated by signal ${result.signal} before returning review feedback.`,
      );
    }
    if (result.status !== 0) {
      const error = new Error(
        `Codiff exited with code ${result.status ?? 1} before returning review feedback.`,
      );
      error.exitCode = result.status ?? 1;
      throw error;
    }

    const repositoryTarget = forwardedArgs.find(
      (arg) => !arg.startsWith('-') && existsSync(resolve(sessionCwd, arg)),
    );
    const expectedRoot = repositoryTarget ? resolve(sessionCwd, repositoryTarget) : sessionCwd;
    const owner = readAgentReviewOwner(reviewResultPath.path, expectedRoot);
    return formatAgentReviewResult(
      readAgentReviewResult(reviewResultPath.path, expectedRoot, owner.repository.source),
    );
  } finally {
    cleanupAgentReviewResultPath(reviewResultPath.directory);
  }
};

const isProcessRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
};

export const waitForAgentReviewResult = async (
  path,
  child,
  {
    forwardingExitGraceMs = 1_000,
    isRunning = isProcessRunning,
    openTimeoutMs = 15_000,
    pollIntervalMs = 50,
    processId = /** @type {number | null} */ (null),
  } = {},
) => {
  const startedAt = Date.now();
  let lastResultError = null;
  let ownerPid = null;
  let childError = null;
  let childExit = null;
  child?.once('error', (error) => {
    childError = error;
  });
  child?.once('exit', (code, signal) => {
    childExit = { code, signal };
  });
  if (child && (child.exitCode != null || child.signalCode != null)) {
    childExit = { code: child.exitCode, signal: child.signalCode };
  }

  for (;;) {
    if (childError) {
      throw childError;
    }

    const readTerminalResult = () => {
      const result = JSON.parse(readFileSync(path, 'utf8'));
      if (result?.status === 'submitted' || result?.status === 'closed') {
        return result;
      }
      return null;
    };
    try {
      const result = readTerminalResult();
      if (result) {
        return result;
      }
    } catch (error) {
      if (existsSync(path)) {
        lastResultError = error;
      }
    }

    try {
      const owner = JSON.parse(readFileSync(getAgentReviewOwnerPath(path), 'utf8'));
      if (owner?.status === 'open' && Number.isInteger(owner.pid) && owner.pid > 0) {
        ownerPid = owner.pid;
      }
    } catch {}

    const ownerExited = ownerPid != null && !isRunning(ownerPid);
    const forwardingExited = childExit || (processId != null && !isRunning(processId));
    if (ownerExited || (ownerPid == null && childExit && childExit.code !== 0)) {
      try {
        const result = readTerminalResult();
        if (result) {
          return result;
        }
      } catch (error) {
        if (existsSync(path)) {
          lastResultError = error;
        }
      }
      const detail = childExit?.signal
        ? ` (${childExit.signal})`
        : childExit?.code != null
          ? ` (code ${childExit.code})`
          : '';
      const diagnostic = lastResultError instanceof Error ? `: ${lastResultError.message}` : '';
      throw new Error(`Codiff exited without a review result${detail}${diagnostic}.`);
    }
    const ownerPublicationTimeoutMs = forwardingExited
      ? Math.min(openTimeoutMs, forwardingExitGraceMs)
      : openTimeoutMs;
    if (ownerPid == null && Date.now() - startedAt >= ownerPublicationTimeoutMs) {
      try {
        const result = readTerminalResult();
        if (result) {
          return result;
        }
      } catch (error) {
        if (existsSync(path)) {
          lastResultError = error;
        }
      }
      const diagnostic = lastResultError instanceof Error ? `: ${lastResultError.message}` : '';
      if (forwardingExited) {
        throw new Error(`Codiff exited without a review result${diagnostic}.`);
      }
      throw new Error(
        `Codiff did not open the review within ${ownerPublicationTimeoutMs / 1000} seconds${diagnostic}.`,
      );
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, pollIntervalMs));
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const resultPath = process.argv[2];
  const processId = Number(process.argv[3]);
  if (!resultPath || !Number.isInteger(processId) || processId <= 0) {
    process.stderr.write('codiff: expected an agent review result path and process id.\n');
    process.exitCode = 1;
  } else {
    try {
      await waitForAgentReviewResult(resultPath, null, { processId });
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
