import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type ManifestEntry = {
  dynamicImports?: Array<string>;
  imports?: Array<string>;
};

// TODO: Remove these workarounds once Void serves static assets outside the Worker and preloads
// the rendered page's chunks. Run after all environments finish so deploy builds receive them too.
export const optimizeBuild = async (distDir: string, assetsDir: string) => {
  const clientDir = resolve(distDir, 'client');
  const wranglerPath = resolve(distDir, 'ssr/wrangler.json');
  const manifestPath = resolve(clientDir, '.vite/manifest.json');

  // Auth middleware can apply private/no-store headers to signed-in asset requests. Bypass the
  // Worker for emitted files and let the asset layer cache fingerprinted files for a year.
  const entries = await readdir(clientDir, { withFileTypes: true });
  const exclusions = entries
    .filter(({ name }) => !name.startsWith('.') && name !== '_headers')
    .map((entry) => (entry.isDirectory() ? `!/${entry.name}/*` : `!/${entry.name}`))
    .toSorted();
  const wrangler = JSON.parse(await readFile(wranglerPath, 'utf8'));
  wrangler.assets.run_worker_first = ['/**', ...exclusions];
  await writeFile(wranglerPath, `${JSON.stringify(wrangler, null, 2)}\n`);
  await writeFile(
    resolve(clientDir, '_headers'),
    `/${assetsDir}/*\n  Cache-Control: public, max-age=31536000, immutable\n`,
  );

  // Preload the shared layout alongside the entry. Pages have their own chunks; preloading
  // all of them would download the plan and walkthrough viewers even on the home page.
  const manifest: Record<string, ManifestEntry> = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entryId = 'virtual:void-pages-client';
  const entry = manifest[entryId];
  const layouts = entry?.dynamicImports?.filter((id) => id === 'pages/layout.tsx') ?? [];
  if (layouts.length === 0) {
    throw new Error(`No layout chunk found under ${entryId} in ${manifestPath}.`);
  }
  entry.imports = [...new Set([...(entry.imports ?? []), ...layouts])];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
};
