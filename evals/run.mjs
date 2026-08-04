#!/usr/bin/env node

import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import process from 'node:process';
import {
  initializeEvalRun,
  loadCaseAdapter,
  readCases,
  resolveRunDir,
  root,
  writeJson,
} from './lib.mjs';
import { assertEvalAttemptMeta } from './review-artifacts.mjs';

const require = createRequire(import.meta.url);
const { readConfig } = require('../electron/config.cjs');

const args = process.argv.slice(2);
const readOption = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const optionNames = new Set(['--case', '--effort', '--model', '--repetitions', '--suite']);
let label = '';
for (let index = 0; index < args.length; index += 1) {
  if (optionNames.has(args[index])) {
    index += 1;
  } else if (!args[index].startsWith('--')) {
    label = args[index];
    break;
  }
}

label ||= `run-${Date.now()}`;
const repetitions = Number(readOption('--repetitions', '2'));
const caseFilter = readOption('--case', '');
const effort = readOption('--effort', 'high');
const prepareOnly = args.includes('--prepare-only');
const suite = readOption('--suite', 'single-commit');
const configuredModel = readConfig().settings.openAIModel;
const model = readOption('--model', configuredModel);
const runDir = resolveRunDir(label);
const allCases = await readCases();
const knownSuites = new Set(allCases.map((item) => item.kind));
const cases = allCases.filter(
  (item) => (!caseFilter || item.id === caseFilter) && (suite === 'all' || item.kind === suite),
);

if (!Number.isInteger(repetitions) || repetitions < 1) {
  throw new Error('--repetitions must be a positive integer.');
}
if (!['low', 'medium', 'high'].includes(effort)) {
  throw new Error('--effort must be low, medium, or high.');
}
if (suite !== 'all' && !knownSuites.has(suite)) {
  throw new Error(`Unknown eval suite ${JSON.stringify(suite)}.`);
}
if (cases.length === 0) {
  throw new Error(`No eval case matched ${JSON.stringify(caseFilter)} in suite ${suite}.`);
}

await initializeEvalRun({
  label,
  metadata: {
    effort,
    label,
    model,
    prepareOnly,
    repetitions,
    startedAt: new Date().toISOString(),
    suite,
  },
  runDir,
});

for (const evalCase of cases) {
  const adapter = await loadCaseAdapter(evalCase, 'runAttempt');
  for (let attempt = 1; attempt <= repetitions; attempt += 1) {
    const attemptDir = join(runDir, evalCase.id, `attempt-${attempt}`);
    await mkdir(attemptDir, { recursive: true });
    await writeJson(join(attemptDir, 'case.json'), evalCase);
    const result = await adapter.runAttempt({
      attempt,
      attemptDir,
      effort,
      evalCase,
      model,
      prepareOnly,
      root,
    });
    assertEvalAttemptMeta(result?.meta);
    await writeJson(join(attemptDir, 'meta.json'), result.meta);
    process.stdout.write(`${result.summary ?? `${evalCase.id} attempt ${attempt}: complete`}\n`);
  }
}

process.stdout.write(`${prepareOnly ? 'Prepared inputs' : 'Artifacts'}: ${runDir}\n`);
if (!prepareOnly) {
  process.stdout.write(
    `Next: node evals/judge.mjs ${basename(runDir)} && node evals/report.mjs ${basename(runDir)}\n`,
  );
}
