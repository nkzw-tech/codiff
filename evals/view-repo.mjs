#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { materializeReviewScenario } from '../test-scenarios/review/index.mjs';
import {
  assertEvalShareManifest,
  assertScenarioReviewTarget,
  remapWalkthroughHunks,
  resolveScenarioReviewRange,
} from './review-artifacts.mjs';

const execFileAsync = promisify(execFile);
const [targetArgument, ...options] = process.argv.slice(2);

if (!targetArgument) {
  throw new Error('usage: pnpm eval:view-repo <review-target.json>');
}

const targetPath = resolve(targetArgument);
const target = JSON.parse(await readFile(targetPath, 'utf8'));
assertScenarioReviewTarget(target);

const walkthroughPath = resolve(dirname(targetPath), 'walkthrough.json');
const walkthrough = JSON.parse(await readFile(walkthroughPath, 'utf8'));
const manifest = JSON.parse(
  await readFile(resolve(dirname(targetPath), 'share-manifest.json'), 'utf8'),
);
assertEvalShareManifest(manifest);

const repositoryRoot = await mkdtemp(`${tmpdir()}/codiff-eval-review-`);
const runGit = async (args) =>
  (await execFileAsync('git', args, { cwd: repositoryRoot })).stdout.trim();
const materialized = await materializeReviewScenario({
  baseBranch: target.materialization.baseBranch,
  featureBranch: target.materialization.featureBranch,
  root: process.cwd(),
  runGit,
  scenarioId: target.materialization.scenarioId,
});
const range = resolveScenarioReviewRange({ materialized, source: target.source });
if (!range.base || !range.head) {
  throw new Error('The recorded scenario range could not be resolved after materialization.');
}
const { readRepositoryState } = await import('../electron/git-state.cjs');
const state = await readRepositoryState(repositoryRoot, {
  base: range.base,
  head: range.head,
  symmetric: range.symmetric,
  type: 'range',
});
const localWalkthrough = remapWalkthroughHunks({
  fromFiles: manifest.files,
  toFiles: state.files,
  walkthrough,
});
const localWalkthroughPath = join(repositoryRoot, '.codiff-eval-walkthrough.json');
await writeFile(localWalkthroughPath, `${JSON.stringify(localWalkthrough, null, 2)}\n`);

const command = [
  'pnpm',
  'codiff',
  '--',
  '--walkthrough-file',
  localWalkthroughPath,
  `${range.base}${range.symmetric ? '...' : '..'}${range.head}`,
  repositoryRoot,
];
process.stdout.write(`Opening repo-backed eval review: ${repositoryRoot}\n`);
process.stdout.write(`Cleanup when finished: rm -rf ${repositoryRoot}\n`);
if (options.includes('--dry-run')) {
  process.stdout.write(`Command: ${command.map((part) => JSON.stringify(part)).join(' ')}\n`);
  await rm(repositoryRoot, { force: true, recursive: true });
  process.exit(0);
}

spawn(command[0], command.slice(1), {
  cwd: process.cwd(),
  detached: true,
  stdio: 'ignore',
}).unref();
