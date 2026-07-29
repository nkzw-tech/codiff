// @ts-check

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const LATEST_RELEASE_URL = 'https://api.github.com/repos/nkzw-tech/codiff/releases/latest';
const UPDATE_CHECK_INTERVAL_MS = 20 * 60 * 60 * 1000;
const USER_AGENT = 'codiff-update-check';

const getDefaultConfigDir = () => join(homedir(), '.codiff');

/**
 * @typedef {{
 *   lastCheckedAt: string;
 *   latestVersion: string;
 *   dismissedVersion?: string;
 * }} UpdateState
 * @typedef {{ digest?: string; name: string; url: string }} ReleaseAsset
 */

/**
 * @param {string} version
 * @returns {[number, number, number] | null}
 */
const parseVersion = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

/**
 * @param {string} latest
 * @param {string} current
 * @returns {boolean}
 */
const isNewerVersion = (latest, current) => {
  const latestParts = parseVersion(latest);
  const currentParts = parseVersion(current);

  if (!latestParts || !currentParts) {
    return false;
  }

  for (let index = 0; index < 3; index++) {
    if (latestParts[index] !== currentParts[index]) {
      return latestParts[index] > currentParts[index];
    }
  }

  return false;
};

/**
 * @param {string} tag
 * @returns {string | null}
 */
const extractVersionFromTag = (tag) => {
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  return parseVersion(version) ? version : null;
};

/**
 * @param {unknown} raw
 * @returns {UpdateState | null}
 */
const parseUpdateState = (raw) => {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const { dismissedVersion, lastCheckedAt, latestVersion } =
    /** @type {Record<string, unknown>} */ (raw);

  if (
    typeof lastCheckedAt !== 'string' ||
    Number.isNaN(Date.parse(lastCheckedAt)) ||
    typeof latestVersion !== 'string'
  ) {
    return null;
  }

  return {
    lastCheckedAt,
    latestVersion,
    ...(typeof dismissedVersion === 'string' ? { dismissedVersion } : {}),
  };
};

/**
 * @param {string} [configDir]
 * @returns {UpdateState | null}
 */
const readUpdateState = (configDir) => {
  const filePath = join(configDir ?? getDefaultConfigDir(), 'update-state.json');

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return parseUpdateState(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return null;
  }
};

/**
 * @param {UpdateState} state
 * @param {string} [configDir]
 */
const writeUpdateState = (state, configDir) => {
  const dir = configDir ?? getDefaultConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(join(dir, 'update-state.json'), JSON.stringify(state, null, 2) + '\n');
};

/**
 * @param {UpdateState | null} state
 * @param {number} now
 * @returns {boolean}
 */
const shouldCheckForUpdates = (state, now) => {
  if (!state) {
    return true;
  }

  const lastCheckedAt = Date.parse(state.lastCheckedAt);
  return Number.isNaN(lastCheckedAt) || now - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS;
};

/**
 * @param {UpdateState | null} state
 * @param {string} currentVersion
 * @returns {{ version: string } | null}
 */
const getAvailableUpdate = (state, currentVersion) => {
  if (
    !state ||
    state.latestVersion === state.dismissedVersion ||
    !isNewerVersion(state.latestVersion, currentVersion)
  ) {
    return null;
  }

  return { version: state.latestVersion };
};

/**
 * @param {string} [url]
 * @returns {Promise<{ assets: Array<ReleaseAsset>; version: string }>}
 */
const fetchLatestRelease = async (url) => {
  const response = await fetch(url ?? LATEST_RELEASE_URL, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Update check failed with status ${response.status}.`);
  }

  const release = /** @type {Record<string, unknown>} */ (await response.json());
  const version =
    typeof release.tag_name === 'string' ? extractVersionFromTag(release.tag_name) : null;

  if (!version) {
    throw new Error(`Update check found no release version in tag ${String(release.tag_name)}.`);
  }

  const assets = Array.isArray(release.assets)
    ? release.assets.flatMap((asset) =>
        typeof asset === 'object' &&
        asset !== null &&
        typeof asset.name === 'string' &&
        typeof asset.browser_download_url === 'string'
          ? [
              {
                ...(typeof asset.digest === 'string' ? { digest: asset.digest } : {}),
                name: asset.name,
                url: asset.browser_download_url,
              },
            ]
          : [],
      )
    : [];

  return { assets, version };
};

/**
 * @param {string} platform
 * @param {string} arch
 * @param {string} version
 * @returns {string}
 */
const updateFeedUrl = (platform, arch, version) =>
  `https://update.electronjs.org/nkzw-tech/codiff/${platform}-${arch}/${version}`;

/**
 * @param {string} version
 * @returns {string}
 */
const releasePageUrl = (version) => `https://github.com/nkzw-tech/codiff/releases/tag/v${version}`;

module.exports = {
  extractVersionFromTag,
  fetchLatestRelease,
  getAvailableUpdate,
  isNewerVersion,
  LATEST_RELEASE_URL,
  readUpdateState,
  releasePageUrl,
  shouldCheckForUpdates,
  UPDATE_CHECK_INTERVAL_MS,
  updateFeedUrl,
  writeUpdateState,
};
