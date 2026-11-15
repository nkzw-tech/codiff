import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

const readBuildFile = (path: string) =>
  readFile(new URL(`../web/dist/${path}`, import.meta.url), 'utf8');

test('serves built assets outside the Worker and preloads only the shared layout', async () => {
  const config = JSON.parse(await readBuildFile('ssr/wrangler.json'));
  expect(config.compatibility_flags).toContain('new_module_registry');
  expect(config.assets.run_worker_first).toEqual(
    expect.arrayContaining([
      '/**',
      '!/__assets-v2/*',
      '!/fonts/*',
      '!/icon.png',
      '!/apple-touch-icon.png',
    ]),
  );
  expect(await readBuildFile('client/_headers')).toContain(
    '/__assets-v2/*\n  Cache-Control: public, max-age=31536000, immutable\n',
  );
  const manifest = JSON.parse(await readBuildFile('client/.vite/manifest.json'));
  const entry = manifest['virtual:void-pages-client'];
  expect(entry.imports).toContain('pages/layout.tsx');
  expect(entry.imports).not.toContain('pages/p/[slug].tsx');
  expect(entry.imports).not.toContain('pages/w/[slug].tsx');
  expect(entry.dynamicImports).toEqual(
    expect.arrayContaining([
      'pages/index.tsx',
      'pages/stats.tsx',
      'pages/connect/[code].tsx',
      'pages/p/[slug].tsx',
      'pages/w/[slug].tsx',
    ]),
  );
});
