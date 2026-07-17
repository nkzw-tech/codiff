import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';
import { createCommandTransport, type FakeCommandProcess } from './helpers/command-transport.ts';

type CommandTransport = ReturnType<typeof createCommandTransport>['transport'];

const require = createRequire(import.meta.url);
const {
  CODEX_NOT_FOUND_CODE,
  DEFAULT_OPENAI_MODEL,
  getCodexCommand,
  normalizeOpenAIModel,
  runCodex,
} = require('../codex.cjs') as {
  CODEX_NOT_FOUND_CODE: string;
  DEFAULT_OPENAI_MODEL: string;
  getCodexCommand: () => string;
  normalizeOpenAIModel: (value: unknown) => string;
  runCodex: (
    repoRoot: string,
    prompt: string,
    schema: unknown,
    outputName?: string,
    timeoutMessage?: string,
    options?: {
      fallbackModel?: string;
      commandTransport?: CommandTransport;
      model?: string;
      onMetrics?: (metrics: {
        transport: string;
        usage?: {
          cachedInputTokens: number;
          inputTokens: number;
          outputTokens: number;
          reasoningOutputTokens: number;
          totalTokens: number;
        };
      }) => void;
      onModelFallback?: (fallbackModel: string, originalModel: string) => void;
      onProgress?: (phase: string) => void;
      reasoningEffort?: 'low' | 'medium' | 'high';
      timeoutMs?: number;
    },
  ) => Promise<string>;
};

const getArgumentValue = (args: ReadonlyArray<string>, name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const completeCodexExec = async (
  commandProcess: FakeCommandProcess,
  output = '{"version":1}',
  stdout = '',
) => {
  const outputPath = getArgumentValue(commandProcess.args, '--output-last-message');
  if (!outputPath) {
    throw new Error('Expected a Codex output path.');
  }
  await writeFile(outputPath, output);
  if (stdout) {
    commandProcess.stdout(stdout);
  }
  commandProcess.close();
};

test('normalizes OpenAI model preferences to known models', () => {
  expect(normalizeOpenAIModel('gpt-5.6-sol')).toBe('gpt-5.6-sol');
  expect(normalizeOpenAIModel('gpt-5.6-terra')).toBe('gpt-5.6-terra');
  expect(normalizeOpenAIModel('gpt-5.6-luna')).toBe('gpt-5.6-luna');
  expect(normalizeOpenAIModel('gpt-5.5')).toBe('gpt-5.5');
  expect(normalizeOpenAIModel('gpt-5.4-mini')).toBe(DEFAULT_OPENAI_MODEL);
  expect(normalizeOpenAIModel('gpt-5.3-codex')).toBe(DEFAULT_OPENAI_MODEL);
  expect(normalizeOpenAIModel('gpt-4o')).toBe(DEFAULT_OPENAI_MODEL);
});

test('rejects invalid explicit Codex CLI overrides', async () => {
  await using _environment = createTemporaryEnvironment({
    CODIFF_CODEX_PATH: '/tmp/codiff-missing-codex',
  });

  expect(() => getCodexCommand()).toThrow('CODIFF_CODEX_PATH');
  try {
    getCodexCommand();
  } catch (error) {
    expect(error).toMatchObject({ code: CODEX_NOT_FOUND_CODE });
  }
});

test.skipIf(process.platform !== 'darwin')(
  'explains macOS Codex CLI security blocks through runCodex',
  async () => {
    const { transport } = createCommandTransport(({ close, stderr, stdin }) => {
      stdin.on('finish', () => {
        stderr('"codex" was not opened because it contains malware.');
        close(1);
      });
    });

    await expect(
      runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
        commandTransport: transport,
      }),
    ).rejects.toThrow('Update Codex CLI');
  },
);

