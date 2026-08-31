import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
        head: source.head,
        symmetric: source.symmetric,
        type: source.type,
      };
    case 'pull-request':
      return { type: source.type, url: source.url };
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

export const readAgentReviewResult = (path, expectedRoot) => {
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

  return {
    comments: result.comments.map(normalizeComment),
    markdown: result.markdown,
    repository: {
      root: expectedRepositoryRoot,
      source: normalizeReviewSource(result.repository.source),
    },
    status: result.status,
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
    return formatAgentReviewResult(
      readAgentReviewResult(
        reviewResultPath.path,
        repositoryTarget ? resolve(sessionCwd, repositoryTarget) : sessionCwd,
      ),
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
  { pollIntervalMs = 50, processId = null } = {},
) => {
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

    try {
      const result = JSON.parse(readFileSync(path, 'utf8'));
      if (result?.status === 'submitted' || result?.status === 'closed') {
        return result;
      }
    } catch {}

    if (childExit || (processId != null && !isProcessRunning(processId))) {
      const detail = childExit?.signal
        ? ` (${childExit.signal})`
        : childExit?.code != null
          ? ` (code ${childExit.code})`
          : '';
      throw new Error(`Codiff exited without a review result${detail}.`);
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
