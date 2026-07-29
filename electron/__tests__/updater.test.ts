import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  bindDisposableHttpServer,
  createTemporaryDirectory,
} from '../../core/__tests__/helpers/resources.ts';

type UpdateStatus = {
  currentVersion: string;
  message?: string;
  phase: 'available' | 'error' | 'idle' | 'installerReady' | 'updating';
  version?: string;
};

type Updater = {
  applyUpdate: () => Promise<UpdateStatus>;
  checkForUpdates: (options?: { force?: boolean }) => Promise<UpdateStatus>;
  dismissUpdate: () => UpdateStatus;
  getStatus: () => UpdateStatus;
};

type ReleaseAsset = { name: string; url: string };

const require = createRequire(import.meta.url);
const { createUpdater, pickReleaseAsset, resolveUpdateStrategy } = require('../updater.cjs') as {
  createUpdater: (options: {
    arch: string;
    autoUpdater?: FakeAutoUpdater;
    configDir: string;
    currentVersion: string;
    downloadDirectory?: string;
    isPackaged: boolean;
    linuxFlavor?: 'deb' | 'rpm' | null;
    log?: (message: string) => void;
    onStatusChange?: (status: UpdateStatus) => void;
    openPath?: (path: string) => Promise<string>;
    platform: string;
    releaseUrl?: string;
    strategy: 'download' | 'squirrel';
  }) => Updater;
  pickReleaseAsset: (
    assets: ReadonlyArray<ReleaseAsset>,
    options: { arch: string; linuxFlavor?: 'deb' | 'rpm' | null; platform: string },
  ) => ReleaseAsset | null;
  resolveUpdateStrategy: (options: {
    hasSquirrelUpdateExe: boolean;
    platform: string;
  }) => 'download' | 'squirrel';
};

class FakeAutoUpdater extends EventEmitter {
  feedURL: { url: string } | null = null;
  checkForUpdatesCalls = 0;
  quitAndInstallCalls = 0;

  setFeedURL(options: { url: string }) {
    this.feedURL = options;
  }

  checkForUpdates() {
    this.checkForUpdatesCalls++;
  }

  quitAndInstall() {
    this.quitAndInstallCalls++;
  }
}

const releaseJson = (version: string, assets: ReadonlyArray<Record<string, string>> = []) =>
  JSON.stringify({
    assets,
    tag_name: `v${version}`,
  });

const startReleaseServer = async (handler: Parameters<typeof createServer>[1]) => {
  const server = createServer(handler);
  const disposable = await bindDisposableHttpServer(server);
  const port = (server.address() as { port: number }).port;
  return { disposable, origin: `http://127.0.0.1:${port}` };
};

const writeState = async (
  configDir: string,
  state: { dismissedVersion?: string; lastCheckedAt: string; latestVersion: string },
) => writeFile(join(configDir, 'update-state.json'), JSON.stringify(state));

const recentCheck = () => new Date().toISOString();

const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition.');
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
};

test('resolveUpdateStrategy uses Squirrel on macOS and Squirrel-installed Windows', () => {
  expect(resolveUpdateStrategy({ hasSquirrelUpdateExe: false, platform: 'darwin' })).toBe(
    'squirrel',
  );
  expect(resolveUpdateStrategy({ hasSquirrelUpdateExe: true, platform: 'win32' })).toBe('squirrel');
  expect(resolveUpdateStrategy({ hasSquirrelUpdateExe: false, platform: 'win32' })).toBe(
    'download',
  );
  expect(resolveUpdateStrategy({ hasSquirrelUpdateExe: false, platform: 'linux' })).toBe(
    'download',
  );
});

