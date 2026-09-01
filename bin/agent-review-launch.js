import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as setTimeoutPromise } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const createAgentReviewLaunch = () => {
  const directory = mkdtempSync(join(tmpdir(), 'codiff-review-open-'));
  return {
    [Symbol.asyncDispose]: async () => rmSync(directory, { force: true, recursive: true }),
    deliveryId: randomUUID(),
    directory,
    openFile: join(directory, 'open.json'),
  };
};

export const waitForAgentReviewOpen = async (
  openFile,
  deliveryId,
  { now = Date.now, openTimeoutMs = 15_000, pollIntervalMs = 50, wait = setTimeoutPromise } = {},
) => {
  const deadline = now() + openTimeoutMs;
  for (;;) {
    if (existsSync(openFile)) {
      const receipt = JSON.parse(readFileSync(openFile, 'utf8'));
      if (receipt?.version !== 1 || receipt.status !== 'open') {
        throw new Error('Codiff returned an invalid window-open receipt.');
      }
      if (receipt.deliveryId !== deliveryId) {
        throw new Error('Codiff window-open receipt has the wrong delivery ID.');
      }
      if (typeof receipt.deliveryAvailable !== 'boolean') {
        throw new Error('Codiff window-open receipt is missing delivery capability.');
      }
      return {
        deliveryAvailable: receipt.deliveryAvailable,
        ...(typeof receipt.reason === 'string' ? { reason: receipt.reason } : {}),
      };
    }
    if (now() >= deadline) {
      throw new Error('Codiff did not open the review within 15 seconds.');
    }
    await wait(pollIntervalMs);
  }
};

export const runAgentReviewLauncher = ({ args, command }) => {
  const launch = createAgentReviewLaunch();
  try {
    const result = spawnSync(
      command,
      [
        ...args,
        '--agent-review-delivery',
        launch.deliveryId,
        '--agent-review-open-file',
        launch.openFile,
      ],
      { encoding: 'utf8', stdio: ['inherit', 'ignore', 'inherit'] },
    );
    if (result.error) throw new Error(`Could not launch Codiff: ${result.error.message}`);
    if (result.signal)
      throw new Error(`Codiff terminated by signal ${result.signal} before opening.`);
    if (result.status !== 0) {
      const error = new Error(`Codiff exited with code ${result.status ?? 1} before opening.`);
      error.exitCode = result.status ?? 1;
      throw error;
    }
    return 'Codiff opened. Review feedback will arrive as a separate message in this session.\n';
  } finally {
    rmSync(launch.directory, { force: true, recursive: true });
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const openFile = process.argv[2];
  const deliveryId = process.argv[3];
  if (!openFile || !deliveryId) {
    process.stderr.write('codiff: expected an agent review open file and delivery ID.\n');
    process.exitCode = 1;
  } else {
    try {
      await waitForAgentReviewOpen(openFile, deliveryId);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
