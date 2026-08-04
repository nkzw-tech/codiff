import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createGlabGitLabTransport } = require('../git-state/glab-gitlab-transport.cjs') as {
  createGlabGitLabTransport: (options: { hostname: string; repoRoot: string }) => {
    request: <T>(request: {
      maxBytes?: number;
      method?: string;
      path: string;
      query?: Record<string, boolean | number | string>;
      body?: unknown;
    }) => Promise<T>;
    requestPages: (request: {
      maxBytes?: number;
      path: string;
      query?: Record<string, boolean | number | string>;
    }) => Promise<Array<unknown>>;
    requestBuffer: (request: {
      maxBytes?: number;
      path: string;
      query?: Record<string, boolean | number | string>;
    }) => Promise<Uint8Array>;
    requestText: (request: {
      maxBytes?: number;
      path: string;
      query?: Record<string, boolean | number | string>;
    }) => Promise<string>;
  };
};

const previousGlabPath = process.env.CODIFF_GLAB_PATH;
const previousCallsPath = process.env.CODIFF_GLAB_TEST_CALLS;

afterEach(() => {
  if (previousGlabPath == null) {
    delete process.env.CODIFF_GLAB_PATH;
  } else {
    process.env.CODIFF_GLAB_PATH = previousGlabPath;
  }
  if (previousCallsPath == null) {
    delete process.env.CODIFF_GLAB_TEST_CALLS;
  } else {
    process.env.CODIFF_GLAB_TEST_CALLS = previousCallsPath;
  }
});

test('createGlabGitLabTransport performs glab api requests through the injected executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-glab-transport-'));
  const fakeGlabPath = join(directory, 'glab');
  const callsPath = join(directory, 'calls.jsonl');
  await writeFile(
    fakeGlabPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const callsPath = process.env.CODIFF_GLAB_TEST_CALLS;
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(callsPath, JSON.stringify({ args, input }) + '\\n');
  if (args.includes('/projects/group%2Fproject/merge_requests/7/versions')) {
    process.stdout.write(JSON.stringify([
      {
        id: 1,
        head_commit_sha: 'b'.repeat(40),
        base_commit_sha: 'a'.repeat(40),
        start_commit_sha: 'a'.repeat(40),
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]));
  } else {
    process.stdout.write('{}');
  }
  process.exit(0);
});
`,
    'utf8',
  );
  await chmod(fakeGlabPath, 0o755);
  process.env.CODIFF_GLAB_PATH = fakeGlabPath;
  process.env.CODIFF_GLAB_TEST_CALLS = callsPath;

  const transport = createGlabGitLabTransport({
    hostname: 'gitlab.example.com',
    repoRoot: directory,
  });
  const versions = await transport.request<Array<{ id: number }>>({
    path: '/api/v4/projects/group%2Fproject/merge_requests/7/versions',
  });
  expect(versions).toEqual([expect.objectContaining({ id: 1 })]);
  const calls = JSON.parse((await readFile(callsPath, 'utf8')).trim()) as { args: Array<string> };
  expect(calls.args).toContain('/projects/group%2Fproject/merge_requests/7/versions');
  expect(calls.args).not.toContain('/api/v4/projects/group%2Fproject/merge_requests/7/versions');
});

test('createGlabGitLabTransport drains oversized JSON, text, binary, and paginated responses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-glab-transport-'));
  const fakeGlabPath = join(directory, 'glab');
  const callsPath = join(directory, 'calls.txt');
  await writeFile(
    fakeGlabPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const resource = process.argv.at(-1);
const chunk = Buffer.alloc(16 * 1024, 120);
let remaining = 16;
const write = () => {
  while (remaining > 0) {
    remaining -= 1;
    if (!process.stdout.write(chunk)) {
      process.stdout.once('drain', write);
      return;
    }
  }
  fs.appendFileSync(process.env.CODIFF_GLAB_TEST_CALLS, resource + '\\n');
};
write();
`,
    'utf8',
  );
  await chmod(fakeGlabPath, 0o755);
  process.env.CODIFF_GLAB_PATH = fakeGlabPath;
  process.env.CODIFF_GLAB_TEST_CALLS = callsPath;

  const transport = createGlabGitLabTransport({
    hostname: 'gitlab.example.com',
    repoRoot: directory,
  });
  const results = await Promise.allSettled([
    transport.request({ maxBytes: 8, path: '/projects/group%2Fproject/merge_requests/1' }),
    transport.requestText({
      maxBytes: 8,
      path: '/projects/group%2Fproject/repository/files/readme/raw',
    }),
    transport.requestBuffer({
      maxBytes: 8,
      path: '/projects/group%2Fproject/repository/blobs/deadbeef/raw',
    }),
    transport.requestPages({
      maxBytes: 8,
      path: '/projects/group%2Fproject/merge_requests/1/discussions',
    }),
  ]);

  expect(results).toHaveLength(4);
  for (const result of results) {
    expect(result).toMatchObject({
      reason: expect.objectContaining({
        message: 'glab api response exceeded the 8-byte safety limit.',
        name: 'ProviderOutputLimitError',
      }),
      status: 'rejected',
    });
  }
  expect((await readFile(callsPath, 'utf8')).trim().split('\n')).toHaveLength(4);
});

