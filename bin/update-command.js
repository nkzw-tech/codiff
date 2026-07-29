import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  fetchLatestRelease,
  isNewerVersion,
  releasePageUrl,
} = require('../electron/update-check.cjs');

/**
 * Decide what `codiff update` should do for this install.
 *
 * Homebrew-owned installs are not special-cased: the cask is marked
 * auto_updates, so the app updating itself in place is the supported path and
 * stays ahead of a tap that may lag behind the newest release.
 *
 * @param {{
 *   currentVersion: string;
 *   isSourceCheckout: boolean;
 *   latestVersion: string;
 * }} options
 * @returns {{ kind: 'up-to-date' } | { kind: 'open-app' | 'source-checkout'; version: string }}
 */
export function resolveUpdateAction({ currentVersion, isSourceCheckout, latestVersion }) {
  if (!isNewerVersion(latestVersion, currentVersion)) {
    return { kind: 'up-to-date' };
  }

  return isSourceCheckout
    ? { kind: 'source-checkout', version: latestVersion }
    : { kind: 'open-app', version: latestVersion };
}

/**
 * Check GitHub Releases and perform the platform-appropriate update.
 *
 * @param {{
 *   currentVersion: string;
 *   isSourceCheckout: boolean;
 *   log: (line: string) => void;
 *   openApp: (() => void) | null;
 *   releaseUrl?: string;
 * }} options
 * @returns {Promise<number>}
 */
export async function runUpdateCommand({
  currentVersion,
  isSourceCheckout,
  log,
  openApp,
  releaseUrl,
}) {
  let latestVersion;
  try {
    latestVersion = (await fetchLatestRelease(releaseUrl)).version;
  } catch (error) {
    log(
      `codiff: could not check for updates: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }

  const action = resolveUpdateAction({ currentVersion, isSourceCheckout, latestVersion });

  switch (action.kind) {
    case 'up-to-date':
      log(`codiff v${currentVersion} is up to date.`);
      return 0;
    case 'source-checkout':
      log(
        `Codiff v${action.version} is available, but this is a source checkout. Run git pull and rebuild instead.`,
      );
      return 0;
    case 'open-app':
      if (openApp) {
        log(`Opening Codiff to install v${action.version}…`);
        openApp();
        return 0;
      }

      log(
        `Codiff v${action.version} is available. Download it from ${releasePageUrl(action.version)} or open the app and use the update banner.`,
      );
      return 1;
  }
}
