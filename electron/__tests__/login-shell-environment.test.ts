import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { getLoginShellEnvironment, resolveLoginShellEnvironment } =
  require('../login-shell-environment.cjs') as {
    getLoginShellEnvironment: () => Promise<Readonly<Record<string, string>>>;
    resolveLoginShellEnvironment: (
      shell: string,
      timeout?: number,
    ) => Promise<Readonly<Record<string, string>>>;
  };

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
CODIFF_FAKE_TOKEN='from-login-shell' CODIFF_FAKE_MULTILINE='first line
second line' exec /bin/sh -c "$3"
`,
  );
  await using _environment = createTemporaryEnvironment({ SHELL: shell });

  const environment = await getLoginShellEnvironment();

  expect(environment.CODIFF_FAKE_TOKEN).toBe('from-login-shell');
  expect(environment.CODIFF_FAKE_MULTILINE).toBe('first line\nsecond line');
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
CODIFF_FAKE_TOKEN='from-login-shell' exec /bin/sh -c "$3"
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

test('salvages a clean environment dump when a background child holds stdout open', async () => {
  await using directory = await createTemporaryDirectory('codiff-login-shell-');
  // The shell finishes the dump and exits cleanly, but leaves behind a child
  // that inherits stdout, so `close` stays hours away from `exit`.
  const shell = await createFakeLoginShell(
    directory.path,
    `CODIFF_FAKE_TOKEN='from-login-shell' /bin/sh -c "$3"
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
