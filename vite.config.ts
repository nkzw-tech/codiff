import { resolve } from 'node:path';
import nkzw from '@nkzw/oxlint-config';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

// shared/narrative-walkthrough-diff.cjs is a CommonJS module (`module.exports =
// { ... }`) shared with the Electron main process, but core/ imports it with
// named ESM imports. The dev server doesn't apply CommonJS->ESM interop to
// source .cjs files, so it serves the raw `module.exports` — `module` is
// undefined in the browser and the named imports resolve to nothing, blanking
// the renderer. This dev-only transform wraps the module so `module.exports`
// resolves, then re-exports each key as a named ESM export. The production
// Rollup build already handles CommonJS, so it is unaffected.
const cjsSourceInterop = () => ({
  // Dev server only — the production Rollup build handles CommonJS natively, and
  // injecting ESM exports there would break it ("export statement outside a
  // module"), since rolldown treats the .cjs as a CommonJS script.
  apply: 'serve' as const,
  enforce: 'pre' as const,
  name: 'codiff-cjs-source-interop',
  transform(code: string, id: string) {
    if (!id.split('?')[0].endsWith('shared/narrative-walkthrough-diff.cjs')) {
      return null;
    }
    const match = code.match(/module\.exports\s*=\s*\{([\s\S]*)\}\s*;?\s*$/);
    if (!match) {
      return null;
    }
    const names = match[1]
      .split(',')
      .map((entry) => entry.split(':')[0].trim())
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
    // The exported identifiers are already top-level `const`s in the file, so
    // re-export the existing bindings instead of redeclaring them. The local
    // `module` shim makes the original `module.exports = { ... }` a harmless
    // assignment rather than a reference to an undefined `module`.
    return {
      code: `const module = { exports: {} };\n${code}\nexport default module.exports;\nexport { ${names.join(', ')} };\n`,
      map: null,
    };
  },
});

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
        files: ['shared/narrative-walkthrough-diff.cjs'],
      },
    ],
  },
  plugins: [
    cjsSourceInterop(),
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
