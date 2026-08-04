import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { collectHunkIds } from '../../evals/lib.mjs';
import {
  buildEvalShareManifest,
  buildScenarioReviewTarget,
  remapWalkthroughHunks,
  resolveScenarioReviewRange,
} from '../../evals/review-artifacts.mjs';
import { materializeReviewScenario, reviewScenarios } from '../../test-scenarios/review/index.mjs';

const execFileAsync = promisify(execFile);
const runGit = (directory: string) => async (args: ReadonlyArray<string>) =>
  (await execFileAsync('git', args, { cwd: directory })).stdout.trim();
const { readRepositoryState } = await import('../../electron/git-state.cjs');

const removeDirectory = async (directory: string) => {
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

const scenarioWalkthrough = (
  scenarioId: string,
  state: Awaited<ReturnType<typeof readRepositoryState>>,
) => ({
  agent: 'codex',
  chapters: [
    {
      blurb: `Review ${scenarioId}.`,
      icon: 'path',
      id: 'scenario',
      stops: collectHunkIds(state.files).map((hunkId, index) => ({
        hunkIds: [hunkId],
        id: `scenario-stop-${index + 1}`,
        importance: 'normal',
        prose: `Review scenario change ${index + 1}.`,
        title: `Scenario change ${index + 1}`,
      })),
      title: 'Scenario',
    },
  ],
  generatedAt: new Date(state.generatedAt).toISOString(),
  kind: 'narrative',
  repo: { branch: state.branch, root: state.root },
  source: state.source,
  support: [],
  title: `Scenario: ${scenarioId}`,
  version: 4,
});

const semanticFiles = (state: Awaited<ReturnType<typeof readRepositoryState>>) =>
  state.files.map((file) => ({
    path: file.path,
    sections: file.sections.map((section) => ({ kind: section.kind, patch: section.patch })),
    status: file.status,
  }));

for (const [scenarioId, definition] of Object.entries(reviewScenarios)) {
  test(`frozen and rematerialized ${scenarioId} reviews preserve semantic files and anchors`, async () => {
    const initialRoot = await mkdtemp(`${tmpdir()}/codiff-eval-parity-initial-`);
    const recreatedRoot = await mkdtemp(`${tmpdir()}/codiff-eval-parity-recreated-`);
    try {
      const materialized = await materializeReviewScenario({
        root: process.cwd(),
        runGit: runGit(initialRoot),
        scenarioId,
      });
      const target = buildScenarioReviewTarget({ materialized, scenarioId });
      const initialRange = resolveScenarioReviewRange({
        materialized,
        source: target.source,
      });
      const initialState = await readRepositoryState(initialRoot, {
        base: initialRange.base,
        head: initialRange.head,
        symmetric: initialRange.symmetric,
        type: 'range',
      });
      const walkthrough = scenarioWalkthrough(scenarioId, initialState);
      const manifest = buildEvalShareManifest({
        artifactId: `scenario/${scenarioId}`,
        reviewScope: {
          kind: 'merge-request',
          structure: definition.walkthroughExpectations.reviewStructure,
        },
        state: initialState,
        walkthrough,
      });

      expect(JSON.stringify(manifest)).not.toContain(initialRoot);

      const recreated = await materializeReviewScenario({
        root: process.cwd(),
        runGit: runGit(recreatedRoot),
        scenarioId,
      });
      const recreatedRange = resolveScenarioReviewRange({
        materialized: recreated,
        source: target.source,
      });
      const recreatedState = await readRepositoryState(recreatedRoot, {
        base: recreatedRange.base,
        head: recreatedRange.head,
        symmetric: recreatedRange.symmetric,
        type: 'range',
      });
      const remapped = remapWalkthroughHunks({
        fromFiles: manifest.files,
        toFiles: recreatedState.files,
        walkthrough: manifest.walkthrough,
      });
      const remappedHunkIds = remapped.chapters.flatMap(
        (chapter: { stops: Array<{ hunkIds: Array<string> }> }) =>
          chapter.stops.flatMap((stop) => stop.hunkIds),
      );

      expect(semanticFiles(recreatedState)).toEqual(semanticFiles(initialState));
      expect(new Set(remappedHunkIds)).toEqual(new Set(collectHunkIds(recreatedState.files)));
    } finally {
      await Promise.all([removeDirectory(initialRoot), removeDirectory(recreatedRoot)]);
    }
  }, 120_000);
}