test('pickReleaseAsset matches the platform-specific artifact', () => {
  const assets = [
    { name: 'Codiff-darwin-arm64-1.9.3.zip', url: 'https://example.com/mac.zip' },
    { name: 'Codiff-win32-x64-1.9.3.zip', url: 'https://example.com/win.zip' },
    { name: 'codiff_1.9.3_amd64.deb', url: 'https://example.com/codiff.deb' },
    { name: 'codiff-1.9.3-1.x86_64.rpm', url: 'https://example.com/codiff.rpm' },
  ];

  expect(pickReleaseAsset(assets, { arch: 'arm64', platform: 'darwin' })?.name).toBe(
    'Codiff-darwin-arm64-1.9.3.zip',
  );
  expect(pickReleaseAsset(assets, { arch: 'x64', platform: 'win32' })?.name).toBe(
    'Codiff-win32-x64-1.9.3.zip',
  );
  expect(
    pickReleaseAsset(assets, { arch: 'x64', linuxFlavor: 'deb', platform: 'linux' })?.name,
  ).toBe('codiff_1.9.3_amd64.deb');
  expect(
    pickReleaseAsset(assets, { arch: 'x64', linuxFlavor: 'rpm', platform: 'linux' })?.name,
  ).toBe('codiff-1.9.3-1.x86_64.rpm');
  expect(pickReleaseAsset(assets, { arch: 'x64', platform: 'freebsd' })).toBeNull();
});

test('starts from the cached state without hitting the network', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const updater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    strategy: 'squirrel',
  });

  expect(updater.getStatus()).toEqual({
    currentVersion: '1.9.2',
    phase: 'available',
    version: '1.9.3',
  });
});

test('checkForUpdates fetches, persists state and reports an available update', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(releaseJson('1.9.3'));
  });

  const notifications: Array<UpdateStatus> = [];
  const updater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    onStatusChange: (status) => notifications.push(status),
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  const status = await updater.checkForUpdates();

  expect(status).toEqual({ currentVersion: '1.9.2', phase: 'available', version: '1.9.3' });
  expect(notifications).toEqual([status]);

  const persisted = JSON.parse(
    await readFile(join(directory.path, 'update-state.json'), 'utf8'),
  ) as { latestVersion: string };
  expect(persisted.latestVersion).toBe('1.9.3');
});

test('checkForUpdates stays idle when already up to date', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(releaseJson('1.9.2'));
  });

  const updater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  expect(await updater.checkForUpdates()).toEqual({ currentVersion: '1.9.2', phase: 'idle' });
});

test('checkForUpdates honors the throttle and force bypasses it', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  let requests = 0;
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    requests++;
    response.setHeader('content-type', 'application/json');
    response.end(releaseJson('1.9.4'));
  });

  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const updater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  const throttled = await updater.checkForUpdates();
  expect(requests).toBe(0);
  expect(throttled).toEqual({ currentVersion: '1.9.2', phase: 'available', version: '1.9.3' });

  const forced = await updater.checkForUpdates({ force: true });
  expect(requests).toBe(1);
  expect(forced).toEqual({ currentVersion: '1.9.2', phase: 'available', version: '1.9.4' });
});

test('checkForUpdates swallows network failures and keeps the cached state', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    response.statusCode = 500;
    response.end('nope');
  });

  const previous = {
    lastCheckedAt: '2026-01-01T00:00:00.000Z',
    latestVersion: '1.9.3',
  };
  await writeState(directory.path, previous);

  const log: Array<string> = [];
  const updater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    log: (message) => log.push(message),
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  const status = await updater.checkForUpdates();

  expect(status).toEqual({ currentVersion: '1.9.2', phase: 'available', version: '1.9.3' });
  expect(log.length).toBe(1);

  const persisted = JSON.parse(
    await readFile(join(directory.path, 'update-state.json'), 'utf8'),
  ) as { lastCheckedAt: string };
  expect(persisted.lastCheckedAt).toBe(previous.lastCheckedAt);
});

test('checkForUpdates rejects on failure only when forced', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    response.statusCode = 500;
    response.end('nope');
  });

  const updater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    log: () => {},
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  await expect(updater.checkForUpdates()).resolves.toEqual({
    currentVersion: '1.9.2',
    phase: 'idle',
  });
  await expect(updater.checkForUpdates({ force: true })).rejects.toThrow();
});

test('checkForUpdates does nothing for unpackaged builds', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  let requests = 0;
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    requests++;
    response.end(releaseJson('9.9.9'));
  });

  const updater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: false,
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  expect(await updater.checkForUpdates()).toEqual({ currentVersion: '1.9.2', phase: 'idle' });
  expect(requests).toBe(0);
});

