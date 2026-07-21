import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loggerScript =
  '#!/bin/sh\nfor arg in "$@"; do\n  printf "%s\\n" "$arg" >> "$OPEN_ARGS_FILE"\ndone\n';

export const createFakeOpenLogger = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-app-helper-'));
  const fakeBin = join(directory, 'bin');
  const logPath = join(directory, 'open-args.txt');
  const openPath = join(fakeBin, 'open');

  await mkdir(fakeBin);
  await writeFile(openPath, loggerScript);
  await chmod(openPath, 0o755);

  return {
    directory,
    env: {
      ...process.env,
      OPEN_ARGS_FILE: logPath,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
    readArgs: async () => (await readFile(logPath, 'utf8')).trim().split('\n'),
    reset: () => writeFile(logPath, ''),
    async [Symbol.asyncDispose]() {
      await rm(directory, { force: true, recursive: true });
    },
  };
};

// Away from macOS the helper executes the Electron binary directly instead of
// going through `open`. `CODIFF_APP_COMMAND` points that lookup at a fake
// executable so the forwarded arguments can be inspected on any platform.
export const createFakeAppCommandLogger = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-app-command-'));
  const logPath = join(directory, 'app-args.txt');
  const commandPath = join(directory, 'codiff-app-command');

  await writeFile(commandPath, loggerScript);
  await chmod(commandPath, 0o755);

  return {
    commandPath,
    directory,
    env: {
      ...process.env,
      CODIFF_APP_COMMAND: commandPath,
      OPEN_ARGS_FILE: logPath,
    },
    // The helper detaches the app, so the log file appears asynchronously.
    readArgs: async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const contents = (await readFile(logPath, 'utf8')).trim();
          if (contents) {
            return contents.split('\n');
          }
        } catch {
          // The fake command has not written the log yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${logPath}.`);
    },
    async [Symbol.asyncDispose]() {
      await rm(directory, { force: true, recursive: true });
    },
  };
};

export const createFakeCommandLogger = async (prefix: string, commandName: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const commandPath = join(directory, commandName);
  const logPath = join(directory, 'args.txt');

  await writeFile(commandPath, loggerScript);
  await chmod(commandPath, 0o755);

  return {
    commandPath,
    directory,
    env: {
      ...process.env,
      OPEN_ARGS_FILE: logPath,
    },
    readArgs: async () => (await readFile(logPath, 'utf8')).trim().split('\n'),
    async [Symbol.asyncDispose]() {
      await rm(directory, { force: true, recursive: true });
    },
  };
};
