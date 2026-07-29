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

const brewOwnsCask = () => {
  throw new Error('Must not probe brew when up to date.');
};

test('resolveUpdateAction reports up to date for equal or older releases', () => {
  expect(
    resolveUpdateAction({
      brewOwnsCask,
      currentVersion: '1.9.2',
      isSourceCheckout: false,
      latestVersion: '1.9.2',
    }),
  ).toEqual({ kind: 'up-to-date' });
  expect(
    resolveUpdateAction({
      brewOwnsCask,
      currentVersion: '2.0.0',
      isSourceCheckout: false,
      latestVersion: '1.9.2',
    }),
  ).toEqual({ kind: 'up-to-date' });
});

test('resolveUpdateAction prefers source-checkout guidance over everything', () => {
  expect(
    resolveUpdateAction({
      brewOwnsCask: () => true,
      currentVersion: '1.9.2',
      isSourceCheckout: true,
      latestVersion: '1.9.3',
    }),
  ).toEqual({ kind: 'source-checkout', version: '1.9.3' });
});

test('resolveUpdateAction upgrades brew-owned installs through brew', () => {
  expect(
    resolveUpdateAction({
      brewOwnsCask: () => true,
      currentVersion: '1.9.2',
      isSourceCheckout: false,
      latestVersion: '1.9.3',
    }),
  ).toEqual({ kind: 'brew-upgrade', version: '1.9.3' });
});

test('resolveUpdateAction hands other installs to the app', () => {
  expect(
    resolveUpdateAction({
      brewOwnsCask: () => false,
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
    brewOwnsCask: () => false,
    currentVersion: '1.9.2',
    isSourceCheckout: false,
    log: (line) => lines.push(line),
    openApp: () => {
      throw new Error('Must not open the app.');
    },
    releaseUrl: url,
    runBrewUpgrade: () => {
      throw new Error('Must not run brew.');
    },
  });

  expect(exitCode).toBe(0);
  expect(lines.join('\n')).toContain('up to date');
});

test('runUpdateCommand runs brew for brew-owned installs and returns its exit code', async () => {
  const { disposable: _server, url } = await startReleaseServer('1.9.3');
  let upgrades = 0;

  const exitCode = await runUpdateCommand({
    brewOwnsCask: () => true,
    currentVersion: '1.9.2',
    isSourceCheckout: false,
    log: () => {},
    openApp: () => {},
    releaseUrl: url,
    runBrewUpgrade: () => {
      upgrades++;
      return 0;
    },
  });

  expect(exitCode).toBe(0);
  expect(upgrades).toBe(1);
});

test('runUpdateCommand opens the app for non-brew installs', async () => {
  const { disposable: _server, url } = await startReleaseServer('1.9.3');
  let opened = 0;
  const lines: Array<string> = [];

  const exitCode = await runUpdateCommand({
    brewOwnsCask: () => false,
    currentVersion: '1.9.2',
    isSourceCheckout: false,
    log: (line) => lines.push(line),
    openApp: () => {
      opened++;
    },
    releaseUrl: url,
    runBrewUpgrade: () => 1,
  });

  expect(exitCode).toBe(0);
  expect(opened).toBe(1);
  expect(lines.join('\n')).toContain('1.9.3');
});

test('runUpdateCommand prints manual guidance when the app cannot be opened', async () => {
  const { disposable: _server, url } = await startReleaseServer('1.9.3');
  const lines: Array<string> = [];

  const exitCode = await runUpdateCommand({
    brewOwnsCask: () => false,
    currentVersion: '1.9.2',
    isSourceCheckout: false,
    log: (line) => lines.push(line),
    openApp: null,
    releaseUrl: url,
    runBrewUpgrade: () => 1,
  });

  expect(exitCode).toBe(1);
  expect(lines.join('\n')).toContain('https://github.com/nkzw-tech/codiff/releases');
});

test('runUpdateCommand guides source checkouts instead of updating', async () => {
  const { disposable: _server, url } = await startReleaseServer('1.9.3');
  const lines: Array<string> = [];

  const exitCode = await runUpdateCommand({
    brewOwnsCask: () => true,
    currentVersion: '1.9.2',
    isSourceCheckout: true,
    log: (line) => lines.push(line),
    openApp: () => {
      throw new Error('Must not open the app.');
    },
    releaseUrl: url,
    runBrewUpgrade: () => {
      throw new Error('Must not run brew.');
    },
  });

  expect(exitCode).toBe(0);
  expect(lines.join('\n')).toContain('git pull');
});

test('runUpdateCommand fails cleanly when the release check fails', async () => {
  const { disposable: _server, url } = await startReleaseServer('1.9.3', 500);
  const lines: Array<string> = [];

  const exitCode = await runUpdateCommand({
    brewOwnsCask: () => false,
    currentVersion: '1.9.2',
    isSourceCheckout: false,
    log: (line) => lines.push(line),
    openApp: () => {},
    releaseUrl: url,
    runBrewUpgrade: () => 1,
  });

  expect(exitCode).toBe(1);
  expect(lines.join('\n')).toContain('could not check');
});