test('dismissUpdate persists the dismissal and hides the update', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const notifications: Array<UpdateStatus> = [];
  const updater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    onStatusChange: (status) => notifications.push(status),
    platform: 'darwin',
    strategy: 'squirrel',
  });

  expect(updater.dismissUpdate()).toEqual({ currentVersion: '1.9.2', phase: 'idle' });
  expect(notifications).toEqual([{ currentVersion: '1.9.2', phase: 'idle' }]);

  const persisted = JSON.parse(
    await readFile(join(directory.path, 'update-state.json'), 'utf8'),
  ) as { dismissedVersion: string };
  expect(persisted.dismissedVersion).toBe('1.9.3');
});

test('applyUpdate drives Squirrel through download and restart', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const autoUpdater = new FakeAutoUpdater();
  const notifications: Array<UpdateStatus> = [];
  const updater = createUpdater({
    arch: 'arm64',
    autoUpdater,
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    onStatusChange: (status) => notifications.push(status),
    platform: 'darwin',
    strategy: 'squirrel',
  });

  const status = await updater.applyUpdate();

  expect(status).toEqual({ currentVersion: '1.9.2', phase: 'updating', version: '1.9.3' });
  expect(autoUpdater.feedURL).toEqual({
    url: 'https://update.electronjs.org/nkzw-tech/codiff/darwin-arm64/1.9.2',
  });
  expect(autoUpdater.checkForUpdatesCalls).toBe(1);

  autoUpdater.emit('update-downloaded');
  expect(autoUpdater.quitAndInstallCalls).toBe(1);
});

test('applyUpdate reports Squirrel errors and offers retry', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const autoUpdater = new FakeAutoUpdater();
  const updater = createUpdater({
    arch: 'arm64',
    autoUpdater,
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    strategy: 'squirrel',
  });

  await updater.applyUpdate();
  autoUpdater.emit('error', new Error('feed unreachable'));

  const status = updater.getStatus();
  expect(status.phase).toBe('error');
  expect(status.version).toBe('1.9.3');
  expect(status.message).toBeTruthy();
  expect(autoUpdater.quitAndInstallCalls).toBe(0);
});

test('applyUpdate reports an error when Squirrel has no update yet', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const autoUpdater = new FakeAutoUpdater();
  const updater = createUpdater({
    arch: 'arm64',
    autoUpdater,
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    strategy: 'squirrel',
  });

  await updater.applyUpdate();
  autoUpdater.emit('update-not-available');

  expect(updater.getStatus().phase).toBe('error');
});

test('applyUpdate downloads and opens the installer for download installs', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await using downloads = await createTemporaryDirectory('codiff-downloads-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const { disposable: _server, origin } = await startReleaseServer((request, response) => {
    if (request.url === '/asset.deb') {
      response.setHeader('content-type', 'application/octet-stream');
      response.end('deb-bytes');
      return;
    }

    response.setHeader('content-type', 'application/json');
    response.end(
      releaseJson('1.9.3', [
        {
          browser_download_url: `${origin}/asset.deb`,
          name: 'codiff_1.9.3_amd64.deb',
        },
      ]),
    );
  });

  const opened: Array<string> = [];
  const updater = createUpdater({
    arch: 'x64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    downloadDirectory: downloads.path,
    isPackaged: true,
    linuxFlavor: 'deb',
    openPath: async (path) => {
      opened.push(path);
      return '';
    },
    platform: 'linux',
    releaseUrl: `${origin}/`,
    strategy: 'download',
  });

  const status = await updater.applyUpdate();

  expect(status).toEqual({ currentVersion: '1.9.2', phase: 'installerReady', version: '1.9.3' });
  expect(opened).toEqual([join(downloads.path, 'codiff_1.9.3_amd64.deb')]);
  expect(await readFile(join(downloads.path, 'codiff_1.9.3_amd64.deb'), 'utf8')).toBe('deb-bytes');
});

