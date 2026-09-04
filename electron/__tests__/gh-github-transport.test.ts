import { chmod, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createGhGitHubTransport } =
  require('../git-state/github-history/gh-github-transport.cjs') as {
    createGhGitHubTransport: (options: { repoRoot: string }) => {
      graphql: <T>(request: {
        maxBytes?: number;
        query: string;
        variables: Record<string, boolean | number | string | null>;
      }) => Promise<T>;
      request: <T>(request: {
        maxBytes?: number;
        method?: string;
        paginate?: boolean;
        path: string;
        query?: Record<string, boolean | number | string>;
      }) => Promise<T>;
      requestBuffer: (request: {
        accept?: string;
        maxBytes?: number;
        path: string;
        query?: Record<string, boolean | number | string>;
        signal?: AbortSignal;
      }) => Promise<Uint8Array>;
      requestText: (request: {
        accept?: string;
        maxBytes?: number;
        paginate?: boolean;
        path: string;
        query?: Record<string, boolean | number | string>;
      }) => Promise<string>;
    };
  };
const { configureCommandLog, disableCommandLog, flushCommandLog, startCommandAction } =
  require('../command-log.cjs') as {
    configureCommandLog: (logsDirectory: string) => string;
    disableCommandLog: () => void;
    flushCommandLog: () => Promise<void>;
    startCommandAction: (input: { command: string }) => {
      cancel: () => void;
      run: <Value>(callback: () => Value) => Value;
      signal: AbortSignal;
    };
  };

const previousGhPath = process.env.CODIFF_GH_PATH;
const previousCallsPath = process.env.CODIFF_GH_TEST_CALLS;

afterEach(async () => {
  await flushCommandLog();
  disableCommandLog();
  if (previousGhPath == null) delete process.env.CODIFF_GH_PATH;
  else process.env.CODIFF_GH_PATH = previousGhPath;
  if (previousCallsPath == null) delete process.env.CODIFF_GH_TEST_CALLS;
  else process.env.CODIFF_GH_TEST_CALLS = previousCallsPath;
});

test('createGhGitHubTransport terminates oversized JSON, text, binary, paginated, and GraphQL responses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-gh-transport-'));
  const fakeGhPath = join(directory, 'gh');
  const callsPath = join(directory, 'calls.txt');
  await writeFile(
    fakeGhPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.CODIFF_GH_TEST_CALLS, 'call\\n');
process.on('SIGTERM', () => {
  fs.appendFileSync(process.env.CODIFF_GH_TEST_CALLS, 'term\\n');
  process.exit(0);
});
const chunk = Buffer.alloc(16 * 1024, 120);
const write = () => {
  if (!process.stdout.write(chunk)) {
    process.stdout.once('drain', write);
    return;
  }
  setImmediate(write);
};
write();
`,
    'utf8',
  );
  await chmod(fakeGhPath, 0o755);
  process.env.CODIFF_GH_PATH = fakeGhPath;
  process.env.CODIFF_GH_TEST_CALLS = callsPath;

  const transport = createGhGitHubTransport({ repoRoot: directory });
  const results = await Promise.allSettled([
    transport.request({ maxBytes: 8, path: '/repos/nkzw-tech/codiff/pulls/1' }),
    transport.requestText({
      maxBytes: 8,
      path: '/repos/nkzw-tech/codiff/readme',
    }),
    transport.requestBuffer({
      maxBytes: 8,
      path: '/repos/nkzw-tech/codiff/git/blobs/deadbeef',
    }),
    transport.request({
      maxBytes: 8,
      paginate: true,
      path: '/repos/nkzw-tech/codiff/pulls/1/comments',
    }),
    transport.graphql({
      maxBytes: 8,
      query: 'query { viewer { login } }',
      variables: {},
    }),
  ]);

  expect(results).toHaveLength(5);
  for (const result of results) {
    expect(result).toMatchObject({
      reason: expect.objectContaining({
        message: 'gh api response exceeded the 8-byte safety limit.',
        name: 'ProviderOutputLimitError',
      }),
      status: 'rejected',
    });
  }
  const events = (await readFile(callsPath, 'utf8')).trim().split('\n');
  expect(events.filter((event) => event === 'call')).toHaveLength(5);
  expect(events.filter((event) => event === 'term')).toHaveLength(5);
});

test('createGhGitHubTransport enforces each response bound on one shared GET', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-gh-transport-'));
  const fakeGhPath = join(directory, 'gh');
  const callsPath = join(directory, 'calls.txt');
  await writeFile(
    fakeGhPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.CODIFF_GH_TEST_CALLS, 'call\\n');
setTimeout(() => process.stdout.write('[{"id":1}]'), 25);
`,
    'utf8',
  );
  await chmod(fakeGhPath, 0o755);
  process.env.CODIFF_GH_PATH = fakeGhPath;
  process.env.CODIFF_GH_TEST_CALLS = callsPath;

  const first = createGhGitHubTransport({ repoRoot: directory });
  const second = createGhGitHubTransport({ repoRoot: directory });
  const path = '/repos/nkzw-tech/codiff/pulls/1/comments';
  const [smallBound, largeBound] = await Promise.allSettled([
    first.request({ maxBytes: 2, paginate: true, path }),
    second.request({ maxBytes: 1024, paginate: true, path }),
  ]);

  expect(smallBound).toMatchObject({
    reason: expect.objectContaining({ name: 'ProviderOutputLimitError' }),
    status: 'rejected',
  });
  expect(largeBound).toEqual({ status: 'fulfilled', value: [{ id: 1 }] });
  expect((await readFile(callsPath, 'utf8')).trim()).toBe('call');
});

