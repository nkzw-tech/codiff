import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getGitTestEnvironmentForSubprocess } from '../../../core/__tests__/helpers/git.ts';
import { createTemporaryDirectory } from '../../../core/__tests__/helpers/resources.ts';

const execFileAsync = promisify(execFile);

export const createTemporaryGitRepository = async (prefix: string) => {
  const directory = await createTemporaryDirectory(prefix);
  try {
    await execFileAsync('git', ['-C', directory.path, 'init', '--quiet'], {
      env: getGitTestEnvironmentForSubprocess(),
    });
    return directory;
  } catch (error) {
    await directory[Symbol.asyncDispose]();
    throw error;
  }
};