test('applyUpdate reports an error when no matching asset exists', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await using downloads = await createTemporaryDirectory('codiff-downloads-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(releaseJson('1.9.3'));
  });

  const updater = createUpdater({
    arch: 'x64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    downloadDirectory: downloads.path,
    isPackaged: true,
    openPath: async () => '',
    platform: 'freebsd',
    releaseUrl: `${origin}/`,
    strategy: 'download',
  });

  expect((await updater.applyUpdate()).phase).toBe('error');
});

test('concurrent applyUpdate calls download the installer only once', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await using downloads = await createTemporaryDirectory('codiff-downloads-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  let assetRequests = 0;
  const { disposable: _server, origin } = await startReleaseServer((request, response) => {
    if (request.url === '/asset.deb') {
      assetRequests++;
      response.end('deb-bytes');
      return;
    }

    response.setHeader('content-type', 'application/json');
    response.end(
      releaseJson('1.9.3', [
        { browser_download_url: `${origin}/asset.deb`, name: 'codiff_1.9.3_amd64.deb' },
      ]),
    );
  });

  const opened: Array<string> = [];
  const updater = createUpdater({
    arch: 'x64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    downloadDirectory: downloads.path,
    isPackaged: true,
    linuxFlavor: 'deb',
    openPath: async (path) => {
      opened.push(path);
      return '';
    },
    platform: 'linux',
    releaseUrl: `${origin}/`,
    strategy: 'download',
  });

  await Promise.all([updater.applyUpdate(), updater.applyUpdate()]);

  expect(assetRequests).toBe(1);
  expect(opened.length).toBe(1);
});

test('applyUpdate reports an error when the installer cannot be opened', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await using downloads = await createTemporaryDirectory('codiff-downloads-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const { disposable: _server, origin } = await startReleaseServer((request, response) => {
    if (request.url === '/asset.deb') {
      response.end('deb-bytes');
      return;
    }

    response.setHeader('content-type', 'application/json');
    response.end(
      releaseJson('1.9.3', [
        { browser_download_url: `${origin}/asset.deb`, name: 'codiff_1.9.3_amd64.deb' },
      ]),
    );
  });

  const updater = createUpdater({
    arch: 'x64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    downloadDirectory: downloads.path,
    isPackaged: true,
    linuxFlavor: 'deb',
    openPath: async () => 'No application found to open the file.',
    platform: 'linux',
    releaseUrl: `${origin}/`,
    strategy: 'download',
  });

  const status = await updater.applyUpdate();

  expect(status.phase).toBe('error');
  expect(status.message).toContain('No application found');
});

test('a dismissal during an in-flight check is not erased', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  let releaseResponse = () => {};
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    releaseResponse = () => {
      response.setHeader('content-type', 'application/json');
      response.end(releaseJson('1.9.3'));
    };
  });

  await writeState(directory.path, {
    lastCheckedAt: '2026-01-01T00:00:00.000Z',
    latestVersion: '1.9.3',
  });

  const updater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  const check = updater.checkForUpdates();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  updater.dismissUpdate();
  releaseResponse();
  const status = await check;

  expect(status).toEqual({ currentVersion: '1.9.2', phase: 'idle' });

  const persisted = JSON.parse(
    await readFile(join(directory.path, 'update-state.json'), 'utf8'),
  ) as { dismissedVersion?: string };
  expect(persisted.dismissedVersion).toBe('1.9.3');
});

test('a forced check clears the dismissal and resurfaces the update', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(releaseJson('1.9.3'));
  });

  await writeState(directory.path, {
    dismissedVersion: '1.9.3',
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const updater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  const status = await updater.checkForUpdates({ force: true });

  expect(status).toEqual({ currentVersion: '1.9.2', phase: 'available', version: '1.9.3' });

  const persisted = JSON.parse(
    await readFile(join(directory.path, 'update-state.json'), 'utf8'),
  ) as { dismissedVersion?: string };
  expect(persisted.dismissedVersion).toBeUndefined();
});