test('createGhGitHubTransport shares paginated GETs across aliases, page sizes, and response bounds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-gh-transport-'));
  const alias = `${directory}-alias`;
  const fakeGhPath = join(directory, 'gh');
  const callsPath = join(directory, 'calls.txt');
  await symlink(directory, alias);
  await writeFile(
    fakeGhPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.CODIFF_GH_TEST_CALLS, 'call\\n');
setTimeout(() => process.stdout.write('[]'), 25);
`,
    'utf8',
  );
  await chmod(fakeGhPath, 0o755);
  process.env.CODIFF_GH_PATH = fakeGhPath;
  process.env.CODIFF_GH_TEST_CALLS = callsPath;

  const first = createGhGitHubTransport({ repoRoot: directory });
  const second = createGhGitHubTransport({ repoRoot: alias });
  const path = '/repos/nkzw-tech/codiff/pulls/7/comments';
  await expect(
    Promise.all([
      first.request({ maxBytes: 8 * 1024 * 1024, paginate: true, path, query: { per_page: 100 } }),
      second.request({ maxBytes: 2 * 1024 * 1024, paginate: true, path, query: { per_page: 50 } }),
    ]),
  ).resolves.toEqual([[], []]);
  expect((await readFile(callsPath, 'utf8')).trim().split('\n')).toHaveLength(1);
});

test('createGhGitHubTransport preserves exact binary response bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-gh-transport-'));
  const fakeGhPath = join(directory, 'gh');
  await writeFile(
    fakeGhPath,
    `#!/usr/bin/env node
process.stdout.write(Buffer.from([0, 255, 10, 128]));
`,
    'utf8',
  );
  await chmod(fakeGhPath, 0o755);
  process.env.CODIFF_GH_PATH = fakeGhPath;

  const transport = createGhGitHubTransport({ repoRoot: directory });
  const bytes = await transport.requestBuffer({
    path: '/repos/nkzw-tech/codiff/git/blobs/deadbeef',
  });

  expect([...bytes]).toEqual([0, 255, 10, 128]);
});

test('createGhGitHubTransport flattens all paginated response documents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-gh-transport-'));
  const fakeGhPath = join(directory, 'gh');
  const callsPath = join(directory, 'calls.txt');
  await writeFile(
    fakeGhPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.CODIFF_GH_TEST_CALLS, 'call\\n');
process.stdout.write('[\\n  {"id": 1, "label": "nested } and \\\\"quoted\\\\" text"}\\n][{"id": 2}]');
`,
    'utf8',
  );
  await chmod(fakeGhPath, 0o755);
  process.env.CODIFF_GH_PATH = fakeGhPath;
  process.env.CODIFF_GH_TEST_CALLS = callsPath;

  const first = createGhGitHubTransport({ repoRoot: directory });
  const second = createGhGitHubTransport({ repoRoot: directory });
  const path = '/repos/nkzw-tech/codiff/issues';
  const pages = await Promise.all([
    first.request({ paginate: true, path }),
    second.request({ paginate: true, path }),
  ]);

  expect(pages).toEqual([
    [{ id: 1, label: 'nested } and "quoted" text' }, { id: 2 }],
    [{ id: 1, label: 'nested } and "quoted" text' }, { id: 2 }],
  ]);
  expect((await readFile(callsPath, 'utf8')).trim()).toBe('call');
});

test('createGhGitHubTransport inherits cancellation from its enclosing action', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-gh-transport-'));
  const fakeGhPath = join(directory, 'gh');
  await writeFile(
    fakeGhPath,
    `#!/usr/bin/env node
setInterval(() => {}, 1_000);
`,
    'utf8',
  );
  await chmod(fakeGhPath, 0o755);
  process.env.CODIFF_GH_PATH = fakeGhPath;
  const commandLogPath = configureCommandLog(directory);

  const transport = createGhGitHubTransport({ repoRoot: directory });
  const action = startCommandAction({ command: 'initial-load' });
  const pending = action.run(() =>
    transport.requestBuffer({
      path: '/repos/nkzw-tech/codiff/git/blobs/deadbeef',
    }),
  );
  setTimeout(() => action.cancel(), 25);

  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(action.signal.aborted).toBe(true);
  await flushCommandLog();
  const commandLog = (await readFile(commandLogPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const actionStart = commandLog.find(
    (record) => record.event === 'start' && record.command === 'initial-load',
  );
  const finishes = commandLog.filter(
    (record) => record.event === 'finish' && record.command === fakeGhPath,
  );
  expect(finishes).toEqual([
    expect.objectContaining({
      actionId: actionStart?.id,
      canceled: true,
      errorName: 'AbortError',
      status: 'canceled',
    }),
  ]);
});

test('createGhGitHubTransport records cancellation before spawning a provider process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-gh-transport-'));
  const fakeGhPath = join(directory, 'gh');
  await writeFile(fakeGhPath, '#!/usr/bin/env node\n', 'utf8');
  await chmod(fakeGhPath, 0o755);
  process.env.CODIFF_GH_PATH = fakeGhPath;
  const commandLogPath = configureCommandLog(directory);
  const controller = new AbortController();
  controller.abort();

  const transport = createGhGitHubTransport({ repoRoot: directory });
  await expect(
    transport.requestBuffer({
      path: '/repos/nkzw-tech/codiff/git/blobs/deadbeef',
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  await flushCommandLog();

  const commandLog = (await readFile(commandLogPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(
    commandLog.filter((record) => record.event === 'start' && record.command === fakeGhPath),
  ).toHaveLength(1);
  expect(commandLog).toContainEqual(
    expect.objectContaining({
      canceled: true,
      command: fakeGhPath,
      errorName: 'AbortError',
      event: 'finish',
      status: 'canceled',
    }),
  );
});
