import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeGitTestDirectory } from './git.ts';

export const createTemporaryDirectorySync = (prefix: string) => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    [Symbol.dispose]() {
      rmSync(path, { force: true, recursive: true });
    },
  };
};

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
    [Symbol.dispose]() {
      process.chdir(previousCwd);
    },
  };
};

export const bindDisposableHttpServer = async (server: Server, host = '127.0.0.1') => {
  await new Promise<void>((resolveListen) => {
    server.listen(0, host, resolveListen);
  });
  return {
    ...server,
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
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
    [Symbol.dispose]() {
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
