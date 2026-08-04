import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, expect, test } from 'vite-plus/test';
import { runScenarioCommand } from '../../scripts/test-scenario-command.mjs';
import { materializeReviewScenario, reviewScenarios } from '../../test-scenarios/review/index.mjs';
import { resolveSubmissionAnchor } from '../../test-scenarios/submission-anchors.mjs';
import { getSubmissionPlan } from '../../test-scenarios/submission/index.mjs';

type MaterializedScenario = {
  directory: string;
  result: Awaited<ReturnType<typeof materializeReviewScenario>>;
  runGit: (args: ReadonlyArray<string>) => string;
};

const materializedScenarios = new Map<string, Promise<MaterializedScenario>>();

const materialize = (scenarioId: string): Promise<MaterializedScenario> => {
  const cached = materializedScenarios.get(scenarioId);
  if (cached) {
    return cached;
  }
  const pending = (async () => {
    const directory = await mkdtemp(`${tmpdir()}/codiff-scenario-`);
    const runGit = (args: ReadonlyArray<string>) =>
      execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
    try {
      const result = await materializeReviewScenario({
        root: process.cwd(),
        runGit,
        scenarioId,
      });
      return { directory, result, runGit };
    } catch (error) {
      await rm(directory, { force: true, recursive: true });
      throw error;
    }
  })();
  materializedScenarios.set(scenarioId, pending);
  return pending;
};

const removeScenarioDirectory = async (directory: string) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await rm(directory, { force: true, recursive: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt === 3) {
        throw error;
      }
      await delay(50);
    }
  }
};

afterAll(async () => {
  const scenarios = await Promise.allSettled(materializedScenarios.values());
  await Promise.all(
    scenarios.flatMap((scenario) =>
      scenario.status === 'fulfilled' ? [removeScenarioDirectory(scenario.value.directory)] : [],
    ),
  );
});

const scenarioTestTimeout = 60_000;

test('scenario manifests reference six canonical patch bodies without stored duplicates', async () => {
  const patchFiles = (await readdir('test-scenarios', { recursive: true }))
    .filter((file) => file.endsWith('.diff'))
    .toSorted();
  const localPatches = patchFiles.filter((file) => !file.startsWith('shared/patches/'));
  const hashes = await Promise.all(
    patchFiles.map(async (file) =>
      createHash('sha256')
        .update(await readFile(`test-scenarios/${file}`))
        .digest('hex'),
    ),
  );

  expect(patchFiles).toHaveLength(6);
  expect(new Set(hashes).size).toBe(6);
  expect(localPatches).toEqual([
    'review/current/current-commit-stack/patches/005-rewrite-orchestration.diff',
  ]);
  for (const scenario of Object.values(reviewScenarios)) {
    expect(scenario.patchSequence.length).toBeGreaterThan(0);
    expect(scenario.patchSequence.every((patch: string) => !patch.startsWith('/'))).toBe(true);
  }
});

test('scenario modules omit unused publication hooks', async () => {
  const scenarioModulePaths = (await readdir('test-scenarios/review', { recursive: true }))
    .filter((file) => file.endsWith('.mjs'))
    .toSorted();
  expect(scenarioModulePaths).not.toContain('publications.mjs');

  const scenarioModuleSources = await Promise.all(
    scenarioModulePaths.map((file) => readFile(`test-scenarios/review/${file}`, 'utf8')),
  );
  const combinedSource = scenarioModuleSources.join('\n');
  expect(combinedSource).not.toContain('onPublish');
  expect(combinedSource).not.toContain('createPublicationRecorder');
});

