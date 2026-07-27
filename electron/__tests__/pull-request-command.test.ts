import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { GH_NOT_FOUND_CODE, getGhCommand, submitPullRequestReview } =
  require('../git-state/pull-request.cjs') as {
    GH_NOT_FOUND_CODE: string;
    getGhCommand: () => string;
    submitPullRequestReview: (
      launchPath: string,
      request: {
        body?: string;
        comments: ReadonlyArray<Record<string, unknown>>;
        event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
        source: {
          provider: 'github';
          type: 'pull-request';
          url: string;
        };
      },
    ) => Promise<void>;
  };

const execFileAsync = promisify(execFile);

test('resolves the GitHub CLI from an explicit override', async () => {
  await using directory = await createTemporaryDirectory('codiff-gh-command-');
  const fakeGh = join(directory.path, 'gh');
  await writeFile(fakeGh, '#!/bin/sh\nexit 0\n');
  await chmod(fakeGh, 0o755);

  await using _environment = createTemporaryEnvironment({ CODIFF_GH_PATH: fakeGh });

  expect(getGhCommand()).toBe(fakeGh);
});

test('rejects invalid explicit GitHub CLI overrides', async () => {
  await using _environment = createTemporaryEnvironment({
    CODIFF_GH_PATH: '/tmp/codiff-missing-gh',
  });

  expect(() => getGhCommand()).toThrow('CODIFF_GH_PATH');
  try {
    getGhCommand();
  } catch (error) {
    expect(error).toMatchObject({ code: GH_NOT_FOUND_CODE });
  }
});

test('falls back to a standard install directory when gh is off PATH', async () => {
  await using directory = await createTemporaryDirectory('codiff-gh-fallback-');
  const localBin = join(directory.path, '.local/bin');
  const emptyBin = join(directory.path, 'empty-bin');
  const fallbackGh = join(localBin, 'gh');

  await Promise.all([mkdir(localBin, { recursive: true }), mkdir(emptyBin)]);
  await writeFile(fallbackGh, '#!/bin/sh\nexit 0\n');
  await chmod(fallbackGh, 0o755);

  await using _environment = createTemporaryEnvironment({
    CODIFF_GH_PATH: undefined,
    HOME: directory.path,
    PATH: emptyBin,
  });

  expect(getGhCommand()).toBe(fallbackGh);
});

test('reports a missing GitHub CLI when the resolved executable cannot be spawned', async () => {
  await using directory = await createTemporaryDirectory('codiff-gh-unspawnable-');
  const repo = join(directory.path, 'repo');
  const fakeGh = join(directory.path, 'gh');

  await mkdir(repo);
  await execFileAsync('git', ['-C', repo, 'init']);
  await execFileAsync('git', [
    '-C',
    repo,
    'remote',
    'add',
    'origin',
    'git@github.com:nkzw-tech/codiff.git',
  ]);

  // Executable enough to pass resolution, but its interpreter is missing, so
  // the spawn itself fails the same way a deleted `gh` would.
  await writeFile(fakeGh, '#!/codiff-missing-interpreter\n');
  await chmod(fakeGh, 0o755);

  await using _environment = createTemporaryEnvironment({
    CODIFF_GH_PATH: fakeGh,
    SHELL: undefined,
  });

  await expect(
    submitPullRequestReview(repo, {
      body: 'General feedback.',
      comments: [],
      event: 'COMMENT',
      source: {
        provider: 'github',
        type: 'pull-request',
        url: 'https://github.com/nkzw-tech/codiff/pull/12',
      },
    }),
  ).rejects.toThrow('GitHub support requires gh');
});

test('reaches the GitHub CLI when it is not on PATH', async () => {
  await using directory = await createTemporaryDirectory('codiff-gh-off-path-');
  const repo = join(directory.path, 'repo');
  const pathBin = join(directory.path, 'path-bin');
  const fakeGh = join(directory.path, 'gh');
  const callsPath = join(directory.path, 'calls.txt');

  await Promise.all([mkdir(repo), mkdir(pathBin)]);
  await execFileAsync('git', ['-C', repo, 'init']);
  await execFileAsync('git', [
    '-C',
    repo,
    'remote',
    'add',
    'origin',
    'git@github.com:nkzw-tech/codiff.git',
  ]);

  // A PATH carrying only the commands this test itself needs reproduces how the
  // packaged app is launched: Homebrew's directory is absent, so `gh` cannot be
  // spawned by name.
  for (const command of ['cat', 'git']) {
    const { stdout } = await execFileAsync('sh', ['-c', `command -v ${command}`]);
    await symlink(stdout.trim(), join(pathBin, command));
  }

  // Records the arguments and the stdin payload of every call, so the review
  // body has to survive the pipe rather than merely reaching the executable.
  await writeFile(
    fakeGh,
    `#!/bin/sh
printf '%s | %s\\n' "$*" "$(cat)" >> "$CODIFF_GITHUB_COMMAND_TEST_CALLS"
for arg in "$@"; do
  if [ "$arg" = 'repos/nkzw-tech/codiff/pulls/12' ]; then
    printf '%s' '{"head":{"sha":"0123456789abcdef0123456789abcdef01234567"}}'
    exit 0
  fi
done
printf '%s' '{}'
`,
  );
  await chmod(fakeGh, 0o755);

  await using _environment = createTemporaryEnvironment({
    CODIFF_GH_PATH: fakeGh,
    CODIFF_GITHUB_COMMAND_TEST_CALLS: callsPath,
    PATH: pathBin,
    SHELL: undefined,
  });

  await submitPullRequestReview(repo, {
    body: 'General feedback.',
    comments: [],
    event: 'COMMENT',
    source: {
      provider: 'github',
      type: 'pull-request',
      url: 'https://github.com/nkzw-tech/codiff/pull/12',
    },
  });

  const calls = (await readFile(callsPath, 'utf8')).trim().split('\n');
  expect(calls).toEqual([
    'api repos/nkzw-tech/codiff/pulls/12 | ',
    'api -X POST repos/nkzw-tech/codiff/pulls/12/reviews --input - | ' +
      '{"body":"General feedback.","comments":[],"event":"COMMENT"}',
  ]);
});

