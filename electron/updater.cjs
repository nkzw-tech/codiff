// @ts-check

const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { link, mkdtemp, rm } = require('node:fs/promises');
const { basename, join } = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const {
  fetchLatestRelease,
  getAvailableUpdate,
  readUpdateState,
  releasePageUrl,
  shouldCheckForUpdates,
  updateFeedUrl,
  writeUpdateState,
} = require('./update-check.cjs');

/**
 * @typedef {import('./update-check.cjs').UpdateState} UpdateState
 * @typedef {{ name: string; url: string }} ReleaseAsset
 * @typedef {'available' | 'error' | 'idle' | 'installerReady' | 'updating'} UpdatePhase
 * @typedef {'download' | 'manual' | 'squirrel'} UpdateStrategy
 * @typedef {{
 *   currentVersion: string;
 *   message?: string;
 *   phase: UpdatePhase;
 *   strategy?: UpdateStrategy;
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
 * @returns {UpdateStrategy}
 */
const resolveUpdateStrategy = ({ hasSquirrelUpdateExe, platform }) =>
  platform === 'darwin' || (platform === 'win32' && hasSquirrelUpdateExe)
    ? 'squirrel'
    : platform === 'win32'
      ? // Windows releases ship only a ZIP; downloading it cannot replace the
        // installed app, so the update hands off to the release page instead.
        'manual'
      : 'download';

// Linux packages spell architectures differently per format: Debian uses
// amd64/arm64 while RPM uses x86_64/aarch64. Node's process.arch is the key.
const LINUX_ARCH_ALIASES = /** @type {Record<string, ReadonlyArray<string>>} */ ({
  arm64: ['arm64', 'aarch64'],
  x64: ['x64', 'amd64', 'x86_64'],
});

/**
 * @param {ReadonlyArray<ReleaseAsset>} assets
 * @param {{ arch: string; linuxFlavor?: 'deb' | 'rpm' | null; platform: string }} options
 * @returns {ReleaseAsset | null}
 */
const pickReleaseAsset = (assets, { arch, linuxFlavor, platform }) => {
  // The asset name becomes a path on the user's disk. A name that is not a
  // plain file name, such as one smuggling in a path separator or '..', is
  // an attack on where the download lands, not an installer.
  /** @param {string} name */
  const isPlainFileName = (name) =>
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('\\') &&
    basename(name) === name;

  /** @param {(asset: ReleaseAsset) => boolean} predicate */
  const find = (predicate) =>
    assets.find((asset) => isPlainFileName(asset.name) && predicate(asset)) ?? null;

  if (platform === 'darwin') {
    return find(({ name }) => name.includes(`darwin-${arch}`) && name.endsWith('.zip'));
  }

  if (platform === 'win32') {
    return find(
      ({ name }) => name.includes('win32') && name.includes(arch) && name.endsWith('.zip'),
    );
  }

  if (platform === 'linux' && linuxFlavor) {
    const aliases = LINUX_ARCH_ALIASES[arch] ?? [arch];
    const otherAliases = Object.values(LINUX_ARCH_ALIASES)
      .flat()
      .filter((alias) => !aliases.includes(alias));
    return (
      find(
        ({ name }) =>
          name.endsWith(`.${linuxFlavor}`) && aliases.some((alias) => name.includes(alias)),
      ) ??
      // An installer with no architecture marker predates multi-architecture
      // releases; one marked for another architecture would not run here.
      find(
        ({ name }) =>
          name.endsWith(`.${linuxFlavor}`) && !otherAliases.some((alias) => name.includes(alias)),
      )
    );
  }

  return null;
};

// A verified installer enters the download folder through an exclusive hard
// link: it fails on a name that already exists instead of replacing the file
// behind it, so a user's same-named file survives and the installer shows up
// beside it under the next free name.
/**
 * @param {string} stagedPath
 * @param {string} directory
 * @param {string} name
 */
