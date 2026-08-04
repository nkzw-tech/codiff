import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import nkzw from '@nkzw/oxlint-config';
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

const testWorkers = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 6)));

export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 10 * 1024,
  },
  fmt: {
    experimentalSortImports: {
      newlinesBetween: false,
    },
    experimentalSortPackageJson: {
      sortScripts: true,
    },
    ignorePatterns: [
      'coverage/',
      'dist/',
      'index.html',
      'pnpm-lock.yaml',
      'core/__generated__/',
      'core/node_modules/',
      'gitlab/node_modules/',
      'gitlab/dist/',
      'service/node_modules/',
      'service/dist/',
      'web/.fate/',
      'web/.void/',
      'web/.wrangler/',
      'web/node_modules/',
    ],
    singleQuote: true,
  },
  lint: {
    extends: [nkzw],
    ignorePatterns: [
      'bin/',
      'dist/',
      'electron/',
      'core/node_modules/',
      'gitlab/node_modules/',
      'gitlab/dist/',
      'service/node_modules/',
      'service/dist/',
      'web/.fate/',
      'web/.void/',
      'web/.wrangler/',
      'web/node_modules/',
      'vite.config.ts.timestamp-*',
    ],
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        env: {
          node: true,
        },
        files: ['core/lib/narrative-walkthrough-diff.cjs'],
      },
    ],
  },
  optimizeDeps: {
    // ghostty-web inlines its WASM binary as a huge base64 data URL, which
    // stalls the dep optimizer; it ships as plain ESM, so skip prebundling.
    exclude: ['ghostty-web'],
  },
  pack: {
    copy: [
      { from: 'fonts', to: 'dist' },
      { from: 'App.css.d.ts', rename: 'styles.css.d.ts', to: 'dist' },
    ],
    dts: false,
    loader: {
      '.svg': 'dataurl',
    },
  },
  plugins: [
    babel({
      presets: [reactCompilerPreset()],
    }),
    react(),
  ],
  resolve: {
    alias: [
      { find: /^react$/, replacement: resolve(__dirname, 'node_modules/react') },
      { find: /^react\/(.*)$/, replacement: `${resolve(__dirname, 'node_modules/react')}/$1` },
      { find: /^react-dom$/, replacement: resolve(__dirname, 'node_modules/react-dom') },
      {
        find: /^react-dom\/(.*)$/,
        replacement: `${resolve(__dirname, 'node_modules/react-dom')}/$1`,
      },
    ],
    conditions: ['@nkzw/codiff-source', 'module', 'browser', 'development|production'],
    dedupe: ['react', 'react-dom'],
  },
  run: {
    tasks: {
      'test:all': {
        command: 'vp check && vp test',
      },
    },
  },
  staged: {
    '*': 'vp check --fix',
  },
  test: {
    include: [
      'core/**/*.test.{ts,tsx}',
      'gitlab/**/*.test.ts',
      'github/**/*.test.ts',
      'electron/**/*.test.ts',
      'service/**/*.test.ts',
      'web/**/*.test.{ts,tsx}',
    ],
    maxWorkers: testWorkers,
    setupFiles: ['./core/__tests__/setup.ts'],
    testTimeout: 15_000,
  },
  worker: {
    format: 'es',
  },
});
