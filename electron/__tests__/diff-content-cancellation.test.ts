import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { git, runWithCommandSignal } = require('../git-state/common.cjs') as {
  git: (repoPath: string, args: ReadonlyArray<string>) => Promise<string>;
  runWithCommandSignal: <Value>(signal: AbortSignal, callback: () => Value) => Value;
};

const waitForFile = async (path: string) => {
  for (let index = 0; index < 100; index += 1) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
};

test('diff-content cancellation terminates the underlying Git command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-diff-cancel-'));
  const command = join(directory, 'git');
  const pidPath = join(directory, 'pid');
  const signalPath = join(directory, 'signal');
  const previousPath = process.env.PATH;
  try {
    await writeFile(
      command,
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on('SIGTERM', () => {
  writeFileSync(${JSON.stringify(signalPath)}, 'SIGTERM');
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
    );
    await chmod(command, 0o755);
    process.env.PATH = `${directory}:${previousPath ?? ''}`;
    const controller = new AbortController();
    const pending = runWithCommandSignal(controller.signal, () => git(directory, ['status']));
    await waitForFile(pidPath);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(waitForFile(signalPath)).resolves.toBe('SIGTERM');
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { force: true, recursive: true });
  }
});

test('renderer reload and retarget cancel main-process diff-content ownership', async () => {
  const source = await readFile(join(process.cwd(), 'electron/main.cjs'), 'utf8');
  const navigation = source.slice(
    source.indexOf("window.webContents.on('did-start-navigation'"),
    source.indexOf("window.webContents.on('render-process-gone'"),
  );
  expect(navigation).toContain('abortDiffContentRequests(webContentsId)');

  const retarget = source.slice(
    source.indexOf("new Error('The walkthrough window was retargeted.')"),
    source.indexOf('matchingWindow.reload()') + 'matchingWindow.reload()'.length,
  );
  expect(retarget).toContain('abortDiffContentRequests(matchingWebContentsId)');
  expect(retarget.indexOf('abortDiffContentRequests')).toBeLessThan(
    retarget.indexOf('matchingWindow.reload()'),
  );
});
