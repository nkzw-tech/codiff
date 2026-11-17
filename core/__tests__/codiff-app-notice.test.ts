import { execFile } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { createTemporaryDirectory } from './helpers/resources.ts';

const execFileAsync = promisify(execFile);

const wrapperPath = resolve('bin/codiff-app');

const runVersion = async (home: string) =>
  execFileAsync('sh', [wrapperPath, '--version'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });

const writeState = async (
  home: string,
  state: {
    compatible?: boolean;
    dismissedVersion?: string;
    lastCheckedAt: string;
    latestVersion: string;
  },
) => writeStateContents(home, JSON.stringify({ compatible: true, ...state }, null, 2));

const writeStateContents = async (home: string, contents: string) => {
  await mkdir(join(home, '.codiff'), { recursive: true });
  await writeFile(join(home, '.codiff', 'update-state.json'), contents);
};

const disableUpdateChecks = async (home: string) => {
  await mkdir(join(home, '.codiff'), { recursive: true });
  await writeFile(
    join(home, '.codiff', 'codiff.jsonc'),
    JSON.stringify({ settings: { checkForUpdates: false } }),
  );
};

test('prints no notice without cached update state', async () => {
  await using home = await createTemporaryDirectory('codiff-app-home-');

  const { stderr, stdout } = await runVersion(home.path);

  expect(stdout).toContain('codiff v');
  expect(stderr).toBe('');
});

test('prints the cached update notice on --version', async () => {
  await using home = await createTemporaryDirectory('codiff-app-home-');
  await writeState(home.path, {
    lastCheckedAt: '2026-07-29T00:00:00.000Z',
    latestVersion: '99.0.0',
  });

  const { stderr, stdout } = await runVersion(home.path);

  expect(stdout).toContain('codiff v');
  expect(stderr).toContain('99.0.0');
  expect(stderr).toContain('codiff update');
});

test.each(['custom', 'xdg'])(
  'shell launcher reads config and update state from %s',
  async (source) => {
    await using home = await createTemporaryDirectory('codiff-app-home-');
    const configDir = join(home.path, source === 'custom' ? 'custom config' : 'xdg/codiff');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, 'update-state.json'),
      JSON.stringify({
        compatible: true,
        lastCheckedAt: '2026-07-29T00:00:00.000Z',
        latestVersion: '99.0.0',
      }),
    );
    const run = () =>
      execFileAsync('sh', [wrapperPath, '--version'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CODIFF_CONFIG_DIR: source === 'custom' ? configDir : '',
          HOME: home.path,
          XDG_CONFIG_HOME: join(home.path, 'xdg'),
        },
      });
    expect((await run()).stderr).toContain('99.0.0');
    await writeFile(
      join(configDir, 'codiff.jsonc'),
      JSON.stringify({ settings: { checkForUpdates: false } }),
    );
    expect((await run()).stderr).toBe('');
  },
);

test('prints no notice for a dismissed version', async () => {
  await using home = await createTemporaryDirectory('codiff-app-home-');
  await writeState(home.path, {
    dismissedVersion: '99.0.0',
    lastCheckedAt: '2026-07-29T00:00:00.000Z',
    latestVersion: '99.0.0',
  });

  expect((await runVersion(home.path)).stderr).toBe('');
});

test('prints no notice for an incompatible release', async () => {
  await using home = await createTemporaryDirectory('codiff-app-home-');
  await writeState(home.path, {
    compatible: false,
    lastCheckedAt: '2026-07-29T00:00:00.000Z',
    latestVersion: '99.0.0',
  });

  expect((await runVersion(home.path)).stderr).toBe('');
});

test('prints no notice when update notifications are disabled', async () => {
  await using home = await createTemporaryDirectory('codiff-app-home-');
  await writeState(home.path, {
    lastCheckedAt: '2026-07-29T00:00:00.000Z',
    latestVersion: '99.0.0',
  });
  await disableUpdateChecks(home.path);

  expect((await runVersion(home.path)).stderr).toBe('');
});

