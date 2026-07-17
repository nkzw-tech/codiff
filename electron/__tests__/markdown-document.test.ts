import { chmod, lstat, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { readMarkdownDocument, writeMarkdownDocument } = require('../markdown-document.cjs') as {
  readMarkdownDocument: (
    request: { kind: 'plan' | 'repository'; path: string },
    context: { planFile?: string; repositoryRoot: string },
  ) => Promise<{
    content: string;
    id: string;
    kind: 'plan' | 'repository';
    path: string;
    version: string;
  }>;
  writeMarkdownDocument: (
    request: {
      baseVersion: string;
      content: string;
      kind: 'plan' | 'repository';
      path: string;
    },
    context: { planFile?: string; repositoryRoot: string },
  ) => Promise<{
    content: string;
    id: string;
    kind: 'plan' | 'repository';
    path: string;
    version: string;
  }>;
};

test('reads and atomically writes repository Markdown documents', async () => {
  await using directory = await createTemporaryDirectory('codiff-markdown-');
  const path = join(directory.path, 'plan.md');
  const context = { repositoryRoot: directory.path };

  await writeFile(path, '# Original\n');
  const document = await readMarkdownDocument({ kind: 'repository', path: 'plan.md' }, context);
  const saved = await writeMarkdownDocument(
    {
      baseVersion: document.version,
      content: '# Updated\n',
      kind: 'repository',
      path: 'plan.md',
    },
    context,
  );

  expect(saved.content).toBe('# Updated\n');
  expect(saved.version).not.toBe(document.version);
  expect(await readFile(path, 'utf8')).toBe('# Updated\n');
});

test('preserves repository Markdown file permissions when saving', async () => {
  await using directory = await createTemporaryDirectory('codiff-markdown-mode-');
  const path = join(directory.path, 'executable.md');
  const context = { repositoryRoot: directory.path };

  await writeFile(path, '# Original\n');
  await chmod(path, 0o755);
  const document = await readMarkdownDocument(
    { kind: 'repository', path: 'executable.md' },
    context,
  );

  await writeMarkdownDocument(
    {
      baseVersion: document.version,
      content: '# Updated\n',
      kind: 'repository',
      path: 'executable.md',
    },
    context,
  );

  expect((await stat(path)).mode & 0o777).toBe(0o755);
});

test('writes through a symlinked plan without replacing the symlink', async () => {
  await using directory = await createTemporaryDirectory('codiff-plan-symlink-');
  const target = join(directory.path, 'target.md');
  const planFile = join(directory.path, 'plan.md');
  const context = { planFile, repositoryRoot: directory.path };

  await writeFile(target, '# Original\n');
  await symlink(target, planFile);
  const document = await readMarkdownDocument({ kind: 'plan', path: planFile }, context);

  await writeMarkdownDocument(
    {
      baseVersion: document.version,
      content: '# Updated\n',
      kind: 'plan',
      path: planFile,
    },
    context,
  );

  expect((await lstat(planFile)).isSymbolicLink()).toBe(true);
  expect(await readFile(target, 'utf8')).toBe('# Updated\n');
});

test('returns the disk document when a stale version attempts to overwrite it', async () => {
  await using directory = await createTemporaryDirectory('codiff-markdown-conflict-');
  const path = join(directory.path, 'plan.md');
  const context = { repositoryRoot: directory.path };

  await writeFile(path, '# Original\n');
  const document = await readMarkdownDocument({ kind: 'repository', path: 'plan.md' }, context);
  await writeFile(path, '# External edit\n');

  await expect(
    writeMarkdownDocument(
      {
        baseVersion: document.version,
        content: '# Local edit\n',
        kind: 'repository',
        path: 'plan.md',
      },
      context,
    ),
  ).rejects.toMatchObject({
    document: {
      content: '# External edit\n',
    },
    name: 'MarkdownDocumentConflictError',
  });
});

test('allows only the exact plan file and repository-contained Markdown paths', async () => {
  await using directory = await createTemporaryDirectory('codiff-markdown-paths-');
  const planFile = join(directory.path, 'plan.md');

  await writeFile(planFile, '# Plan\n');
  await expect(
    readMarkdownDocument(
      { kind: 'plan', path: join(directory.path, 'other.md') },
      { planFile, repositoryRoot: directory.path },
    ),
  ).rejects.toThrow('does not belong to this window');
  await expect(
    readMarkdownDocument(
      { kind: 'repository', path: '../plan.md' },
      { repositoryRoot: directory.path },
    ),
  ).rejects.toThrow('escapes the repository');
  await expect(
    readMarkdownDocument(
      { kind: 'repository', path: 'plan.txt' },
      { repositoryRoot: directory.path },
    ),
  ).rejects.toThrow('Invalid repository Markdown path');
});

test('rejects repository Markdown paths that resolve outside through a symlink', async () => {
  await using root = await createTemporaryDirectory('codiff-markdown-symlink-root-');
  await using outside = await createTemporaryDirectory('codiff-markdown-symlink-outside-');
  const outsidePath = join(outside.path, 'outside.md');

  await writeFile(outsidePath, '# Outside\n');
  await symlink(outside.path, join(root.path, 'docs'));

  await expect(
    readMarkdownDocument(
      { kind: 'repository', path: 'docs/outside.md' },
      { repositoryRoot: root.path },
    ),
  ).rejects.toThrow('escapes the repository');
  expect(await readFile(outsidePath, 'utf8')).toBe('# Outside\n');
});
