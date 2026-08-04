#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { promisify } from 'node:util';
import { reviewScenarios } from '../test-scenarios/review/index.mjs';
import { writeJson } from './lib.mjs';
import { assertScenarioReviewTarget } from './review-artifacts.mjs';

const execFileAsync = promisify(execFile);
const [targetArgument, ...options] = process.argv.slice(2);
const optionValue = (name) => {
  const index = options.indexOf(name);
  return index === -1 ? null : (options[index + 1] ?? null);
};
const hasOption = (name) => options.includes(name);

if (!targetArgument) {
  throw new Error(
    'usage: pnpm eval:view-provider <review-target.json> --state <state.json> --provider github|gitlab [--create] [--cleanup --yes]',
  );
}

const targetPath = resolve(targetArgument);
const target = JSON.parse(await readFile(targetPath, 'utf8'));
assertScenarioReviewTarget(target);
const statePath = optionValue('--state');
const provider = optionValue('--provider');
if (!statePath || (provider !== 'github' && provider !== 'gitlab')) {
  throw new Error('--state and --provider github|gitlab are required.');
}

const scenarioId = target.materialization.scenarioId;
const providerScenarioId = reviewScenarios[scenarioId]?.providerScenarioId ?? scenarioId;
const resolvedStatePath = resolve(statePath);
if (hasOption('--create')) {
  await execFileAsync('node', [
    'scripts/test-scenarios.mjs',
    'create-scenarios',
    '--providers',
    provider,
    '--scenarios',
    providerScenarioId,
    '--state',
    resolvedStatePath,
  ]);
}

if (hasOption('--cleanup')) {
  if (!hasOption('--yes')) {
    throw new Error(
      '--cleanup closes every tracked review in the supplied state file; repeat with --yes.',
    );
  }
  await execFileAsync('node', [
    'scripts/test-scenarios.mjs',
    'destroy',
    '--state',
    resolvedStatePath,
    '--yes',
  ]);
  process.stdout.write(`Cleaned provider scenario state: ${resolvedStatePath}\n`);
  process.exit(0);
}

const state = JSON.parse(await readFile(resolvedStatePath, 'utf8'));
const review = state.reviews?.find(
  (candidate) => candidate.provider === provider && candidate.scenario === providerScenarioId,
);
if (!review) {
  throw new Error(
    `No ${provider} provider review exists for ${scenarioId}. Pass --create to create it explicitly.`,
  );
}
if (review.creationStatus === 'partial') {
  throw new Error(
    `Provider creation is incomplete. Recover with: pnpm eval:view-provider ${targetPath} --state ${resolvedStatePath} --provider ${provider} --cleanup --yes`,
  );
}

await writeJson(resolve(dirname(targetPath), 'provider-review.json'), {
  createdOrReusedAt: new Date().toISOString(),
  provider: review.provider,
  providerScenarioId,
  repository: review.repository,
  reviewNumber: Number(new URL(review.url).pathname.split('/').filter(Boolean).at(-1)),
  scenarioId,
  statePath: resolvedStatePath,
  teardown: {
    command: `pnpm eval:view-provider ${targetPath} --state ${resolvedStatePath} --provider ${provider} --cleanup --yes`,
    status: 'available',
  },
  url: review.url,
  worktree: review.worktree,
});

process.stdout.write(`Opening provider eval review: ${review.url}\n`);
spawn('pnpm', ['exec', 'codiff', review.url, review.worktree], {
  cwd: process.cwd(),
  detached: true,
  stdio: 'ignore',
}).unref();
