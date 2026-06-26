import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createWalkthroughCommit } = require('../walkthrough-commit.cjs') as {
  createWalkthroughCommit: (
    repoPath: string,
    request: {
      body?: string;
      paths?: ReadonlyArray<string>;
      source?: { type: 'arc-working-tree' | 'working-tree' };
      subject?: string;
    },
  ) => Promise<{ hash: string; status: 'committed' } | { reason: string; status: 'failed' }>;
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

test.sequential('commits selected Arc working-tree paths with arc', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-walkthrough-commit-arc-'));
  const fakeBin = join(directory, 'bin');
  const repo = join(directory, 'repo');
  const previousPath = process.env.PATH;

  try {
    await mkdir(fakeBin);
    await mkdir(repo);
    await writeFile(
      join(fakeBin, 'arc'),
      `#!/bin/sh
printf '%s\\n' "$@" >> "${join(directory, 'arc-args.txt')}"
if [ "$1" = "commit" ]; then
  cp "$3" "${join(directory, 'commit-message.txt')}"
  printf '%s\\n' "$3" > "${join(directory, 'commit-message-path.txt')}"
  exit 0
fi
if [ "$1" = "log" ]; then
  printf '[{"commit":"abc123","message":"Fix arc"}]'
  exit 0
fi
exit 0
`,
    );
    await chmod(join(fakeBin, 'arc'), 0o755);
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;

    const result = await createWalkthroughCommit(repo, {
      body: 'Body line',
      paths: ['src/a.ts', 'src/b.ts'],
      source: { type: 'arc-working-tree' },
      subject: 'Fix arc',
    });

    expect(result).toEqual({ hash: 'abc123', status: 'committed' });
    await expect(readFile(join(directory, 'commit-message.txt'), 'utf8')).resolves.toBe(
      'Fix arc\n\nBody line\n',
    );
    const messagePath = (await readFile(join(directory, 'commit-message-path.txt'), 'utf8')).trim();
    expect(messagePath).toContain('codiff-arc-commit-');
    const arcArgs = await readFile(join(directory, 'arc-args.txt'), 'utf8');
    expect(arcArgs).toBe(
      `add\n--\nsrc/a.ts\nsrc/b.ts\ncommit\n-F\n${messagePath}\n--\nsrc/a.ts\nsrc/b.ts\nlog\n-n\n1\n--json\n`,
    );
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { force: true, recursive: true });
  }
});
