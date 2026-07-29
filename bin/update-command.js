/**
 * @param {{
 *   brewOwnsCask: () => boolean;
 *   currentVersion: string;
 *   isSourceCheckout: boolean;
 *   latestVersion: string;
 * }} options
 * @returns {{ kind: 'up-to-date' } | { kind: 'brew-upgrade' | 'open-app' | 'source-checkout'; version: string }}
 */
export function resolveUpdateAction(options) {
  void options;
  return { kind: 'up-to-date' };
}

/**
 * @param {{
 *   brewOwnsCask: () => boolean;
 *   currentVersion: string;
 *   isSourceCheckout: boolean;
 *   log: (line: string) => void;
 *   openApp: (() => void) | null;
 *   releaseUrl?: string;
 *   runBrewUpgrade: () => number;
 * }} options
 * @returns {Promise<number>}
 */
export async function runUpdateCommand(options) {
  void options;
  return 0;
}
