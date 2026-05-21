import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { parseArguments, resolvePullRequestUrl } from '../../bin/arguments.js';

const execFileAsync = promisify(execFile);

const git = async (repo: string, args: ReadonlyArray<string>) => {
  await execFileAsync('git', ['-C', repo, ...args], { encoding: 'utf8' });
};

test('parseArguments treats a hash positional as a commit ref', () => {
  const commitRef = 'a1b2c3d4e5f678901234567890abcdef12345678';

  expect(parseArguments(['-w', commitRef])).toEqual({
    commitRef,
    pullRequestNumber: null,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    walkthrough: true,
  });
});

test('parseArguments treats HEAD positional revisions as commit refs', () => {
  expect(parseArguments(['HEAD'])).toEqual({
    commitRef: 'HEAD',
    pullRequestNumber: null,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    walkthrough: false,
  });

  expect(parseArguments(['HEAD^1'])).toEqual({
    commitRef: 'HEAD^1',
    pullRequestNumber: null,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    walkthrough: false,
  });
});

test('parseArguments keeps existing hash-like paths as repository paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-cli-'));
  const repositoryPath = join(directory, 'deadbeef');

  try {
    await mkdir(repositoryPath);

    expect(parseArguments([repositoryPath])).toEqual({
      commitRef: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
      requestedPath: repositoryPath,
      walkthrough: false,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('parseArguments treats GitHub pull request URLs as review sources', () => {
  const pullRequestUrl = 'https://github.com/nkzw-tech/codiff/pull/3';

  expect(parseArguments([pullRequestUrl])).toEqual({
    commitRef: null,
    pullRequestNumber: null,
    pullRequestUrl,
    requestedPath: resolve(process.cwd()),
    walkthrough: false,
  });
});

test('parseArguments treats PR number shorthands as review sources', () => {
  expect(parseArguments(['#75'])).toEqual({
    commitRef: null,
    pullRequestNumber: 75,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    walkthrough: false,
  });
});

test('parseArguments treats PR marker arguments as review sources', () => {
  expect(parseArguments(['pr', '75'])).toEqual({
    commitRef: null,
    pullRequestNumber: 75,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    walkthrough: false,
  });
});

test('parseArguments treats hash-prefixed PR marker values as review sources', () => {
  expect(parseArguments(['pr', '#75'])).toEqual({
    commitRef: null,
    pullRequestNumber: 75,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    walkthrough: false,
  });
});

test('resolvePullRequestUrl builds GitHub PR URLs from the origin remote', async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'codiff-cli-'));

  try {
    await git(repositoryPath, ['init']);
    await git(repositoryPath, ['remote', 'add', 'upstream', 'https://github.com/other/repo.git']);
    await git(repositoryPath, ['remote', 'add', 'origin', 'git@github.com:nkzw-tech/codiff.git']);

    expect(resolvePullRequestUrl(repositoryPath, 75)).toBe(
      'https://github.com/nkzw-tech/codiff/pull/75',
    );
  } finally {
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('packaged terminal helper forwards --commit HEAD to Electron', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-app-helper-'));
  const fakeBin = join(directory, 'bin');
  const logPath = join(directory, 'open-args.txt');
  const repositoryPath = join(directory, 'repo');
  const openPath = join(fakeBin, 'open');

  try {
    await mkdir(fakeBin);
    await mkdir(repositoryPath);
    await writeFile(
      openPath,
      '#!/bin/sh\nfor arg in "$@"; do\n  printf "%s\\n" "$arg" >> "$OPEN_ARGS_FILE"\ndone\n',
    );
    await chmod(openPath, 0o755);

    await execFileAsync(resolve('bin/codiff-app'), ['--commit', 'HEAD', repositoryPath], {
      env: {
        ...process.env,
        OPEN_ARGS_FILE: logPath,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });

    expect((await readFile(logPath, 'utf8')).trim().split('\n')).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--commit',
      'HEAD',
      repositoryPath,
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('packaged terminal helper forwards HEAD^1 to Electron as a commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-app-helper-'));
  const fakeBin = join(directory, 'bin');
  const logPath = join(directory, 'open-args.txt');
  const openPath = join(fakeBin, 'open');

  try {
    await mkdir(fakeBin);
    await writeFile(
      openPath,
      '#!/bin/sh\nfor arg in "$@"; do\n  printf "%s\\n" "$arg" >> "$OPEN_ARGS_FILE"\ndone\n',
    );
    await chmod(openPath, 0o755);

    await execFileAsync(resolve('bin/codiff-app'), ['HEAD^1'], {
      env: {
        ...process.env,
        OPEN_ARGS_FILE: logPath,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });

    expect((await readFile(logPath, 'utf8')).trim().split('\n')).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--commit',
      'HEAD^1',
      process.cwd(),
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('packaged terminal helper forwards relative repository paths as absolute paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-app-helper-'));
  const fakeBin = join(directory, 'bin');
  const logPath = join(directory, 'open-args.txt');
  const repositoryPath = join(directory, 'repo');
  const openPath = join(fakeBin, 'open');

  try {
    await mkdir(fakeBin);
    await mkdir(join(repositoryPath, 'sub'), { recursive: true });
    const actualRepositoryPath = await realpath(repositoryPath);
    await writeFile(
      openPath,
      '#!/bin/sh\nfor arg in "$@"; do\n  printf "%s\\n" "$arg" >> "$OPEN_ARGS_FILE"\ndone\n',
    );
    await chmod(openPath, 0o755);

    const runHelper = async (args: ReadonlyArray<string>) => {
      await writeFile(logPath, '');
      await execFileAsync(resolve('bin/codiff-app'), args, {
        cwd: repositoryPath,
        env: {
          ...process.env,
          OPEN_ARGS_FILE: logPath,
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
      });
      return (await readFile(logPath, 'utf8')).trim().split('\n');
    };

    expect(await runHelper(['.'])).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      `${actualRepositoryPath}/.`,
    ]);
    expect(await runHelper(['sub'])).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      join(actualRepositoryPath, 'sub'),
    ]);
    expect(await runHelper(['-w', '.'])).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--walkthrough',
      `${actualRepositoryPath}/.`,
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
