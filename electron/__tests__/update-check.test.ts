import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  bindDisposableHttpServer,
  createTemporaryDirectory,
} from '../../core/__tests__/helpers/resources.ts';

type UpdateState = {
  dismissedVersion?: string;
  lastCheckedAt: string;
  latestVersion: string;
};

const require = createRequire(import.meta.url);
const {
  extractVersionFromTag,
  fetchLatestRelease,
  getAvailableUpdate,
  isNewerVersion,
  LATEST_RELEASE_URL,
  readUpdateState,
  releasePageUrl,
  shouldCheckForUpdates,
  UPDATE_CHECK_INTERVAL_MS,
  updateFeedUrl,
  writeUpdateState,
} = require('../update-check.cjs') as {
  extractVersionFromTag: (tag: string) => string | null;
  fetchLatestRelease: (url?: string) => Promise<{
    assets: ReadonlyArray<{ name: string; url: string }>;
    version: string;
  }>;
  getAvailableUpdate: (
    state: UpdateState | null,
    currentVersion: string,
  ) => { version: string } | null;
  isNewerVersion: (latest: string, current: string) => boolean;
  LATEST_RELEASE_URL: string;
  readUpdateState: (configDir?: string) => UpdateState | null;
  releasePageUrl: (version: string) => string;
  shouldCheckForUpdates: (state: UpdateState | null, now: number) => boolean;
  UPDATE_CHECK_INTERVAL_MS: number;
  updateFeedUrl: (platform: string, arch: string, version: string) => string;
  writeUpdateState: (state: UpdateState, configDir?: string) => void;
};

const validState: UpdateState = {
  lastCheckedAt: '2026-07-28T10:00:00.000Z',
  latestVersion: '1.9.3',
};

test('isNewerVersion detects newer patch, minor and major versions', () => {
  expect(isNewerVersion('1.9.3', '1.9.2')).toBe(true);
  expect(isNewerVersion('1.10.0', '1.9.2')).toBe(true);
  expect(isNewerVersion('2.0.0', '1.9.2')).toBe(true);
});

test('isNewerVersion compares components numerically, not lexicographically', () => {
  expect(isNewerVersion('1.10.0', '1.9.9')).toBe(true);
  expect(isNewerVersion('1.9.10', '1.9.9')).toBe(true);
});

test('isNewerVersion returns false for equal or older versions', () => {
  expect(isNewerVersion('1.9.2', '1.9.2')).toBe(false);
  expect(isNewerVersion('1.9.1', '1.9.2')).toBe(false);
  expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false);
});

test('isNewerVersion treats prerelease or malformed versions as not newer', () => {
  expect(isNewerVersion('1.10.0-beta.1', '1.9.2')).toBe(false);
  expect(isNewerVersion('1.10', '1.9.2')).toBe(false);
  expect(isNewerVersion('not-a-version', '1.9.2')).toBe(false);
  expect(isNewerVersion('1.10.0', 'not-a-version')).toBe(false);
});

test('extractVersionFromTag strips the leading v', () => {
  expect(extractVersionFromTag('v1.9.3')).toBe('1.9.3');
  expect(extractVersionFromTag('1.9.3')).toBe('1.9.3');
});

test('extractVersionFromTag rejects tags that are not plain versions', () => {
  expect(extractVersionFromTag('v1.9.3-beta.1')).toBeNull();
  expect(extractVersionFromTag('release-1.9.3')).toBeNull();
  expect(extractVersionFromTag('')).toBeNull();
});

test('readUpdateState returns null when the file does not exist', async () => {
  await using directory = await createTemporaryDirectory('codiff-update-');
  expect(readUpdateState(directory.path)).toBeNull();
});

test('readUpdateState returns null for corrupt JSON', async () => {
  await using directory = await createTemporaryDirectory('codiff-update-');
  await writeFile(join(directory.path, 'update-state.json'), '{not valid json');
  expect(readUpdateState(directory.path)).toBeNull();
});

test('readUpdateState returns null when fields are missing or invalid', async () => {
  await using directory = await createTemporaryDirectory('codiff-update-');
  await writeFile(
    join(directory.path, 'update-state.json'),
    JSON.stringify({ lastCheckedAt: '2026-07-28T10:00:00.000Z' }),
  );
  expect(readUpdateState(directory.path)).toBeNull();

  await writeFile(
    join(directory.path, 'update-state.json'),
    JSON.stringify({ ...validState, lastCheckedAt: 'not a date' }),
  );
  expect(readUpdateState(directory.path)).toBeNull();
});

test('writeUpdateState round-trips and creates the directory', async () => {
  await using directory = await createTemporaryDirectory('codiff-update-');
  const nested = join(directory.path, 'nested');
  const state = { ...validState, dismissedVersion: '1.9.3' };
  writeUpdateState(state, nested);
  expect(readUpdateState(nested)).toEqual(state);
});

test('readUpdateState drops an invalid dismissedVersion but keeps the rest', async () => {
  await using directory = await createTemporaryDirectory('codiff-update-');
  await writeFile(
    join(directory.path, 'update-state.json'),
    JSON.stringify({ ...validState, dismissedVersion: 42 }),
  );
  expect(readUpdateState(directory.path)).toEqual(validState);
});

