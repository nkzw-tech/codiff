#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createDefinitionNavigationRepository } from './create-repository.mjs';

const keep = process.argv.includes('--keep');
const repositoryPath = mkdtempSync(join(tmpdir(), 'codiff-definition-navigation-'));
createDefinitionNavigationRepository(repositoryPath);

process.stdout.write(`Opening deterministic example repository: ${repositoryPath}\n`);
process.stdout.write(
  'Mod/Ctrl-click formatGreeting to jump within the diff, or DEFAULT_NAME to open its source in your editor.\n',
);
const result = spawnSync(
  process.execPath,
  [resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/codiff.js'), repositoryPath],
  { stdio: 'inherit' },
);
if (keep) {
  process.stdout.write(`Kept example repository at ${repositoryPath}\n`);
} else {
  rmSync(repositoryPath, { force: true, recursive: true });
}
process.exitCode = result.status ?? 1;
