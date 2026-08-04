#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process, { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { readJson, runsRoot } from './lib.mjs';

const openCommand = (script, argument, extra = []) => {
  spawn('pnpm', [script, argument, ...extra], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
  }).unref();
};

const runDirectories = async () =>
  (await readdir(runsRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

const attemptsForRun = async (runName) => {
  const runDir = join(runsRoot, runName);
  const caseEntries = await readdir(runDir, { withFileTypes: true });
  const attempts = [];
  for (const entry of caseEntries.filter((candidate) => candidate.isDirectory())) {
    const caseDir = join(runDir, entry.name);
    const attemptEntries = await readdir(caseDir, { withFileTypes: true });
    for (const attempt of attemptEntries.filter((candidate) => candidate.isDirectory())) {
      const directory = join(caseDir, attempt.name);
      const [caseFile, meta] = await Promise.all([
        readJson(join(directory, 'case.json')),
        readJson(join(directory, 'meta.json')),
      ]);
      attempts.push({
        caseId: caseFile?.id ?? entry.name,
        directory,
        exitStatus: meta?.exitStatus ?? 'unknown',
        hasProvider: Boolean(await readJson(join(directory, 'provider-review.json'))),
        hasRepo: Boolean(await readJson(join(directory, 'review-target.json'))),
        hasShare: Boolean(await readJson(join(directory, 'share-manifest.json'))),
        name: `${entry.name}/${attempt.name}`,
      });
    }
  }
  return attempts.sort((left, right) => left.name.localeCompare(right.name));
};

const choice = async (reader, prompt, count) => {
  const value = Number(await reader.question(prompt));
  return Number.isInteger(value) && value >= 1 && value <= count ? value - 1 : -1;
};

const reader = createInterface({ input: stdin, output: stdout });
try {
  const runs = await runDirectories();
  if (runs.length === 0) {
    throw new Error('No eval runs found in evals/runs.');
  }
  stdout.write('Eval runs:\n');
  runs.forEach((run, index) => stdout.write(`  ${index + 1}. ${run}\n`));
  const runIndex = await choice(reader, 'Run: ', runs.length);
  if (runIndex < 0) {
    throw new Error('Invalid run selection.');
  }

  const attempts = await attemptsForRun(runs[runIndex]);
  if (attempts.length === 0) {
    throw new Error('The selected run has no attempts.');
  }
  stdout.write('\nAttempts:\n');
  attempts.forEach((attempt, index) => {
    const modes = [
      attempt.hasShare ? 'share' : null,
      attempt.hasRepo ? 'repo' : null,
      attempt.hasProvider ? 'provider' : null,
    ]
      .filter(Boolean)
      .join(', ');
    stdout.write(
      `  ${index + 1}. ${attempt.name} [${attempt.exitStatus}; ${modes || 'artifacts only'}]\n`,
    );
  });
  const attemptIndex = await choice(reader, 'Attempt: ', attempts.length);
  if (attemptIndex < 0) {
    throw new Error('Invalid attempt selection.');
  }
  const attempt = attempts[attemptIndex];
  const action = await reader.question(
    'Action: [s]hare, [r]epo, [p]rovider, [c]leanup, [i]nspect, [q]uit: ',
  );
  if (action === 's') {
    if (!attempt.hasShare) {
      throw new Error('This attempt has no frozen share manifest.');
    }
    openCommand('eval:view-share', join(attempt.directory, 'share-manifest.json'));
  } else if (action === 'r') {
    if (!attempt.hasRepo) {
      throw new Error('This attempt has no local repo target.');
    }
    openCommand('eval:view-repo', join(attempt.directory, 'review-target.json'));
  } else if (action === 'p') {
    if (!attempt.hasRepo) {
      throw new Error('Provider views require a scenario review target.');
    }
    const provider = await reader.question('Provider (github/gitlab): ');
    const statePath = await reader.question('Provider state file: ');
    const create = await reader.question(
      'Create a private review using a new state file now? [y/N] ',
    );
    openCommand('eval:view-provider', join(attempt.directory, 'review-target.json'), [
      '--state',
      resolve(statePath),
      '--provider',
      provider,
      ...(create.toLowerCase() === 'y' ? ['--create'] : []),
    ]);
  } else if (action === 'c') {
    if (!attempt.hasRepo) {
      throw new Error('Provider cleanup requires a scenario review target.');
    }
    const provider = await reader.question('Provider (github/gitlab): ');
    const statePath = await reader.question('Provider state file: ');
    const confirmation = await reader.question(
      'Close every tracked review in this state file? Type yes to continue: ',
    );
    if (confirmation !== 'yes') {
      throw new Error('Provider cleanup was not confirmed.');
    }
    openCommand('eval:view-provider', join(attempt.directory, 'review-target.json'), [
      '--state',
      resolve(statePath),
      '--provider',
      provider,
      '--cleanup',
      '--yes',
    ]);
  } else if (action === 'i') {
    const [meta, share, target, provider] = await Promise.all([
      readJson(join(attempt.directory, 'meta.json')),
      readJson(join(attempt.directory, 'share-manifest.json')),
      readJson(join(attempt.directory, 'review-target.json')),
      readJson(join(attempt.directory, 'provider-review.json')),
    ]);
    stdout.write(`${JSON.stringify({ meta, provider, share, target }, null, 2)}\n`);
  } else if (action !== 'q') {
    throw new Error('Unknown action.');
  }
} finally {
  reader.close();
}