test('prints no notice when the cached version is not newer', async () => {
  await using home = await createTemporaryDirectory('codiff-app-home-');
  await writeState(home.path, {
    lastCheckedAt: '2026-07-29T00:00:00.000Z',
    latestVersion: '0.0.1',
  });

  expect((await runVersion(home.path)).stderr).toBe('');
});

test('ignores malformed cached versions', async () => {
  await using home = await createTemporaryDirectory('codiff-app-home-');
  await writeState(home.path, {
    lastCheckedAt: '2026-07-29T00:00:00.000Z',
    latestVersion: 'not-a-version',
  });

  expect((await runVersion(home.path)).stderr).toBe('');
});

test('succeeds without a notice when HOME is unset', async () => {
  const env = { ...process.env };
  delete env.HOME;

  const { stderr, stdout } = await execFileAsync('sh', [wrapperPath, '--version'], {
    encoding: 'utf8',
    env,
  });

  expect(stdout).toContain('codiff v');
  expect(stderr).toBe('');
});

test('stays silent when the state file is unreadable', async () => {
  await using home = await createTemporaryDirectory('codiff-app-home-');
  await writeState(home.path, {
    lastCheckedAt: '2026-07-29T00:00:00.000Z',
    latestVersion: '99.0.0',
  });
  const stateFile = join(home.path, '.codiff', 'update-state.json');
  await chmod(stateFile, 0o000);

  try {
    expect((await runVersion(home.path)).stderr).toBe('');
  } finally {
    await chmod(stateFile, 0o644);
  }
});

test('stays silent for version components beyond the shell integer range', async () => {
  await using home = await createTemporaryDirectory('codiff-app-home-');
  await writeState(home.path, {
    lastCheckedAt: '2026-07-29T00:00:00.000Z',
    latestVersion: '99999999999999999999.0.0',
  });

  expect((await runVersion(home.path)).stderr).toBe('');
});

test('stays silent when lastCheckedAt is missing', async () => {
  await using home = await createTemporaryDirectory('codiff-app-home-');
  await writeStateContents(home.path, JSON.stringify({ latestVersion: '99.0.0' }));

  expect((await runVersion(home.path)).stderr).toBe('');
});

test('stays silent for invalid JSON with an unparseable lastCheckedAt', async () => {
  await using home = await createTemporaryDirectory('codiff-app-home-');
  await writeStateContents(
    home.path,
    '{\n  "lastCheckedAt": "nope",\n  "latestVersion": "99.0.0"\n',
  );

  expect((await runVersion(home.path)).stderr).toBe('');
});

test('stays silent when lastCheckedAt does not parse as a date', async () => {
  await using home = await createTemporaryDirectory('codiff-app-home-');

  for (const lastCheckedAt of [
    '2026-07-29Tgarbage',
    '2026-99-99T99:99:99.999Z',
    '2026-07-29T10:00:00garbage',
  ]) {
    await writeState(home.path, { lastCheckedAt, latestVersion: '99.0.0' });

    expect((await runVersion(home.path)).stderr, lastCheckedAt).toBe('');
  }
});

test('resolves duplicate keys last-wins like JSON parsing does', async () => {
  await using home = await createTemporaryDirectory('codiff-app-home-');
  await writeStateContents(
    home.path,
    '{\n  "compatible": true,\n  "lastCheckedAt": "2026-07-29T00:00:00.000Z",\n  "latestVersion": "99.0.0",\n  "latestVersion": "0.0.1"\n}',
  );

  expect((await runVersion(home.path)).stderr).toBe('');

  await writeStateContents(
    home.path,
    '{\n  "compatible": true,\n  "compatible": false,\n  "lastCheckedAt": "2026-07-29T00:00:00.000Z",\n  "latestVersion": "99.0.0"\n}',
  );

  expect((await runVersion(home.path)).stderr).toBe('');
});
