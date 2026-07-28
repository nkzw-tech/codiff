// @ts-check

const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  fetchLatestRelease,
  getAvailableUpdate,
  readUpdateState,
  shouldCheckForUpdates,
  updateFeedUrl,
  writeUpdateState,
} = require('./update-check.cjs');

/**
 * @typedef {import('./update-check.cjs').UpdateState} UpdateState
 * @typedef {{ name: string; url: string }} ReleaseAsset
 * @typedef {'available' | 'error' | 'idle' | 'installerReady' | 'updating'} UpdatePhase
 * @typedef {{
 *   currentVersion: string;
 *   message?: string;
 *   phase: UpdatePhase;
 *   version?: string;
 * }} UpdateStatus
 * @typedef {{
 *   checkForUpdates: () => void;
 *   on: (event: string, listener: (...args: Array<unknown>) => void) => unknown;
 *   quitAndInstall: () => void;
 *   setFeedURL: (options: { url: string }) => void;
 * }} SquirrelAutoUpdater
 */

/**
 * @param {{ hasSquirrelUpdateExe: boolean; platform: string }} options
 * @returns {'download' | 'squirrel'}
 */
const resolveUpdateStrategy = ({ hasSquirrelUpdateExe, platform }) =>
  platform === 'darwin' || (platform === 'win32' && hasSquirrelUpdateExe) ? 'squirrel' : 'download';

/**
 * @param {ReadonlyArray<ReleaseAsset>} assets
 * @param {{ arch: string; linuxFlavor?: 'deb' | 'rpm' | null; platform: string }} options
 * @returns {ReleaseAsset | null}
 */
const pickReleaseAsset = (assets, { arch, linuxFlavor, platform }) => {
  /** @param {(asset: ReleaseAsset) => boolean} predicate */
  const find = (predicate) => assets.find(predicate) ?? null;

  if (platform === 'darwin') {
    return find(({ name }) => name.includes(`darwin-${arch}`) && name.endsWith('.zip'));
  }

  if (platform === 'win32') {
    return find(
      ({ name }) => name.includes('win32') && name.includes(arch) && name.endsWith('.zip'),
    );
  }

  if (platform === 'linux' && linuxFlavor) {
    return find(({ name }) => name.endsWith(`.${linuxFlavor}`));
  }

  return null;
};

/**
 * @param {{
 *   arch: string;
 *   autoUpdater?: SquirrelAutoUpdater;
 *   configDir?: string;
 *   currentVersion: string;
 *   downloadDirectory?: string;
 *   isPackaged: boolean;
 *   linuxFlavor?: 'deb' | 'rpm' | null;
 *   log?: (message: string) => void;
 *   onStatusChange?: (status: UpdateStatus) => void;
 *   openPath?: (path: string) => Promise<string>;
 *   platform: string;
 *   releaseUrl?: string;
 *   strategy: 'download' | 'squirrel';
 * }} options
 */
const createUpdater = ({
  arch,
  autoUpdater,
  configDir,
  currentVersion,
  downloadDirectory,
  isPackaged,
  linuxFlavor,
  log,
  onStatusChange,
  openPath,
  platform,
  releaseUrl,
  strategy,
}) => {
  const logError = log ?? ((/** @type {string} */ message) => console.error(message));

  /** @returns {UpdateStatus} */
  const statusFromState = () => {
    const update = getAvailableUpdate(readUpdateState(configDir), currentVersion);
    return update
      ? { currentVersion, phase: 'available', version: update.version }
      : { currentVersion, phase: 'idle' };
  };

  /** @type {UpdateStatus} */
  let status = statusFromState();

  /** @param {UpdateStatus} next */
  const setStatus = (next) => {
    if (
      next.phase === status.phase &&
      next.version === status.version &&
      next.message === status.message
    ) {
      return status;
    }

    status = next;
    onStatusChange?.({ ...status });
    return status;
  };

  /**
   * @param {string} message
   * @param {string} [version]
   */
  const setError = (message, version) =>
    setStatus({
      currentVersion,
      message,
      phase: 'error',
      ...(version ? { version } : {}),
    });

  if (autoUpdater) {
    autoUpdater.on('update-downloaded', () => {
      if (status.phase === 'updating') {
        autoUpdater.quitAndInstall();
      }
    });
    autoUpdater.on('update-not-available', () => {
      if (status.phase === 'updating') {
        setError('The update is not available for download yet. Try again later.', status.version);
      }
    });
    autoUpdater.on('error', (error) => {
      if (status.phase === 'updating') {
        setError(error instanceof Error ? error.message : String(error), status.version);
      }
    });
  }

  const checkForUpdates = async ({ force = false } = {}) => {
    if (!isPackaged || status.phase === 'updating') {
      return { ...status };
    }

    const state = readUpdateState(configDir);
    if (!force && !shouldCheckForUpdates(state, Date.now())) {
      return { ...setStatus(statusFromState()) };
    }

    try {
      const release = await fetchLatestRelease(releaseUrl);
      writeUpdateState(
        {
          lastCheckedAt: new Date().toISOString(),
          latestVersion: release.version,
          ...(state?.dismissedVersion ? { dismissedVersion: state.dismissedVersion } : {}),
        },
        configDir,
      );
    } catch (error) {
      logError(`Update check failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return { ...setStatus(statusFromState()) };
  };

  const applySquirrelUpdate = () => {
    if (!autoUpdater) {
      return setError('The updater is unavailable in this build.', status.version);
    }

    const version = status.version;
    try {
      autoUpdater.setFeedURL({ url: updateFeedUrl(platform, arch, currentVersion) });
    } catch (error) {
      return setError(error instanceof Error ? error.message : String(error), version);
    }

    const next = setStatus({ currentVersion, phase: 'updating', version });
    autoUpdater.checkForUpdates();
    return next;
  };

  const applyDownloadUpdate = async () => {
    const version = status.version;

    try {
      const release = await fetchLatestRelease(releaseUrl);
      const asset = pickReleaseAsset(release.assets, { arch, linuxFlavor, platform });

      if (!asset || !downloadDirectory || !openPath) {
        return setError('No download is available for this platform.', version);
      }

      setStatus({ currentVersion, phase: 'updating', version: release.version });

      const response = await fetch(asset.url);
      if (!response.ok) {
        throw new Error(`Downloading the update failed with status ${response.status}.`);
      }

      const path = join(downloadDirectory, asset.name);
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
      await openPath(path);

      return setStatus({ currentVersion, phase: 'installerReady', version: release.version });
    } catch (error) {
      return setError(error instanceof Error ? error.message : String(error), version);
    }
  };

  const applyUpdate = async () => {
    if (status.phase !== 'available' && status.phase !== 'error') {
      return { ...status };
    }

    return {
      ...(strategy === 'squirrel' ? applySquirrelUpdate() : await applyDownloadUpdate()),
    };
  };

  const dismissUpdate = () => {
    const state = readUpdateState(configDir);
    if (state) {
      writeUpdateState({ ...state, dismissedVersion: state.latestVersion }, configDir);
    }

    return { ...setStatus(statusFromState()) };
  };

  return {
    applyUpdate,
    checkForUpdates,
    dismissUpdate,
    getStatus: () => ({ ...status }),
  };
};

module.exports = {
  createUpdater,
  pickReleaseAsset,
  resolveUpdateStrategy,
};