test('runs Codex walkthroughs as fresh ephemeral repository-scoped calls', async () => {
  const { calls, transport } = createCommandTransport((commandProcess) => {
    commandProcess.stdin.on('finish', () => void completeCodexExec(commandProcess));
  });

  await expect(
    runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
    }),
  ).resolves.toBe('{"version":1}');

  expect(calls[0].args).toContain('--ephemeral');
  expect(calls[0].args).toContain('--json');
  expect(calls[0].args).toContain('--cd');
  expect(calls[0].args).toContain('/repo');
  expect(calls[0].args).toContain('model_reasoning_effort="low"');
  expect(calls[0].args).not.toContain('resume');
});

test('retries unavailable GPT-5.6 models with model-specific reasoning', async () => {
  const attempts: Array<string> = [];
  const { transport } = createCommandTransport((commandProcess) => {
    commandProcess.stdin.on('finish', () => {
      const model = getArgumentValue(commandProcess.args, '-m') || '';
      const effort = getArgumentValue(commandProcess.args, '-c') || '';
      attempts.push(`${model}|${effort}`);
      if (model !== 'gpt-5.5') {
        commandProcess.stderr(`You do not have access to model ${model}.`);
        commandProcess.close(1);
      } else {
        void completeCodexExec(commandProcess);
      }
    });
  });
  const fallbacks: Array<[string, string]> = [];

  await expect(
    runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
      model: 'gpt-5.6-sol',
      onModelFallback: (fallbackModel, originalModel) => {
        fallbacks.push([fallbackModel, originalModel]);
      },
    }),
  ).resolves.toBe('{"version":1}');

  expect(attempts).toEqual([
    'gpt-5.6-sol|model_reasoning_effort="medium"',
    'gpt-5.6-terra|model_reasoning_effort="low"',
    'gpt-5.5|model_reasoning_effort="low"',
  ]);
  expect(fallbacks).toEqual([['gpt-5.5', 'gpt-5.6-sol']]);
});

