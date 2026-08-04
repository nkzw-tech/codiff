import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';
import type { GenerationProfile } from '../../core/types.ts';

const require = createRequire(import.meta.url);
const { getAgent } = require('../agent.cjs') as { getAgent: (id: string) => any };
const { invokeWalkthroughModel, parseStructuredModelResponse } =
  require('../walkthrough-model-invocation.cjs') as {
    invokeWalkthroughModel: (input: any) => Promise<{
      generationMetadata: { model: string; profile: GenerationProfile };
      response: string;
    }>;
    parseStructuredModelResponse: (response: unknown) => unknown;
  };

const profile: GenerationProfile = {
  agent: 'codex',
  authoringVersion: 'format-neutral-test',
  modelCandidates: ['primary', 'intermediate', 'fallback'],
};

const agent = (run: (...args: Array<any>) => Promise<string>) => ({
  defaultTimeoutMs: 1_000,
  id: 'codex',
  normalizeModel: (value: unknown) => String(value),
  run,
});

test('records an actual intermediate fallback while preserving the complete candidate chain', async () => {
  const onModelFallback = vi.fn();
  const run = vi.fn(async (...args: Array<any>) => {
    expect(args[5]).toMatchObject({ fallbackModel: 'fallback', model: 'primary' });
    await args[5].onModelFallback('intermediate', 'primary');
    return '```json\n{"value":42}\n```';
  });

  const result = await invokeWalkthroughModel({
    agent: agent(run),
    agentOptions: { onModelFallback },
    generatedAt: () => '2026-08-04T00:00:00.000Z',
    profile,
    prompt: 'Explain the review.',
    repoRoot: '/repo',
    schema: { type: 'object' },
  });

  expect(result.generationMetadata).toMatchObject({ model: 'intermediate', profile });
  expect(onModelFallback).toHaveBeenCalledWith('intermediate', 'primary');
  expect(parseStructuredModelResponse(result.response)).toEqual({ value: 42 });
});

test('cancels publication while a model invocation is still pending', async () => {
  const controller = new AbortController();
  const run = vi.fn(() => new Promise<string>(() => {}));
  const invocation = invokeWalkthroughModel({
    agent: agent(run),
    profile,
    prompt: 'Explain the review.',
    repoRoot: '/repo',
    schema: { type: 'object' },
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

  controller.abort(new Error('The review changed.'));

  await expect(invocation).rejects.toThrow('The review changed.');
});

test('aborting model invocation terminates the actual agent child process', async () => {
  let child: ReturnType<typeof spawn> | null = null;
  let resolveStarted!: (pid: number) => void;
  const started = new Promise<number>((resolve) => {
    resolveStarted = resolve;
  });
  let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = resolve;
  });
  const fixtureSource = `
    process.stdout.write(JSON.stringify({ pid: process.pid }) + '\\n');
    process.on('SIGTERM', () => process.exit(0));
    process.stdin.resume();
    setTimeout(() => process.exit(96), 4000);
  `;
  const commandTransport = {
    command: 'bounded-claude-fixture',
    spawn: (_command: string, _args: ReadonlyArray<string>, options: { signal?: AbortSignal }) => {
      child = spawn(process.execPath, ['-e', fixtureSource], {
        signal: options.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        output += chunk;
        const line = output.split('\n').find(Boolean);
        if (line) {
          resolveStarted((JSON.parse(line) as { pid: number }).pid);
        }
      });
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
      return child;
    },
  };
  const controller = new AbortController();
  const claudeAgent = getAgent('claude');
  const invocation = invokeWalkthroughModel({
    agent: claudeAgent,
    agentOptions: { commandTransport },
    profile: {
      agent: 'claude',
      authoringVersion: 'child-cancellation-test',
      modelCandidates: [claudeAgent.defaultModel],
    },
    prompt: 'Wait for cancellation.',
    repoRoot: '/repo',
    schema: { type: 'object' },
    signal: controller.signal,
    timeoutMs: 3500,
  });
  const pid = await started;
  controller.abort(new Error('The review changed.'));

  await expect(invocation).rejects.toThrow('The review changed.');
  await expect(exited).resolves.toMatchObject({ code: 0 });
  expect(child?.pid).toBe(pid);
  expect(child?.exitCode).not.toBeNull();
});
