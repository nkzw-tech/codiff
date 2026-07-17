import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';
import { createCommandTransport } from './helpers/command-transport.ts';

type CommandTransport = ReturnType<typeof createCommandTransport>['transport'];

const require = createRequire(import.meta.url);
const {
  DEFAULT_OPENCODE_MODEL,
  FALLBACK_OPENCODE_MODEL,
  OPENCODE_MODELS,
  OPENCODE_NOT_FOUND_CODE,
  OPENCODE_TIMEOUT_MS,
  getOpenCodeCommand,
  isOpenCodeNotFoundError,
  normalizeOpenCodeModel,
  renderOpenCodeCommand,
  runOpenCode,
} = require('../opencode.cjs') as {
  DEFAULT_OPENCODE_MODEL: string;
  FALLBACK_OPENCODE_MODEL: string;
  OPENCODE_MODELS: ReadonlyArray<{ id: string; label: string }>;
  OPENCODE_NOT_FOUND_CODE: string;
  OPENCODE_TIMEOUT_MS: number;
  getOpenCodeCommand: () => string;
  isOpenCodeNotFoundError: (error: unknown) => boolean;
  normalizeOpenCodeModel: (value: unknown) => string;
  renderOpenCodeCommand: (template: string, model: unknown) => string;
  runOpenCode: (
    repoRoot: string,
    prompt: string,
    schema: unknown,
    outputName?: string,
    timeoutMessage?: string,
    options?: {
      commandTransport?: CommandTransport;
      fallbackModel?: string;
      model?: string;
      onModelFallback?: (fallbackModel: string, originalModel: string) => void;
      onProgress?: (phase: string) => void;
    },
  ) => Promise<string>;
};

