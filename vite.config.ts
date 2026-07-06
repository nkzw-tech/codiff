import { resolve } from 'node:path';
import nkzw from '@nkzw/oxlint-config';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  base: './',
  fmt: {
    experimentalSortImports: {
      newlinesBetween: false,
    },
    experimentalSortPackageJson: {
      sortScripts: true,
    },
    experimentalTailwindcss: {
      stylesheet: 'core/App.css',
    },
    ignorePatterns: [
      'coverage/',
      'dist/',
      'index.html',
      'pnpm-lock.yaml',
      'core/__generated__/',
      'core/node_modules/',
      'core/translations/',
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
  plugins: [
    babel({
      presets: [reactCompilerPreset()],
    }),
    tailwindcss(),
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
    include: ['core/**/*.test.{ts,tsx}', 'electron/**/*.test.ts'],
    setupFiles: ['./core/__tests__/setup.ts'],
  },
  worker: {
    format: 'es',
  },
});
