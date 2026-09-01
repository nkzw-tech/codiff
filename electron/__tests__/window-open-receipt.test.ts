import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { registerWindowOpenReceipt } = require('../window-open-receipt.cjs') as {
  registerWindowOpenReceipt: (
    window: { once: (event: string, listener: () => void) => void; show: () => void },
    launchOptions: {
      agentReview?: { deliveryId: string; sessionId: string };
      agentReviewOpenFile?: string;
    },
  ) => void;
};

test('publishes the matching receipt only after the window is ready to show', async () => {
  await using directory = await createTemporaryDirectory('codiff-window-open-receipt-');
  const openFile = join(directory.path, 'open.json');
  let readyToShow: (() => void) | undefined;
  let shown = false;

  registerWindowOpenReceipt(
    {
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
  );

  await expect(readFile(openFile, 'utf8')).rejects.toThrow();
  readyToShow?.();

  expect(shown).toBe(true);
  await expect(readFile(openFile, 'utf8').then(JSON.parse)).resolves.toEqual({
    deliveryAvailable: true,
    deliveryId: 'delivery-1',
    status: 'open',
    version: 1,
  });
});
