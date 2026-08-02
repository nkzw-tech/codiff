import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
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
  strategy?: 'download' | 'manual' | 'squirrel';
  version?: string;
};

type Updater = {
  applyLatest: () => Promise<UpdateStatus>;
  applyUpdate: () => Promise<UpdateStatus>;
  checkForUpdates: (options?: { force?: boolean }) => Promise<UpdateStatus>;
  dismissUpdate: () => UpdateStatus;
  getStatus: () => UpdateStatus;
};

type ReleaseAsset = { digest?: string; name: string; url: string };

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
    openExternal?: (url: string) => Promise<void>;
    openPath?: (path: string) => Promise<string>;
    platform: string;
    releaseUrl?: string;
    strategy: 'download' | 'manual' | 'squirrel';
    updatesEnabled?: boolean;
  }) => Updater;
  pickReleaseAsset: (
    assets: ReadonlyArray<ReleaseAsset>,
    options: { arch: string; linuxFlavor?: 'deb' | 'rpm' | null; platform: string },
  ) => ReleaseAsset | null;
  resolveUpdateStrategy: (options: {
    hasSquirrelUpdateExe: boolean;
    platform: string;
  }) => 'download' | 'manual' | 'squirrel';
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

const sha256 = (data: string) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

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
  expect(resolveUpdateStrategy({ hasSquirrelUpdateExe: false, platform: 'win32' })).toBe('manual');
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

test('pickReleaseAsset matches the Linux installer for the running architecture', () => {
  const assets = [
    { name: 'codiff_1.9.3_amd64.deb', url: 'https://example.com/amd64.deb' },
    { name: 'codiff_1.9.3_arm64.deb', url: 'https://example.com/arm64.deb' },
    { name: 'codiff-1.9.3-1.x86_64.rpm', url: 'https://example.com/x86_64.rpm' },
    { name: 'codiff-1.9.3-1.aarch64.rpm', url: 'https://example.com/aarch64.rpm' },
  ];

  expect(
    pickReleaseAsset(assets, { arch: 'x64', linuxFlavor: 'deb', platform: 'linux' })?.name,
  ).toBe('codiff_1.9.3_amd64.deb');
  expect(
    pickReleaseAsset(assets, { arch: 'arm64', linuxFlavor: 'deb', platform: 'linux' })?.name,
  ).toBe('codiff_1.9.3_arm64.deb');
  expect(
    pickReleaseAsset(assets, { arch: 'x64', linuxFlavor: 'rpm', platform: 'linux' })?.name,
  ).toBe('codiff-1.9.3-1.x86_64.rpm');
  expect(
    pickReleaseAsset(assets, { arch: 'arm64', linuxFlavor: 'rpm', platform: 'linux' })?.name,
  ).toBe('codiff-1.9.3-1.aarch64.rpm');
});

test('pickReleaseAsset refuses a Linux installer built for another architecture', () => {
  const amd64Only = [{ name: 'codiff_1.9.3_amd64.deb', url: 'https://example.com/amd64.deb' }];

  expect(
    pickReleaseAsset(amd64Only, { arch: 'arm64', linuxFlavor: 'deb', platform: 'linux' }),
  ).toBeNull();
  expect(
    pickReleaseAsset([{ name: 'codiff_1.9.3.deb', url: 'https://example.com/codiff.deb' }], {
      arch: 'arm64',
      linuxFlavor: 'deb',
      platform: 'linux',
    })?.name,
  ).toBe('codiff_1.9.3.deb');
});

test('pickReleaseAsset refuses an asset whose name is not a plain file name', () => {
  const traversal = [
    { name: '../codiff_1.9.3_amd64.deb', url: 'https://example.com/traversal.deb' },
  ];

  expect(
    pickReleaseAsset(traversal, { arch: 'x64', linuxFlavor: 'deb', platform: 'linux' }),
  ).toBeNull();
  expect(
    pickReleaseAsset([{ name: 'darwin-arm64/../evil.zip', url: 'https://example.com/evil.zip' }], {
      arch: 'arm64',
      platform: 'darwin',
    }),
  ).toBeNull();
});

