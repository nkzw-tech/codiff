import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vite-plus/test';

test('routes the production walkthrough IPC handler through the structured task runner', async () => {
  const source = await readFile(new URL('../main.cjs', import.meta.url), 'utf8');
  const handlerStart = source.indexOf("ipcMain.handle('codiff:getNarrativeWalkthrough'");
  const handlerEnd = source.indexOf("ipcMain.handle('codiff:shareWalkthrough'", handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);

  expect(handlerStart).toBeGreaterThan(-1);
  expect(handlerEnd).toBeGreaterThan(handlerStart);
  expect(source).toContain(
    "const { runWalkthroughGenerationTasks } = require('./walkthrough-generation-bridge.cjs');",
  );
  expect(handler).toContain('const result = await runWalkthroughGenerationTasks({');
  expect(handler).not.toContain('agent.run(');
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

test('loads the built walkthrough runtime from a packaged application shape', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-walkthrough-package-'));
  try {
    const bridgePath = join(directory, 'electron/walkthrough-generation-bridge.cjs');
    await mkdir(dirname(bridgePath), { recursive: true });
    await cp(new URL('../walkthrough-generation-bridge.cjs', import.meta.url), bridgePath);
    await cp(join(process.cwd(), 'core/dist'), join(directory, 'core/dist'), { recursive: true });
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
