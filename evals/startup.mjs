// Usage: node evals/startup.mjs --output /tmp/before.json --runs 10 [--app /path/to/checkout]
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    app: { type: 'string' },
    baseline: { type: 'string' },
    capture: { type: 'string' },
    case: { type: 'string' },
    output: { type: 'string' },
    runs: { default: '10', type: 'string' },
  },
});
const root = resolve(import.meta.dirname, '..');
const appRoot = resolve(values.app ?? root);
const require = createRequire(import.meta.url);
const electron = require('electron');
const directory = await mkdtemp(join(tmpdir(), 'codiff-startup-'));
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error('--runs must be a positive integer');
}
const results = { app: appRoot, cases: {}, date: new Date().toISOString(), runs };
if (values.capture) {
  await mkdir(values.capture, { recursive: true });
}

for (const [name, fileCount, lineCount] of [
  ['small', 1, 100],
  ['large', 100, 200],
  ['empty', 0, 0],
  ['markdown', 0, 0],
  ['plan', 0, 0],
  ['error', 0, 0],
]) {
  if (values.case && values.case !== name) {
    continue;
  }
  const repository = join(directory, name);
  await mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Startup benchmark');
  git('config', 'user.email', 'startup@example.test');
  for (let index = 0; index < fileCount; index++) {
    await writeFile(
      join(repository, `file-${String(index).padStart(3, '0')}.ts`),
      Array.from({ length: lineCount }, (_, line) => `export const value${line} = ${line};\n`).join(
        '',
      ),
    );
  }
  git('add', '.');
  git('commit', '-qm', 'Initial', '--allow-empty');
  for (let index = 0; index < fileCount; index++) {
    const path = join(repository, `file-${String(index).padStart(3, '0')}.ts`);
    await writeFile(path, (await readFile(path, 'utf8')).replaceAll(' = ', ' = 1 + '));
  }
  const markdownPath = join(repository, 'review.md');
  if (name === 'markdown' || name === 'plan') {
    await writeFile(
      markdownPath,
      '# Startup review\n\nA complete first view.\n\n## Changes\n\n- Prepare the renderer.\n- Show the window.\n',
    );
  }
  const samples = [];
  // Discard one warmup; measured launches use fresh processes and warm disk caches.
  for (let run = -1; run < runs; run++) {
    const home = join(directory, `${name}-${run}`);
    await mkdir(join(home, '.codiff'), { recursive: true });
    await writeFile(
      join(home, '.codiff', 'codiff.jsonc'),
      JSON.stringify({ settings: { agentBackend: 'claude' } }),
    );
    await writeFile(
      join(home, '.codiff', 'window-state.json'),
      JSON.stringify({ height: 800, width: 1200, x: 100, y: 100 }),
    );
    const output = join(home, 'sample.json');
    const environment = {
      ...process.env,
      CODIFF_BENCHMARK_APP: appRoot,
      CODIFF_BENCHMARK_CAPTURE:
        values.capture && run === 0 ? join(values.capture, `${name}.png`) : '',
      CODIFF_BENCHMARK_HOME: home,
      CODIFF_BENCHMARK_ORIGIN: String(Date.now()),
      CODIFF_BENCHMARK_OUTPUT: output,
      CODIFF_CONFIG_DIR: join(home, '.codiff'),
      CODIFF_PLAN_FILE: name === 'plan' ? markdownPath : '',
      CODIFF_REPOSITORY_PATH: name === 'error' ? home : repository,
      ELECTRON_RENDERER_URL: '',
    };
    delete environment.ELECTRON_RUN_AS_NODE;
    await new Promise((resolveRun, reject) => {
      const child = spawn(electron, [join(root, 'electron/benchmarks/startup.cjs')], {
        env: environment,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Startup timed out: ${stderr}`));
      }, 20_000);
      child.on('error', reject);
      child.on('exit', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolveRun();
        } else {
          reject(new Error(`Electron exited ${code}: ${stderr}`));
        }
      });
    });
    const sample = JSON.parse(await readFile(output, 'utf8'));
    await rm(home, { force: true, recursive: true });
    if (run >= 0) {
      samples.push(sample);
    }
    process.stdout.write(
      `${name} ${run < 0 ? 'warmup' : run + 1}: content ${sample.content.toFixed(1)}ms, shown ${sample.windowShown.toFixed(1)}ms, partial ${sample.partialView.toFixed(1)}ms\n`,
    );
  }
  const summary = {};
  for (const key of Object.keys(samples[0])) {
    const sorted = samples.map((sample) => sample[key]).sort((a, b) => a - b);
    summary[key] = {
      median:
        (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
      p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
    };
  }
  results.cases[name] = { samples, summary };
  await rm(repository, { force: true, recursive: true });
}
if (Object.keys(results.cases).length === 0) {
  throw new Error(`Unknown startup case: ${values.case}`);
}
if (values.baseline) {
  const baseline = JSON.parse(await readFile(values.baseline, 'utf8'));
  results.comparison = {};
  for (const [name, result] of Object.entries(results.cases)) {
    const before = baseline.cases[name]?.summary;
    if (!before?.completeView) {
      throw new Error(`Baseline has no complete-view timings for ${name}`);
    }
    const after = result.summary;
    const difference = after.completeView.median - before.completeView.median;
    results.comparison[name] = {
      after: after.completeView,
      before: before.completeView,
      difference,
      partialFramesAfter: after.partialFrames,
      partialFramesBefore: before.partialFrames,
      percent: (difference / before.completeView.median) * 100,
    };
  }
}
await writeFile(
  values.output ?? join(directory, 'results.json'),
  `${JSON.stringify(results, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify(Object.fromEntries(Object.entries(results.cases).map(([name, result]) => [name, result.summary])), null, 2)}\n`,
);
if (results.comparison) {
  process.stdout.write(`Comparison: ${JSON.stringify(results.comparison, null, 2)}\n`);
}
