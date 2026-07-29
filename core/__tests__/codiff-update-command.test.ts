import { createServer } from 'node:http';
import { expect, test } from 'vite-plus/test';
import { resolveUpdateAction, runUpdateCommand } from '../../bin/update-command.js';
import { bindDisposableHttpServer } from './helpers/resources.ts';

const startReleaseServer = async (version: string, statusCode = 200) => {
  const server = createServer((_request, response) => {
    response.statusCode = statusCode;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ assets: [], tag_name: `v${version}` }));
  });
  const disposable = await bindDisposableHttpServer(server);
  const port = (server.address() as { port: number }).port;
  return { disposable, url: `http://127.0.0.1:${port}/` };
};

test('resolveUpdateAction reports up to date for equal or older releases', () => {
  expect(
    resolveUpdateAction({
      currentVersion: '1.9.2',
      isSourceCheckout: false,
      latestVersion: '1.9.2',
    }),
  ).toEqual({ kind: 'up-to-date' });
  expect(
    resolveUpdateAction({
      currentVersion: '2.0.0',
      isSourceCheckout: false,
      latestVersion: '1.9.2',
    }),
  ).toEqual({ kind: 'up-to-date' });
});

test('resolveUpdateAction prefers source-checkout guidance over everything', () => {
  expect(
    resolveUpdateAction({
      currentVersion: '1.9.2',
      isSourceCheckout: true,
      latestVersion: '1.9.3',
    }),
  ).toEqual({ kind: 'source-checkout', version: '1.9.3' });
});

test('resolveUpdateAction hands every packaged install to the app self-updater', () => {
  // Homebrew installs included: the cask is marked auto_updates, so the app
  // updating itself in place is the supported path and brew is never probed.
  expect(
    resolveUpdateAction({
      currentVersion: '1.9.2',
      isSourceCheckout: false,
      latestVersion: '1.9.3',
    }),
  ).toEqual({ kind: 'open-app', version: '1.9.3' });
});

test('runUpdateCommand reports up to date without touching brew or the app', async () => {
  const { disposable: _server, url } = await startReleaseServer('1.9.2');
  const lines: Array<string> = [];

  const exitCode = await runUpdateCommand({
    currentVersion: '1.9.2',
    isSourceCheckout: false,
    log: (line) => lines.push(line),
    openApp: () => {
      throw new Error('Must not open the app.');
    },
    releaseUrl: url,
  });

  expect(exitCode).toBe(0);
  expect(lines.join('\n')).toContain('up to date');
});

test('runUpdateCommand opens the app for non-brew installs', async () => {
  const { disposable: _server, url } = await startReleaseServer('1.9.3');
  let opened = 0;
  const lines: Array<string> = [];

  const exitCode = await runUpdateCommand({
    currentVersion: '1.9.2',
    isSourceCheckout: false,
    log: (line) => lines.push(line),
    openApp: () => {
      opened++;
    },
    releaseUrl: url,
  });

  expect(exitCode).toBe(0);
  expect(opened).toBe(1);
  expect(lines.join('\n')).toContain('1.9.3');
});

test('runUpdateCommand prints manual guidance when the app cannot be opened', async () => {
  const { disposable: _server, url } = await startReleaseServer('1.9.3');
  const lines: Array<string> = [];

  const exitCode = await runUpdateCommand({
    currentVersion: '1.9.2',
    isSourceCheckout: false,
    log: (line) => lines.push(line),
    openApp: null,
    releaseUrl: url,
  });

  expect(exitCode).toBe(1);
  expect(lines.join('\n')).toContain('https://github.com/nkzw-tech/codiff/releases');
});

test('runUpdateCommand guides source checkouts instead of updating', async () => {
  const { disposable: _server, url } = await startReleaseServer('1.9.3');
  const lines: Array<string> = [];

  const exitCode = await runUpdateCommand({
    currentVersion: '1.9.2',
    isSourceCheckout: true,
    log: (line) => lines.push(line),
    openApp: () => {
      throw new Error('Must not open the app.');
    },
    releaseUrl: url,
  });

  expect(exitCode).toBe(0);
  expect(lines.join('\n')).toContain('git pull');
});

test('runUpdateCommand fails cleanly when the release check fails', async () => {
  const { disposable: _server, url } = await startReleaseServer('1.9.3', 500);
  const lines: Array<string> = [];

  const exitCode = await runUpdateCommand({
    currentVersion: '1.9.2',
    isSourceCheckout: false,
    log: (line) => lines.push(line),
    openApp: () => {},
    releaseUrl: url,
  });

  expect(exitCode).toBe(1);
  expect(lines.join('\n')).toContain('could not check');
});