test('createGlabGitLabTransport bounds and drains responses without an explicit limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-glab-transport-'));
  const fakeGlabPath = join(directory, 'glab');
  const callsPath = join(directory, 'calls.txt');
  await writeFile(
    fakeGlabPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const chunk = Buffer.alloc(1024 * 1024, 120);
let remaining = 9;
const write = () => {
  while (remaining > 0) {
    remaining -= 1;
    if (!process.stdout.write(chunk)) {
      process.stdout.once('drain', write);
      return;
    }
  }
  fs.appendFileSync(process.env.CODIFF_GLAB_TEST_CALLS, 'drained\\n');
};
write();
`,
    'utf8',
  );
  await chmod(fakeGlabPath, 0o755);
  process.env.CODIFF_GLAB_PATH = fakeGlabPath;
  process.env.CODIFF_GLAB_TEST_CALLS = callsPath;

  const transport = createGlabGitLabTransport({
    hostname: 'gitlab.example.com',
    repoRoot: directory,
  });

  await expect(
    transport.request({ path: '/projects/group%2Fproject/merge_requests/1' }),
  ).rejects.toMatchObject({
    message: 'glab api response exceeded the 8388608-byte safety limit.',
    name: 'ProviderOutputLimitError',
  });
  expect((await readFile(callsPath, 'utf8')).trim()).toBe('drained');
});

test('createGlabGitLabTransport enforces each response bound on one shared GET', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-glab-transport-'));
  const fakeGlabPath = join(directory, 'glab');
  const callsPath = join(directory, 'calls.txt');
  await writeFile(
    fakeGlabPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.CODIFF_GLAB_TEST_CALLS, 'call\\n');
setTimeout(() => process.stdout.write('[{"id":1}]'), 25);
`,
    'utf8',
  );
  await chmod(fakeGlabPath, 0o755);
  process.env.CODIFF_GLAB_PATH = fakeGlabPath;
  process.env.CODIFF_GLAB_TEST_CALLS = callsPath;

  const first = createGlabGitLabTransport({
    hostname: 'gitlab.example.com',
    repoRoot: directory,
  });
  const second = createGlabGitLabTransport({
    hostname: 'gitlab.example.com',
    repoRoot: directory,
  });
  const path = '/projects/group%2Fproject/merge_requests/1/discussions';
  const [smallBound, largeBound] = await Promise.allSettled([
    first.requestPages({ maxBytes: 2, path }),
    second.requestPages({ maxBytes: 1024, path }),
  ]);

  expect(smallBound).toMatchObject({
    reason: expect.objectContaining({ name: 'ProviderOutputLimitError' }),
    status: 'rejected',
  });
  expect(largeBound).toEqual({ status: 'fulfilled', value: [{ id: 1 }] });
  expect((await readFile(callsPath, 'utf8')).trim()).toBe('call');
});

