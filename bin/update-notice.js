import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * @param {{ configDir?: string; currentVersion: string }} options
 * @returns {string | null}
 */
export function getUpdateNotice(options) {
  void options;
  return null;
}
