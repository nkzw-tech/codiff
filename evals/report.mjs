#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import {
  average,
  listAttemptDirs,
  median,
  readCases,
  readJson,
  resolveRunDir,
  writeJson,
} from './lib.mjs';
import { assertEvalAttemptMeta, assertEvalContract } from './review-artifacts.mjs';

const [label] = process.argv.slice(2);
if (!label) {
  throw new Error('usage: node evals/report.mjs <run-label>');
}

const finiteMedian = (values, { positive = false } = {}) => {
  const finite = values.filter((value) => Number.isFinite(value) && (!positive || value > 0));
  return finite.length > 0 ? median(finite) : null;
};
const finiteAverage = (values) => {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? average(finite) : null;
};
const formatNumber = (value, render) => (Number.isFinite(value) ? render(value) : 'n/a');
const runDir = resolveRunDir(label);
const rows = [];

for (const evalCase of await readCases()) {
  const attempts = [];
  for (const attemptDir of await listAttemptDirs(runDir, evalCase.id)) {
    const meta = await readJson(join(attemptDir, 'meta.json'));
    if (!meta) {
      continue;
    }
    const contract = await readJson(join(attemptDir, 'contract.json'));
    attempts.push({
      contract: contract == null ? null : assertEvalContract(contract),
      judge: await readJson(join(attemptDir, 'judge.json')),
      meta: assertEvalAttemptMeta(meta),
    });
  }
  if (attempts.length === 0) {
    continue;
  }

  const completed = attempts.filter(
    (attempt) => attempt.meta.exitStatus === 'ready' || attempt.meta.exitStatus === 'prepared',
  );
  const generated = completed.filter((attempt) => attempt.meta.exitStatus === 'ready');
  const metricAttempts = generated.length > 0 ? generated : completed;
  const judged = attempts.filter((attempt) => attempt.judge);
  const contracted = attempts.filter((attempt) => typeof attempt.contract?.pass === 'boolean');
  const digests = new Set(completed.map((attempt) => attempt.meta.fixtureDigest).filter(Boolean));
  const stateTimes = attempts.map((attempt) => attempt.meta.stateMs);
  const contractMetricNames = new Set(
    contracted.flatMap((attempt) =>
      Object.entries(attempt.contract?.metrics ?? {}).flatMap(([name, value]) =>
        Number.isFinite(value) ? [name] : [],
      ),
    ),
  );
  rows.push({
    attempts: attempts.length,
    case: evalCase.id,
    contractMetrics: Object.fromEntries(
      [...contractMetricNames].map((name) => [
        name,
        average(
          contracted.map((attempt) => attempt.contract?.metrics?.[name]).filter(Number.isFinite),
        ),
      ]),
    ),
    contractPassRate:
      contracted.length === 0
        ? null
        : contracted.filter((attempt) => attempt.contract.pass).length / contracted.length,
    firstResponseMs: finiteMedian(generated.map((attempt) => attempt.meta.firstResponseMs)),
    fixtureConsistent: digests.size === 1,
    fixtureDigest: digests.size === 1 ? [...digests][0] : null,
    generationMs: finiteMedian(
      generated.map((attempt) => attempt.meta.generationMs),
      { positive: true },
    ),
    hunkCount: metricAttempts[0]?.meta.metrics?.hunkCount ?? 0,
    inputTokens: finiteMedian(generated.map((attempt) => attempt.meta.usage?.inputTokens)),
    mainCoverage: finiteAverage(
      metricAttempts.map((attempt) => attempt.meta.metrics?.mainCoverage),
    ),
    modelCalls: finiteMedian(completed.map((attempt) => attempt.meta.modelCalls)) ?? 0,
    outputTokens: finiteMedian(generated.map((attempt) => attempt.meta.usage?.outputTokens)),
    promptChars: finiteMedian(completed.map((attempt) => attempt.meta.promptChars)),
    quality:
      judged.length === 0
        ? null
        : average(judged.map((attempt) => attempt.judge.total).filter(Number.isFinite)),
    stateMs: finiteMedian(stateTimes, { positive: true }),
    successRate: completed.length / attempts.length,
    transport: generated[0]?.meta.transport ?? 'unknown',
    variant: completed[0]?.meta.variant ?? evalCase.kind,
  });
}

const summary = {
  averageContractPassRate: finiteAverage(rows.map((row) => row.contractPassRate)),
  averageQuality: finiteAverage(rows.map((row) => row.quality)),
  averageSuccessRate: average(rows.map((row) => row.successRate)),
  cases: rows.length,
  contractMetrics: Object.fromEntries(
    [...new Set(rows.flatMap((row) => Object.keys(row.contractMetrics)))].map((name) => [
      name,
      average(rows.map((row) => row.contractMetrics[name]).filter(Number.isFinite)),
    ]),
  ),
  medianFirstResponseMs: finiteMedian(rows.map((row) => row.firstResponseMs)),
  medianGenerationMs: finiteMedian(
    rows.map((row) => row.generationMs),
    { positive: true },
  ),
  medianStateMs: finiteMedian(
    rows.map((row) => row.stateMs),
    { positive: true },
  ),
};
await writeJson(join(runDir, 'summary.json'), { rows, summary });

const lines = [
  `# Walkthrough eval: ${label}`,
  '',
  '| Case | Variant | Attempts | Success | Contract | Contract metrics | Calls | Hunks | State | Prompt | First response | Generation | Input | Output | Main coverage | Quality | Transport |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
  ...rows.map(
    (row) =>
      `| ${row.case} | ${row.variant} | ${row.attempts} | ${(row.successRate * 100).toFixed(0)}% | ${formatNumber(row.contractPassRate, (value) => `${(value * 100).toFixed(0)}%`)} | ${
        Object.entries(row.contractMetrics)
          .map(([name, value]) => `${name}=${value.toFixed(3)}`)
          .join(', ') || 'n/a'
      } | ${row.modelCalls} | ${row.hunkCount} | ${formatNumber(row.stateMs, (value) => `${value.toFixed(1)}ms`)} | ${formatNumber(row.promptChars, (value) => `${Math.round(value / 1000)}k`)} | ${formatNumber(row.firstResponseMs, (value) => `${(value / 1000).toFixed(2)}s`)} | ${formatNumber(row.generationMs, (value) => `${(value / 1000).toFixed(2)}s`)} | ${formatNumber(row.inputTokens, Math.round)} | ${formatNumber(row.outputTokens, Math.round)} | ${formatNumber(row.mainCoverage, (value) => `${(value * 100).toFixed(0)}%`)} | ${formatNumber(row.quality, (value) => `${value.toFixed(1)}/100`)} | ${row.transport} |`,
  ),
  '',
  '## Summary',
  '',
  '```json',
  JSON.stringify(summary, null, 2),
  '```',
  '',
];
const report = `${lines.join('\n')}\n`;
await writeFile(join(runDir, 'report.md'), report);
process.stdout.write(report);
