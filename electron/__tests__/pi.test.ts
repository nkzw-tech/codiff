import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const piModule = require('../pi.cjs') as {
  DEFAULT_PI_MODEL: string;
  FALLBACK_PI_MODEL: string;
  PI_MODELS: ReadonlyArray<{ id: string; label: string }>;
  PI_NOT_FOUND_CODE: string;
  PI_NOT_FOUND_MESSAGE: string;
  getCachedPiModels: () => ReadonlyArray<{ id: string; label: string }>;
  getPiCommand: () => string;
  getPiModels: () => Promise<ReadonlyArray<{ id: string; label: string }>>;
  isPiInstalled: () => Promise<boolean>;
  isPiNotFoundError: (error: unknown) => boolean;
  normalizePiModel: (value: unknown) => string;
  runPi: (
    repoRoot: string,
    prompt: string,
    schema: unknown,
    outputName?: string,
    timeoutMessage?: string,
  ) => Promise<string>;
};

const {
  DEFAULT_PI_MODEL,
  FALLBACK_PI_MODEL,
  PI_MODELS,
  PI_NOT_FOUND_CODE,
  PI_NOT_FOUND_MESSAGE,
  getCachedPiModels,
  getPiCommand,
  isPiInstalled,
  isPiNotFoundError,
  normalizePiModel,
} = piModule;

test('exposes the Pi default model identifier', () => {
  expect(DEFAULT_PI_MODEL).toBe('pi-default');
  expect(FALLBACK_PI_MODEL).toBe('pi-default');
  expect(PI_NOT_FOUND_CODE).toBe('PI_NOT_FOUND');
  expect(typeof PI_NOT_FOUND_MESSAGE).toBe('string');
});

test('PI_MODELS proxy reflects the cached model list', () => {
  const cached = getCachedPiModels();
  expect(PI_MODELS.length).toBe(cached.length);
  for (let i = 0; i < cached.length; i += 1) {
    expect(PI_MODELS[i]).toEqual(cached[i]);
  }
  expect([...PI_MODELS]).toEqual([...cached]);
});

test('detects Pi-not-found errors by code', () => {
  expect(isPiNotFoundError({ code: PI_NOT_FOUND_CODE })).toBe(true);
  expect(isPiNotFoundError({ code: 'MODULE_NOT_FOUND' })).toBe(true);
  expect(isPiNotFoundError({ code: 'ENOENT' })).toBe(true);
  expect(isPiNotFoundError(new Error('other'))).toBe(false);
  expect(isPiNotFoundError(null)).toBe(false);
});

test('rejects invalid explicit Pi CLI overrides', () => {
  const previous = process.env.CODIFF_PI_PATH;
  process.env.CODIFF_PI_PATH = '/tmp/codiff-missing-pi';

  try {
    expect(() => getPiCommand()).toThrow('CODIFF_PI_PATH');
    try {
      getPiCommand();
    } catch (error) {
      expect(error).toMatchObject({ code: PI_NOT_FOUND_CODE });
    }
  } finally {
    if (previous == null) {
      delete process.env.CODIFF_PI_PATH;
    } else {
      process.env.CODIFF_PI_PATH = previous;
    }
  }
});

// Everything below depends on the Pi SDK being installed. The `isPiInstalled`
// probe reuses the same dynamic-import path that `runPi` walks, so it returns
// the same answer a real call would observe at runtime. When the SDK is
// missing we still keep the synchronous helpers above green and skip the
// integration-style assertions below.
const sdkInstalled = await isPiInstalled();

test.skipIf(!sdkInstalled)('isPiInstalled reports the SDK as installed', async () => {
  expect(await isPiInstalled()).toBe(true);
});

vi.mock('@earendil-works/pi-coding-agent', () => {
  const defineTool = (definition: unknown) => definition;
  return {
    AuthStorage: {
      create: () => ({}),
    },
    ModelRegistry: {
      create: () => ({
        getAvailable: () => [
          { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
          { provider: 'google', id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
        ],
        getAll: () => [
          { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
          { provider: 'google', id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
        ],
        find: (provider: string, id: string) => ({ provider, id, name: id }),
      }),
    },
    SessionManager: {
      inMemory: () => ({}),
    },
    createAgentSession: () =>
      Promise.resolve({
        session: {
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: '{"version":1,"headline":"Walkthrough is ready."}' }],
            },
          ],
          subscribe: () => () => {},
          prompt: () => Promise.resolve(),
          abort: () => Promise.resolve(),
          dispose: () => {},
        },
      }),
    defineTool,
  };
});

test.skipIf(!sdkInstalled)(
  'cached model list contains real registry entries after getPiModels resolves',
  async () => {
    const models = await piModule.getPiModels();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(typeof model.id).toBe('string');
      expect(model.id.length).toBeGreaterThan(0);
      expect(typeof model.label).toBe('string');
    }
  },
  15_000,
);

test.skipIf(!sdkInstalled)(
  'normalizes unknown Pi model preferences to the first real model',
  async () => {
    const models = await piModule.getPiModels();
    const firstRealId = models[0]?.id;
    if (!firstRealId) {
      throw new Error('Expected at least one real Pi model to be registered.');
    }
    expect(normalizePiModel(firstRealId)).toBe(firstRealId);
    // Unknown identifiers should fall back to the first real model, not the
    // placeholder, so the agent has a working default as soon as the registry
    // has been loaded.
    expect(normalizePiModel('no-such/model')).toBe(firstRealId);
    expect(normalizePiModel(undefined)).toBe(firstRealId);
  },
);
