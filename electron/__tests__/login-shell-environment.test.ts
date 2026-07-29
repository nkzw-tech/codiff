import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { getCommandEnvironment, getLoginShellEnvironment, resolveLoginShellEnvironment } =
  require('../login-shell-environment.cjs') as {
    getCommandEnvironment: () => Promise<Record<string, string | undefined>>;
    getLoginShellEnvironment: () => Promise<Readonly<Record<string, string>>>;
    resolveLoginShellEnvironment: (
      shell: string,
      timeout?: number,
    ) => Promise<Readonly<Record<string, string>>>;
  };
const { findExecutableOnPath } = require('../agent-shared.cjs') as {
  findExecutableOnPath: (command: string) => string | null;
};

const fishPath = findExecutableOnPath('fish');
const zshPath = findExecutableOnPath('zsh');

const createFakeLoginShell = async (directory: string, body: string) => {
  const shellPath = join(directory, 'fake-login-shell');
  await writeFile(shellPath, `#!/bin/sh\n${body}`);
  await chmod(shellPath, 0o755);
  return shellPath;
};

test('resolves variables exported by the login shell', async () => {
  await using directory = await createTemporaryDirectory('codiff-login-shell-');
  // Prints startup noise first, the way version managers do in real login
  // shells, so parsing has to survive output preceding the marker.
  const shell = await createFakeLoginShell(
    directory.path,
    `echo 'Using Node v24.15.0'
if [ "$1" != '-l' ] || [ "$2" != '-i' ] || [ "$3" != '-c' ]; then
  exit 1
fi
CODIFF_FAKE_TOKEN='from-login-shell' CODIFF_FAKE_MULTILINE='first line
second line' exec /bin/sh -c "$4"
`,
  );
  await using _environment = createTemporaryEnvironment({ SHELL: shell });

  const environment = await getLoginShellEnvironment();

  expect(environment.CODIFF_FAKE_TOKEN).toBe('from-login-shell');
  expect(environment.CODIFF_FAKE_MULTILINE).toBe('first line\nsecond line');
});

test.skipIf(!fishPath)('resolves variables exported by Fish config', async () => {
  await using directory = await createTemporaryDirectory('codiff-fish-login-shell-');
  const fishConfigDirectory = join(directory.path, 'fish');
  await mkdir(fishConfigDirectory);
  await writeFile(
    join(fishConfigDirectory, 'config.fish'),
    'set --export CODIFF_FAKE_TOKEN from-fish-config\n',
  );
  await using _environment = createTemporaryEnvironment({
    HOME: directory.path,
    XDG_CONFIG_HOME: directory.path,
  });

  const environment = await resolveLoginShellEnvironment(fishPath!);

  expect(environment.CODIFF_FAKE_TOKEN).toBe('from-fish-config');
});

test.skipIf(!zshPath)('resolves variables exported by zshrc', async () => {
  await using directory = await createTemporaryDirectory('codiff-zsh-login-shell-');
  await writeFile(join(directory.path, '.zshrc'), "export CODIFF_FAKE_TOKEN='from-zsh-config'\n");
  await using _environment = createTemporaryEnvironment({
    HOME: directory.path,
    ZDOTDIR: directory.path,
  });

  const environment = await resolveLoginShellEnvironment(zshPath!);

  expect(environment.CODIFF_FAKE_TOKEN).toBe('from-zsh-config');
});

test('returns an empty environment when the login shell fails', async () => {
  await using directory = await createTemporaryDirectory('codiff-login-shell-');
  const shell = await createFakeLoginShell(directory.path, 'exit 1\n');
  await using _environment = createTemporaryEnvironment({ SHELL: shell });

  expect(await getLoginShellEnvironment()).toEqual({});
});

test('returns an empty environment when no login shell is configured', async () => {
  await using _environment = createTemporaryEnvironment({ SHELL: undefined });

  expect(await getLoginShellEnvironment()).toEqual({});
});

test('resolves each login shell once, even under concurrent calls', async () => {
  await using directory = await createTemporaryDirectory('codiff-login-shell-');
  const runsPath = join(directory.path, 'runs.txt');
  const shell = await createFakeLoginShell(
    directory.path,
    `echo run >> '${runsPath}'
CODIFF_FAKE_TOKEN='from-login-shell' exec /bin/sh -c "$4"
`,
  );
  await using _environment = createTemporaryEnvironment({ SHELL: shell });

  const [first, second] = await Promise.all([
    getLoginShellEnvironment(),
    getLoginShellEnvironment(),
  ]);
  const third = await getLoginShellEnvironment();

  expect(second).toBe(first);
  expect(third).toBe(first);
  expect((await readFile(runsPath, 'utf8')).trim().split('\n')).toHaveLength(1);
});

test('builds command environments where the process wins over the login shell', async () => {
  await using directory = await createTemporaryDirectory('codiff-login-shell-');
  const shell = await createFakeLoginShell(
    directory.path,
    `CODIFF_FAKE_TOKEN='from-login-shell' CODIFF_FAKE_SHARED='from-login-shell' exec /bin/sh -c "$4"
`,
  );
  await using _environment = createTemporaryEnvironment({
    CODIFF_FAKE_SHARED: 'from-process',
    CODIFF_FAKE_TOKEN: undefined,
    SHELL: shell,
  });

  const environment = await getCommandEnvironment();

  expect(environment.CODIFF_FAKE_TOKEN).toBe('from-login-shell');
  expect(environment.CODIFF_FAKE_SHARED).toBe('from-process');
});

test('salvages a clean environment dump when a background child holds stdout open', async () => {
  await using directory = await createTemporaryDirectory('codiff-login-shell-');
  // The shell finishes the dump and exits cleanly, but leaves behind a child
  // that inherits stdout, so `close` stays hours away from `exit`.
  const shell = await createFakeLoginShell(
    directory.path,
    `CODIFF_FAKE_TOKEN='from-login-shell' /bin/sh -c "$4"
sleep 10 &
exit 0
`,
  );

  const environment = await resolveLoginShellEnvironment(shell, 500);

  expect(environment.CODIFF_FAKE_TOKEN).toBe('from-login-shell');
});

test('abandons a login shell that ignores termination', async () => {
  await using directory = await createTemporaryDirectory('codiff-login-shell-');
  const shell = await createFakeLoginShell(
    directory.path,
    `trap '' TERM
sleep 10
`,
  );

  expect(await resolveLoginShellEnvironment(shell, 500)).toEqual({});
});
