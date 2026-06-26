// @ts-check

const { execFileSync } = require('node:child_process');

/** @param {string} repositoryPath @param {ReadonlyArray<string>} args */
const gitSucceeds = (repositoryPath, args) => {
  try {
    execFileSync('git', ['-C', repositoryPath, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
};

/** @param {string} repositoryPath @param {ReadonlyArray<string>} args */
const arcSucceeds = (repositoryPath, args) => {
  try {
    execFileSync('arc', args, {
      cwd: repositoryPath,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
};

/** @param {string} repositoryPath */
const shouldUseArcRepository = (repositoryPath) => arcSucceeds(repositoryPath, ['root']);

module.exports = {
  arcSucceeds,
  shouldUseArcRepository,
};
