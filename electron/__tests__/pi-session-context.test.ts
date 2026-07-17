import { appendFile, mkdir, truncate, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { readPiSessionContext } = require('../pi-session-context.cjs') as {
  readPiSessionContext: (sessionId?: string) => Promise<{
    messages?: ReadonlyArray<{ role: 'assistant' | 'user'; text: string }>;
    risks?: ReadonlyArray<string>;
    source: { threadId?: string; type: string };
    version: 1;
  } | null>;
};

const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';

test('extracts bounded readable messages from Pi session jsonl', async () => {
  await using directory = await createTemporaryDirectory('codiff-pi-session-');
  const sessionDirectory = join(directory.path, 'agent', 'sessions', 'repo');
  const sessionPath = join(sessionDirectory, `${sessionId}.jsonl`);
  await using _environment = createTemporaryEnvironment({ PI_HOME: directory.path });

  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    sessionPath,
    [
      JSON.stringify({ type: 'session' }),
      JSON.stringify({
        message: {
          content: [{ text: 'Implement walkthrough session handoff.', type: 'text' }],
          role: 'user',
        },
        type: 'message',
      }),
      JSON.stringify({
        message: {
          content: [
            { thinking: 'planning', type: 'thinking' },
            { text: 'Updated the Pi skill handoff.', type: 'text' },
          ],
          role: 'assistant',
        },
        type: 'message',
      }),
      JSON.stringify({
        message: { content: [{ text: '/codiff', type: 'text' }], role: 'user' },
        type: 'message',
      }),
    ].join('\n'),
  );

  await expect(readPiSessionContext(sessionId)).resolves.toMatchObject({
    messages: [
      { role: 'user', text: 'Implement walkthrough session handoff.' },
      { role: 'assistant', text: 'Updated the Pi skill handoff.' },
    ],
  });
});

test('finds the active Pi session under PI_HOME', async () => {
  await using directory = await createTemporaryDirectory('codiff-pi-home-');
  await using _environment = createTemporaryEnvironment({ PI_HOME: directory.path });

  const sessionDirectory = join(directory.path, 'agent', 'sessions', 'encoded-repo');
  const sessionPath = join(sessionDirectory, `2026-06-10_${sessionId}.jsonl`);
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      message: {
        content: [
          {
            text: 'Keep Codiff in charge of the ephemeral walkthrough.',
            type: 'text',
          },
        ],
        role: 'user',
      },
      type: 'message',
    })}\n`,
  );

  await expect(readPiSessionContext(sessionId)).resolves.toMatchObject({
    messages: [
      {
        role: 'user',
        text: 'Keep Codiff in charge of the ephemeral walkthrough.',
      },
    ],
    source: {
      threadId: sessionId,
      type: 'pi-session-excerpt',
    },
    version: 1,
  });
});

test('ignores invalid Pi session ids', async () => {
  await expect(readPiSessionContext('../../sessions')).resolves.toBeNull();
});

test('reads recent Pi messages from a large session without loading the whole file', async () => {
  await using directory = await createTemporaryDirectory('codiff-pi-large-session-');
  const sessionDirectory = join(directory.path, 'agent', 'sessions', 'repo');
  const sessionPath = join(sessionDirectory, `${sessionId}.jsonl`);
  await using _environment = createTemporaryEnvironment({ PI_HOME: directory.path });

  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(sessionPath, '');
  await truncate(sessionPath, 17 * 1024 * 1024);
  await appendFile(
    sessionPath,
    `\n${JSON.stringify({
      message: {
        content: [{ text: 'Newest bounded Pi message.', type: 'text' }],
        role: 'user',
      },
      type: 'message',
    })}\n`,
  );

  await expect(readPiSessionContext(sessionId)).resolves.toMatchObject({
    messages: [{ role: 'user', text: 'Newest bounded Pi message.' }],
  });
});
