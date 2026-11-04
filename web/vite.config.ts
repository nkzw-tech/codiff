import { resolve } from 'node:path';
import { voidReact } from '@void/react/plugin';
import { fate } from 'react-fate/vite';
import { defineConfig, lazyPlugins } from 'vite-plus';
import { voidPlugin } from 'void';
import { optimizeBuild } from './build/optimizeBuild.ts';

const codiffSourceConditions = [
  '@nkzw/codiff-source',
  'module',
  'browser',
  'development|production',
];
const workspacePackages = ['@nkzw/codiff-core', '@nkzw/codiff-service'];

export default defineConfig({
  build: { assetsDir: '__assets-v2' },
  environments: {
    void_worker: {
      optimizeDeps: {
        exclude: ['@nkzw/fate/server', '@nkzw/fate/server/drizzle', 'void-fate/server'],
      },
    },
  },
  optimizeDeps: { exclude: workspacePackages },
  plugins: [
    ...(lazyPlugins(() => [...voidPlugin(), ...voidReact({ react: { compiler: true } })]) ?? []),
    fate({
      module: './src/server/fate.ts',
      transport: 'void',
    }),
    {
      apply: 'build',
      buildApp: {
        handler: (builder) =>
          optimizeBuild(
            resolve(builder.config.root, 'dist'),
            builder.environments.client.config.build.assetsDir,
          ),
        order: 'post',
      },
      enforce: 'post',
      name: 'codiff:optimize-web-build',
    },
  ],
  resolve: {
    alias: [{ find: '@web', replacement: resolve(__dirname, '.') }],
    conditions: codiffSourceConditions,
    dedupe: ['react', 'react-dom'],
  },
  server: { port: 6002 },
});
