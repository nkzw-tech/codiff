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
 * Environment for spawning CLIs on the user's behalf: the login shell fills
 * variables a GUI launch never inherited, such as `GH_TOKEN` or
 * `ANTHROPIC_API_KEY`, and the process environment wins for anything it
 * already defines.
 *
 * @returns {Promise<Record<string, string | undefined>>}
 */
const getCommandEnvironment = async () => ({
  ...(await getLoginShellEnvironment()),
  ...process.env,
});

/**
 * The environment of the user's interactive login shell, resolved once per
 * shell and cached. GUI launches inherit launchd's minimal environment, so variables
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

/**
 * Resolution settles no matter how the interactive login shell behaves: the deadline
 * force-kills a shell that ignores termination and releases a stdout pipe
 * kept open by a background child the shell left behind, the case where
 * `close` trails `exit` indefinitely. A dump the shell completed cleanly
 * before such a straggler is still used.
 *
 * @param {string} shell
 * @param {number} [timeout]
 * @returns {Promise<Readonly<Record<string, string>>>}
 */
const resolveLoginShellEnvironment = (shell, timeout = RESOLUTION_TIMEOUT) =>
  new Promise((resolve) => {
    const child = spawn(shell, ['-l', '-i', '-c', ENVIRONMENT_COMMAND], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    /** @type {Array<Buffer>} */
    const stdout = [];
    /** @param {number | null} code */
    const finish = (code) => {
      clearTimeout(deadline);
      resolve(code === 0 ? parseEnvironment(Buffer.concat(stdout).toString('utf8')) : {});
    };
    const deadline = setTimeout(() => {
      finish(child.exitCode);
      child.kill('SIGKILL');
      child.stdout.destroy();
    }, timeout);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.on('error', () => finish(null));
    child.on('close', finish);
  });

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

module.exports = {
  getCommandEnvironment,
  getLoginShellEnvironment,
  resolveLoginShellEnvironment,
};
