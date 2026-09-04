import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createWalkthroughProgressReporter } = require('../walkthrough-progress.cjs') as {
  createWalkthroughProgressReporter: (webContents: {
    isDestroyed: () => boolean;
    send: (channel: string, progress: unknown) => void;
  }) => (update: { phase: string; summary: string } | string) => void;
};

test('forwards repeated real progress events while the request is current', () => {
  let destroyed = false;
  let current = true;
  const send = vi.fn();
  const reportProgress = createWalkthroughProgressReporter(
    {
      isDestroyed: () => destroyed,
      send,
    },
    () => current,
  );

  reportProgress('response-received');
  reportProgress('response-received');

  expect(send.mock.calls).toEqual([
    ['codiff:walkthroughProgress', { phase: 'response-received' }],
    ['codiff:walkthroughProgress', { phase: 'response-received' }],
  ]);

  destroyed = true;
  reportProgress('agent-generation');
  expect(send).toHaveBeenCalledTimes(2);

  destroyed = false;
  current = false;
  reportProgress('agent-generation');
  expect(send).toHaveBeenCalledTimes(2);
});

test('forwards structured generation progress without provider fields', () => {
  const send = vi.fn();
  const reportProgress = createWalkthroughProgressReporter({
    isDestroyed: () => false,
    send,
  });
  const generation = {
    phase: 'generating-units',
    summary: 'Generating the second task.',
  };

  reportProgress(generation);

  expect(send).toHaveBeenCalledWith('codiff:walkthroughProgress', { generation });
});
