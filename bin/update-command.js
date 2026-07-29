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
 * @param {{
 *   brewOwnsCask?: () => boolean;
 *   currentVersion: string;
 *   isSourceCheckout: boolean;
 *   latestVersion: string;
 * }} options
 * @returns {{ kind: 'up-to-date' } | { kind: 'brew-upgrade' | 'open-app' | 'source-checkout'; version: string }}
 */
export function resolveUpdateAction({
  brewOwnsCask,
  currentVersion,
  isSourceCheckout,
  latestVersion,
}) {
  if (!isNewerVersion(latestVersion, currentVersion)) {
    return { kind: 'up-to-date' };
  }

  if (isSourceCheckout) {
    return { kind: 'source-checkout', version: latestVersion };
  }

  return /** @type {() => boolean} */ (brewOwnsCask)()
    ? { kind: 'brew-upgrade', version: latestVersion }
    : { kind: 'open-app', version: latestVersion };
}

/**
 * Check GitHub Releases and perform the platform-appropriate update.
 *
 * @param {{
 *   brewOwnsCask?: () => boolean;
 *   currentVersion: string;
 *   isSourceCheckout: boolean;
 *   log: (line: string) => void;
 *   openApp: (() => void) | null;
 *   releaseUrl?: string;
 *   runBrewUpgrade?: () => number;
 * }} options
 * @returns {Promise<number>}
 */
export async function runUpdateCommand({
  brewOwnsCask,
  currentVersion,
  isSourceCheckout,
  log,
  openApp,
  releaseUrl,
  runBrewUpgrade,
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

  const action = resolveUpdateAction({
    brewOwnsCask,
    currentVersion,
    isSourceCheckout,
    latestVersion,
  });

  switch (action.kind) {
    case 'up-to-date':
      log(`codiff v${currentVersion} is up to date.`);
      return 0;
    case 'source-checkout':
      log(
        `Codiff v${action.version} is available, but this is a source checkout. Run git pull and rebuild instead.`,
      );
      return 0;
    case 'brew-upgrade':
      log(`Updating Codiff v${currentVersion} -> v${action.version} via Homebrew…`);
      return /** @type {() => number} */ (runBrewUpgrade)();
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