test('streams Codex app-server reasoning and message deltas as semantic progress', async () => {
  await using directory = await createTemporaryDirectory('codiff-codex-progress-');
  const fakeCodexPath = join(directory.path, 'codex');
  const requestsPath = join(directory.path, 'requests.txt');
  await using _environment = createTemporaryEnvironment({ CODIFF_CODEX_PATH: fakeCodexPath });

  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const readline = require('node:readline');
const requestsPath = ${JSON.stringify(requestsPath)};
for (const arg of process.argv.slice(2)) {
  appendFileSync(requestsPath, JSON.stringify({ arg }) + '\\n');
}
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  appendFileSync(requestsPath, JSON.stringify({ message }) + '\\n');
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} });
  } else if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread-1' } } });
    send({ method: 'thread/started', params: { thread: { id: 'thread-1' } } });
  } else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } });
    send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
    send({
      method: 'item/started',
      params: { item: { id: 'reasoning-1', type: 'reasoning' } },
    });
    send({
      method: 'item/reasoning/summaryTextDelta',
      params: { delta: 'Reasoning privately.' },
    });
    send({
      method: 'item/agentMessage/delta',
      params: { delta: '{"version":' },
    });
    send({
      method: 'item/agentMessage/delta',
      params: { delta: '1}' },
    });
    send({
      method: 'item/completed',
      params: { item: { text: '{"version":1}', type: 'agentMessage' } },
    });
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          total: {
            cachedInputTokens: 80,
            inputTokens: 100,
            outputTokens: 25,
            reasoningOutputTokens: 10,
            totalTokens: 125,
          },
        },
      },
    });
    send({
      method: 'turn/completed',
      params: { turn: { items: [], status: 'completed' } },
    });
  }
});
`,
  );
  await chmod(fakeCodexPath, 0o755);
  const phases: Array<string> = [];
  const metrics: Array<any> = [];

  await expect(
    runCodex(directory.path, 'prompt', {}, 'walkthrough.json', 'Timed out.', {
      onProgress: (phase) => phases.push(phase),
      onMetrics: (value) => metrics.push(value),
    }),
  ).resolves.toBe('{"version":1}');

  expect(phases).toEqual([
    'agent-generation',
    'agent-generation',
    'agent-generation',
    'agent-generation',
    'response-received',
    'response-received',
    'response-received',
  ]);
  expect(metrics).toEqual([
    {
      transport: 'app-server',
      usage: {
        cachedInputTokens: 80,
        inputTokens: 100,
        outputTokens: 25,
        reasoningOutputTokens: 10,
        totalTokens: 125,
      },
    },
  ]);

  const records = (await readFile(requestsPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(records.filter((record) => record.arg).map((record) => record.arg)).toContain(
    'app-server',
  );
  const threadStart = records.find((record) => record.message?.method === 'thread/start').message;
  expect(threadStart.params).toMatchObject({
    approvalPolicy: 'never',
    cwd: directory.path,
    ephemeral: true,
    sandbox: 'read-only',
  });
  const turnStart = records.find((record) => record.message?.method === 'turn/start').message;
  expect(turnStart.params).toMatchObject({
    approvalPolicy: 'never',
    cwd: directory.path,
    effort: 'low',
    outputSchema: {},
    sandboxPolicy: {
      networkAccess: false,
      type: 'readOnly',
    },
    threadId: 'thread-1',
  });
});

test('reports Codex exec token usage for eval instrumentation', async () => {
  const { transport } = createCommandTransport((commandProcess) => {
    commandProcess.stdin.on(
      'finish',
      () =>
        void completeCodexExec(
          commandProcess,
          '{"version":1}',
          `${JSON.stringify({
            type: 'turn.completed',
            usage: {
              cached_input_tokens: 80,
              input_tokens: 100,
              output_tokens: 25,
              reasoning_output_tokens: 10,
            },
          })}\n`,
        ),
    );
  });
  const metrics: Array<any> = [];

  await expect(
    runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
      onMetrics: (value) => metrics.push(value),
    }),
  ).resolves.toBe('{"version":1}');

  expect(metrics).toEqual([
    {
      transport: 'exec',
      usage: {
        cachedInputTokens: 80,
        inputTokens: 100,
        outputTokens: 25,
        reasoningOutputTokens: 10,
        totalTokens: 125,
      },
    },
  ]);
});

test('falls back to codex exec when app-server is unavailable', async () => {
  const { transport } = createCommandTransport((commandProcess) => {
    if (commandProcess.args[0] === 'app-server') {
      queueMicrotask(() => {
        commandProcess.stderr("error: unrecognized subcommand 'app-server'");
        commandProcess.close(2);
      });
      return;
    }
    commandProcess.stdin.on('finish', () => void completeCodexExec(commandProcess));
  });

  await expect(
    runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
      onProgress: () => {},
    }),
  ).resolves.toBe('{"version":1}');
});

test('forwards per-call Codex reasoning effort overrides', async () => {
  const { calls, transport } = createCommandTransport((commandProcess) => {
    commandProcess.stdin.on('finish', () => void completeCodexExec(commandProcess));
  });

  await expect(
    runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
      reasoningEffort: 'low',
    }),
  ).resolves.toBe('{"version":1}');

  expect(calls[0].args).toContain('model_reasoning_effort="low"');
});

test('supports per-call Codex timeouts', async () => {
  const { transport } = createCommandTransport(() => {});
  await expect(
    runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
      timeoutMs: 10,
    }),
  ).rejects.toThrow('Timed out.');
});

test('surfaces structured Codex CLI errors without the full prompt stream', async () => {
  const { transport } = createCommandTransport(({ close, stderr, stdin, stdout }) => {
    stdin.on('finish', () => {
      stdout('user very long prompt that should not be shown\n');
      stderr('ERROR: {"type":"error","error":{"message":"Invalid schema for response_format."}}\n');
      close(1);
    });
  });

  let message = '';
  try {
    await runCodex('/repo', 'prompt', {}, 'walkthrough.json', 'Timed out.', {
      commandTransport: transport,
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain('Invalid schema for response_format.');
  expect(message).not.toContain('very long prompt');
});