test('a traversal asset name cannot reach files outside the staging area', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await using downloads = await createTemporaryDirectory('codiff-downloads-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });
  await writeFile(join(downloads.path, 'codiff_1.9.3_amd64.deb'), 'unrelated user file');

  const { disposable: _server, origin } = await startReleaseServer((request, response) => {
    if (request.url === '/asset.deb') {
      response.end('tampered-bytes');
      return;
    }

    response.setHeader('content-type', 'application/json');
    response.end(
      releaseJson('1.9.3', [
        {
          browser_download_url: `${origin}/asset.deb`,
          digest: sha256('deb-bytes'),
          name: '../codiff_1.9.3_amd64.deb',
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

  expect(status.phase).toBe('error');
  expect(opened).toEqual([]);
  expect(await readFile(join(downloads.path, 'codiff_1.9.3_amd64.deb'), 'utf8')).toBe(
    'unrelated user file',
  );
  expect(await readdir(downloads.path)).toEqual(['codiff_1.9.3_amd64.deb']);
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
    strategy: 'squirrel',
    version: '1.9.3',
  });
});

test('a cached update stays hidden when update checks are disabled', async () => {
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
    updatesEnabled: false,
  });

  expect(updater.getStatus()).toEqual({
    currentVersion: '1.9.2',
    phase: 'idle',
    strategy: 'squirrel',
  });
});

test('an explicit check still reports updates when automatic checks are disabled', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(releaseJson('1.9.3'));
  });

  const updater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
    updatesEnabled: false,
  });

  const status = await updater.checkForUpdates({ force: true });

  expect(status).toEqual({
    currentVersion: '1.9.2',
    phase: 'available',
    strategy: 'squirrel',
    version: '1.9.3',
  });
});

test('reports the strategy that will apply the update', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const squirrelUpdater = createUpdater({
    arch: 'arm64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    platform: 'darwin',
    strategy: 'squirrel',
  });
  const downloadUpdater = createUpdater({
    arch: 'x64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    linuxFlavor: 'deb',
    platform: 'linux',
    strategy: 'download',
  });

  expect(squirrelUpdater.getStatus().strategy).toBe('squirrel');
  expect(downloadUpdater.getStatus().strategy).toBe('download');
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

  expect(status).toEqual({
    currentVersion: '1.9.2',
    phase: 'available',
    strategy: 'squirrel',
    version: '1.9.3',
  });
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

  expect(await updater.checkForUpdates()).toEqual({
    currentVersion: '1.9.2',
    phase: 'idle',
    strategy: 'squirrel',
  });
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
  expect(throttled).toEqual({
    currentVersion: '1.9.2',
    phase: 'available',
    strategy: 'squirrel',
    version: '1.9.3',
  });

  const forced = await updater.checkForUpdates({ force: true });
  expect(requests).toBe(1);
  expect(forced).toEqual({
    currentVersion: '1.9.2',
    phase: 'available',
    strategy: 'squirrel',
    version: '1.9.4',
  });
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

  expect(status).toEqual({
    currentVersion: '1.9.2',
    phase: 'available',
    strategy: 'squirrel',
    version: '1.9.3',
  });
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
    strategy: 'squirrel',
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

  expect(await updater.checkForUpdates()).toEqual({
    currentVersion: '1.9.2',
    phase: 'idle',
    strategy: 'squirrel',
  });
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

  expect(updater.dismissUpdate()).toEqual({
    currentVersion: '1.9.2',
    phase: 'idle',
    strategy: 'squirrel',
  });
  expect(notifications).toEqual([{ currentVersion: '1.9.2', phase: 'idle', strategy: 'squirrel' }]);

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

  expect(status).toEqual({
    currentVersion: '1.9.2',
    phase: 'updating',
    strategy: 'squirrel',
    version: '1.9.3',
  });
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
          digest: sha256('deb-bytes'),
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

  expect(status).toEqual({
    currentVersion: '1.9.2',
    phase: 'installerReady',
    strategy: 'download',
    version: '1.9.3',
  });
  expect(opened).toEqual([join(downloads.path, 'codiff_1.9.3_amd64.deb')]);
  expect(await readFile(join(downloads.path, 'codiff_1.9.3_amd64.deb'), 'utf8')).toBe('deb-bytes');
});

