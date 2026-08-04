// @ts-check

/**
 * CJS bridge to @nkzw/codiff-github (ESM).
 */

const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

/** @type {Promise<typeof import('../github/dist/index.mjs')> | null} */
let modulePromise = null;

const loadGitHubHistory = () => {
  if (!modulePromise) {
    const modulePath = join(__dirname, '../github/dist/index.mjs');
    modulePromise = import(pathToFileURL(modulePath).href);
  }
  return modulePromise;
};

module.exports = {
  loadGitHubHistory,
};
