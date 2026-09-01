import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { registerWindowOpenReceipt } = require('../window-open-receipt.cjs') as {
  registerWindowOpenReceipt: (
    window: {
      destroy: () => void;
      isDestroyed: () => boolean;
      once: (event: string, listener: () => Promise<void>) => void;
      show: () => void;
    },
    launchOptions: {
      agentReview?: { deliveryId: string; sessionId: string };
      agentReviewOpenFile?: string;
    },
    capability: Promise<{ available: boolean; reason?: string }> | null,
  ) => void;
};

test('publishes the shared delivery preflight only after the window is ready to show', async () => {
  await using directory = await createTemporaryDirectory('codiff-window-open-receipt-');
  const openFile = join(directory.path, 'open.json');
  let readyToShow: (() => Promise<void>) | undefined;
  let shown = false;
  let resolveCapability!: (capability: { available: boolean; reason?: string }) => void;
  const capability = new Promise<{ available: boolean; reason?: string }>((resolve) => {
    resolveCapability = resolve;
  });

  registerWindowOpenReceipt(
    {
      destroy: () => {},
      isDestroyed: () => false,
      once: (event, listener) => {
        expect(event).toBe('ready-to-show');
        readyToShow = listener;
      },
      show: () => {
        shown = true;
      },
    },
    {
      agentReview: { deliveryId: 'delivery-1', sessionId: 'session-1' },
      agentReviewOpenFile: openFile,
    },
    capability,
  );

  await expect(readFile(openFile, 'utf8')).rejects.toThrow();
  const publish = readyToShow?.();

  expect(shown).toBe(true);
  await expect(readFile(openFile, 'utf8')).rejects.toThrow();
  resolveCapability({ available: false, reason: 'Adapter unavailable.' });
  await publish;
  await expect(readFile(openFile, 'utf8').then(JSON.parse)).resolves.toEqual({
    deliveryAvailable: false,
    deliveryId: 'delivery-1',
    reason: 'Adapter unavailable.',
    status: 'open',
    version: 1,
  });
});

test('destroys an unacknowledged window after the launcher removes its directory', async () => {
  await using directory = await createTemporaryDirectory('codiff-window-open-receipt-');
  const openFile = join(directory.path, 'open.json');
  let readyToShow: (() => Promise<void>) | undefined;
  let destroyed = false;

  registerWindowOpenReceipt(
    {
      destroy: () => {
        destroyed = true;
      },
      isDestroyed: () => destroyed,
      once: (_event, listener) => {
        readyToShow = listener;
      },
      show: () => {},
    },
    {
      agentReview: { deliveryId: 'delivery-1', sessionId: 'session-1' },
      agentReviewOpenFile: openFile,
    },
    Promise.resolve({ available: false }),
  );
  await rm(directory.path, { recursive: true });

  await expect(readyToShow?.()).resolves.toBeUndefined();
  expect(destroyed).toBe(true);
});

test('does not publish a receipt when the window closes during preflight', async () => {
  await using directory = await createTemporaryDirectory('codiff-window-open-receipt-');
  const openFile = join(directory.path, 'open.json');
  let destroyed = false;
  let readyToShow: (() => Promise<void>) | undefined;
  let resolveCapability!: (capability: { available: boolean }) => void;
  const capability = new Promise<{ available: boolean }>((resolve) => {
    resolveCapability = resolve;
  });

  registerWindowOpenReceipt(
    {
      destroy: () => {
        destroyed = true;
      },
      isDestroyed: () => destroyed,
      once: (_event, listener) => {
        readyToShow = listener;
      },
      show: () => {},
    },
    {
      agentReview: { deliveryId: 'delivery-1', sessionId: 'session-1' },
      agentReviewOpenFile: openFile,
    },
    capability,
  );

  const publish = readyToShow?.();
  destroyed = true;
  resolveCapability({ available: true });
  await publish;

  await expect(readFile(openFile, 'utf8')).rejects.toThrow();
});
