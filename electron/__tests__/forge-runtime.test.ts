import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const forgeConfig = require('../../forge.config.cjs') as {
  hooks: {
    packageAfterCopy: (config: unknown, buildPath: string) => Promise<void>;
  };
};

describe('packaged Core runtime', () => {
  test('builds every package artifact before supported Forge entry points', async () => {
    const rootPackage = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = rootPackage.scripts ?? {};

    for (const [scriptName, forgeCommand] of [
      ['forge:make', 'electron-forge make'],
      ['forge:package', 'electron-forge package'],
      ['package:app', 'electron-forge package'],
    ] as const) {
      const commands = scripts[scriptName]?.split(/\s*&&\s*/) ?? [];
      const buildIndex = commands.indexOf('vpr build');
      const forgeIndex = commands.findIndex((command) => command.startsWith(forgeCommand));

      expect(buildIndex, `${scriptName} must run the full root build`).toBeGreaterThanOrEqual(0);
      expect(forgeIndex, `${scriptName} must invoke ${forgeCommand}`).toBeGreaterThan(buildIndex);
    }

    const buildCommands = scripts.build?.split(/\s*&&\s*/) ?? [];
    const coreBuildIndex = buildCommands.indexOf("vp run --filter '@nkzw/codiff-core' build");
    const rendererBuildIndex = buildCommands.lastIndexOf('vp build');

    expect(coreBuildIndex, 'the root build must compile Core').toBeGreaterThanOrEqual(0);
    expect(rendererBuildIndex, 'the root build must compile the renderer').toBeGreaterThan(
      coreBuildIndex,
    );
  });

  test('copies Core ESM output and the legacy walkthrough diff runtime', async () => {
    const buildPath = await mkdtemp(join(tmpdir(), 'codiff-forge-runtime-'));
    try {
      await forgeConfig.hooks.packageAfterCopy({}, buildPath);
      await expect(
        access(join(buildPath, 'core/dist/walkthrough-authoring.mjs')),
      ).resolves.toBeUndefined();
      await expect(access(join(buildPath, 'core/dist/index.mjs'))).resolves.toBeUndefined();
      await expect(
        access(join(buildPath, 'core/lib/narrative-walkthrough-diff.cjs')),
      ).resolves.toBeUndefined();

      const index = await readFile(join(buildPath, 'core/dist/index.mjs'), 'utf8');
      const chunk = index.match(/\.\/[^'"]+\.mjs/)?.[0]?.slice(2);
      if (chunk) {
        await expect(access(join(buildPath, 'core/dist', chunk))).resolves.toBeUndefined();
      }

      const electronPath = join(buildPath, 'electron');
      await mkdir(electronPath, { recursive: true });
      await mkdir(join(buildPath, 'node_modules'), { recursive: true });
      await symlink(
        join(process.cwd(), 'node_modules/valibot'),
        join(buildPath, 'node_modules/valibot'),
        'dir',
      );
      await copyFile(
        join(process.cwd(), 'electron/walkthrough-authoring-bridge.cjs'),
        join(electronPath, 'walkthrough-authoring-bridge.cjs'),
      );
      const packagedRequire = createRequire(join(electronPath, 'main.cjs'));
      const authoringBridge = packagedRequire('./walkthrough-authoring-bridge.cjs') as {
        loadAuthoring: () => Promise<{ buildWalkthroughPrompt: unknown }>;
      };

      await expect(authoringBridge.loadAuthoring()).resolves.toMatchObject({
        buildWalkthroughPrompt: expect.any(Function),
      });
    } finally {
      await rm(buildPath, { force: true, recursive: true });
    }
  });

  test('declares Core as an Electron production dependency', async () => {
    const rootPackage = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(rootPackage.dependencies?.['@nkzw/codiff-core']).toBe('workspace:*');
    expect(rootPackage.dependencies).not.toHaveProperty('codiff');
  });
});