test('createGlabGitLabTransport keeps mutation resources last', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-glab-transport-'));
  const fakeGlabPath = join(directory, 'glab');
  const callsPath = join(directory, 'calls.jsonl');
  await writeFile(
    fakeGlabPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.CODIFF_GLAB_TEST_CALLS, JSON.stringify({ args, input }) + '\\n');
  process.stdout.write('{}');
});
`,
    'utf8',
  );
  await chmod(fakeGlabPath, 0o755);
  process.env.CODIFF_GLAB_PATH = fakeGlabPath;
  process.env.CODIFF_GLAB_TEST_CALLS = callsPath;

  const transport = createGlabGitLabTransport({
    hostname: 'gitlab.example.com',
    repoRoot: directory,
  });
  await transport.request({
    body: { body: 'Looks good.' },
    method: 'POST',
    path: '/api/v4/projects/group%2Fproject/merge_requests/7/notes',
  });

  const call = JSON.parse((await readFile(callsPath, 'utf8')).trim()) as {
    args: Array<string>;
    input: string;
  };
  expect(call.args.at(-1)).toBe('/projects/group%2Fproject/merge_requests/7/notes');
  expect(call.args).toContain('Content-Type: application/json');
  expect(JSON.parse(call.input)).toEqual({ body: 'Looks good.' });
});

test('createGlabGitLabTransport preserves exact binary response bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-glab-transport-'));
  const fakeGlabPath = join(directory, 'glab');
  const callsPath = join(directory, 'calls.jsonl');
  await writeFile(
    fakeGlabPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CODIFF_GLAB_TEST_CALLS, JSON.stringify({ args }) + '\\n');
process.stdout.write(Buffer.from([0, 255, 10, 128]));
`,
    'utf8',
  );
  await chmod(fakeGlabPath, 0o755);
  process.env.CODIFF_GLAB_PATH = fakeGlabPath;
  process.env.CODIFF_GLAB_TEST_CALLS = callsPath;

  const transport = createGlabGitLabTransport({
    hostname: 'gitlab.example.com',
    repoRoot: directory,
  });
  const bytes = await transport.requestBuffer({
    path: '/api/v4/projects/group%2Fproject/repository/blobs/deadbeef/raw',
  });

  expect([...bytes]).toEqual([0, 255, 10, 128]);
  const calls = JSON.parse((await readFile(callsPath, 'utf8')).trim()) as {
    args: Array<string>;
  };
  expect(calls.args).toContain('/projects/group%2Fproject/repository/blobs/deadbeef/raw');
});

test('createGlabGitLabTransport flattens all glab paginated response pages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-glab-transport-'));
  const fakeGlabPath = join(directory, 'glab');
  const callsPath = join(directory, 'calls.jsonl');
  await writeFile(
    fakeGlabPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CODIFF_GLAB_TEST_CALLS, JSON.stringify({ args }) + '\\n');
process.stdout.write('[\\n  {"id": 1, "label": "nested } and \\\\"quoted\\\\" text"}\\n][{"id": 2}]');
`,
    'utf8',
  );
  await chmod(fakeGlabPath, 0o755);
  process.env.CODIFF_GLAB_PATH = fakeGlabPath;
  process.env.CODIFF_GLAB_TEST_CALLS = callsPath;

  const transport = createGlabGitLabTransport({
    hostname: 'gitlab.example.com',
    repoRoot: directory,
  });
  const secondTransport = createGlabGitLabTransport({
    hostname: 'gitlab.example.com',
    repoRoot: directory,
  });
  const pages = await Promise.all([
    transport.requestPages({ path: '/api/v4/projects/group%2Fproject/issues' }),
    secondTransport.requestPages({ path: '/api/v4/projects/group%2Fproject/issues' }),
  ]);
  expect(pages).toEqual([
    [{ id: 1, label: 'nested } and "quoted" text' }, { id: 2 }],
    [{ id: 1, label: 'nested } and "quoted" text' }, { id: 2 }],
  ]);
  const calls = (await readFile(callsPath, 'utf8')).trim().split('\n');
  expect(calls).toHaveLength(1);
  expect((JSON.parse(calls[0]) as { args: Array<string> }).args).toContain('--paginate');
});
