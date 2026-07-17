import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { readGitIdentity } = require('../git-state/working-tree.cjs') as {
  readGitIdentity: (path: string) => Promise<{ email: string; name: string }>;
};

const execFileAsync = promisify(execFile);
const git = async (repo: string, args: ReadonlyArray<string>) => {
  await execFileAsync('git', ['-C', repo, ...args], { encoding: 'utf8' });
};

test('uses configured git identity without inferring it from the current commit author', async () => {
  await using directory = await createTemporaryDirectory('codiff-git-identity-');
  await git(directory.path, ['init']);
  await writeFile(join(directory.path, 'README.md'), '# Test\n');
  await git(directory.path, ['add', 'README.md']);
  await git(directory.path, [
    '-c',
    'user.name=Commit Author',
    '-c',
    'user.email=commit@example.com',
    'commit',
    '-m',
    'Initial commit',
  ]);

  await git(directory.path, ['config', 'user.name', 'Configured User']);
  await git(directory.path, ['config', 'user.email', 'configured@example.com']);
  await expect(readGitIdentity(directory.path)).resolves.toMatchObject({
    email: 'configured@example.com',
    name: 'Configured User',
  });

  await git(directory.path, ['config', 'user.name', '']);
  await git(directory.path, ['config', 'user.email', '']);
  await expect(readGitIdentity(directory.path)).resolves.toMatchObject({
    email: '',
    name: '',
  });
});

test('reads the global git identity outside a repository', async () => {
  await using directory = await createTemporaryDirectory('codiff-global-git-identity-');
  const globalConfig = join(directory.path, '.gitconfig');
  await writeFile(globalConfig, '[user]\n\tname = Global User\n\temail = global@example.com\n');
  await using _environment = createTemporaryEnvironment({ GIT_CONFIG_GLOBAL: globalConfig });

  await expect(readGitIdentity(directory.path)).resolves.toMatchObject({
    email: 'global@example.com',
    name: 'Global User',
  });
});
