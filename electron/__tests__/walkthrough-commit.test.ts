import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createWalkthroughCommit } = require('../walkthrough-commit.cjs') as {
  createWalkthroughCommit: (
    repoPath: string,
    request: { body?: string; paths?: ReadonlyArray<string>; subject?: string },
    onOutput?: (chunk: string) => void,
  ) => Promise<{ hash: string; status: 'committed' } | { reason: string; status: 'failed' }>;
};

const execFileAsync = promisify(execFile);

const git = async (repoPath: string, args: ReadonlyArray<string>) => {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
  });
  return stdout;
};

const withRepo = async (testBody: (repoPath: string) => Promise<void>) => {
  const repoPath = await mkdtemp(join(tmpdir(), 'codiff-walkthrough-commit-'));
  try {
    await git(repoPath, ['init']);
    await git(repoPath, ['config', 'commit.gpgSign', 'false']);
    await git(repoPath, ['config', 'user.email', 'codiff@example.com']);
    await git(repoPath, ['config', 'user.name', 'Codiff Test']);
    await testBody(repoPath);
  } finally {
    await rm(repoPath, { force: true, recursive: true });
  }
};

test('rejects a commit with no subject before touching git', async () => {
  const result = await createWalkthroughCommit('/repo', {
    paths: ['src/App.tsx'],
    subject: '   ',
  });
  expect(result.status).toBe('failed');
});

test('rejects a commit with no selected files', async () => {
  const result = await createWalkthroughCommit('/repo', { paths: [], subject: 'Fix it' });
  expect(result.status).toBe('failed');
});

test('rejects a path that escapes the repository', async () => {
  const result = await createWalkthroughCommit('/repo', {
    paths: ['../../etc/passwd'],
    subject: 'Fix it',
  });
  expect(result).toEqual({ reason: 'A selected file path is invalid.', status: 'failed' });
});

test('commits only selected files and leaves unrelated staged files alone', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'selected.txt'), 'before\n');
    await writeFile(join(repoPath, 'other.txt'), 'before\n');
    await git(repoPath, ['add', 'selected.txt', 'other.txt']);
    await git(repoPath, ['commit', '-m', 'Initial commit']);

    await writeFile(join(repoPath, 'selected.txt'), 'after\n');
    await writeFile(join(repoPath, 'other.txt'), 'after\n');
    await git(repoPath, ['add', 'other.txt']);

    const result = await createWalkthroughCommit(repoPath, {
      body: 'Body line',
      paths: ['selected.txt'],
      subject: 'Update selected',
    });

    expect(result.status).toBe('committed');
    expect(await git(repoPath, ['show', '--format=%B', '--no-patch', 'HEAD'])).toBe(
      'Update selected\n\nBody line\n\n',
    );
    expect(await git(repoPath, ['show', '--format=', '--name-only', 'HEAD'])).toBe(
      'selected.txt\n',
    );
    expect(await git(repoPath, ['diff', '--name-only', '--cached'])).toBe('other.txt\n');
  });
});

test('streams hook output and returns stripped failure text', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'example.txt'), 'before\n');
    await git(repoPath, ['add', 'example.txt']);
    await git(repoPath, ['commit', '-m', 'Initial commit']);
    await writeFile(
      join(repoPath, '.git/hooks/pre-commit'),
      [
        '#!/bin/sh',
        'printf "\\033[31mhook started\\033[0m\\n"',
        'printf "hook failed\\n"',
        'exit 1',
        '',
      ].join('\n'),
    );
    await chmod(join(repoPath, '.git/hooks/pre-commit'), 0o755);
    await writeFile(join(repoPath, 'example.txt'), 'after\n');

    const output: Array<string> = [];
    const result = await createWalkthroughCommit(
      repoPath,
      {
        paths: ['example.txt'],
        subject: 'Update example',
      },
      (chunk) => output.push(chunk),
    );

    expect(output.join('')).toContain('hook started');
    expect(result).toEqual({
      reason: 'hook started\nhook failed',
      status: 'failed',
    });
    expect(await readFile(join(repoPath, 'example.txt'), 'utf8')).toBe('after\n');
  });
});