test('concurrent checks run one at a time and the newest result wins', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const pending: Array<(version: string) => void> = [];
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    pending.push((version) => {
      response.setHeader('content-type', 'application/json');
      response.end(releaseJson(version));
    });
  });

  await writeState(directory.path, {
    lastCheckedAt: '2026-01-01T00:00:00.000Z',
    latestVersion: '1.9.2',
  });

  const updater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  const scheduled = updater.checkForUpdates();
  await waitFor(() => pending.length === 1);
  const forced = updater.checkForUpdates({ force: true });

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  expect(pending.length).toBe(1);

  pending[0]('1.9.3');
  expect(await scheduled).toEqual({
    currentVersion: '1.9.2',
    phase: 'available',
    version: '1.9.3',
  });

  await waitFor(() => pending.length === 2);
  pending[1]('1.9.4');
  expect(await forced).toEqual({ currentVersion: '1.9.2', phase: 'available', version: '1.9.4' });

  const persisted = JSON.parse(
    await readFile(join(directory.path, 'update-state.json'), 'utf8'),
  ) as { latestVersion: string };
  expect(persisted.latestVersion).toBe('1.9.4');
});

test('a forced check keeps a dismissal made while it was in flight', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const pending: Array<(version: string) => void> = [];
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    pending.push((version) => {
      response.setHeader('content-type', 'application/json');
      response.end(releaseJson(version));
    });
  });

  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const updater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  const forced = updater.checkForUpdates({ force: true });
  await waitFor(() => pending.length === 1);
  updater.dismissUpdate();
  pending[0]('1.9.4');
  await forced;

  const persisted = JSON.parse(
    await readFile(join(directory.path, 'update-state.json'), 'utf8'),
  ) as { dismissedVersion?: string };
  expect(persisted.dismissedVersion).toBe('1.9.3');
});

test('a check completion does not cancel an active Squirrel update', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const pending: Array<(version: string) => void> = [];
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    pending.push((version) => {
      response.setHeader('content-type', 'application/json');
      response.end(releaseJson(version));
    });
  });

  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const autoUpdater = new FakeAutoUpdater();
  const updater = createUpdater({
    arch: 'arm64',
    autoUpdater,
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  const check = updater.checkForUpdates({ force: true });
  await waitFor(() => pending.length === 1);
  await updater.applyUpdate();
  pending[0]('1.9.3');
  await check;

  expect(updater.getStatus().phase).toBe('updating');

  autoUpdater.emit('update-downloaded');
  expect(autoUpdater.quitAndInstallCalls).toBe(1);
});

test('a forced check failure belongs only to its own caller', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const pending: Array<(respond: { status?: number; version?: string }) => void> = [];
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    pending.push(({ status: statusCode, version }) => {
      if (statusCode) {
        response.statusCode = statusCode;
        response.end('nope');
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(releaseJson(version ?? '0.0.1'));
    });
  });

  await writeState(directory.path, {
    lastCheckedAt: '2026-01-01T00:00:00.000Z',
    latestVersion: '1.9.2',
  });

  const log: Array<string> = [];
  const updater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    log: (message) => log.push(message),
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  const first = updater.checkForUpdates({ force: true });
  await waitFor(() => pending.length === 1);
  const second = updater.checkForUpdates({ force: true });

  pending[0]({ status: 500 });
  await expect(first).rejects.toThrow();

  await waitFor(() => pending.length === 2);
  pending[1]({ version: '1.9.4' });
  await expect(second).resolves.toEqual({
    currentVersion: '1.9.2',
    phase: 'available',
    version: '1.9.4',
  });
  expect(log.length).toBe(1);
});

test('a queued check cannot discard a successful forced result', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const pending: Array<(version: string) => void> = [];
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    pending.push((version) => {
      response.setHeader('content-type', 'application/json');
      response.end(releaseJson(version));
    });
  });

  await writeState(directory.path, {
    lastCheckedAt: '2026-01-01T00:00:00.000Z',
    latestVersion: '1.9.2',
  });

  const updater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  const forced = updater.checkForUpdates({ force: true });
  await waitFor(() => pending.length === 1);
  const scheduled = updater.checkForUpdates();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));

  pending[0]('1.9.4');

  expect(await forced).toEqual({ currentVersion: '1.9.2', phase: 'available', version: '1.9.4' });
  expect(await scheduled).toEqual({
    currentVersion: '1.9.2',
    phase: 'available',
    version: '1.9.4',
  });
  expect(pending.length).toBe(1);

  const persisted = JSON.parse(
    await readFile(join(directory.path, 'update-state.json'), 'utf8'),
  ) as { latestVersion: string };
  expect(persisted.latestVersion).toBe('1.9.4');
});

