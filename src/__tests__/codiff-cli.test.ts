import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { formatHelpText, parseArguments, resolvePullRequestUrl } from '../../bin/arguments.js';

const execFileAsync = promisify(execFile);

const git = async (repo: string, args: ReadonlyArray<string>) => {
  await execFileAsync('git', ['-C', repo, ...args], { encoding: 'utf8' });
};

test('parseArguments treats a hash positional as a commit ref', () => {
  const commitRef = 'a1b2c3d4e5f678901234567890abcdef12345678';

  expect(parseArguments(['-w', commitRef])).toEqual({
    commitRef,
    help: false,
    pullRequestNumber: null,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: true,
  });
});

test('parseArguments treats HEAD positional revisions as commit refs', () => {
  expect(parseArguments(['HEAD'])).toEqual({
    commitRef: 'HEAD',
    help: false,
    pullRequestNumber: null,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: false,
  });

  expect(parseArguments(['HEAD^1'])).toEqual({
    commitRef: 'HEAD^1',
    help: false,
    pullRequestNumber: null,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: false,
  });
});

test('parseArguments treats plain branch refs as branch refs', async () => {
  const repositoryPath = await realpath(await mkdtemp(join(tmpdir(), 'codiff-cli-')));
  const previousCwd = process.cwd();

  try {
    await git(repositoryPath, ['init']);
    await git(repositoryPath, ['config', 'user.email', 'codiff@example.com']);
    await git(repositoryPath, ['config', 'user.name', 'Codiff Test']);
    await git(repositoryPath, ['commit', '--allow-empty', '-m', 'initial commit']);
    await git(repositoryPath, ['checkout', '-b', 'feature']);
    process.chdir(repositoryPath);

    expect(parseArguments(['feature'])).toEqual({
      branchRef: 'feature',
      commitRef: null,
      help: false,
      pullRequestNumber: null,
      pullRequestUrl: null,
      requestedPath: repositoryPath,
      version: false,
      walkthrough: false,
    });
  } finally {
    process.chdir(previousCwd);
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('parseArguments treats hex-like refs as commits before branches', async () => {
  const repositoryPath = await realpath(await mkdtemp(join(tmpdir(), 'codiff-cli-')));
  const previousCwd = process.cwd();

  try {
    await git(repositoryPath, ['init']);
    await git(repositoryPath, ['config', 'user.email', 'codiff@example.com']);
    await git(repositoryPath, ['config', 'user.name', 'Codiff Test']);
    await git(repositoryPath, ['commit', '--allow-empty', '-m', 'initial commit']);
    const { stdout } = await execFileAsync('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    });
    const shortHash = stdout.trim().slice(0, 8);
    await git(repositoryPath, ['branch', shortHash]);
    process.chdir(repositoryPath);

    expect(parseArguments([shortHash])).toMatchObject({
      commitRef: shortHash,
      requestedPath: repositoryPath,
    });

    expect(parseArguments(['--branch', shortHash])).toMatchObject({
      branchRef: shortHash,
      commitRef: null,
      requestedPath: repositoryPath,
    });
  } finally {
    process.chdir(previousCwd);
    await rm(repositoryPath, { force: true, recursive: true });
  }
});

test('parseArguments keeps existing hash-like paths as repository paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-cli-'));
  const repositoryPath = join(directory, 'deadbeef');

  try {
    await mkdir(repositoryPath);

    expect(parseArguments([repositoryPath])).toEqual({
      commitRef: null,
      help: false,
      pullRequestNumber: null,
      pullRequestUrl: null,
      requestedPath: repositoryPath,
      version: false,
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
    help: false,
    pullRequestNumber: null,
    pullRequestUrl,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: false,
  });
});

test('parseArguments treats PR number shorthands as review sources', () => {
  expect(parseArguments(['#75'])).toEqual({
    commitRef: null,
    help: false,
    pullRequestNumber: 75,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: false,
  });
});

test('parseArguments treats PR marker arguments as review sources', () => {
  expect(parseArguments(['pr', '75'])).toEqual({
    commitRef: null,
    help: false,
    pullRequestNumber: 75,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: false,
  });
});

test('parseArguments recognizes Codex walkthrough seed options', () => {
  expect(
    parseArguments([
      '-w',
      '--codex-session',
      '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
      '--walkthrough-context',
      'seed.json',
    ]),
  ).toEqual({
    codexSessionId: '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
    commitRef: null,
    help: false,
    pullRequestNumber: null,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
    walkthrough: true,
    walkthroughContextPath: resolve('seed.json'),
  });
});

test('parseArguments recognizes a pre-authored walkthrough file', () => {
  expect(parseArguments(['-w', '--walkthrough-file', '.codiff/walkthrough.json'])).toMatchObject({
    walkthrough: true,
    walkthroughFilePath: resolve('.codiff/walkthrough.json'),
  });
});

test('parseArguments recognizes the walkthrough guide flag', () => {
  expect(parseArguments(['--walkthrough-guide'])).toMatchObject({ walkthroughGuide: true });
  expect(parseArguments([])).not.toHaveProperty('walkthroughGuide');
});

test('parseArguments recognizes Claude walkthrough seed options and the agent override', () => {
  expect(
    parseArguments([
      '-w',
      '--agent',
      'claude',
      '--claude-session',
      '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
    ]),
  ).toMatchObject({
    agentBackend: 'claude',
    claudeSessionId: '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
    walkthrough: true,
  });
});

test('parseArguments ignores unknown agent backends', () => {
  const result = parseArguments(['--agent', 'gpt']) as { agentBackend?: string };
  expect(result.agentBackend).toBeUndefined();
});

test('parseArguments treats hash-prefixed PR marker values as review sources', () => {
  expect(parseArguments(['pr', '#75'])).toEqual({
    commitRef: null,
    help: false,
    pullRequestNumber: 75,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    version: false,
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

test('packaged terminal helper forwards branch names to Electron as branches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-app-helper-'));
  const fakeBin = join(directory, 'bin');
  const logPath = join(directory, 'open-args.txt');
  const openPath = join(fakeBin, 'open');
  const repositoryPath = join(directory, 'repo');

  try {
    await mkdir(fakeBin);
    await mkdir(repositoryPath);
    const realRepositoryPath = await realpath(repositoryPath);
    await git(repositoryPath, ['init']);
    await git(repositoryPath, ['config', 'user.email', 'codiff@example.com']);
    await git(repositoryPath, ['config', 'user.name', 'Codiff Test']);
    await git(repositoryPath, ['commit', '--allow-empty', '-m', 'initial commit']);
    await git(repositoryPath, ['checkout', '-b', 'feature']);
    await writeFile(
      openPath,
      '#!/bin/sh\nfor arg in "$@"; do\n  printf "%s\\n" "$arg" >> "$OPEN_ARGS_FILE"\ndone\n',
    );
    await chmod(openPath, 0o755);

    await execFileAsync(resolve('bin/codiff-app'), ['feature'], {
      cwd: realRepositoryPath,
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
      '--branch',
      'feature',
      realRepositoryPath,
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('packaged terminal helper forwards hex refs to Electron as commits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-app-helper-'));
  const fakeBin = join(directory, 'bin');
  const logPath = join(directory, 'open-args.txt');
  const openPath = join(fakeBin, 'open');
  const repositoryPath = join(directory, 'repo');

  try {
    await mkdir(fakeBin);
    await mkdir(repositoryPath);
    const realRepositoryPath = await realpath(repositoryPath);
    await git(repositoryPath, ['init']);
    await git(repositoryPath, ['config', 'user.email', 'codiff@example.com']);
    await git(repositoryPath, ['config', 'user.name', 'Codiff Test']);
    await git(repositoryPath, ['commit', '--allow-empty', '-m', 'initial commit']);
    const { stdout } = await execFileAsync('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    });
    const shortHash = stdout.trim().slice(0, 8);
    await git(repositoryPath, ['branch', shortHash]);
    await writeFile(
      openPath,
      '#!/bin/sh\nfor arg in "$@"; do\n  printf "%s\\n" "$arg" >> "$OPEN_ARGS_FILE"\ndone\n',
    );
    await chmod(openPath, 0o755);

    await execFileAsync(resolve('bin/codiff-app'), [shortHash], {
      cwd: realRepositoryPath,
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
      shortHash,
      realRepositoryPath,
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

test('packaged terminal helper forwards Codex walkthrough seed options', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-app-helper-'));
  const fakeBin = join(directory, 'bin');
  const logPath = join(directory, 'open-args.txt');
  const repositoryPath = join(directory, 'repo');
  const openPath = join(fakeBin, 'open');
  const contextPath = join(directory, 'seed.json');

  try {
    await mkdir(fakeBin);
    await mkdir(repositoryPath);
    await writeFile(contextPath, '{}');
    await writeFile(
      openPath,
      '#!/bin/sh\nfor arg in "$@"; do\n  printf "%s\\n" "$arg" >> "$OPEN_ARGS_FILE"\ndone\n',
    );
    await chmod(openPath, 0o755);

    await execFileAsync(
      resolve('bin/codiff-app'),
      [
        '-w',
        '--codex-session',
        '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
        '--walkthrough-context',
        contextPath,
        repositoryPath,
      ],
      {
        env: {
          ...process.env,
          OPEN_ARGS_FILE: logPath,
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
      },
    );

    expect((await readFile(logPath, 'utf8')).trim().split('\n')).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--codex-session',
      '019e5e57-e7d6-7392-9ad1-ad959319d2fb',
      '--walkthrough-context',
      contextPath,
      '--walkthrough',
      repositoryPath,
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('Codex skill launcher uses the session cwd as the repository target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-skill-launcher-'));
  const home = join(directory, 'home');
  const repositoryPath = join(directory, 'repo');
  const sessionDirectory = join(home, '.codex', 'sessions', '2026', '05', '25');
  const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';
  const sessionPath = join(sessionDirectory, `rollout-${sessionId}.jsonl`);
  const fakeCodiff = join(directory, 'codiff');
  const logPath = join(directory, 'args.txt');

  try {
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        payload: { cwd: repositoryPath },
        type: 'turn_context',
      })}\n`,
    );
    await writeFile(
      fakeCodiff,
      '#!/bin/sh\nfor arg in "$@"; do\n  printf "%s\\n" "$arg" >> "$OPEN_ARGS_FILE"\ndone\n',
    );
    await chmod(fakeCodiff, 0o755);

    await execFileAsync(
      process.execPath,
      [resolve('codex/skills/codiff/scripts/open-codiff.mjs'), 'HEAD'],
      {
        cwd: resolve('codex/skills/codiff'),
        env: {
          ...process.env,
          CODEX_HOME: join(home, '.codex'),
          CODEX_THREAD_ID: sessionId,
          CODIFF_COMMAND: fakeCodiff,
          OPEN_ARGS_FILE: logPath,
        },
      },
    );

    expect((await readFile(logPath, 'utf8')).trim().split('\n')).toEqual([
      '-w',
      '--codex-session',
      sessionId,
      'HEAD',
      repositoryPath,
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('Codex skill launcher does not override explicit repository targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-skill-launcher-'));
  const sessionRepositoryPath = join(directory, 'session-repo');
  const explicitRepositoryPath = join(directory, 'explicit-repo');
  const fakeCodiff = join(directory, 'codiff');
  const logPath = join(directory, 'args.txt');

  try {
    await mkdir(sessionRepositoryPath, { recursive: true });
    await mkdir(explicitRepositoryPath, { recursive: true });
    await writeFile(
      fakeCodiff,
      '#!/bin/sh\nfor arg in "$@"; do\n  printf "%s\\n" "$arg" >> "$OPEN_ARGS_FILE"\ndone\n',
    );
    await chmod(fakeCodiff, 0o755);

    await execFileAsync(
      process.execPath,
      [resolve('codex/skills/codiff/scripts/open-codiff.mjs'), explicitRepositoryPath],
      {
        cwd: resolve('codex/skills/codiff'),
        env: {
          ...process.env,
          CODEX_SESSION_CWD: sessionRepositoryPath,
          CODEX_THREAD_ID: '',
          CODIFF_COMMAND: fakeCodiff,
          OPEN_ARGS_FILE: logPath,
        },
      },
    );

    expect((await readFile(logPath, 'utf8')).trim().split('\n')).toEqual([
      '-w',
      explicitRepositoryPath,
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('Claude skill launcher uses the session cwd and forwards --agent claude', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-claude-launcher-'));
  const home = join(directory, 'home');
  const repositoryPath = join(directory, 'repo');
  const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';
  const projectDirectory = join(home, '.claude', 'projects', '-tmp-repo');
  const sessionPath = join(projectDirectory, `${sessionId}.jsonl`);
  const fakeCodiff = join(directory, 'codiff');
  const logPath = join(directory, 'args.txt');

  try {
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(sessionPath, `${JSON.stringify({ cwd: repositoryPath })}\n`);
    await writeFile(
      fakeCodiff,
      '#!/bin/sh\nfor arg in "$@"; do\n  printf "%s\\n" "$arg" >> "$OPEN_ARGS_FILE"\ndone\n',
    );
    await chmod(fakeCodiff, 0o755);

    await execFileAsync(
      process.execPath,
      [resolve('claude/skills/codiff/scripts/open-codiff.mjs'), 'HEAD'],
      {
        cwd: resolve('claude/skills/codiff'),
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          CLAUDE_SESSION_ID: sessionId,
          CODIFF_COMMAND: fakeCodiff,
          OPEN_ARGS_FILE: logPath,
        },
      },
    );

    expect((await readFile(logPath, 'utf8')).trim().split('\n')).toEqual([
      '-w',
      '--agent',
      'claude',
      '--claude-session',
      sessionId,
      'HEAD',
      repositoryPath,
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('packaged terminal helper forwards the agent and Claude session to Electron', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-app-helper-'));
  const fakeBin = join(directory, 'bin');
  const logPath = join(directory, 'open-args.txt');
  const repositoryPath = join(directory, 'repo');
  const openPath = join(fakeBin, 'open');
  const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';

  try {
    await mkdir(fakeBin);
    await mkdir(repositoryPath);
    await writeFile(
      openPath,
      '#!/bin/sh\nfor arg in "$@"; do\n  printf "%s\\n" "$arg" >> "$OPEN_ARGS_FILE"\ndone\n',
    );
    await chmod(openPath, 0o755);

    await execFileAsync(
      resolve('bin/codiff-app'),
      ['-w', '--agent', 'claude', '--claude-session', sessionId, repositoryPath],
      {
        env: {
          ...process.env,
          OPEN_ARGS_FILE: logPath,
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
      },
    );

    expect((await readFile(logPath, 'utf8')).trim().split('\n')).toEqual([
      '-n',
      resolve('bin/../../../..'),
      '--args',
      '--claude-session',
      sessionId,
      '--agent',
      'claude',
      '--walkthrough',
      repositoryPath,
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('parseArguments recognizes --help and -h flags', () => {
  expect(parseArguments(['--help']).help).toBe(true);
  expect(parseArguments(['-h']).help).toBe(true);
});

test('parseArguments recognizes --version and -v flags', () => {
  expect(parseArguments(['--version']).version).toBe(true);
  expect(parseArguments(['-v']).version).toBe(true);
});

test('parseArguments defaults help and version to false', () => {
  const result = parseArguments([]);
  expect(result.help).toBe(false);
  expect(result.version).toBe(false);
});

test('formatHelpText includes version and all flags', () => {
  const text = formatHelpText('1.2.3');
  expect(text).toContain('codiff v1.2.3');
  expect(text).toContain('Usage:');
  expect(text).toContain('--help');
  expect(text).toContain('--version');
  expect(text).toContain('--commit');
  expect(text).toContain('--codex-session');
  expect(text).toContain('--walkthrough');
  expect(text).toContain('--walkthrough-context');
  expect(text).toContain('-h');
  expect(text).toContain('-v');
  expect(text).toContain('-w');
});

test('formatHelpText styles titles and descriptions', () => {
  const text = formatHelpText('1.2.3');

  expect(text).toContain('\u001b[1;34mUsage:\u001b[0m');
  expect(text).toContain('\u001b[1;34mOptions:\u001b[0m');
  expect(text).toContain('\u001b[1;34mExamples:\u001b[0m');
  expect(text).toContain('  --help, -h');
  expect(text).not.toContain('\u001b[1;34m--help, -h\u001b[0m');
  expect(text).toContain('\u001b[90mShow this help message and exit.\u001b[0m');
  expect(text).toContain('  codiff -w');
  expect(text).not.toContain('\u001b[1;34mcodiff -w\u001b[0m');
  expect(text).toContain('\u001b[90mStart with an LLM walkthrough.\u001b[0m');
});

test('codiff-app --help prints help text and exits 0', async () => {
  const { stdout } = await execFileAsync(resolve('bin/codiff-app'), ['--help'], {
    encoding: 'utf8',
  });
  expect(stdout).toContain('codiff v');
  expect(stdout).toContain('Usage:');
  expect(stdout).toContain('--help');
  expect(stdout).toContain('\u001b[1;34mUsage:\u001b[0m');
  expect(stdout).toContain('\u001b[90mShow this help message and exit.\u001b[0m');
});

test('codiff-app -h prints help text and exits 0', async () => {
  const { stdout } = await execFileAsync(resolve('bin/codiff-app'), ['-h'], {
    encoding: 'utf8',
  });
  expect(stdout).toContain('Usage:');
});

test('codiff-app --version prints version and exits 0', async () => {
  const { stdout } = await execFileAsync(resolve('bin/codiff-app'), ['--version'], {
    encoding: 'utf8',
  });
  expect(stdout).toMatch(/^codiff v\d+\.\d+\.\d+\n$/);
});

test('codiff-app -v prints version and exits 0', async () => {
  const { stdout } = await execFileAsync(resolve('bin/codiff-app'), ['-v'], {
    encoding: 'utf8',
  });
  expect(stdout).toMatch(/^codiff v\d+\.\d+\.\d+\n$/);
});

test('codiff --walkthrough-guide prints the guide and embedded schema, then exits 0', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['bin/codiff.js', '--walkthrough-guide'],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
    },
  );

  // The authoring prose...
  expect(stdout).toContain('Narrative walkthrough — authoring guide');
  expect(stdout).toContain('segments');
  expect(stdout).toContain('orders');
  // ...followed by the live JSON schema, embedded as a fenced block.
  expect(stdout).toContain('```json');
  expect(stdout).toContain('"defaultOrder"');
  expect(stdout).toContain('"const": 2');
});

test('the walkthrough authoring guide file exists and is non-trivial', async () => {
  const guide = await readFile(resolve('bin/walkthrough-guide.md'), 'utf8');
  expect(guide.length).toBeGreaterThan(500);
  expect(guide).toContain('segments');
  expect(guide).toContain('orders');
});

test('parseArguments reads base...head and base..head as a range', async () => {
  const repositoryPath = await realpath(await mkdtemp(join(tmpdir(), 'codiff-cli-')));
  const previousCwd = process.cwd();

  try {
    await git(repositoryPath, ['init']);
    await git(repositoryPath, ['config', 'user.email', 'codiff@example.com']);
    await git(repositoryPath, ['config', 'user.name', 'Codiff Test']);
    await git(repositoryPath, ['commit', '--allow-empty', '-m', 'first']);
    await git(repositoryPath, ['branch', 'base']);
    await git(repositoryPath, ['commit', '--allow-empty', '-m', 'second']);
    await git(repositoryPath, ['branch', 'head']);
    process.chdir(repositoryPath);

    expect(parseArguments(['-w', 'base...head'])).toMatchObject({
      range: { base: 'base', head: 'head', symmetric: true },
      requestedPath: repositoryPath,
    });
    expect(parseArguments(['base..head'])).toMatchObject({
      range: { base: 'base', head: 'head', symmetric: false },
    });
    // Unresolved refs fall back instead of being silently read as a range.
    expect(parseArguments(['nope...nada']).range).toBeUndefined();
  } finally {
    process.chdir(previousCwd);
    await rm(repositoryPath, { force: true, recursive: true });
  }
});
