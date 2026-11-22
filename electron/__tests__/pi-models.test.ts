import { createRequire } from 'node:module';
import { beforeEach, expect, test } from 'vite-plus/test';
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
  expect(calls[0].args).toEqual(['--list-models']);
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
