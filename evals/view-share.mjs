#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { assertEvalShareManifest } from './review-artifacts.mjs';

const [manifestArgument] = process.argv.slice(2);

if (!manifestArgument) {
  throw new Error('usage: pnpm eval:view-share <share-manifest.json>');
}

const manifestPath = resolve(manifestArgument);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assertEvalShareManifest(manifest);

const port = Number(process.env.CODIFF_EVAL_PORT) || 6002;
const url = `http://127.0.0.1:${port}/eval-viewer.html`;
const child = spawn(
  'pnpm',
  [
    'exec',
    'vp',
    'dev',
    '--config',
    'eval-vite.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  {
    cwd: resolve('web'),
    env: {
      ...process.env,
      CODIFF_EVAL_MANIFEST: manifestPath,
      CODIFF_EVAL_PORT: String(port),
    },
    stdio: 'inherit',
  },
);

process.stdout.write(`Open frozen eval share: ${url}\n`);

const stop = (signal) => {
  child.kill(signal);
};

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 1));
