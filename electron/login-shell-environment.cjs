// @ts-check

const { spawn } = require('node:child_process');

// Marks where login shell startup noise (version manager banners, greetings)
// ends and the `env -0` dump begins.
const ENVIRONMENT_MARKER = '__CODIFF_LOGIN_SHELL_ENVIRONMENT__';
const ENVIRONMENT_COMMAND = `printf '${ENVIRONMENT_MARKER}'; /usr/bin/env -0`;
const RESOLUTION_TIMEOUT = 10_000;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @type {Map<string, Promise<Readonly<Record<string, string>>>>} */
const cache = new Map();

/**
 * @param {string} output
 * @returns {Readonly<Record<string, string>>}
 */
const parseEnvironment = (output) => {
  const markerIndex = output.indexOf(ENVIRONMENT_MARKER);
  if (markerIndex === -1) {
    return {};
  }

  /** @type {Record<string, string>} */
  const environment = {};
  for (const entry of output.slice(markerIndex + ENVIRONMENT_MARKER.length).split('\0')) {
    const separator = entry.indexOf('=');
    if (separator > 0 && VARIABLE_NAME.test(entry.slice(0, separator))) {
      environment[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
  }
  return environment;
};

/**
 * @param {string} shell
 * @returns {Promise<Readonly<Record<string, string>>>}
 */
const resolveLoginShellEnvironment = (shell) =>
  new Promise((resolve) => {
    const child = spawn(shell, ['-l', '-c', ENVIRONMENT_COMMAND], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: RESOLUTION_TIMEOUT,
    });
    /** @type {Array<Buffer>} */
    const stdout = [];

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.on('error', () => resolve({}));
    child.on('close', (code) =>
      resolve(code === 0 ? parseEnvironment(Buffer.concat(stdout).toString('utf8')) : {}),
    );
  });

/**
 * The environment of the user's login shell, resolved once per shell and
 * cached. GUI launches inherit launchd's minimal environment, so variables
 * like `GH_TOKEN` may only exist in the login shell; resolving them lets CLI
 * spawns behave the way they would in a terminal. Resolution failures yield
 * an empty environment instead of an error.
 *
 * @returns {Promise<Readonly<Record<string, string>>>}
 */
const getLoginShellEnvironment = () => {
  const shell = process.env.SHELL;
  if (!shell) {
    return Promise.resolve({});
  }

  let environment = cache.get(shell);
  if (!environment) {
    environment = resolveLoginShellEnvironment(shell);
    cache.set(shell, environment);
  }
  return environment;
};

module.exports = {
  getLoginShellEnvironment,
};
