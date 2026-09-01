import { access, chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';
import {
  createAgentReviewLaunch,
  runAgentReviewLauncher,
  waitForAgentReviewOpen,
} from '../agent-review-launch.js';

test('returns after the matching window-open receipt', async () => {
  await using launch = createAgentReviewLaunch();
  const waiting = waitForAgentReviewOpen(launch.openFile, launch.deliveryId, {
    pollIntervalMs: 1,
  });
  await writeFile(
    launch.openFile,
    JSON.stringify({
      deliveryAvailable: true,
      deliveryId: launch.deliveryId,
      status: 'open',
      version: 1,
    }),
  );
  await expect(waiting).resolves.toMatchObject({ deliveryAvailable: true });
});

test('rejects a receipt for another delivery', async () => {
  await using launch = createAgentReviewLaunch();
  await writeFile(
    launch.openFile,
    JSON.stringify({
      deliveryAvailable: true,
      deliveryId: 'different',
      status: 'open',
      version: 1,
    }),
  );
  await expect(
    waitForAgentReviewOpen(launch.openFile, launch.deliveryId, { openTimeoutMs: 5 }),
  ).rejects.toThrow('delivery ID');
});

test.each([
  ['malformed JSON', '{'],
  ['unsupported version', JSON.stringify({ deliveryId: 'delivery', status: 'open', version: 2 })],
  ['wrong status', JSON.stringify({ deliveryId: 'delivery', status: 'closed', version: 1 })],
  [
    'missing delivery capability',
    JSON.stringify({ deliveryId: 'delivery', status: 'open', version: 1 }),
  ],
])('rejects a %s window-open receipt', async (_label, receipt) => {
  await using launch = createAgentReviewLaunch();
  await writeFile(launch.openFile, receipt.replace('delivery', launch.deliveryId));

  await expect(waitForAgentReviewOpen(launch.openFile, launch.deliveryId)).rejects.toThrow();
});

test('times out after the bounded 15-second open window', async () => {
  await using launch = createAgentReviewLaunch();
  let currentTime = 0;

  await expect(
    waitForAgentReviewOpen(launch.openFile, launch.deliveryId, {
      now: () => currentTime,
      pollIntervalMs: 50,
      wait: async (milliseconds) => {
        currentTime += milliseconds;
      },
    }),
  ).rejects.toThrow('Codiff did not open the review within 15 seconds.');
  expect(currentTime).toBe(15_000);
});

test.each([
  ['success', 0],
  ['child failure', 7],
])('launcher cleans up open receipt state after %s', async (_label, exitCode) => {
  await using directory = await createTemporaryDirectory('codiff-agent-review-launch-test-');
  const command = join(directory.path, 'codiff');
  const openFileLog = join(directory.path, 'open-file.txt');
  await using _environment = createTemporaryEnvironment({
    CODIFF_TEST_OPEN_FILE_LOG: openFileLog,
  });
  await writeFile(
    command,
    `#!/bin/sh
previous=""
for arg in "$@"; do
  if [ "$previous" = "--agent-review-open-file" ]; then
    printf '%s' "$arg" > "$CODIFF_TEST_OPEN_FILE_LOG"
  fi
  previous="$arg"
done
exit ${exitCode}
`,
  );
  await chmod(command, 0o755);

  if (exitCode === 0) {
    expect(runAgentReviewLauncher({ args: ['--walkthrough'], command })).toBe(
      'Codiff opened. Review feedback will arrive as a separate message in this session.\n',
    );
  } else {
    expect(() => runAgentReviewLauncher({ args: ['--walkthrough'], command })).toThrow(
      'Codiff exited with code 7 before opening.',
    );
  }

  const openFile = await readFile(openFileLog, 'utf8');
  await expect(access(dirname(openFile))).rejects.toThrow();
});
