import { chmod, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { readOpenCodeSessionContext } = require('../opencode-session-context.cjs') as {
  readOpenCodeSessionContext: (sessionId?: string) => Promise<{
    messages?: ReadonlyArray<{ role: 'assistant' | 'user'; text: string }>;
    risks?: ReadonlyArray<string>;
    source: { threadId?: string; type: string };
    version: 1;
  } | null>;
};

const sessionId = 'ses_121b4816bffebMr9YE52O4870p';

test('reads the linked session through the OpenCode export command', async () => {
  await using directory = await createTemporaryDirectory('codiff-opencode-session-test-');
  const commandPath = join(directory.path, 'opencode');
  await using _environment = createTemporaryEnvironment({ CODIFF_OPENCODE_PATH: commandPath });

  await writeFile(
    commandPath,
    `#!/bin/sh
printf '%s' '${JSON.stringify({
      info: { id: sessionId },
      messages: [
        {
          info: { role: 'user' },
          parts: [{ text: 'Keep the creating session attached.', type: 'text' }],
        },
      ],
    })}'
`,
  );
  await chmod(commandPath, 0o755);

  await expect(readOpenCodeSessionContext(sessionId)).resolves.toMatchObject({
    messages: [{ role: 'user', text: 'Keep the creating session attached.' }],
    source: {
      threadId: sessionId,
      type: 'opencode-session-excerpt',
    },
    version: 1,
  });
});

test('does not block the event loop while OpenCode exports a session', async () => {
  await using directory = await createTemporaryDirectory('codiff-opencode-session-async-');
  const commandPath = join(directory.path, 'opencode');
  await using _environment = createTemporaryEnvironment({ CODIFF_OPENCODE_PATH: commandPath });

  await writeFile(
    commandPath,
    `#!/bin/sh
sleep 0.1
printf '%s' '${JSON.stringify({
      info: { id: sessionId },
      messages: [],
    })}'
`,
  );
  await chmod(commandPath, 0o755);

  let settled = false;
  const context = readOpenCodeSessionContext(sessionId).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  await context;
});

test('rejects invalid ids and mismatched session exports', async () => {
  await using directory = await createTemporaryDirectory('codiff-opencode-session-mismatch-');
  const commandPath = join(directory.path, 'opencode');
  await using _environment = createTemporaryEnvironment({ CODIFF_OPENCODE_PATH: commandPath });

  await writeFile(
    commandPath,
    `#!/bin/sh
printf '%s' '${JSON.stringify({
      info: { id: 'ses_differentSession123' },
      messages: [
        {
          info: { role: 'user' },
          parts: [{ text: 'Wrong session.', type: 'text' }],
        },
      ],
    })}'
`,
  );
  await chmod(commandPath, 0o755);

  await expect(readOpenCodeSessionContext('../../sessions')).resolves.toBeNull();
  await expect(readOpenCodeSessionContext(sessionId)).resolves.toMatchObject({
    messages: [],
    risks: ['Codiff could not find recent readable messages for the linked OpenCode session.'],
  });
});

test('rejects oversized OpenCode session exports', async () => {
  await using directory = await createTemporaryDirectory('codiff-opencode-session-large-');
  const commandPath = join(directory.path, 'opencode');
  await using _environment = createTemporaryEnvironment({ CODIFF_OPENCODE_PATH: commandPath });

  await writeFile(
    commandPath,
    `#!/bin/sh
printf '{"info":{"id":"${sessionId}"},"messages":[]}'
dd if=/dev/zero bs=1048576 count=17 2>/dev/null
`,
  );
  await chmod(commandPath, 0o755);

  await expect(readOpenCodeSessionContext(sessionId)).resolves.toMatchObject({
    messages: [],
    risks: ['Codiff could not find recent readable messages for the linked OpenCode session.'],
  });
});
