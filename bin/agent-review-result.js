import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const createAgentReviewResultPath = () => {
  const directory = mkdtempSync(join(tmpdir(), 'codiff-review-result-'));
  return { directory, path: join(directory, 'result.json') };
};

export const cleanupAgentReviewResultPath = (directory) => {
  rmSync(directory, { force: true, recursive: true });
};

const invalidResult = (message) =>
  new Error(`Codiff returned an invalid review result: ${message}.`);

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
  if (
    !result.repository ||
    typeof result.repository !== 'object' ||
    typeof result.repository.root !== 'string' ||
    resolve(result.repository.root) !== resolve(expectedRoot)
  ) {
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

  return result;
};

export const formatAgentReviewResult = (result) =>
  `CODIFF_REVIEW_RESULT ${JSON.stringify(result)}\n`;

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
