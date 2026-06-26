import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { readGitIdentity } = require('../git-state/working-tree.cjs') as {
  readGitIdentity: (path: string) => Promise<{ email: string; name: string }>;
};

const execFileAsync = promisify(execFile);
const git = async (repo: string, args: ReadonlyArray<string>) => {
  await execFileAsync('git', ['-C', repo, ...args], { encoding: 'utf8' });
};

test('prefers configured git identity and falls back to the current commit author', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'codiff-git-identity-'));
  try {
    await git(repo, ['init']);
    await writeFile(join(repo, 'README.md'), '# Test\n');
    await git(repo, ['add', 'README.md']);
    await git(repo, [
      '-c',
      'user.name=Commit Author',
      '-c',
      'user.email=commit@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Initial commit',
    ]);

    await git(repo, ['config', 'user.name', 'Configured User']);
    await git(repo, ['config', 'user.email', 'configured@example.com']);
    await expect(readGitIdentity(repo)).resolves.toMatchObject({
      email: 'configured@example.com',
      name: 'Configured User',
    });

    await git(repo, ['config', 'user.name', '']);
    await git(repo, ['config', 'user.email', '']);
    await expect(readGitIdentity(repo)).resolves.toMatchObject({
      email: 'commit@example.com',
      name: 'Commit Author',
    });
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
});

test('reads the global git identity outside a repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-global-git-identity-'));
  const globalConfig = join(directory, '.gitconfig');
  const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  try {
    await writeFile(globalConfig, '[user]\n\tname = Global User\n\temail = global@example.com\n');
    process.env.GIT_CONFIG_GLOBAL = globalConfig;

    await expect(readGitIdentity(directory)).resolves.toMatchObject({
      email: 'global@example.com',
      name: 'Global User',
    });
  } finally {
    if (previousGlobalConfig == null) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    }
    await rm(directory, { force: true, recursive: true });
  }
});
