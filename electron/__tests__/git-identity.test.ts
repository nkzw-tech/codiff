import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
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
const { startCommandAction } = require('../command-log.cjs') as {
  startCommandAction: (input: { command: string }) => {
    cancel: () => void;
    run: <Value>(callback: () => Value) => Value;
    signal: AbortSignal;
  };
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
}, 30_000);

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

test.sequential('single-flights concurrent Git identity reads without retaining stale values', async () => {
  await using directory = await createTemporaryDirectory('codiff-git-identity-single-flight-');
  const fakeBin = join(directory.path, 'bin');
  const fakeGit = join(fakeBin, 'git');
  const callsPath = join(directory.path, 'calls.txt');
  await mkdir(fakeBin);
  await writeFile(
    fakeGit,
    `#!/usr/bin/env node
const fs = require('node:fs');
const key = process.argv.at(-1);
fs.appendFileSync(process.env.CODIFF_GIT_IDENTITY_CALLS, key + '\\n');
setTimeout(() => process.stdout.write(key === 'user.name' ? 'Codiff User\\n' : 'codiff@example.com\\n'), 150);
`,
    'utf8',
  );
  await chmod(fakeGit, 0o755);
  await using _environment = createTemporaryEnvironment({
    CODIFF_GIT_IDENTITY_CALLS: callsPath,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
  });

  await expect(
    Promise.all([readGitIdentity(directory.path), readGitIdentity(directory.path)]),
  ).resolves.toEqual([
    expect.objectContaining({ email: 'codiff@example.com', name: 'Codiff User' }),
    expect.objectContaining({ email: 'codiff@example.com', name: 'Codiff User' }),
  ]);
  expect((await readFile(callsPath, 'utf8')).trim().split('\n').sort()).toEqual([
    'user.email',
    'user.name',
  ]);

  await expect(readGitIdentity(directory.path)).resolves.toMatchObject({
    email: 'codiff@example.com',
    name: 'Codiff User',
  });
  expect((await readFile(callsPath, 'utf8')).trim().split('\n')).toHaveLength(4);

  const canceledAction = startCommandAction({ command: 'initial-load' });
  const activeAction = startCommandAction({ command: 'initial-load' });
  const canceledRead = canceledAction.run(() => readGitIdentity(directory.path));
  const activeRead = activeAction.run(() => readGitIdentity(directory.path));
  setTimeout(() => canceledAction.cancel(), 25);

  await expect(canceledRead).rejects.toMatchObject({ name: 'AbortError' });
  expect(canceledAction.signal.aborted).toBe(true);
  await expect(activeRead).resolves.toMatchObject({
    email: 'codiff@example.com',
    name: 'Codiff User',
  });
});
