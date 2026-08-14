import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** @param {string} repositoryPath */
export const createDefinitionNavigationRepository = (repositoryPath) => {
  mkdirSync(repositoryPath, { recursive: true });
  cpSync(join(fixtureRoot, 'base'), repositoryPath, { recursive: true });
  /** @param {ReadonlyArray<string>} args */
  const git = (args) =>
    execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim();
  git(['init', '--quiet']);
  git(['add', '.']);
  git([
    '-c',
    'user.name=Codiff Example',
    '-c',
    'user.email=codiff-example@localhost',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '--quiet',
    '-m',
    'Create definition navigation example',
  ]);
  cpSync(join(fixtureRoot, 'changes'), repositoryPath, { recursive: true });
  return repositoryPath;
};
