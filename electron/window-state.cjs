// @ts-check

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const MIN_WIDTH = 880;
const MIN_HEIGHT = 520;
const MIN_OVERLAP = 100;

const getDefaultConfigDir = () => join(homedir(), '.codiff');

/**
 * @typedef {{
 *   x: number;
 *   y: number;
 *   width: number;
 *   height: number;
 *   isMaximized: boolean;
 *   isFullScreen: boolean;
 * }} WindowState
 */

/**
 * @param {unknown} raw
 * @returns {WindowState | null}
 */
const parseWindowState = (raw) => {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const obj = /** @type {Record<string, unknown>} */ (raw);
  const { x, y, width, height, isMaximized, isFullScreen } = obj;

  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < MIN_WIDTH ||
    height < MIN_HEIGHT
  ) {
    return null;
  }

  return {
    height,
    isFullScreen: typeof isFullScreen === 'boolean' ? isFullScreen : false,
    isMaximized: typeof isMaximized === 'boolean' ? isMaximized : false,
    width,
    x,
    y,
  };
};

/**
 * @param {string} [configDir]
 * @returns {WindowState | null}
 */
const readWindowState = (configDir) => {
  const filePath = join(configDir ?? getDefaultConfigDir(), 'window-state.json');

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    return parseWindowState(raw);
  } catch {
    return null;
  }
};

/**
 * @param {WindowState} state
 * @param {string} [configDir]
 */
const writeWindowState = (state, configDir) => {
  const dir = configDir ?? getDefaultConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(join(dir, 'window-state.json'), JSON.stringify(state, null, 2) + '\n');
};

/**
 * @param {WindowState} state
 * @param {ReadonlyArray<{ workArea: { x: number; y: number; width: number; height: number } }>} displays
 * @returns {WindowState | null}
 */
const validateWindowStateOnScreen = (state, displays) => {
  for (const display of displays) {
    const { workArea } = display;
    const overlapX = Math.max(
      0,
      Math.min(state.x + state.width, workArea.x + workArea.width) - Math.max(state.x, workArea.x),
    );
    const overlapY = Math.max(
      0,
      Math.min(state.y + state.height, workArea.y + workArea.height) -
        Math.max(state.y, workArea.y),
    );

    if (overlapX >= MIN_OVERLAP && overlapY >= MIN_OVERLAP) {
      return state;
    }
  }

  return null;
};

module.exports = {
  readWindowState,
  validateWindowStateOnScreen,
  writeWindowState,
};
