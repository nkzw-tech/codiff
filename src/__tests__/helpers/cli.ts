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
    cleanup: () => rm(directory, { force: true, recursive: true }),
    directory,
    env: {
      ...process.env,
      OPEN_ARGS_FILE: logPath,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
    readArgs: async () => (await readFile(logPath, 'utf8')).trim().split('\n'),
    reset: () => writeFile(logPath, ''),
  };
};

export const createFakeCommandLogger = async (prefix: string, commandName: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const commandPath = join(directory, commandName);
  const logPath = join(directory, 'args.txt');

  await writeFile(commandPath, loggerScript);
  await chmod(commandPath, 0o755);

  return {
    cleanup: () => rm(directory, { force: true, recursive: true }),
    commandPath,
    directory,
    env: {
      ...process.env,
      OPEN_ARGS_FILE: logPath,
    },
    readArgs: async () => (await readFile(logPath, 'utf8')).trim().split('\n'),
  };
};
