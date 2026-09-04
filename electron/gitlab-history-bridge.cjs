// @ts-check

/**
 * CJS bridge to @nkzw/codiff-gitlab (ESM).
 */

const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

/** @type {Promise<typeof import('../gitlab/dist/index.mjs')> | null} */
let modulePromise = null;

const loadGitLabHistory = () => {
  if (!modulePromise) {
    const modulePath = join(__dirname, '../gitlab/dist/index.mjs');
    modulePromise = import(pathToFileURL(modulePath).href);
  }
  return modulePromise;
};

module.exports = {
  loadGitLabHistory,
};
