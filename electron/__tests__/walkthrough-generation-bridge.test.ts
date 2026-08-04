import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vite-plus/test';

test('routes every public walkthrough request through one narrative coordinator', async () => {
  const source = await readFile(new URL('../main.cjs', import.meta.url), 'utf8');
  const coordinatorStart = source.indexOf('const getSingleDiffNarrativeWalkthrough');
  const coordinatorEnd = source.indexOf(
    "ipcMain.handle('codiff:shareWalkthrough'",
    coordinatorStart,
  );
  const coordinator = source.slice(coordinatorStart, coordinatorEnd);

  expect(coordinatorStart).toBeGreaterThan(-1);
  expect(coordinatorEnd).toBeGreaterThan(coordinatorStart);
  expect(source.match(/ipcMain\.handle\('codiff:getNarrativeWalkthrough'/g)).toHaveLength(1);
  expect(source).not.toContain("ipcMain.handle('codiff:generateReviewWalkthrough'");
  expect(source).toContain("require('./walkthrough-generation-bridge.cjs')");
  expect(coordinator).toContain('const result = await runWalkthroughGenerationTasks({');
  expect(coordinator).toContain('const result = await runStructuredWalkthroughGeneration({');
  expect(coordinator).not.toContain('agent.run(');
});

test('registers source-change cancellation across the production Electron bridge', async () => {
  const [mainSource, preloadSource] = await Promise.all([
    readFile(new URL('../main.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../preload.cjs', import.meta.url), 'utf8'),
  ]);
  const handlerStart = mainSource.indexOf("ipcMain.handle('codiff:cancelNarrativeWalkthrough'");
  const handlerEnd = mainSource.indexOf(
    "ipcMain.handle('codiff:getNarrativeWalkthrough'",
    handlerStart,
  );
  const handler = mainSource.slice(handlerStart, handlerEnd);

  expect(handlerStart).toBeGreaterThan(-1);
  expect(handlerEnd).toBeGreaterThan(handlerStart);
  expect(handler).toContain('walkthroughProgressGenerations.set(');
  expect(handler).toContain('walkthroughGenerationCoordinator.cancel(');
  expect(handler).toContain("new Error('The review source changed.')");
  expect(preloadSource).toContain(
    "cancelNarrativeWalkthrough: () => ipcRenderer.invoke('codiff:cancelNarrativeWalkthrough')",
  );
});

test('routes version walkthroughs from preload through the coordinated main handler', async () => {
  const [mainSource, preloadSource] = await Promise.all([
    readFile(new URL('../main.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../preload.cjs', import.meta.url), 'utf8'),
  ]);
  const handlerStart = mainSource.indexOf('const getTargetComparisonNarrativeWalkthrough');
  const handlerEnd = mainSource.indexOf(
    "ipcMain.handle('codiff:getNarrativeWalkthrough'",
    handlerStart,
  );
  const handler = mainSource.slice(handlerStart, handlerEnd);

  expect(handlerStart).toBeGreaterThan(-1);
  expect(handlerEnd).toBeGreaterThan(handlerStart);
  expect(preloadSource).toContain("ipcRenderer.invoke('codiff:getNarrativeWalkthrough', request)");
  expect(handler).toContain("request.selection.relation === 'version-comparison'");
  expect(handler).toContain('compareReviewVersionAggregate(');
  expect(handler).toContain('classifyReviewVersionEvolution(');
  expect(handler).toContain('walkthroughGenerationCoordinator.begin(');
  expect(handler).toContain('walkthroughGenerationCoordinator.getReusable(');
  expect(handler).toContain('walkthroughGenerationCoordinator.retain(');
  expect(handler).toContain('walkthroughGenerationCoordinator.finish(');
  expect(handler).toContain('base: parentSha');
  expect(handler).toContain('runWithCommandSignal(signal');
  expect(handler).toContain('mapWithConcurrency(commitUnits, 3');
  expect(handler).toContain('preparedCommitDiffs += 1;');
  expect(handler).toContain(
    'Prepared ${preparedCommitDiffs} of ${commitUnits.length} commit diffs.',
  );
});

test('loads the built walkthrough runtime from a packaged application shape', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-walkthrough-package-'));
  try {
    const bridgePath = join(directory, 'electron/walkthrough-generation-bridge.cjs');
    await mkdir(dirname(bridgePath), { recursive: true });
    await cp(new URL('../walkthrough-generation-bridge.cjs', import.meta.url), bridgePath);
    await cp(join(process.cwd(), 'core/dist'), join(directory, 'core/dist'), { recursive: true });
    await cp(join(process.cwd(), 'node_modules/valibot'), join(directory, 'node_modules/valibot'), {
      recursive: true,
    });
    const require = createRequire(join(directory, 'package.json'));
    const { loadWalkthroughGeneration } = require(bridgePath) as {
      loadWalkthroughGeneration: () => Promise<{
        runWalkthroughGenerationTasks: unknown;
      }>;
    };

    await expect(loadWalkthroughGeneration()).resolves.toMatchObject({
      runWalkthroughGenerationTasks: expect.any(Function),
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