test('applyUpdate opens the release page for manual installs', async () => {
  // A plain Windows ZIP install has no Squirrel and opening a downloaded ZIP
  // would not replace the app, so the update hands off to the release page.
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const openedUrls: Array<string> = [];
  const updater = createUpdater({
    arch: 'x64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    openExternal: async (url) => {
      openedUrls.push(url);
    },
    platform: 'win32',
    strategy: 'manual',
  });

  const status = await updater.applyUpdate();

  expect(openedUrls).toEqual(['https://github.com/nkzw-tech/codiff/releases/tag/v1.9.3']);
  expect(status).toEqual({
    currentVersion: '1.9.2',
    phase: 'available',
    strategy: 'manual',
    version: '1.9.3',
  });
});

test('applyUpdate reports an error when the release page cannot be opened', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const updater = createUpdater({
    arch: 'x64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    openExternal: async () => {
      throw new Error('No browser is available.');
    },
    platform: 'win32',
    strategy: 'manual',
  });

  const status = await updater.applyUpdate();

  expect(status.phase).toBe('error');
  expect(status.message).toContain('No browser is available.');
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
        {
          browser_download_url: `${origin}/asset.deb`,
          digest: sha256('deb-bytes'),
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

  await Promise.all([updater.applyUpdate(), updater.applyUpdate()]);

  expect(assetRequests).toBe(1);
  expect(opened.length).toBe(1);
});

test('concurrent manual applies open the release page only once', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  let resolveOpen = () => {};
  const openedUrls: Array<string> = [];
  const updater = createUpdater({
    arch: 'x64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    openExternal: (url) => {
      openedUrls.push(url);
      return new Promise((resolveOpened) => {
        resolveOpen = resolveOpened;
      });
    },
    platform: 'win32',
    strategy: 'manual',
  });

  const first = updater.applyUpdate();
  const second = updater.applyUpdate();
  resolveOpen();

  await Promise.all([first, second]);

  expect(openedUrls.length).toBe(1);
  expect(updater.getStatus().phase).toBe('available');
});

test('applyLatest supersedes a pending manual hand-off', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(releaseJson('1.9.4'));
  });

  const openedUrls: Array<string> = [];
  let rejectFirstOpen: (error: Error) => void = () => {};
  let resolveSecondOpen = () => {};
  const updater = createUpdater({
    arch: 'x64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    openExternal: (url) => {
      openedUrls.push(url);
      return new Promise((resolveOpened, rejectOpened) => {
        if (openedUrls.length === 1) {
          rejectFirstOpen = rejectOpened;
        } else {
          resolveSecondOpen = resolveOpened;
        }
      });
    },
    platform: 'win32',
    releaseUrl: `${origin}/`,
    strategy: 'manual',
  });

  const pending = updater.applyUpdate();
  const latest = updater.applyLatest();

  // The forced check discovers 1.9.4 while the 1.9.3 hand-off is still
  // opening; the newer request must supersede it, not become a no-op.
  await waitFor(() => updater.getStatus().version === '1.9.4');
  rejectFirstOpen(new Error('No browser is available.'));
  await waitFor(() => openedUrls.length === 2);
  resolveSecondOpen();

  const [first, second] = await Promise.all([pending, latest]);

  expect(openedUrls).toEqual([
    'https://github.com/nkzw-tech/codiff/releases/tag/v1.9.3',
    'https://github.com/nkzw-tech/codiff/releases/tag/v1.9.4',
  ]);
  expect(first.phase).toBe('available');
  expect(second).toEqual({
    currentVersion: '1.9.2',
    phase: 'available',
    strategy: 'manual',
    version: '1.9.4',
  });
  expect(updater.getStatus().phase).toBe('available');
  expect(updater.getStatus().version).toBe('1.9.4');
});

test('a dismissal during a queued manual hand-off wins', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(releaseJson('1.9.4'));
  });

  const openedUrls: Array<string> = [];
  let rejectFirstOpen: (error: Error) => void = () => {};
  const updater = createUpdater({
    arch: 'x64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    openExternal: (url) => {
      openedUrls.push(url);
      return openedUrls.length === 1
        ? new Promise((_resolveOpened, rejectOpened) => {
            rejectFirstOpen = rejectOpened;
          })
        : Promise.reject(new Error('No browser is available.'));
    },
    platform: 'win32',
    releaseUrl: `${origin}/`,
    strategy: 'manual',
  });

  const pending = updater.applyUpdate();
  const latest = updater.applyLatest();
  await waitFor(() => updater.getStatus().version === '1.9.4');

  // The dismissal arrives while the 1.9.4 hand-off is still queued behind the
  // hanging 1.9.3 open; it must win over both once they settle.
  updater.dismissUpdate();
  rejectFirstOpen(new Error('No browser is available.'));

  const [first, second] = await Promise.all([pending, latest]);

  expect(openedUrls).toEqual(['https://github.com/nkzw-tech/codiff/releases/tag/v1.9.3']);
  expect(first.phase).toBe('idle');
  expect(second.phase).toBe('idle');
  expect(updater.getStatus().phase).toBe('idle');
});

