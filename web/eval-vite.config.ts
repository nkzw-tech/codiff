import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite-plus';

const manifestEndpoint = (): Plugin => ({
  configureServer(server) {
    const manifestPath = process.env.CODIFF_EVAL_MANIFEST;
    if (!manifestPath) {
      return;
    }
    server.middlewares.use('/__codiff_eval/manifest', async (_request, response) => {
      try {
        const manifest = await readFile(manifestPath, 'utf8');
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(manifest);
      } catch {
        response.statusCode = 404;
        response.end('Local eval manifest is unavailable.');
      }
    });
  },
  enforce: 'pre',
  name: 'codiff:eval-manifest',
});

export default defineConfig({
  plugins: [manifestEndpoint(), react()],
  resolve: {
    alias: [{ find: '@web', replacement: resolve(__dirname, '.') }],
    conditions: ['@nkzw/codiff-source', 'module', 'browser', 'development|production'],
    dedupe: ['react', 'react-dom'],
  },
});
