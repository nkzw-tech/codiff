#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { stdout } from 'node:process';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const { evaluateStartupTrace, parseStartupTrace } = require('../electron/startup-trace-gate.cjs');

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    scenario: { type: 'string' },
    temperature: { type: 'string' },
  },
  strict: true,
});

if (
  !['gitlab', 'local'].includes(values.scenario) ||
  !['cold', 'warm'].includes(values.temperature)
) {
  throw new Error('Expected --scenario=local|gitlab and --temperature=cold|warm.');
}
if (positionals.length === 0) {
  throw new Error('Expected at least one command-log JSONL path.');
}

for (const path of positionals) {
  const records = parseStartupTrace(await readFile(path, 'utf8'));
  const result = evaluateStartupTrace(records, {
    scenario: values.scenario,
    temperature: values.temperature,
  });
  stdout.write(`${JSON.stringify({ path, ...result })}\n`);
}