test('shouldCheckForUpdates returns true without previous state', () => {
  expect(shouldCheckForUpdates(null, Date.now())).toBe(true);
});

test('shouldCheckForUpdates respects the check interval', () => {
  const now = Date.parse('2026-07-28T12:00:00.000Z');
  const recent = { ...validState, lastCheckedAt: '2026-07-28T11:00:00.000Z' };
  expect(shouldCheckForUpdates(recent, now)).toBe(false);

  const stale = { ...validState, lastCheckedAt: '2026-07-27T11:00:00.000Z' };
  expect(shouldCheckForUpdates(stale, now)).toBe(true);
});

test('shouldCheckForUpdates returns true for an unparseable timestamp', () => {
  expect(shouldCheckForUpdates({ ...validState, lastCheckedAt: 'not a date' }, Date.now())).toBe(
    true,
  );
});

test('UPDATE_CHECK_INTERVAL_MS is twenty hours', () => {
  expect(UPDATE_CHECK_INTERVAL_MS).toBe(20 * 60 * 60 * 1000);
});

test('getAvailableUpdate returns the newer version', () => {
  expect(getAvailableUpdate(validState, '1.9.2')).toEqual({ version: '1.9.3' });
});

test('getAvailableUpdate returns null without state or without a newer version', () => {
  expect(getAvailableUpdate(null, '1.9.2')).toBeNull();
  expect(getAvailableUpdate(validState, '1.9.3')).toBeNull();
  expect(getAvailableUpdate(validState, '2.0.0')).toBeNull();
});

test('getAvailableUpdate returns null when the latest version was dismissed', () => {
  expect(getAvailableUpdate({ ...validState, dismissedVersion: '1.9.3' }, '1.9.2')).toBeNull();
});

test('getAvailableUpdate resurfaces after a dismissed version is superseded', () => {
  const state = { ...validState, dismissedVersion: '1.9.3', latestVersion: '1.9.4' };
  expect(getAvailableUpdate(state, '1.9.2')).toEqual({ version: '1.9.4' });
});

test('LATEST_RELEASE_URL points at the codiff repository', () => {
  expect(LATEST_RELEASE_URL).toBe('https://api.github.com/repos/nkzw-tech/codiff/releases/latest');
});

test('updateFeedUrl targets update.electronjs.org for the current install', () => {
  expect(updateFeedUrl('darwin', 'arm64', '1.9.2')).toBe(
    'https://update.electronjs.org/nkzw-tech/codiff/darwin-arm64/1.9.2',
  );
});

test('releasePageUrl links to the tagged release', () => {
  expect(releasePageUrl('1.9.3')).toBe('https://github.com/nkzw-tech/codiff/releases/tag/v1.9.3');
});

test('fetchLatestRelease parses the release and sends a User-Agent', async () => {
  let userAgent: string | undefined;
  const server = createServer((request, response) => {
    userAgent = request.headers['user-agent'];
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        assets: [
          {
            browser_download_url:
              'https://github.com/nkzw-tech/codiff/releases/download/v1.9.3/Codiff-darwin-arm64-1.9.3.zip',
            digest: 'sha256:4db4acfef44780957e2801700008c94399f57d84f7971a948a3e2851c1366175',
            name: 'Codiff-darwin-arm64-1.9.3.zip',
          },
        ],
        tag_name: 'v1.9.3',
      }),
    );
  });
  await using _ = await bindDisposableHttpServer(server);
  const port = (server.address() as { port: number }).port;

  const release = await fetchLatestRelease(`http://127.0.0.1:${port}/`);

  expect(release.version).toBe('1.9.3');
  expect(release.assets).toEqual([
    {
      digest: 'sha256:4db4acfef44780957e2801700008c94399f57d84f7971a948a3e2851c1366175',
      name: 'Codiff-darwin-arm64-1.9.3.zip',
      url: 'https://github.com/nkzw-tech/codiff/releases/download/v1.9.3/Codiff-darwin-arm64-1.9.3.zip',
    },
  ]);
  expect(userAgent).toBeTruthy();
});

test('fetchLatestRelease rejects on a non-2xx response', async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 500;
    response.end('nope');
  });
  await using _ = await bindDisposableHttpServer(server);
  const port = (server.address() as { port: number }).port;

  await expect(fetchLatestRelease(`http://127.0.0.1:${port}/`)).rejects.toThrow();
});

test('fetchLatestRelease rejects when the tag is missing or not a version', async () => {
  let tagName = 'v2.0.0-beta.1';
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ assets: [], tag_name: tagName }));
  });
  await using _ = await bindDisposableHttpServer(server);
  const port = (server.address() as { port: number }).port;

  await expect(fetchLatestRelease(`http://127.0.0.1:${port}/`)).rejects.toThrow();

  tagName = '';
  await expect(fetchLatestRelease(`http://127.0.0.1:${port}/`)).rejects.toThrow();
});

test('fetchLatestRelease tolerates releases without assets', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ tag_name: 'v1.9.3' }));
  });
  await using _ = await bindDisposableHttpServer(server);
  const port = (server.address() as { port: number }).port;

  const release = await fetchLatestRelease(`http://127.0.0.1:${port}/`);
  expect(release.version).toBe('1.9.3');
  expect(release.assets).toEqual([]);
});