const exposeVerifiedDownload = async (stagedPath, directory, name) => {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let counter = 0; counter < 100; counter++) {
    const candidate = join(directory, counter ? `${base} (${counter})${extension}` : name);
    try {
      await link(stagedPath, candidate);
      return candidate;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        /** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST'
      ) {
        throw error;
      }
    }
  }

  throw new Error(`The download folder already has too many files named ${name}.`);
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
 *   openExternal?: (url: string) => Promise<void>;
 *   openPath?: (path: string) => Promise<string>;
 *   platform: string;
 *   releaseUrl?: string;
 *   strategy: UpdateStrategy;
 *   updatesEnabled?: boolean;
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
  openExternal,
  openPath,
  platform,
  releaseUrl,
  strategy,
  updatesEnabled = true,
}) => {
  const logError = log ?? ((/** @type {string} */ message) => console.error(message));

  /** @returns {UpdateStatus} */
  const statusFromState = () => {
    const update = getAvailableUpdate(readUpdateState(configDir), currentVersion);
    return update
      ? { currentVersion, phase: 'available', strategy, version: update.version }
      : { currentVersion, phase: 'idle', strategy };
  };

  // The setting promises no update notifications, so a launch never surfaces
  // an update remembered from before it was turned off. Checks the user asks
  // for explicitly still report; only the cache stays silent.
  /** @type {UpdateStatus} */
  let status = updatesEnabled ? statusFromState() : { currentVersion, phase: 'idle', strategy };

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

    status = { ...next, strategy };
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

      // Installers are only opened after their bytes match the checksum the
      // release published; a download nobody can verify is not an update.
      const expectedDigest = asset.digest?.startsWith('sha256:')
        ? asset.digest.slice('sha256:'.length)
        : null;
      if (!expectedDigest) {
        throw new Error('The release does not publish a SHA-256 checksum for this download.');
      }

      const response = await fetch(asset.url);
      if (!response.ok || !response.body) {
        throw new Error(`Downloading the update failed with status ${response.status}.`);
      }

      // The download only ever writes inside a directory created for it, so
      // no user file is a write target and a failure can only delete the
      // staging copy. The installer reaches the download folder itself after
      // its bytes match the published checksum.
      const stagingDirectory = await mkdtemp(join(downloadDirectory, '.codiff-update-'));
      let path;
      try {
        const stagedPath = join(stagingDirectory, asset.name);
        const hash = createHash('sha256');
        await pipeline(
          Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (response.body)),
          new Transform({
            transform(chunk, _encoding, callback) {
              hash.update(chunk);
              callback(null, chunk);
            },
          }),
          createWriteStream(stagedPath),
        );

        if (hash.digest('hex') !== expectedDigest.toLowerCase()) {
          throw new Error('The downloaded update failed its integrity check. Try again later.');
        }

        path = await exposeVerifiedDownload(stagedPath, downloadDirectory, asset.name);
      } finally {
        await rm(stagingDirectory, { force: true, recursive: true });
      }

      const openError = await openPath(path);
      if (openError) {
        throw new Error(openError);
      }

      return setStatus({ currentVersion, phase: 'installerReady', version: release.version });
    } catch (error) {
      return setError(error instanceof Error ? error.message : String(error), version);
    }
  };

  // The manual strategy never leaves the available phase, so the phase guard
  // in applyUpdate cannot serialize it. The in-flight hand-off is tracked by
  // its URL: a repeat click for the same page shares the pending outcome
  // (one browser tab, one result), while a request for a different page, such
  // as applyLatest discovering a newer version, supersedes it.
  /** @type {{ generation: number; promise: Promise<UpdateStatus>; url: string } | null} */
  let manualOpen = null;

  const manualUpdateUrl = () =>
    status.version
      ? releasePageUrl(status.version)
      : 'https://github.com/nkzw-tech/codiff/releases';

  const applyManualUpdate = async () => {
    const version = status.version;
    const url = manualUpdateUrl();
    if (!openExternal) {
      return setError('The updater is unavailable in this build.', version);
    }

    const superseded = manualOpen;
    // Captured before waiting on the older hand-off: an action that lands
    // during that wait (a dismissal, another apply) owns the status, and
    // opening the page for this stale request would resurrect it.
    const generationAtStart = actionGeneration;
    const attempt = (async () => {
      if (superseded) {
        // Let the older hand-off settle first; its completion yields to this
        // newer action through the generation check below.
        await superseded.promise;
        if (actionGeneration !== generationAtStart) {
          return { ...status };
        }
      }

      try {
        await openExternal(url);
        // Nothing was installed; the update stays available until the user
        // replaces the app themselves. Recomputing from state also clears a
        // previous open failure once a retry reaches the release page. An
        // action taken while the browser was opening is newer information
        // and owns the status instead.
        return actionGeneration === generationAtStart
          ? setStatus(statusFromState())
          : { ...status };
      } catch (error) {
        return actionGeneration === generationAtStart
          ? setError(error instanceof Error ? error.message : String(error), version)
          : { ...status };
      }
    })();

    manualOpen = { generation: generationAtStart, promise: attempt, url };
    try {
      return await attempt;
    } finally {
      if (manualOpen?.promise === attempt) {
        manualOpen = null;
      }
    }
  };

  const applyUpdate = async () => {
    if (status.phase !== 'available' && status.phase !== 'error') {
      return { ...status };
    }

    // A repeat click while the same hand-off is still opening is not a new
    // action; share the pending outcome instead of opening a second tab. The
    // generation must still match: an action since the hand-off was queued
    // (a dismissal, then a fresh request) means it will yield without ever
    // opening, so a new request must queue its own hand-off instead.
    if (
      strategy === 'manual' &&
      manualOpen &&
      manualOpen.url === manualUpdateUrl() &&
      manualOpen.generation === actionGeneration
    ) {
      return { ...(await manualOpen.promise) };
    }

    actionGeneration++;
    return {
      ...(strategy === 'squirrel'
        ? applySquirrelUpdate()
        : strategy === 'manual'
          ? await applyManualUpdate()
          : await applyDownloadUpdate()),
    };
  };

  let applyLatestSequence = 0;

  const applyLatest = async () => {
    const applyLatestId = ++applyLatestSequence;
    const generationAtStart = actionGeneration;
    let checked;
    try {
      checked = await checkForUpdates({ force: true });
    } catch (error) {
      // An apply or dismissal that started while the check was pending, or a
      // newer applyLatest request still in flight, is newer information than
      // this failure; leave the status to it.
      if (applyLatestId !== applyLatestSequence || actionGeneration !== generationAtStart) {
        return { ...status };
      }

      // The caller asked for an update, so a failed check is an update
      // failure; surface it in the banner instead of rejecting into a void.
      actionGeneration++;
      return { ...setError(error instanceof Error ? error.message : String(error)) };
    }

    // A newer applyLatest request is pending; let it own the apply so the
    // freshest release wins.
    if (applyLatestId !== applyLatestSequence) {
      return { ...status };
    }

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