test('a fresh request after a dismissal does not share a dead hand-off', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(releaseJson('1.9.4'));
  });

  const openedUrls: Array<string> = [];
  let rejectFirstOpen: (error: Error) => void = () => {};
  let resolveSecondOpen = () => {};
  const updater = createUpdater({
    arch: 'x64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    openExternal: (url) => {
      openedUrls.push(url);
      return new Promise((resolveOpened, rejectOpened) => {
        if (openedUrls.length === 1) {
          rejectFirstOpen = rejectOpened;
        } else {
          resolveSecondOpen = resolveOpened;
        }
      });
    },
    platform: 'win32',
    releaseUrl: `${origin}/`,
    strategy: 'manual',
  });

  const pending = updater.applyUpdate();
  const invalidated = updater.applyLatest();
  await waitFor(() => updater.getStatus().version === '1.9.4');
  updater.dismissUpdate();

  // The dismissal killed the queued 1.9.4 hand-off; a fresh request for the
  // same version must queue its own hand-off instead of sharing the dead one.
  const fresh = updater.applyLatest();
  await waitFor(() => updater.getStatus().phase === 'available');
  rejectFirstOpen(new Error('No browser is available.'));
  await waitFor(() => openedUrls.length === 2);
  resolveSecondOpen();

  const [, , freshStatus] = await Promise.all([pending, invalidated, fresh]);

  expect(openedUrls).toEqual([
    'https://github.com/nkzw-tech/codiff/releases/tag/v1.9.3',
    'https://github.com/nkzw-tech/codiff/releases/tag/v1.9.4',
  ]);
  expect(freshStatus).toEqual({
    currentVersion: '1.9.2',
    phase: 'available',
    strategy: 'manual',
    version: '1.9.4',
  });
  expect(updater.getStatus().phase).toBe('available');
  expect(updater.getStatus().version).toBe('1.9.4');
});

test('a dismissal wins over a pending manual failure', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  let rejectOpen: (error: Error) => void = () => {};
  const updater = createUpdater({
    arch: 'x64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    openExternal: () =>
      new Promise((_resolveOpened, rejectOpened) => {
        rejectOpen = rejectOpened;
      }),
    platform: 'win32',
    strategy: 'manual',
  });

  const pending = updater.applyUpdate();
  updater.dismissUpdate();
  rejectOpen(new Error('No browser is available.'));

  const result = await pending;

  expect(result.phase).toBe('idle');
  expect(updater.getStatus().phase).toBe('idle');
});

test('a manual retry clears the error once the release page opens', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  let attempts = 0;
  const updater = createUpdater({
    arch: 'x64',
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    openExternal: async () => {
      if (++attempts === 1) {
        throw new Error('No browser is available.');
      }
    },
    platform: 'win32',
    strategy: 'manual',
  });

  expect((await updater.applyUpdate()).phase).toBe('error');

  const status = await updater.applyUpdate();

  expect(status.phase).toBe('available');
  expect(status.version).toBe('1.9.3');
});

