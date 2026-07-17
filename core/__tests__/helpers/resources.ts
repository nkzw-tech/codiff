import { mkdtemp } from 'node:fs/promises';
/**
 * Test helpers that return `AsyncDisposable` values for `await using`.
 *
 * Factory names stay verb-based (`createTemporaryDirectory`, not `*Using` /
 * `*Disposable`); callers must bind with `await using`. Prefer
 * `withGitTestEnvironment` when a callback scope is enough.
 */
import { createServer, type RequestListener, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeGitTestDirectory } from './git.ts';

export const createTemporaryDirectory = async (prefix: string) => {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    async [Symbol.asyncDispose]() {
      await removeGitTestDirectory(path);
    },
  };
};

export const createTemporaryWorkingDirectory = (cwd: string) => {
  const previousCwd = process.cwd();
  process.chdir(cwd);
  return {
    async [Symbol.asyncDispose]() {
      process.chdir(previousCwd);
    },
  };
};

export const bindDisposableHttpServer = async (server: Server, host = '127.0.0.1') => {
  await new Promise<void>((resolveListen) => {
    server.listen(0, host, resolveListen);
  });
  return Object.assign(server, {
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  });
};

export const createDisposableHttpServer = async (handler: RequestListener, host = '127.0.0.1') =>
  bindDisposableHttpServer(createServer(handler), host);

export const createTemporaryEnvironment = (
  overrides: Readonly<Record<string, string | undefined>>,
) => {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return {
    async [Symbol.asyncDispose]() {
      for (const [key, value] of previous) {
        if (value == null) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
};
