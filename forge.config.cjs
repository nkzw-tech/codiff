// @ts-check

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const electronCachePath = process.env.ELECTRON_CACHE || join(__dirname, '.cache/electron');
const entitlementsPath = join(__dirname, 'electron/entitlements.plist');
const iconPath = existsSync(join(__dirname, 'electron/icons/icon.icns'))
  ? './electron/icons/icon'
  : undefined;
const macIconAssetName = 'Icon';
const macAssetCatalogPath = existsSync(join(__dirname, 'electron/icons/Assets.car'))
  ? './electron/icons/Assets.car'
  : undefined;
const linuxIconPath = './electron/icons/icon.png';
const windowsIconPath = './electron/icons/icon.ico';
const skipSquirrel = process.env.CODIFF_SKIP_SQUIRREL === '1';
const osxNotarize =
  process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID
    ? {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
        tool: 'notarytool',
      }
    : undefined;

/**
 * @typedef {import('@electron-forge/shared-types').ForgeArch} ForgeArch
 * @typedef {import('@electron-forge/shared-types').ForgeConfig} ForgeConfig
 * @typedef {import('@electron-forge/shared-types').ForgePlatform} ForgePlatform
 * @typedef {Omit<import('@electron-forge/shared-types').ForgePackagerOptions, 'osxNotarize' | 'osxSign'> & {
 *   osxNotarize?: Record<string, unknown>;
 *   osxSign?: Record<string, unknown>;
 * }} CodiffPackagerConfig
 * @typedef {{
 *   arch?: Array<ForgeArch>;
 *   config?: Record<string, unknown>;
 *   enabled?: boolean;
 *   name: string;
 *   platforms?: Array<ForgePlatform> | null;
 * }} CodiffMakerConfig
 * @typedef {Omit<ForgeConfig, 'makers' | 'packagerConfig'> & {
 *   makers: Array<CodiffMakerConfig>;
 *   packagerConfig: CodiffPackagerConfig;
 * }} CodiffForgeConfig
 */

/** @type {CodiffForgeConfig} */
module.exports = {
  hooks: {
    prePackage: async (forgeConfig, platform) => {
      if (platform !== 'darwin' || !macAssetCatalogPath) {
        return;
      }

      forgeConfig.packagerConfig.extendInfo = {
        ...(typeof forgeConfig.packagerConfig.extendInfo === 'object'
          ? forgeConfig.packagerConfig.extendInfo
          : {}),
        CFBundleIconName: macIconAssetName,
      };
      const extraResource = forgeConfig.packagerConfig.extraResource;
      forgeConfig.packagerConfig.extraResource = [
        ...(Array.isArray(extraResource) ? extraResource : extraResource ? [extraResource] : []),
        macAssetCatalogPath,
      ];
    },
  },
  makers: [
    {
      config: {
        setupIcon: windowsIconPath,
      },
      enabled: !skipSquirrel,
      name: '@electron-forge/maker-squirrel',
    },
    {
      arch: ['arm64'],
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
    },
    {
      config: {
        icon: linuxIconPath,
      },
      name: '@electron-forge/maker-deb',
    },
    {
      config: {
        icon: linuxIconPath,
      },
      name: '@electron-forge/maker-rpm',
    },
  ],
  packagerConfig: {
    appBundleId: 'dev.nkzw-tech.codiff',
    appCopyright: 'Copyright (c) 2026-current Nakazawa Tech',
    asar: false,
    download: {
      cacheRoot: electronCachePath,
    },
    executableName: 'codiff',
    ...(iconPath ? { icon: iconPath } : {}),
    ignore: [
      /^\/\.DS_Store$/,
      /^\/\.cache(?:$|\/)/,
      /^\/\.enum_manifest\.json$/,
      /^\/\.env(?:$|[.])/,
      /^\/\.git(?:$|\/)/,
      /^\/\.gitignore$/,
      /^\/\.github(?:$|\/)/,
      /^\/\.vite-hooks(?:$|\/)/,
      /^\/\.vscode(?:$|\/)/,
      /^\/README\.md$/,
      /^\/coverage(?:$|\/)/,
      /^\/docs(?:$|\/)/,
      /^\/forge\.config\.cjs$/,
      /^\/index\.html$/,
      /^\/out(?:$|\/)/,
      /^\/pnpm-workspace\.yaml$/,
      /^\/public(?:$|\/)/,
      /^\/src(?:$|\/)/,
      /^\/tsconfig/,
      /^\/vite\.config\./,
    ],
    name: 'Codiff',
    ...(osxNotarize ? { osxNotarize } : {}),
    osxSign: {
      continueOnError: false,
      hardenedRuntime: true,
      identity: process.env.APPLE_SIGNING_IDENTITY,
      optionsForFile: () => ({
        entitlements: entitlementsPath,
      }),
    },
    protocols: [
      {
        name: 'Codiff',
        schemes: ['codiff'],
      },
    ],
  },
  rebuildConfig: {},
};
