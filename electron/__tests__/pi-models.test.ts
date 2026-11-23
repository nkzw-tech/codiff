import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import { createCommandTransport } from './helpers/command-transport.ts';

const require = createRequire(import.meta.url);
const { createPiModelCatalogLoader, readPiModels } = require('../pi-models.cjs') as {
  createPiModelCatalogLoader: (options: {
    readModels: () => Promise<ReadonlyArray<{ id: string; label: string }>>;
    onModels: (models: ReadonlyArray<{ id: string; label: string }>) => void;
  }) => () => Promise<void>;
  readPiModels: (options?: {
    commandTransport?: ReturnType<typeof createCommandTransport>['transport'];
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<ReadonlyArray<{ id: string; label: string }>>;
};

beforeEach(() => {
  const shell = process.env.SHELL;
  delete process.env.SHELL;
  return () => {
    if (shell === undefined) delete process.env.SHELL;
    else process.env.SHELL = shell;
  };
});

afterEach(() => vi.useRealTimers());

test('loads only Pi CLI table rows, including a provider named provider', async () => {
  const { calls, transport } = createCommandTransport(({ close, stdin, stdout }) => {
    stdin.on('finish', () => {
      stdout(
        [
          'Pi login helper      /Users/example with two spaces in its path',
          'provider        model                       context  max-out  thinking  images',
          'provider        custom-model                64K      16K      no        no',
          'github-copilot  gpt-6.1-terra               272K     128K     yes       yes',
          'openrouter      openai/gpt-6.1-terra        272K     128K     yes       yes',
        ].join('\n'),
      );
      close();
    });
  });

  await expect(readPiModels({ commandTransport: transport })).resolves.toEqual([
    { id: 'pi-default', label: 'Pi default' },
    { id: 'provider/custom-model', label: 'provider/custom-model' },
    { id: 'github-copilot/gpt-6.1-terra', label: 'github-copilot/gpt-6.1-terra' },
    { id: 'openrouter/openai/gpt-6.1-terra', label: 'openrouter/openai/gpt-6.1-terra' },
  ]);
  expect(calls[0].args).toContain('--no-approve');
  expect(calls[0].args).toContain('--list-models');
});

test("waits for a model list that takes longer than Pi's 15-second lookup window", async () => {
  vi.useFakeTimers();
  const { transport } = createCommandTransport(({ close, stdin, stdout }) => {
    stdin.on('finish', () => {
      setTimeout(() => {
        stdout('provider        model\nslow-provider  slow-model');
        close();
      }, 16_000);
    });
  });

  const models = readPiModels({ commandTransport: transport });
  await vi.advanceTimersByTimeAsync(16_000);

  await expect(models).resolves.toContainEqual({
    id: 'slow-provider/slow-model',
    label: 'slow-provider/slow-model',
  });
});

test('retries a default-only catalog and caches the populated result', async () => {
  const defaultModels = [{ id: 'pi-default', label: 'Pi default' }];
  const availableModels = [
    ...defaultModels,
    { id: 'github-copilot/gpt-6.1-terra', label: 'github-copilot/gpt-6.1-terra' },
  ];
  let attempts = 0;
  const loadedModels: ReadonlyArray<{ id: string; label: string }>[] = [];
  const loadCatalog = createPiModelCatalogLoader({
    readModels: async () => {
      attempts += 1;
      return attempts === 1 ? defaultModels : availableModels;
    },
    onModels: (models) => loadedModels.push(models),
  });

  await loadCatalog();
  expect(loadedModels).toEqual([defaultModels]);
  await loadCatalog();
  expect(loadedModels).toEqual([defaultModels, availableModels]);
  await loadCatalog();
  expect(attempts).toBe(2);
});

test('retries Pi model discovery after a transient failure', async () => {
  const availableModels = [
    { id: 'pi-default', label: 'Pi default' },
    { id: 'github-copilot/gpt-6.1-terra', label: 'github-copilot/gpt-6.1-terra' },
  ];
  let attempts = 0;
  const loadedModels: ReadonlyArray<{ id: string; label: string }>[] = [];
  const loadCatalog = createPiModelCatalogLoader({
    readModels: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Pi model discovery timed out.');
      return availableModels;
    },
    onModels: (models) => loadedModels.push(models),
  });

  await loadCatalog();
  expect(loadedModels).toEqual([]);
  await loadCatalog();
  expect(loadedModels).toEqual([availableModels]);
  expect(attempts).toBe(2);
});

test('cancels pending Pi model discovery when requested', async () => {
  const controller = new AbortController();
  const { calls, transport } = createCommandTransport(({ stdin }) => {
    stdin.on('finish', () => controller.abort());
  });

  await expect(
    readPiModels({ commandTransport: transport, signal: controller.signal }),
  ).rejects.toThrow('cancelled');
  expect(calls[0].process.killed).toBe(true);
});
