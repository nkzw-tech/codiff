import { execFileSync } from 'node:child_process';
import { chmod, lstat, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import type {
  RepositoryFileDocument,
  SaveRepositoryFileRequest,
  SaveRepositoryFileResult,
} from '../../core/types.ts';

const require = createRequire(import.meta.url);
const { readRepositoryFile, writeRepositoryFile } = require('../repository-file.cjs') as {
  readRepositoryFile: (
    root: string,
    path: string,
  ) => Promise<RepositoryFileDocument & { gitIdent?: boolean }>;
  writeRepositoryFile: (
    root: string,
    request: SaveRepositoryFileRequest,
  ) => Promise<SaveRepositoryFileResult>;
};

test('saves UTF-8 source without changing line endings, BOM, or executable permissions', async () => {
  await using directory = await createTemporaryDirectory('codiff-edit-');
  const path = join(directory.path, 'script.ts');
  await writeFile(path, '\uFEFFconst greeting = "こんにちは";\r\n');
  await chmod(path, 0o755);
  const document = await readRepositoryFile(directory.path, 'script.ts');
  const content = document.content.replace('こんにちは', 'こんばんは');
  const result = await writeRepositoryFile(directory.path, {
    ...document,
    baseVersion: document.version,
    content,
  });
  expect(result.status).toBe('saved');
  expect(await readFile(path, 'utf8')).toBe(content);
  expect(result.document.version).not.toBe(document.version);
  expect((await stat(path)).mode & 0o777).toBe(0o755);
});

test('recognizes expanded Git ident keywords only on paths with the attribute', async () => {
  await using directory = await createTemporaryDirectory('codiff-edit-ident-');
  execFileSync('git', ['init', '--quiet', directory.path]);
  const content = `new $Id: ${'a'.repeat(40)} $\n`;
  await writeFile(join(directory.path, 'source.ts'), content);
  await writeFile(join(directory.path, '.gitattributes'), 'source.ts ident\n');
  expect(await readRepositoryFile(directory.path, 'source.ts')).toMatchObject({
    content,
    gitIdent: true,
  });
  await writeFile(join(directory.path, '.gitattributes'), 'source.ts -ident\n');
  expect((await readRepositoryFile(directory.path, 'source.ts')).gitIdent).toBeUndefined();
});

test('keeps external edits and rejects saves belonging to a different repository', async () => {
  await using directory = await createTemporaryDirectory('codiff-edit-conflict-');
  const path = join(directory.path, 'source.ts');
  await writeFile(path, 'original\n');
  const document = await readRepositoryFile(directory.path, 'source.ts');
  await writeFile(path, 'external\n');
  const result = await writeRepositoryFile(directory.path, {
    ...document,
    baseVersion: document.version,
    content: 'draft\n',
  });
  expect(result).toMatchObject({ status: 'conflict', document: { content: 'external\n' } });
  expect(await readFile(path, 'utf8')).toBe('external\n');
  await expect(
    writeRepositoryFile(directory.path, {
      ...document,
      root: '/different-repository',
      baseVersion: document.version,
      content: 'draft\n',
    }),
  ).rejects.toThrow('different repository');
});

test('writes through contained symlinks but rejects traversal, outside targets, and Git metadata', async () => {
  await using directory = await createTemporaryDirectory('codiff-edit-path-');
  await using outside = await createTemporaryDirectory('codiff-edit-outside-');
  await writeFile(join(directory.path, 'target.ts'), 'original\n');
  await symlink('target.ts', join(directory.path, 'source.ts'));
  await symlink(outside.path, join(directory.path, 'outside'));
  await writeFile(join(outside.path, 'target.ts'), 'outside\n');
  await writeFile(join(directory.path, '.git'), 'gitdir: somewhere\n');
  const document = await readRepositoryFile(directory.path, 'source.ts');
  await writeRepositoryFile(directory.path, {
    ...document,
    baseVersion: document.version,
    content: 'updated\n',
  });
  expect((await lstat(join(directory.path, 'source.ts'))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(directory.path, 'target.ts'), 'utf8')).toBe('updated\n');
  await expect(readRepositoryFile(directory.path, 'outside/target.ts')).rejects.toThrow('escapes');
  await expect(readRepositoryFile(directory.path, '../outside/target.ts')).rejects.toThrow();
  await expect(readRepositoryFile(directory.path, '.git')).rejects.toThrow('Git metadata');
  expect(await readFile(join(outside.path, 'target.ts'), 'utf8')).toBe('outside\n');
});

test('refuses binary, non-UTF-8, and oversized files without rewriting them', async () => {
  await using directory = await createTemporaryDirectory('codiff-edit-binary-');
  for (const bytes of [
    Buffer.from([0, 1, 2]),
    Buffer.from([0xff]),
    Buffer.alloc(2 * 1024 * 1024 + 1, 97),
  ]) {
    const path = join(directory.path, 'data');
    await writeFile(path, bytes);
    await expect(readRepositoryFile(directory.path, 'data')).rejects.toThrow();
    expect((await readFile(path)).equals(bytes)).toBe(true);
  }
});
