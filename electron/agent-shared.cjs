// @ts-check

const { accessSync, constants, statSync } = require('node:fs');
const { delimiter, join } = require('node:path');

// Backend-neutral helpers shared by the Codex and Claude Code agent backends.

/** @param {unknown} value @param {string} [fallback] */
const oneLine = (value, fallback = '') =>
  (typeof value === 'string' ? value : fallback).replace(/\s+/g, ' ').trim();

/** @param {string} value @param {number} maxLength */
const truncate = (value, maxLength) => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated]`;
};

/** @param {unknown} value @param {string} [fallback] */
const cleanText = (value, fallback = '') =>
  oneLine(value, fallback).replace(/\s*\.{3}\[truncated]$/i, '');

/** @template T @param {unknown} value @param {ReadonlySet<T>} allowed @param {T} fallback */
const normalizeEnum = (value, allowed, fallback) =>
  allowed.has(/** @type {T} */ (value)) ? /** @type {T} */ (value) : fallback;

/** @param {string} message @returns {unknown} */
const parseJSONMessage = (message) => {
  try {
    return JSON.parse(message);
  } catch {
    const match = message.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('The agent did not return JSON.');
    }

    return JSON.parse(match[0]);
  }
};

/** @param {string} path */
const isExecutableFile = (path) => {
  try {
    return statSync(path).isFile() && (accessSync(path, constants.X_OK), true);
  } catch {
    return false;
  }
};

/** @param {string} command */
const getExecutableNames = (command) => {
  if (process.platform !== 'win32') {
    return [command];
  }

  const extensions = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
};

/** @param {string} command */
const findExecutableOnPath = (command) => {
  const path = process.env.PATH;
  if (!path) {
    return null;
  }

  for (const directory of path.split(delimiter)) {
    if (!directory) {
      continue;
    }

    for (const executable of getExecutableNames(command)) {
      const candidate = join(directory, executable);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
};

module.exports = {
  cleanText,
  findExecutableOnPath,
  getExecutableNames,
  isExecutableFile,
  normalizeEnum,
  oneLine,
  parseJSONMessage,
  truncate,
};
