import { chmod, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import process from 'node:process';
import { afterEach, expect, test } from 'vite-plus/test';
import { createTemporaryGitRepository } from './helpers/git-repository.ts';

const require = createRequire(import.meta.url);
const {
  configureCommandLog,
  disableCommandLog,
  flushCommandLog,
  recordCommandMilestone,
  runWithCommandAction,
  sanitizeArgs,
  startCommandAction,
  startCommandTiming,
} = require('../command-log.cjs') as {
  configureCommandLog: (logsDirectory: string) => string;
  disableCommandLog: () => void;
  flushCommandLog: () => Promise<void>;
  recordCommandMilestone: (name: string) => void;
  runWithCommandAction: <Value>(
    input: { command: string; details?: Record<string, unknown> },
    callback: () => Promise<Value>,
  ) => Promise<Value>;
  startCommandAction: (input: { command: string; details?: Record<string, unknown> }) => {
    cancel: () => void;
    run: <Value>(callback: () => Value) => Value;
    signal: AbortSignal;
  };
  sanitizeArgs: (args: ReadonlyArray<string>) => ReadonlyArray<string>;
  startCommandTiming: (input: {
    args?: ReadonlyArray<string>;
    command: string;
    cwd?: string;
    details?: Record<string, unknown>;
    kind?: 'action' | 'command';
  }) => { finish: (result?: { error?: unknown; exitCode?: number | null }) => void };
};
const { git } = require('../git-state/common.cjs') as {
  git: (
    repoPath: string,
    args: ReadonlyArray<string>,
    options?: { signal?: AbortSignal },
  ) => Promise<string>;
};

type CommandLogRecord = {
  args?: ReadonlyArray<string>;
  command?: string;
  details?: Record<string, unknown>;
  durationMs?: number;
  exitCode?: number;
  actionId?: number;
  event: 'finish' | 'milestone' | 'session-start' | 'start';
  id?: number;
  kind?: 'action' | 'command';
  loggerOverhead?: {
    averageRecordMs: number;
    sampleCount: number;
    totalMs: number;
  };
  status?: 'canceled' | 'error' | 'ok' | 'timeout';
};

type TemporaryGitRepository = Awaited<ReturnType<typeof createTemporaryGitRepository>>;

const temporaryRepositories: Array<TemporaryGitRepository> = [];

const createCommandLogRepository = async () => {
  const repository = await createTemporaryGitRepository('codiff-command-log-');
  temporaryRepositories.push(repository);
  return repository.path;
};

afterEach(async () => {
  await flushCommandLog();
  disableCommandLog();
  await Promise.all(
    temporaryRepositories.splice(0).map((repository) => repository[Symbol.asyncDispose]()),
  );
});

test('records action and Git command timings without affecting command results', async () => {
  const repository = await createCommandLogRepository();
  const path = configureCommandLog(repository);

  await runWithCommandAction(
    {
      command: 'review-load',
      details: { sourceType: 'pull-request' },
    },
    async () => {
      recordCommandMilestone('evidence-ready');
      await expect(git(repository, ['rev-parse', '--show-toplevel'])).resolves.toContain(
        'codiff-command-log-',
      );
      await expect(
        git(repository, ['rev-parse', '--verify', 'refs/codiff-tests/definitely-missing']),
      ).rejects.toThrow();
    },
  );
  await flushCommandLog();

  const records = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as CommandLogRecord);
  expect(records[0]).toEqual(
    expect.objectContaining({
      event: 'session-start',
      loggerOverhead: {
        averageRecordMs: expect.any(Number),
        sampleCount: 100,
        totalMs: expect.any(Number),
      },
    }),
  );
  expect(records[0]!.loggerOverhead!.averageRecordMs).toBeLessThan(1);

  const actionStart = records.find(
    (record) => record.event === 'start' && record.command === 'review-load',
  );
  expect(actionStart).toEqual(
    expect.objectContaining({
      details: { sourceType: 'pull-request' },
      kind: 'action',
    }),
  );
  expect(records).toContainEqual(
    expect.objectContaining({
      command: 'review-load',
      durationMs: expect.any(Number),
      event: 'finish',
      id: actionStart?.id,
      status: 'ok',
    }),
  );

  const gitStarts = records.filter(
    (record) => record.event === 'start' && record.command === 'git',
  );
  expect(gitStarts).toHaveLength(2);
  expect(gitStarts.every((record) => record.actionId === actionStart?.id)).toBe(true);
  expect(gitStarts[0]?.args).toEqual(expect.arrayContaining(['rev-parse', '--show-toplevel']));
  expect(records).toContainEqual(
    expect.objectContaining({
      command: 'git',
      durationMs: expect.any(Number),
      event: 'finish',
      exitCode: 0,
      id: gitStarts[0]?.id,
      status: 'ok',
    }),
  );
  expect(records).toContainEqual(
    expect.objectContaining({
      command: 'git',
      durationMs: expect.any(Number),
      event: 'finish',
      exitCode: expect.any(Number),
      id: gitStarts[1]?.id,
      status: 'error',
    }),
  );
});

