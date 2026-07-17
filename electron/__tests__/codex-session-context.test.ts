import { mkdir, open, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { readCodexSessionContext } = require('../codex-session-context.cjs') as {
  readCodexSessionContext: (sessionId?: string) => Promise<{
    messages?: ReadonlyArray<{ role: 'assistant' | 'user'; text: string }>;
    risks?: ReadonlyArray<string>;
    source: { threadId?: string; type: string };
    version: 1;
  } | null>;
};

const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';

test('extracts bounded readable messages from Codex session jsonl', async () => {
  await using directory = await createTemporaryDirectory('codiff-session-');
  const sessionDirectory = join(directory.path, 'sessions', '2026', '05', '25');
  const sessionPath = join(sessionDirectory, `rollout-${sessionId}.jsonl`);
  await using _environment = createTemporaryEnvironment({ CODEX_HOME: directory.path });

  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    sessionPath,
    [
      JSON.stringify({
        payload: {
          content: [{ text: 'Implement walkthrough session handoff.', type: 'input_text' }],
          role: 'user',
          type: 'message',
        },
        type: 'response_item',
      }),
      JSON.stringify({
        payload: {
          content: [{ text: 'Updated the CLI and skill handoff.', type: 'output_text' }],
          role: 'assistant',
          type: 'message',
        },
        type: 'response_item',
      }),
      JSON.stringify({
        payload: {
          content: [{ text: 'Internal developer instruction.', type: 'input_text' }],
          role: 'developer',
          type: 'message',
        },
        type: 'response_item',
      }),
      JSON.stringify({
        payload: {
          content: [{ text: '$codiff', type: 'input_text' }],
          role: 'user',
          type: 'message',
        },
        type: 'response_item',
      }),
    ].join('\n'),
  );

  await expect(readCodexSessionContext(sessionId)).resolves.toMatchObject({
    messages: [
      { role: 'user', text: 'Implement walkthrough session handoff.' },
      { role: 'assistant', text: 'Updated the CLI and skill handoff.' },
    ],
  });
});

test('finds the active Codex session under CODEX_HOME', async () => {
  await using directory = await createTemporaryDirectory('codiff-codex-home-');
  await using _environment = createTemporaryEnvironment({ CODEX_HOME: directory.path });

  const sessionDirectory = join(directory.path, 'sessions', '2026', '05', '25');
  const sessionPath = join(sessionDirectory, `rollout-${sessionId}.jsonl`);
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      payload: {
        content: [
          {
            text: 'Keep Codiff in charge of the ephemeral walkthrough.',
            type: 'input_text',
          },
        ],
        role: 'user',
        type: 'message',
      },
      type: 'response_item',
    })}\n`,
  );

  await expect(readCodexSessionContext(sessionId)).resolves.toMatchObject({
    messages: [
      {
        role: 'user',
        text: 'Keep Codiff in charge of the ephemeral walkthrough.',
      },
    ],
    source: {
      threadId: sessionId,
      type: 'codex-session-excerpt',
    },
    version: 1,
  });
});

test('searches newer Codex session directories first', async () => {
  await using directory = await createTemporaryDirectory('codiff-codex-session-order-');
  const olderDirectory = join(directory.path, 'sessions', '2025', '12', '31');
  const newerDirectory = join(directory.path, 'sessions', '2026', '01', '01');
  const olderPath = join(olderDirectory, `rollout-${sessionId}.jsonl`);
  const newerPath = join(newerDirectory, `rollout-${sessionId}.jsonl`);
  await using _environment = createTemporaryEnvironment({ CODEX_HOME: directory.path });

  await mkdir(olderDirectory, { recursive: true });
  await mkdir(newerDirectory, { recursive: true });
  await writeFile(
    olderPath,
    `${JSON.stringify({
      payload: {
        content: [{ text: 'Older message.', type: 'input_text' }],
        role: 'user',
        type: 'message',
      },
      type: 'response_item',
    })}\n`,
  );
  await writeFile(
    newerPath,
    `${JSON.stringify({
      payload: {
        content: [{ text: 'Newer message.', type: 'input_text' }],
        role: 'user',
        type: 'message',
      },
      type: 'response_item',
    })}\n`,
  );

  await expect(readCodexSessionContext(sessionId)).resolves.toMatchObject({
    messages: [{ role: 'user', text: 'Newer message.' }],
  });
});

test('reads recent Codex messages from a large session without loading the whole file', async () => {
  await using directory = await createTemporaryDirectory('codiff-codex-large-session-');
  const sessionDirectory = join(directory.path, 'sessions', '2026', '05', '25');
  const sessionPath = join(sessionDirectory, `rollout-${sessionId}.jsonl`);
  await using _environment = createTemporaryEnvironment({ CODEX_HOME: directory.path });

  await mkdir(sessionDirectory, { recursive: true });
  await using file = await open(sessionPath, 'w');
  await file.truncate(16 * 1024 * 1024 + 1);
  await file.write('\n', 0, 'utf8');
  await file.write(
    `${JSON.stringify({
      payload: {
        content: [{ text: 'Newest bounded Codex message.', type: 'input_text' }],
        role: 'user',
        type: 'message',
      },
      type: 'response_item',
    })}\n`,
    1,
    'utf8',
  );

  await expect(readCodexSessionContext(sessionId)).resolves.toMatchObject({
    messages: [{ role: 'user', text: 'Newest bounded Codex message.' }],
  });
});