test('exposes selectable OpenCode models while keeping its configured default', () => {
  expect(DEFAULT_OPENCODE_MODEL).toBe('opencode-default');
  expect(FALLBACK_OPENCODE_MODEL).toBe(DEFAULT_OPENCODE_MODEL);
  expect(OPENCODE_TIMEOUT_MS).toBe(300_000);
  expect(OPENCODE_MODELS).toEqual([
    { id: DEFAULT_OPENCODE_MODEL, label: 'OpenCode configured default' },
    { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
  ]);
  expect(normalizeOpenCodeModel(DEFAULT_OPENCODE_MODEL)).toBe(DEFAULT_OPENCODE_MODEL);
  expect(normalizeOpenCodeModel('openai/gpt-5.5')).toBe('openai/gpt-5.5');
  expect(normalizeOpenCodeModel('custom-provider/custom-model')).toBe(
    'custom-provider/custom-model',
  );
  expect(normalizeOpenCodeModel('amazon-bedrock/anthropic.claude-sonnet-v1:0')).toBe(
    'amazon-bedrock/anthropic.claude-sonnet-v1:0',
  );
  expect(normalizeOpenCodeModel('ollama/gpt-oss:120b')).toBe('ollama/gpt-oss:120b');
  expect(normalizeOpenCodeModel('openrouter/deepseek/deepseek-r1:free')).toBe(
    'openrouter/deepseek/deepseek-r1:free',
  );
  expect(normalizeOpenCodeModel('../../sessions')).toBe(DEFAULT_OPENCODE_MODEL);
});

test('renders the selected model into the managed OpenCode command', () => {
  const template = '---\n{{CODIFF_OPENCODE_MODEL}}\n---\nRun Codiff.\n';

  expect(renderOpenCodeCommand(template, DEFAULT_OPENCODE_MODEL)).toBe('---\n\n---\nRun Codiff.\n');
  expect(renderOpenCodeCommand(template, 'anthropic/claude-sonnet-4-6')).toBe(
    '---\nmodel: anthropic/claude-sonnet-4-6\n---\nRun Codiff.\n',
  );
  expect(() => renderOpenCodeCommand('Run Codiff.\n', DEFAULT_OPENCODE_MODEL)).toThrow(
    'exactly one',
  );
  expect(() =>
    renderOpenCodeCommand(
      '{{CODIFF_OPENCODE_MODEL}}\n{{CODIFF_OPENCODE_MODEL}}\n',
      DEFAULT_OPENCODE_MODEL,
    ),
  ).toThrow('exactly one');
});

test('detects OpenCode-not-found errors and invalid overrides', async () => {
  expect(isOpenCodeNotFoundError({ code: OPENCODE_NOT_FOUND_CODE })).toBe(true);
  expect(isOpenCodeNotFoundError({ code: 'ENOENT' })).toBe(true);
  expect(isOpenCodeNotFoundError(new Error('other'))).toBe(false);

  await using _environment = createTemporaryEnvironment({
    CODIFF_OPENCODE_PATH: '/tmp/codiff-missing-opencode',
  });
  expect(() => getOpenCodeCommand()).toThrow('CODIFF_OPENCODE_PATH');
});

test('runs OpenCode as an external read-only call', async () => {
  let stdin = '';
  const { calls, transport } = createCommandTransport(({ close, stdin: input, stdout }) => {
    input.on('data', (chunk) => {
      stdin += chunk.toString();
    });
    input.on('finish', () => {
      stdout(
        `${JSON.stringify({
          part: { id: 'answer', text: '{"version":1}' },
          type: 'text',
        })}\n`,
      );
      close();
    });
  });

  await expect(
    runOpenCode(
      '/repo',
      'prompt',
      { required: ['version'], type: 'object' },
      undefined,
      undefined,
      {
        commandTransport: transport,
      },
    ),
  ).resolves.toBe('{"version":1}');

  expect(calls[0].args).toEqual([
    'run',
    '--format',
    'json',
    '--pure',
    '--agent',
    'build',
    '--dir',
    '/repo',
  ]);
  expect(JSON.parse(String(calls[0].options.env?.OPENCODE_PERMISSION))).toEqual({ '*': 'deny' });
  expect(stdin).toContain('prompt');
  expect(stdin).toContain('Follow this JSON Schema exactly');
  expect(stdin).toContain('"required":["version"]');
});

test('streams semantic progress from the OpenCode event server', async () => {
  await using directory = await createTemporaryDirectory('codiff-opencode-progress-');
  const fakeOpenCodePath = join(directory.path, 'opencode');
  const argsPath = join(directory.path, 'args.txt');
  const requestPath = join(directory.path, 'request.json');
  await using _environment = createTemporaryEnvironment({ CODIFF_OPENCODE_PATH: fakeOpenCodePath });

  await writeFile(
    fakeOpenCodePath,
    `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args) + '\\n');
if (args[0] !== 'serve') process.exit(2);
const port = Number(args.find((arg) => arg.startsWith('--port='))?.slice(7));
const sessionID = 'session-1';
let events;
const readBody = (request) => new Promise((resolve) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => resolve(body));
});
const sendEvent = (event) => {
  events.write('data: ' + JSON.stringify({ payload: event }) + '\\n\\n');
};
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'POST' && url.pathname === '/session') {
    const body = JSON.parse(await readBody(request));
    writeFileSync(${JSON.stringify(requestPath)}, JSON.stringify({ session: body }));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: sessionID }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/event') {
    events = response;
    response.writeHead(200, {
      'cache-control': 'no-cache',
      'content-type': 'text/event-stream',
    });
    response.flushHeaders();
    return;
  }
  if (request.method === 'POST' && url.pathname === '/session/' + sessionID + '/message') {
    const body = JSON.parse(await readBody(request));
    writeFileSync(
      ${JSON.stringify(requestPath)},
      JSON.stringify({ ...JSON.parse(require('node:fs').readFileSync(${JSON.stringify(requestPath)})), prompt: body }),
    );
    sendEvent({
      properties: {
        part: { messageID: 'user-1', type: 'text' },
        sessionID,
      },
      type: 'message.part.updated',
    });
    sendEvent({
      properties: {
        info: { id: 'assistant-1', role: 'assistant' },
        sessionID,
      },
      type: 'message.updated',
    });
    sendEvent({
      properties: {
        part: { messageID: 'assistant-1', type: 'step-start' },
        sessionID,
      },
      type: 'message.part.updated',
    });
    sendEvent({
      properties: {
        delta: '{"version":1}',
        field: 'text',
        messageID: 'assistant-1',
        partID: 'answer',
        sessionID,
      },
      type: 'message.part.delta',
    });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      info: { role: 'assistant' },
      parts: [{ id: 'answer', text: '{"version":1}', type: 'text' }],
    }));
    return;
  }
  if (request.method === 'DELETE' && url.pathname === '/session/' + sessionID) {
    response.end('{}');
    return;
  }
  response.statusCode = 404;
  response.end();
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write('opencode server listening on http://127.0.0.1:' + port + '\\n');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
  );
  await chmod(fakeOpenCodePath, 0o755);
  const phases: Array<string> = [];

  await expect(
    runOpenCode(
      directory.path,
      'prompt',
      { required: ['version'], type: 'object' },
      undefined,
      undefined,
      {
        onProgress: (phase) => phases.push(phase),
      },
    ),
  ).resolves.toBe('{"version":1}');

  expect(phases).toEqual(['agent-generation', 'response-received']);
  const calls = (await readFile(argsPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(calls).toEqual([expect.arrayContaining(['serve', '--pure', '--hostname=127.0.0.1'])]);
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  expect(request.session.permission).toEqual([{ action: 'deny', pattern: '*', permission: '*' }]);
  expect(request.prompt.parts[0].text).toContain('Follow this JSON Schema exactly');
  expect(request.prompt.tools).toEqual({});
});

test('falls back to OpenCode CLI JSON mode when event streaming is unavailable', async () => {
  const { calls, transport } = createCommandTransport((commandProcess) => {
    if (commandProcess.args[0] === 'serve') {
      queueMicrotask(() => {
        commandProcess.stderr('unknown command: serve');
        commandProcess.close(1);
      });
      return;
    }
    commandProcess.stdin.on('finish', () => {
      commandProcess.stdout(
        `${JSON.stringify({
          part: { id: 'answer', text: '{"version":1}' },
          type: 'text',
        })}\n`,
      );
      commandProcess.close();
    });
  });

  await expect(
    runOpenCode(
      '/repo',
      'prompt',
      { required: ['version'], type: 'object' },
      undefined,
      undefined,
      {
        commandTransport: transport,
        onProgress: () => {},
      },
    ),
  ).resolves.toBe('{"version":1}');

  expect(calls[0].args[0]).toBe('serve');
  expect(calls[1].args.slice(0, 3)).toEqual(['run', '--format', 'json']);
});

test('passes explicit models to OpenCode and falls back when they are unavailable', async () => {
  const { calls, transport } = createCommandTransport((commandProcess) => {
    commandProcess.stdin.on('finish', () => {
      if (commandProcess.args.includes('--model')) {
        commandProcess.stderr('Model not found: anthropic/claude-sonnet-4-6');
        commandProcess.close(1);
        return;
      }
      commandProcess.stdout(
        `${JSON.stringify({
          part: { id: 'answer', text: '{"version":1}' },
          type: 'text',
        })}\n`,
      );
      commandProcess.close();
    });
  });
  const fallbacks: Array<[string, string]> = [];

  await expect(
    runOpenCode(
      '/repo',
      'prompt',
      { required: ['version'], type: 'object' },
      undefined,
      undefined,
      {
        commandTransport: transport,
        fallbackModel: DEFAULT_OPENCODE_MODEL,
        model: 'anthropic/claude-sonnet-4-6',
        onModelFallback: (fallbackModel, originalModel) => {
          fallbacks.push([fallbackModel, originalModel]);
        },
      },
    ),
  ).resolves.toBe('{"version":1}');

  expect(calls).toHaveLength(2);
  expect(calls[0].args).toContain('anthropic/claude-sonnet-4-6');
  expect(calls[1].args).not.toContain('--model');
  expect(fallbacks).toEqual([[DEFAULT_OPENCODE_MODEL, 'anthropic/claude-sonnet-4-6']]);
});