test('a check completion does not erase an apply failure', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const pending: Array<(version: string) => void> = [];
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    pending.push((version) => {
      response.setHeader('content-type', 'application/json');
      response.end(releaseJson(version));
    });
  });

  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const autoUpdater = new FakeAutoUpdater();
  const updater = createUpdater({
    arch: 'arm64',
    autoUpdater,
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  const check = updater.checkForUpdates({ force: true });
  await waitFor(() => pending.length === 1);
  await updater.applyUpdate();
  autoUpdater.emit('error', new Error('Squirrel download failed'));
  pending[0]('1.9.3');
  const status = await check;

  expect(status.phase).toBe('error');
  expect(status.message).toContain('Squirrel download failed');
  expect(updater.getStatus().phase).toBe('error');
});

test('a retry that fails identically still outlives a completing check', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const pending: Array<(version: string) => void> = [];
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    pending.push((version) => {
      response.setHeader('content-type', 'application/json');
      response.end(releaseJson(version));
    });
  });

  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const autoUpdater = new FakeAutoUpdater();
  autoUpdater.setFeedURL = () => {
    throw new Error('Could not set the update feed.');
  };
  const updater = createUpdater({
    arch: 'arm64',
    autoUpdater,
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  await updater.applyUpdate();
  expect(updater.getStatus().phase).toBe('error');

  const check = updater.checkForUpdates({ force: true });
  await waitFor(() => pending.length === 1);
  await updater.applyUpdate();
  pending[0]('1.9.3');
  await check;

  expect(updater.getStatus().phase).toBe('error');
  expect(updater.getStatus().message).toContain('Could not set the update feed.');
});

test('a dismissal made after a forced check was queued survives it', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const pending: Array<(version: string) => void> = [];
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    pending.push((version) => {
      response.setHeader('content-type', 'application/json');
      response.end(releaseJson(version));
    });
  });

  await writeState(directory.path, {
    lastCheckedAt: '2026-01-01T00:00:00.000Z',
    latestVersion: '1.9.3',
  });

  const updater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  const scheduled = updater.checkForUpdates();
  await waitFor(() => pending.length === 1);
  const forced = updater.checkForUpdates({ force: true });
  updater.dismissUpdate();

  pending[0]('1.9.3');
  await scheduled;
  await waitFor(() => pending.length === 2);
  pending[1]('1.9.3');

  expect(await forced).toEqual({ currentVersion: '1.9.2', phase: 'idle' });

  const persisted = JSON.parse(
    await readFile(join(directory.path, 'update-state.json'), 'utf8'),
  ) as { dismissedVersion?: string };
  expect(persisted.dismissedVersion).toBe('1.9.3');
});

test('an apply failure after a check was queued survives its completion', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const pending: Array<(version: string) => void> = [];
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    pending.push((version) => {
      response.setHeader('content-type', 'application/json');
      response.end(releaseJson(version));
    });
  });

  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const autoUpdater = new FakeAutoUpdater();
  const updater = createUpdater({
    arch: 'arm64',
    autoUpdater,
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  const forced = updater.checkForUpdates({ force: true });
  await waitFor(() => pending.length === 1);
  const scheduled = updater.checkForUpdates();

  await updater.applyUpdate();
  autoUpdater.emit('error', new Error('Squirrel download failed'));

  pending[0]('1.9.3');
  await forced;
  await scheduled;

  expect(updater.getStatus().phase).toBe('error');
  expect(updater.getStatus().message).toContain('Squirrel download failed');
});

test('applyUpdate is a no-op unless an update is available', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');

  const autoUpdater = new FakeAutoUpdater();
  const updater = createUpdater({
    arch: 'arm64',
    autoUpdater,
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    strategy: 'squirrel',
  });

  expect((await updater.applyUpdate()).phase).toBe('idle');
  expect(autoUpdater.checkForUpdatesCalls).toBe(0);
  expect(autoUpdater.feedURL).toBeNull();
});
