import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, expect, test } from 'vite-plus/test';
import {
  materializeReviewScenario,
  reviewScenarios,
} from '../../test-scenarios/review/index.mjs';

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