test('records canceled Git commands at a standalone action boundary', async () => {
  const repository = await createCommandLogRepository();
  const path = configureCommandLog(repository);
  const controller = new AbortController();
  controller.abort();

  await expect(
    git(repository, ['rev-parse', '--show-toplevel'], { signal: controller.signal }),
  ).rejects.toThrow();
  await flushCommandLog();

  const records = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as CommandLogRecord);
  const commandStart = records.find(
    (record) => record.event === 'start' && record.command === 'git',
  );
  expect(commandStart?.actionId).toEqual(expect.any(Number));
  expect(records).toContainEqual(
    expect.objectContaining({
      actionId: commandStart?.actionId,
      command: 'git',
      event: 'finish',
      id: commandStart?.id,
      status: 'canceled',
    }),
  );
  expect(records).toContainEqual(
    expect.objectContaining({
      command: 'standalone-command',
      event: 'finish',
      id: commandStart?.actionId,
      status: 'canceled',
    }),
  );
});

test('cancels Git commands through their enclosing action signal', async () => {
  const repository = await createCommandLogRepository();
  const path = configureCommandLog(repository);
  const action = startCommandAction({ command: 'initial-load' });

  action.cancel();
  expect(action.signal.aborted).toBe(true);
  await expect(
    action.run(() => git(repository, ['rev-parse', '--show-toplevel'])),
  ).rejects.toMatchObject({ name: 'AbortError' });
  await flushCommandLog();

  const records = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as CommandLogRecord);
  const actionStart = records.find(
    (record) => record.event === 'start' && record.command === 'initial-load',
  );
  expect(records).toContainEqual(
    expect.objectContaining({
      actionId: actionStart?.id,
      command: 'git',
      event: 'finish',
      status: 'canceled',
    }),
  );
  expect(records).toContainEqual(
    expect.objectContaining({
      command: 'initial-load',
      event: 'finish',
      id: actionStart?.id,
      status: 'canceled',
    }),
  );
});

test('redacts inline headers, URL userinfo, arrays, and nested details', async () => {
  const secrets = [
    'header-secret',
    'inline-header-secret',
    'short-header-secret',
    'url-user-secret',
    'url-password-secret',
    'query-secret',
    'array-secret',
    'nested-secret',
  ];
  const args = sanitizeArgs([
    'api',
    '--header',
    'Authorization: Bearer header-secret',
    '--header=PRIVATE-TOKEN: inline-header-secret',
    '-HAuthorization: Bearer short-header-secret',
    'https://url-user-secret:url-password-secret@provider.example.test/path?private_token=query-secret&ref=main',
  ]);
  expect(JSON.stringify(args)).not.toContain(secrets.join('|'));
  for (const secret of secrets.slice(0, 6)) {
    expect(JSON.stringify(args)).not.toContain(secret);
  }

  const repository = await createCommandLogRepository();
  const path = configureCommandLog(repository);
  const timing = startCommandTiming({
    command: 'security-shape',
    details: {
      array: ['safe', { token: 'array-secret' }],
      nested: { authorization: 'nested-secret' },
    },
  });
  timing.finish();
  await flushCommandLog();
  const contents = await readFile(path, 'utf8');
  expect(contents).not.toContain('array-secret');
  expect(contents).not.toContain('nested-secret');
  expect(contents).toContain('[REDACTED]');
});

test('command log initialization is idempotent and waits for primary-instance ownership', async () => {
  const repository = await createCommandLogRepository();
  const path = configureCommandLog(repository);
  const timing = startCommandTiming({ command: 'primary-sentinel' });
  timing.finish();
  await flushCommandLog();
  expect(configureCommandLog(repository)).toBe(path);
  await flushCommandLog();
  const contents = await readFile(path, 'utf8');
  expect(contents.match(/"event":"session-start"/g)).toHaveLength(1);
  expect(contents).toContain('primary-sentinel');

  const mainSource = await readFile(new URL('../main.cjs', import.meta.url), 'utf8');
  expect(mainSource.indexOf('configureCommandLog(app.getPath')).toBeGreaterThan(
    mainSource.indexOf('app.requestSingleInstanceLock'),
  );
});

test('creates command logs with owner-only permissions under a permissive umask', async () => {
  if (process.platform === 'win32') {
    return;
  }
  const repository = await createCommandLogRepository();
  await chmod(repository, 0o777);
  const previousUmask = process.umask(0);
  let path = '';
  try {
    path = configureCommandLog(repository);
    await flushCommandLog();
  } finally {
    process.umask(previousUmask);
  }
  expect((await stat(repository)).mode & 0o077).toBe(0);
  expect((await stat(path)).mode & 0o077).toBe(0);
});
