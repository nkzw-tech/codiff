import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
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
  state: { dismissedVersion?: string; lastCheckedAt: string; latestVersion: string },
) => {
  await mkdir(join(home, '.codiff'), { recursive: true });
  await writeFile(join(home, '.codiff', 'update-state.json'), JSON.stringify(state, null, 2));
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

test('prints no notice for a dismissed version', async () => {
  await using home = await createTemporaryDirectory('codiff-app-home-');
  await writeState(home.path, {
    dismissedVersion: '99.0.0',
    lastCheckedAt: '2026-07-29T00:00:00.000Z',
    latestVersion: '99.0.0',
  });

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
