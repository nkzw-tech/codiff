#!/usr/bin/env node

import { join } from 'node:path';
import process from 'node:process';
import { readJson, resolveRunDir } from './lib.mjs';

const [baselineLabel, candidateLabel, enforceFlag] = process.argv.slice(2);
if (!baselineLabel || !candidateLabel) {
  throw new Error('usage: node evals/compare.mjs <baseline-label> <candidate-label> [--enforce]');
}

const isNumber = (value) => Number.isFinite(value);
const isValidTiming = (value) => isNumber(value) && value > 0;
const ratio = (baseline, candidate) =>
  isValidTiming(baseline) && isValidTiming(candidate) ? baseline / candidate : null;
const qualityPass = (baseline, candidate) =>
  isNumber(baseline) && isNumber(candidate)
    ? baseline === 0 || candidate / baseline >= 0.9
    : !isNumber(baseline) && !isNumber(candidate);

const baseline = await readJson(join(resolveRunDir(baselineLabel), 'summary.json'));
const candidate = await readJson(join(resolveRunDir(candidateLabel), 'summary.json'));
if (!baseline || !candidate) {
  throw new Error('Run evals/report.mjs for both labels before comparing them.');
}

const baselineRows = new Map(baseline.rows.map((row) => [row.case, row]));
const candidateRows = new Map(candidate.rows.map((row) => [row.case, row]));
const caseIdsMatch =
  baselineRows.size === candidateRows.size &&
  [...baselineRows.keys()].every((caseId) => candidateRows.has(caseId));
const comparisons = [...baselineRows].flatMap(([caseId, base]) => {
  const candidateRow = candidateRows.get(caseId);
  if (!candidateRow) {
    return [];
  }
  const baselineHasContract = isNumber(base.contractPassRate);
  const candidateHasContract = isNumber(candidateRow.contractPassRate);
  return [
    {
      case: caseId,
      contractGatePassed:
        baselineHasContract === candidateHasContract &&
        (!candidateHasContract || candidateRow.contractPassRate === 1),
      fixtureMatches:
        base.fixtureConsistent === true &&
        candidateRow.fixtureConsistent === true &&
        base.fixtureDigest === candidateRow.fixtureDigest,
      qualityChange:
        isNumber(base.quality) && isNumber(candidateRow.quality)
          ? candidateRow.quality - base.quality
          : null,
      qualityGatePassed: qualityPass(base.quality, candidateRow.quality),
      speedup: ratio(base.generationMs, candidateRow.generationMs),
      stateSpeedup: ratio(base.stateMs, candidateRow.stateMs),
      variantMatches: base.variant === candidateRow.variant,
    },
  ];
});

const baselineQuality = baseline.summary.averageQuality;
const candidateQuality = candidate.summary.averageQuality;
const qualityRatio =
  isNumber(baselineQuality) && isNumber(candidateQuality)
    ? baselineQuality === 0
      ? 1
      : candidateQuality / baselineQuality
    : null;
const qualityGatePassed = qualityRatio == null || qualityRatio >= 0.9;
const perCaseQualityGatePassed = comparisons.every((item) => item.qualityGatePassed);
const fixtureGatePassed =
  caseIdsMatch && comparisons.every((item) => item.fixtureMatches && item.variantMatches);
const contractGatePassed = caseIdsMatch && comparisons.every((item) => item.contractGatePassed);
const speedup = ratio(baseline.summary.medianGenerationMs, candidate.summary.medianGenerationMs);
const baselineStateMs = baseline.summary.medianStateMs;
const candidateStateMs = candidate.summary.medianStateMs;
const baselineStateAvailable = isValidTiming(baselineStateMs);
const candidateStateAvailable = isValidTiming(candidateStateMs);
const stateMetricsAvailable = baselineStateAvailable && candidateStateAvailable;
const stateSpeedup = ratio(baselineStateMs, candidateStateMs);
const stateRegressionAllowanceMs = baselineStateAvailable
  ? Math.max(3, baselineStateMs * 0.05)
  : null;
const stateGatePassed =
  !baselineStateAvailable ||
  (candidateStateAvailable && candidateStateMs <= baselineStateMs + stateRegressionAllowanceMs);

process.stdout.write('# Walkthrough eval comparison\n\n');
process.stdout.write(`- Baseline: \`${baselineLabel}\`\n`);
process.stdout.write(`- Candidate: \`${candidateLabel}\`\n`);
process.stdout.write(
  `- Aggregate speedup: ${speedup == null ? 'n/a' : `${speedup.toFixed(2)}x`}\n`,
);
process.stdout.write(
  `- Repository state: ${
    stateMetricsAvailable
      ? `${baselineStateMs.toFixed(1)}ms -> ${candidateStateMs.toFixed(1)}ms (${stateSpeedup.toFixed(2)}x)`
      : baselineStateAvailable
        ? `${baselineStateMs.toFixed(1)}ms -> n/a`
        : 'n/a'
  }\n`,
);
process.stdout.write(
  `- Quality: ${
    qualityRatio == null
      ? 'n/a'
      : `${baselineQuality.toFixed(1)} -> ${candidateQuality.toFixed(1)} (${((qualityRatio - 1) * 100).toFixed(1)}%)`
  }\n`,
);
process.stdout.write(
  `- Repository-state gate: ${baselineStateAvailable ? (stateGatePassed ? 'PASS' : 'FAIL') : 'N/A'}${
    baselineStateAvailable ? ` (max +${stateRegressionAllowanceMs.toFixed(1)}ms)` : ''
  }\n`,
);
process.stdout.write(`- 10% quality gate: ${qualityGatePassed ? 'PASS' : 'FAIL'}\n`);
process.stdout.write(`- Per-case quality gate: ${perCaseQualityGatePassed ? 'PASS' : 'FAIL'}\n`);
process.stdout.write(`- Fixture/variant gate: ${fixtureGatePassed ? 'PASS' : 'FAIL'}\n`);
process.stdout.write(`- Review contract gate: ${contractGatePassed ? 'PASS' : 'FAIL'}\n\n`);
process.stdout.write(
  '| Case | Fixture | Variant | Contract | State speedup | Generation speedup | Quality change |\n|---|---|---|---|---:|---:|---:|\n',
);
for (const comparison of comparisons) {
  process.stdout.write(
    `| ${comparison.case} | ${comparison.fixtureMatches ? 'match' : 'mismatch'} | ${comparison.variantMatches ? 'match' : 'mismatch'} | ${comparison.contractGatePassed ? 'PASS' : 'FAIL'} | ${comparison.stateSpeedup == null ? 'n/a' : `${comparison.stateSpeedup.toFixed(2)}x`} | ${comparison.speedup == null ? 'n/a' : `${comparison.speedup.toFixed(2)}x`} | ${comparison.qualityChange == null ? 'n/a' : `${comparison.qualityChange >= 0 ? '+' : ''}${comparison.qualityChange.toFixed(1)}`} |\n`,
  );
}

if (
  enforceFlag === '--enforce' &&
  (!qualityGatePassed ||
    !perCaseQualityGatePassed ||
    !fixtureGatePassed ||
    !contractGatePassed ||
    !stateGatePassed)
) {
  process.exitCode = 2;
}