test('applyUpdate refuses an installer that fails its integrity check', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await using downloads = await createTemporaryDirectory('codiff-downloads-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  const { disposable: _server, origin } = await startReleaseServer((request, response) => {
    if (request.url === '/asset.deb') {
      response.end('tampered-bytes');
      return;
    }

    response.setHeader('content-type', 'application/json');
    response.end(
      releaseJson('1.9.3', [
        {
          browser_download_url: `${origin}/asset.deb`,
          digest: sha256('deb-bytes'),
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

  expect(status.phase).toBe('error');
  expect(status.message).toContain('integrity check');
  expect(opened).toEqual([]);
  expect(existsSync(join(downloads.path, 'codiff_1.9.3_amd64.deb'))).toBe(false);
});

test('applyUpdate refuses an installer without a published checksum', async () => {
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

  expect(status.phase).toBe('error');
  expect(status.message).toContain('checksum');
  expect(opened).toEqual([]);
});

test('a failed download never touches an existing file with the installer name', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await using downloads = await createTemporaryDirectory('codiff-downloads-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });
  await writeFile(join(downloads.path, 'codiff_1.9.3_amd64.deb'), 'unrelated user file');

  const { disposable: _server, origin } = await startReleaseServer((request, response) => {
    if (request.url === '/asset.deb') {
      response.end('tampered-bytes');
      return;
    }

    response.setHeader('content-type', 'application/json');
    response.end(
      releaseJson('1.9.3', [
        {
          browser_download_url: `${origin}/asset.deb`,
          digest: sha256('deb-bytes'),
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

  expect(status.phase).toBe('error');
  expect(opened).toEqual([]);
  expect(await readFile(join(downloads.path, 'codiff_1.9.3_amd64.deb'), 'utf8')).toBe(
    'unrelated user file',
  );
  expect(await readdir(downloads.path)).toEqual(['codiff_1.9.3_amd64.deb']);
});

test('a verified installer lands next to an existing file with its name', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await using downloads = await createTemporaryDirectory('codiff-downloads-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });
  await writeFile(join(downloads.path, 'codiff_1.9.3_amd64.deb'), 'unrelated user file');

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
          digest: sha256('deb-bytes'),
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

  expect(status.phase).toBe('installerReady');
  expect(opened).toEqual([join(downloads.path, 'codiff_1.9.3_amd64 (1).deb')]);
  expect(await readFile(join(downloads.path, 'codiff_1.9.3_amd64 (1).deb'), 'utf8')).toBe(
    'deb-bytes',
  );
  expect(await readFile(join(downloads.path, 'codiff_1.9.3_amd64.deb'), 'utf8')).toBe(
    'unrelated user file',
  );
  expect((await readdir(downloads.path)).sort()).toEqual([
    'codiff_1.9.3_amd64 (1).deb',
    'codiff_1.9.3_amd64.deb',
  ]);
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
        {
          browser_download_url: `${origin}/asset.deb`,
          digest: sha256('deb-bytes'),
          name: 'codiff_1.9.3_amd64.deb',
        },
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

  expect(status).toEqual({ currentVersion: '1.9.2', phase: 'idle', strategy: 'squirrel' });

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

  expect(status).toEqual({
    currentVersion: '1.9.2',
    phase: 'available',
    strategy: 'squirrel',
    version: '1.9.3',
  });

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
    strategy: 'squirrel',
    version: '1.9.3',
  });

  await waitFor(() => pending.length === 2);
  pending[1]('1.9.4');
  expect(await forced).toEqual({
    currentVersion: '1.9.2',
    phase: 'available',
    strategy: 'squirrel',
    version: '1.9.4',
  });

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
    strategy: 'squirrel',
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

  expect(await forced).toEqual({
    currentVersion: '1.9.2',
    phase: 'available',
    strategy: 'squirrel',
    version: '1.9.4',
  });
  expect(await scheduled).toEqual({
    currentVersion: '1.9.2',
    phase: 'available',
    strategy: 'squirrel',
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

  expect(await forced).toEqual({ currentVersion: '1.9.2', phase: 'idle', strategy: 'squirrel' });

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

test('checks leave a handed-off installer alone until relaunch', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  await using downloads = await createTemporaryDirectory('codiff-downloads-');
  await writeState(directory.path, {
    lastCheckedAt: recentCheck(),
    latestVersion: '1.9.3',
  });

  let requests = 0;
  const { disposable: _server, origin } = await startReleaseServer((request, response) => {
    if (request.url === '/asset.deb') {
      response.end('deb-bytes');
      return;
    }

    requests++;
    response.setHeader('content-type', 'application/json');
    response.end(
      releaseJson('1.9.3', [
        {
          browser_download_url: `${origin}/asset.deb`,
          digest: sha256('deb-bytes'),
          name: 'codiff_1.9.3_amd64.deb',
        },
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
    openPath: async () => '',
    platform: 'linux',
    releaseUrl: `${origin}/`,
    strategy: 'download',
  });

  await updater.applyUpdate();
  expect(updater.getStatus().phase).toBe('installerReady');
  const requestsAfterApply = requests;

  expect((await updater.checkForUpdates()).phase).toBe('installerReady');
  expect((await updater.checkForUpdates({ force: true })).phase).toBe('installerReady');
  expect(requests).toBe(requestsAfterApply);
});

test('a throttled check does not erase an apply failure', async () => {
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
  autoUpdater.emit('error', new Error('Squirrel download failed'));
  expect(updater.getStatus().phase).toBe('error');

  const status = await updater.checkForUpdates();

  expect(status.phase).toBe('error');
  expect(status.message).toContain('Squirrel download failed');
});

test('applyLatest force-checks and applies in one step', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(releaseJson('1.9.3'));
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

  const status = await updater.applyLatest();

  expect(status).toEqual({
    currentVersion: '1.9.2',
    phase: 'updating',
    strategy: 'squirrel',
    version: '1.9.3',
  });
  expect(autoUpdater.feedURL).toEqual({
    url: 'https://update.electronjs.org/nkzw-tech/codiff/darwin-arm64/1.9.2',
  });
  expect(autoUpdater.checkForUpdatesCalls).toBe(1);
});

test('applyLatest stays idle when already up to date', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(releaseJson('1.9.2'));
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

  expect(await updater.applyLatest()).toEqual({
    currentVersion: '1.9.2',
    phase: 'idle',
    strategy: 'squirrel',
  });
  expect(autoUpdater.feedURL).toBeNull();
  expect(autoUpdater.checkForUpdatesCalls).toBe(0);
});

test('applyLatest surfaces a failed check as an error status', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    response.statusCode = 500;
    response.end('nope');
  });

  const autoUpdater = new FakeAutoUpdater();
  const updater = createUpdater({
    arch: 'arm64',
    autoUpdater,
    configDir: directory.path,
    currentVersion: '1.9.2',
    isPackaged: true,
    log: () => {},
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  const status = await updater.applyLatest();

  expect(status.phase).toBe('error');
  expect(status.message).toBeTruthy();
  expect(updater.getStatus().phase).toBe('error');
  expect(autoUpdater.checkForUpdatesCalls).toBe(0);
});

test('a failed applyLatest check does not cancel an apply started meanwhile', async () => {
  await using directory = await createTemporaryDirectory('codiff-updater-');
  const pending: Array<() => void> = [];
  const { disposable: _server, origin } = await startReleaseServer((_request, response) => {
    pending.push(() => {
      response.statusCode = 500;
      response.end('nope');
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
    log: () => {},
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  const latest = updater.applyLatest();
  await waitFor(() => pending.length === 1);
  await updater.applyUpdate();
  pending[0]();
  await latest;

  expect(updater.getStatus().phase).toBe('updating');

  autoUpdater.emit('update-downloaded');
  expect(autoUpdater.quitAndInstallCalls).toBe(1);
});

test('an older failed applyLatest defers to a newer successful one', async () => {
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
    log: () => {},
    platform: 'darwin',
    releaseUrl: `${origin}/`,
    strategy: 'squirrel',
  });

  const first = updater.applyLatest();
  await waitFor(() => pending.length === 1);
  const second = updater.applyLatest();

  pending[0]({ status: 500 });
  await first;
  await waitFor(() => pending.length === 2);
  pending[1]({ version: '1.9.4' });
  const status = await second;

  expect(status).toEqual({
    currentVersion: '1.9.2',
    phase: 'updating',
    strategy: 'squirrel',
    version: '1.9.4',
  });
  expect(updater.getStatus().phase).toBe('updating');
  expect(autoUpdater.checkForUpdatesCalls).toBe(1);
});

test('a newer applyLatest owns the apply over an older successful one', async () => {
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

  const first = updater.applyLatest();
  await waitFor(() => pending.length === 1);
  const second = updater.applyLatest();

  pending[0]('1.9.3');
  await first;
  await waitFor(() => pending.length === 2);
  pending[1]('1.9.4');
  const status = await second;

  expect(status).toEqual({
    currentVersion: '1.9.2',
    phase: 'updating',
    strategy: 'squirrel',
    version: '1.9.4',
  });
  expect(updater.getStatus()).toEqual({
    currentVersion: '1.9.2',
    phase: 'updating',
    strategy: 'squirrel',
    version: '1.9.4',
  });
  expect(autoUpdater.checkForUpdatesCalls).toBe(1);
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
