import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { beforeEach, expect, test, vi } from 'vite-plus/test';
import { createCommandTransport, type FakeCommandProcess } from './helpers/command-transport.ts';

const require = createRequire(import.meta.url);
const { readCodexModels } = require('../codex-models.cjs') as {
  readCodexModels: (options?: {
    commandTransport?: ReturnType<typeof createCommandTransport>['transport'];
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<
    ReadonlyArray<{ id: string; label: string; reasoningEfforts: ReadonlyArray<string> }>
  >;
};

type Request = {
  id?: number;
  method: string;
  params?: { cursor?: string; includeHidden?: boolean };
};

const createCatalogTransport = (
  onRequest: (request: Request, process: FakeCommandProcess) => void,
) =>
  createCommandTransport((process) => {
    const lines = createInterface({ input: process.stdin });
    lines.on('line', (line) => onRequest(JSON.parse(line), process));
  });

beforeEach(() => {
  const shell = process.env.SHELL;
  delete process.env.SHELL;
  return () => {
    if (shell === undefined) delete process.env.SHELL;
    else process.env.SHELL = shell;
  };
});

test('discovers every visible page with executable IDs and model-specific efforts', async () => {
  const requests: Request[] = [];
  const { calls, transport } = createCatalogTransport((request, process) => {
    requests.push(request);
    if (request.method === 'initialize') {
      process.stdout(`${JSON.stringify({ id: request.id, result: {} })}\n`);
    } else if (request.method === 'model/list') {
      const result = request.params?.cursor
        ? {
            data: [
              {
                model: 'gpt-6-luna',
                displayName: 'GPT-6 Luna',
                supportedReasoningEfforts: [
                  { reasoningEffort: 'low' },
                  { reasoningEffort: 'high' },
                ],
              },
            ],
            nextCursor: null,
          }
        : {
            data: [
              {
                id: 'picker-sol',
                model: 'gpt-6.1-sol',
                displayName: 'GPT-6.1 Sol',
                supportedReasoningEfforts: [
                  { reasoningEffort: 'high' },
                  { reasoningEffort: 'ultra' },
                  { reasoningEffort: 'high' },
                  null,
                ],
              },
              { model: 'hidden-model', hidden: true },
              { model: '' },
              null,
            ],
            nextCursor: 'page-2',
          };
      process.stdout(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  });
  await expect(readCodexModels({ commandTransport: transport })).resolves.toEqual([
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', reasoningEfforts: ['high', 'ultra'] },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', reasoningEfforts: ['low', 'high'] },
  ]);
  expect(requests.map((request) => request.method)).toEqual([
    'initialize',
    'initialized',
    'model/list',
    'model/list',
  ]);
  expect(
    requests.filter((request) => request.method === 'model/list').map((request) => request.params),
  ).toEqual([
    { limit: 100, includeHidden: false },
    { limit: 100, includeHidden: false, cursor: 'page-2' },
  ]);
  expect(calls[0].process.killed).toBe(true);
});

test.each([
  { result: { data: [], nextCursor: 'loop' }, error: 'repeated' },
  { result: { data: 'invalid', nextCursor: null }, error: 'invalid model catalog' },
])('rejects a broken catalog and terminates discovery: $error', async ({ result, error }) => {
  const { calls, transport } = createCatalogTransport((request, process) => {
    if (request.id != null)
      process.stdout(
        `${JSON.stringify({ id: request.id, result: request.method === 'initialize' ? {} : result })}\n`,
      );
  });
  await expect(readCodexModels({ commandTransport: transport })).rejects.toThrow(error);
  expect(calls[0].process.killed).toBe(true);
});

test('rejects an unsupported model/list method so callers can retain manual choices', async () => {
  const { calls, transport } = createCatalogTransport((request, process) => {
    if (request.method === 'initialize')
      process.stdout(`${JSON.stringify({ id: request.id, result: {} })}\n`);
    if (request.method === 'model/list')
      process.stdout(
        `${JSON.stringify({ id: request.id, error: { code: -32601, message: 'Method not found' } })}\n`,
      );
  });
  await expect(readCodexModels({ commandTransport: transport })).rejects.toThrow(
    'Method not found',
  );
  expect(calls[0].process.killed).toBe(true);
});

test('returns an empty catalog without inventing available models', async () => {
  const { transport } = createCatalogTransport((request, process) => {
    if (request.id != null)
      process.stdout(
        `${JSON.stringify({ id: request.id, result: request.method === 'initialize' ? {} : { data: [], nextCursor: null } })}\n`,
      );
  });
  await expect(readCodexModels({ commandTransport: transport })).resolves.toEqual([]);
});

test('escalates termination when the CLI does not close after SIGTERM', async () => {
  const signals: Array<string | number | undefined> = [];
  const { transport } = createCommandTransport((process) => {
    const kill = process.process.kill.bind(process.process);
    process.process.kill = (signal) => {
      signals.push(signal);
      return kill(signal);
    };
  });
  await expect(readCodexModels({ commandTransport: transport, timeoutMs: 10 })).rejects.toThrow(
    'timed out',
  );
  await vi.waitFor(() => expect(signals).toEqual(['SIGTERM', 'SIGKILL']));
});

test('times out an unresponsive CLI and kills its process', async () => {
  const { calls, transport } = createCommandTransport(() => {});
  await expect(readCodexModels({ commandTransport: transport, timeoutMs: 10 })).rejects.toThrow(
    'timed out',
  );
  expect(calls[0].process.killed).toBe(true);
});

test('cancels pending discovery when the application exits', async () => {
  const controller = new AbortController();
  const signals: Array<string | number | undefined> = [];
  const { calls, transport } = createCommandTransport((process) => {
    const kill = process.process.kill.bind(process.process);
    process.process.kill = (signal) => {
      signals.push(signal);
      return kill(signal);
    };
    process.stdin.on('data', () => controller.abort());
  });
  await expect(
    readCodexModels({ commandTransport: transport, signal: controller.signal }),
  ).rejects.toThrow('cancelled');
  expect(calls[0].process.killed).toBe(true);
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
});
