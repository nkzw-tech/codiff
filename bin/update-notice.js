import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getAvailableUpdate, readUpdateState } = require('../electron/update-check.cjs');

/**
 * Build a one-line update notice from the state cached by the app's daily
 * check. Never performs network requests so CLI startup stays instant.
 *
 * @param {{ configDir?: string; currentVersion: string }} options
 * @returns {string | null}
 */
export function getUpdateNotice({ configDir, currentVersion }) {
  const update = getAvailableUpdate(readUpdateState(configDir), currentVersion);
  return update
    ? `A new version of Codiff is available (v${currentVersion} -> v${update.version}). Run \`codiff update\` to update.`
    : null;
}
