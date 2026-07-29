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

  // Counts user and auto-updater actions (apply attempts, their outcomes,
  // dismissals). Checks snapshot it when they are requested and refuse to
  // overwrite the status once it moved: the action happened after the caller
  // asked for the check, so it is newer information. Check-driven transitions
  // deliberately do not count; a queued check may build on its predecessor.
  let actionGeneration = 0;

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
        actionGeneration++;
        setError('The update is not available for download yet. Try again later.', status.version);
      }
    });
    autoUpdater.on('error', (error) => {
      if (status.phase === 'updating') {
        actionGeneration++;
        setError(error instanceof Error ? error.message : String(error), status.version);
      }
    });
  }

  /**
   * @param {boolean} force
   * @param {number} generationAtStart
   * @param {string | undefined} dismissedBefore
   */
  const performCheck = async (force, generationAtStart, dismissedBefore) => {
    const state = readUpdateState(configDir);
    if (!force && !shouldCheckForUpdates(state, Date.now())) {
      // A throttled check brings no new information; never move the status.
      return { ...status };
    }

    try {
      const release = await fetchLatestRelease(releaseUrl);

      // Re-read after the network round trip: a dismissal may have been
      // persisted while the request was in flight and must survive. A forced
      // check is explicit user intent to see updates again, so it drops the
      // dismissal it started with, but never one made after it started.
      const dismissedNow = readUpdateState(configDir)?.dismissedVersion;
      const dismissedVersion = force && dismissedNow === dismissedBefore ? undefined : dismissedNow;
      writeUpdateState(
        {
          lastCheckedAt: new Date().toISOString(),
          latestVersion: release.version,
          ...(dismissedVersion ? { dismissedVersion } : {}),
        },
        configDir,
      );
    } catch (error) {
      logError(`Update check failed: ${error instanceof Error ? error.message : String(error)}`);
      if (force) {
        throw error;
      }
    }

    // An action happened after this check was requested (an apply started,
    // failed, or handed off; or the user dismissed). That is newer
    // information than this check; do not overwrite it.
    if (actionGeneration !== generationAtStart) {
      return { ...status };
    }

    return { ...setStatus(statusFromState()) };
  };

  // Checks are serialized: only one release request is ever in flight, and a
  // queued check runs against the state its predecessor persisted (usually
  // resolving from the fresh cache without another request). This makes
  // out-of-order completions impossible and keeps every failure owned by the
  // caller that triggered it.
  /** @type {Promise<unknown>} */
  let pendingCheck = Promise.resolve();

  const checkForUpdates = ({ force = false } = {}) => {
    // installerReady is terminal until relaunch: the user already has the new
    // installer open, so checking again can only produce confusing states.
    if (!isPackaged || status.phase === 'updating' || status.phase === 'installerReady') {
      return Promise.resolve({ ...status });
    }

    // Snapshot the caller's context now, not when the queued check finally
    // runs: a dismissal or apply transition made while this check waits in
    // the queue happened after the caller acted and must win over it.
    const generationAtStart = actionGeneration;
    const dismissedBefore = readUpdateState(configDir)?.dismissedVersion;

    const current = pendingCheck.then(() =>
      performCheck(force, generationAtStart, dismissedBefore),
    );
    pendingCheck = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };

  const applySquirrelUpdate = () => {
    if (!autoUpdater) {
      return setError('The updater is unavailable in this build.', status.version);
    }

    const version = status.version;
    // Enter the updating phase before setFeedURL so even a retry that fails
    // with an identical error produces status transitions; otherwise a check
    // completing mid-retry could overwrite the fresh failure.
    const next = setStatus({ currentVersion, phase: 'updating', version });
    try {
      autoUpdater.setFeedURL({ url: updateFeedUrl(platform, arch, currentVersion) });
    } catch (error) {
      return setError(error instanceof Error ? error.message : String(error), version);
    }

    autoUpdater.checkForUpdates();
    return next;
  };

  const applyDownloadUpdate = async () => {
    const version = status.version;
    // Enter the updating phase before any await so a concurrent applyUpdate
    // call sees it and becomes a no-op instead of downloading twice.
    setStatus({ currentVersion, phase: 'updating', version });

    try {
      const release = await fetchLatestRelease(releaseUrl);
      const asset = pickReleaseAsset(release.assets, { arch, linuxFlavor, platform });

      if (!asset || !downloadDirectory || !openPath) {
        return setError('No download is available for this platform.', version);
      }

      const response = await fetch(asset.url);
      if (!response.ok) {
        throw new Error(`Downloading the update failed with status ${response.status}.`);
      }

      const path = join(downloadDirectory, asset.name);
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
      const openError = await openPath(path);
      if (openError) {
        throw new Error(openError);
      }

      return setStatus({ currentVersion, phase: 'installerReady', version: release.version });
    } catch (error) {
      return setError(error instanceof Error ? error.message : String(error), version);
    }
  };

  const applyUpdate = async () => {
    if (status.phase !== 'available' && status.phase !== 'error') {
      return { ...status };
    }

    actionGeneration++;
    return {
      ...(strategy === 'squirrel' ? applySquirrelUpdate() : await applyDownloadUpdate()),
    };
  };

  const applyLatest = async () => {
    const checked = await checkForUpdates({ force: true });
    return checked.phase === 'available' ? applyUpdate() : checked;
  };

  const dismissUpdate = () => {
    actionGeneration++;
    const state = readUpdateState(configDir);
    if (state) {
      writeUpdateState({ ...state, dismissedVersion: state.latestVersion }, configDir);
    }

    return { ...setStatus(statusFromState()) };
  };

  return {
    applyLatest,
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