test('scenario commands bound output and terminate timeout and cancellation paths', async () => {
  const directory = await mkdtemp(`${tmpdir()}/codiff-scenario-command-`);
  try {
    await expect(
      runScenarioCommand({
        args: ['-e', `process.stdout.write('x'.repeat(2048))`],
        capture: true,
        cwd: directory,
        executable: process.execPath,
        maxBytes: 1024,
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({ code: 'output-limit' });

    const marker = `${directory}/partial-state`;
    const timeoutSignal = `${directory}/timeout-signal`;
    await expect(
      runScenarioCommand({
        args: [
          '-e',
          `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'partial'); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(timeoutSignal)}, 'SIGTERM'); process.exit(0); }); setInterval(() => {}, 1000);`,
        ],
        capture: true,
        cwd: directory,
        executable: process.execPath,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
    await expect(readFile(marker, 'utf8')).resolves.toBe('partial');
    await expect(readFile(timeoutSignal, 'utf8')).resolves.toBe('SIGTERM');

    const preAbortedMarker = `${directory}/pre-aborted-marker`;
    const preAbortedController = new AbortController();
    preAbortedController.abort();
    await expect(
      runScenarioCommand({
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(preAbortedMarker)}, 'ran')`,
        ],
        capture: true,
        cwd: directory,
        executable: process.execPath,
        signal: preAbortedController.signal,
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
    await expect(readFile(preAbortedMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const abortSignal = `${directory}/abort-signal`;
    const controller = new AbortController();
    const aborted = runScenarioCommand({
      args: [
        '-e',
        `const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(abortSignal)}, 'SIGTERM'); process.exit(0); }); setInterval(() => {}, 1000);`,
      ],
      capture: true,
      cwd: directory,
      executable: process.execPath,
      signal: controller.signal,
      timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(aborted).rejects.toMatchObject({ code: 'aborted' });
    await expect(readFile(abortSignal, 'utf8')).resolves.toBe('SIGTERM');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

for (const scenarioId of Object.keys(reviewScenarios)) {
  test(
    `materializes ${scenarioId} as a current notification-preferences review`,
    async () => {
      const scenario = await materialize(scenarioId);
      expect(scenario.runGit(['branch', '--show-current'])).toBe('feature/test-scenario');
      expect(scenario.runGit(['show', 'HEAD:src/domain/preferences.ts'])).toContain(
        'defaultPreferences',
      );
      expect(scenario.runGit(['show', 'HEAD:src/application/update-preferences.ts'])).toContain(
        'updatePreferences',
      );
      expect(Object.keys(scenario.result.revisions).length).toBeGreaterThanOrEqual(5);
    },
    scenarioTestTimeout,
  );
}

test(
  'current commit stack preserves the canonical feature order',
  async () => {
    const scenario = await materialize('current-commit-stack');
    const subjects = scenario.runGit(['log', '--format=%s', 'main..HEAD']).split('\n');
    expect(subjects).toEqual([
      'Verify preference update lifecycle',
      'Record preference update audit history',
      'Schedule preference deliveries around quiet hours',
      'Define quiet-hour preference policy',
    ]);
  },
  scenarioTestTimeout,
);

test(
  'current scenario materialization exposes base and feature checkpoints',
  async () => {
    const directory = await mkdtemp(`${tmpdir()}/codiff-scenario-`);
    const runGit = (args: ReadonlyArray<string>) =>
      execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
    const checkpoints: Array<string> = [];
    try {
      await materializeReviewScenario({
        onCheckpoint: async ({ kind }: { kind: string }) => {
          checkpoints.push(kind);
        },
        root: process.cwd(),
        runGit,
        scenarioId: 'current-commit-stack',
      });
      expect(checkpoints).toEqual([
        'base-ready',
        'feature-commit',
        'feature-commit',
        'feature-commit',
        'feature-commit',
      ]);
    } finally {
      await removeScenarioDirectory(directory);
    }
  },
  scenarioTestTimeout,
);

test('every current scenario exposes provider submission plans with resolvable anchors', async () => {
  for (const scenarioId of Object.keys(reviewScenarios)) {
    const scenario = await materialize(scenarioId);
    for (const provider of ['github', 'gitlab'] as const) {
      const plan = await getSubmissionPlan({
        provider,
        revisions: scenario.result.revisions,
        scenarioId,
      });
      expect(plan.length).toBeGreaterThan(0);
      for (const action of plan) {
        const targets = [
          ...(action.target ? [action.target] : []),
          ...('targets' in action ? action.targets : []),
        ];
        for (const target of targets) {
          await expect(
            resolveSubmissionAnchor({
              ...target,
              runGit: scenario.runGit,
            }),
          ).resolves.toMatchObject({ path: expect.any(String) });
        }
      }
    }
  }
}, 120_000);