test('authenticates gh from the login shell environment when the app inherited none', async () => {
  await using directory = await createTemporaryDirectory('codiff-gh-login-env-');
  const repo = join(directory.path, 'repo');
  const fakeGh = join(directory.path, 'gh');
  const fakeShell = join(directory.path, 'fake-login-shell');

  await mkdir(repo);
  await execFileAsync('git', ['-C', repo, 'init']);
  await execFileAsync('git', [
    '-C',
    repo,
    'remote',
    'add',
    'origin',
    'git@github.com:nkzw-tech/codiff.git',
  ]);

  // A GUI-launched Codiff keeps launchd's minimal environment: no GH_TOKEN,
  // even when the user's login shell exports one. This gh fails auth exactly
  // the way the real one does when the token never reaches it.
  await writeFile(
    fakeShell,
    `#!/bin/sh
GH_TOKEN='from-login-shell' exec /bin/sh -c "$3"
`,
  );
  await writeFile(
    fakeGh,
    `#!/bin/sh
if [ "$GH_TOKEN" != 'from-login-shell' ]; then
  echo 'To get started with GitHub CLI, please run:  gh auth login' >&2
  exit 4
fi
for arg in "$@"; do
  if [ "$arg" = 'repos/nkzw-tech/codiff/pulls/12' ]; then
    printf '%s' '{"head":{"sha":"0123456789abcdef0123456789abcdef01234567"}}'
    exit 0
  fi
done
printf '%s' '{}'
`,
  );
  await Promise.all([chmod(fakeShell, 0o755), chmod(fakeGh, 0o755)]);

  await using _environment = createTemporaryEnvironment({
    CODIFF_GH_PATH: fakeGh,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    SHELL: fakeShell,
  });

  await submitPullRequestReview(repo, {
    body: 'General feedback.',
    comments: [],
    event: 'COMMENT',
    source: {
      provider: 'github',
      type: 'pull-request',
      url: 'https://github.com/nkzw-tech/codiff/pull/12',
    },
  });
});

test('prefers the process environment over the login shell for gh', async () => {
  await using directory = await createTemporaryDirectory('codiff-gh-env-precedence-');
  const repo = join(directory.path, 'repo');
  const fakeGh = join(directory.path, 'gh');
  const fakeShell = join(directory.path, 'fake-login-shell');

  await mkdir(repo);
  await execFileAsync('git', ['-C', repo, 'init']);
  await execFileAsync('git', [
    '-C',
    repo,
    'remote',
    'add',
    'origin',
    'git@github.com:nkzw-tech/codiff.git',
  ]);

  await writeFile(
    fakeShell,
    `#!/bin/sh
GH_TOKEN='from-login-shell' exec /bin/sh -c "$3"
`,
  );
  await writeFile(
    fakeGh,
    `#!/bin/sh
if [ "$GH_TOKEN" != 'from-process' ]; then
  echo 'Expected the process GH_TOKEN to win, got:' "$GH_TOKEN" >&2
  exit 4
fi
for arg in "$@"; do
  if [ "$arg" = 'repos/nkzw-tech/codiff/pulls/12' ]; then
    printf '%s' '{"head":{"sha":"0123456789abcdef0123456789abcdef01234567"}}'
    exit 0
  fi
done
printf '%s' '{}'
`,
  );
  await Promise.all([chmod(fakeShell, 0o755), chmod(fakeGh, 0o755)]);

  await using _environment = createTemporaryEnvironment({
    CODIFF_GH_PATH: fakeGh,
    GH_TOKEN: 'from-process',
    GITHUB_TOKEN: undefined,
    SHELL: fakeShell,
  });

  await submitPullRequestReview(repo, {
    body: 'General feedback.',
    comments: [],
    event: 'COMMENT',
    source: {
      provider: 'github',
      type: 'pull-request',
      url: 'https://github.com/nkzw-tech/codiff/pull/12',
    },
  });
});
