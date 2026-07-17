import { execFile } from 'node:child_process';
import { readFile, realpath, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { getGitTestEnvironment } from '../../core/__tests__/helpers/git.ts';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

type Snapshot = {
  head: string;
  pathSignatures: Record<string, string>;
  pathVersions?: Record<string, string>;
  root: string;
  signature: string;
};

type SubscriberState = {
  focused: boolean;
  visible: boolean;
};

type Coordinator = {
  attach: (subscriber: {
    getState: () => SubscriberState;
    id: number;
    notify: (root: string) => void;
    root: string;
  }) => Promise<void>;
  beginWrite: (
    id: number,
    path: string,
  ) => { generation: number; path: string; root: string } | null;
  checkNow: (id: number) => Promise<void>;
  detach: (id: number) => void;
  finishWrite: (
    token: { generation: number; path: string; root: string } | null,
    version: string | null,
  ) => void;
  focus: (id: number) => void;
  getWatcherCount: () => number;
  getWatcherSubscriberCount: (root: string) => number;
  reset: (id: number, root: string) => Promise<void>;
  visibilityChanged: (id: number) => void;
};

const require = createRequire(import.meta.url);
const {
  createRepositoryWatcherCoordinator,
  getRepositoryWatcherPollInterval,
  normalizeRepositoryWatcherPath,
  parseRepositoryWatcherStatus,
  readRepositoryWatcherSnapshot,
  repositoryWatcherSnapshotsMatchExpectedWrites,
} = require('../repository-watcher.cjs') as {
  createRepositoryWatcherCoordinator: (options: {
    clearTimeoutImpl?: (timer: unknown) => void;
    readSnapshot: (
      root: string,
      exactPaths: Iterable<string>,
      knownDirtyPaths: Iterable<string>,
    ) => Promise<Snapshot>;
    setTimeoutImpl?: (callback: () => void, delay: number) => unknown;
  }) => Coordinator;
  getRepositoryWatcherPollInterval: (states: ReadonlyArray<SubscriberState>) => number;
  normalizeRepositoryWatcherPath: (path: string, pathSeparator?: string) => string;
  parseRepositoryWatcherStatus: (raw: string) => { head: string; paths: Array<string> };
  readRepositoryWatcherSnapshot: (
    root: string,
    exactPaths?: Iterable<string>,
    knownDirtyPaths?: Iterable<string>,
  ) => Promise<Snapshot>;
  repositoryWatcherSnapshotsMatchExpectedWrites: (
    left: Snapshot,
    right: Snapshot,
    expectedPathVersions: ReadonlyMap<string, string>,
  ) => boolean;
};

const execFileAsync = promisify(execFile);
const largeTestFileSize = 8 * 1024 * 1024;
const planVersion = '1234567890abcdef'.padEnd(64, '0');
const planSignature = ['docs/plan.md', 'file', '33188', '5', '1000'].join('\0');
const baseline: Snapshot = {
  head: 'head',
  pathSignatures: {
    'docs/plan.md': 'old-plan',
    'src/app.ts': 'old-app',
  },
  root: '/repo',
  signature: 'baseline',
};

const git = async (repository: string, args: ReadonlyArray<string>) => {
  const { stdout } = await execFileAsync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: getGitTestEnvironment(),
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
};

test('normalizes repository watcher paths', () => {
  expect(normalizeRepositoryWatcherPath('docs\\plan.md', '\\')).toBe('docs/plan.md');
  expect(normalizeRepositoryWatcherPath('docs\\plan.md', '/')).toBe('docs\\plan.md');
});

test('parses porcelain-v2 branch information and dirty paths', () => {
  const hash = '1'.repeat(40);
  const raw = [
    `# branch.oid ${hash}`,
    '# branch.head feature',
    `1 .M N... 100644 100644 100644 ${hash} ${hash} src/app file.ts`,
    `2 R. N... 100644 100644 100644 ${hash} ${hash} R100 src/new.ts`,
    'src/old.ts',
    `u UU N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} conflicted.ts`,
    '? untracked file.txt',
    '',
  ].join('\0');

  expect(parseRepositoryWatcherStatus(raw)).toEqual({
    head: `${hash}\0feature`,
    paths: ['src/app file.ts', 'src/new.ts', 'src/old.ts', 'conflicted.ts', 'untracked file.txt'],
  });
});

test('ignores only expected app-written paths', () => {
  expect(
    repositoryWatcherSnapshotsMatchExpectedWrites(
      baseline,
      {
        ...baseline,
        pathSignatures: {
          ...baseline.pathSignatures,
          'docs/plan.md': planSignature,
        },
        pathVersions: {
          'docs/plan.md': planVersion.slice(0, 16),
        },
      },
      new Map([['docs/plan.md', planVersion]]),
    ),
  ).toBe(true);

  expect(
    repositoryWatcherSnapshotsMatchExpectedWrites(
      baseline,
      {
        ...baseline,
        pathSignatures: {
          'docs/plan.md': planSignature,
          'src/app.ts': 'new-app',
        },
        pathVersions: {
          'docs/plan.md': planVersion.slice(0, 16),
        },
      },
      new Map([['docs/plan.md', planVersion]]),
    ),
  ).toBe(false);
});

test('does not ignore a different write to the expected path', () => {
  expect(
    repositoryWatcherSnapshotsMatchExpectedWrites(
      baseline,
      {
        ...baseline,
        pathSignatures: {
          ...baseline.pathSignatures,
          'docs/plan.md': planSignature,
        },
        pathVersions: {
          'docs/plan.md': 'external-change',
        },
      },
      new Map([['docs/plan.md', planVersion]]),
    ),
  ).toBe(false);
});

test('never ignores repository HEAD changes', () => {
  expect(
    repositoryWatcherSnapshotsMatchExpectedWrites(
      baseline,
      {
        ...baseline,
        head: 'new-head',
        pathSignatures: {
          ...baseline.pathSignatures,
          'docs/plan.md': planSignature,
        },
        pathVersions: {
          'docs/plan.md': planVersion.slice(0, 16),
        },
      },
      new Map([['docs/plan.md', planVersion]]),
    ),
  ).toBe(false);
});

test('shares one watcher per repository and adapts polling to window state', async () => {
  const timers: Array<{ callback: () => void; cleared: boolean; delay: number }> = [];
  const states = new Map<number, SubscriberState>([
    [1, { focused: true, visible: true }],
    [2, { focused: false, visible: false }],
  ]);
  const notifications: Array<number> = [];
  let current = baseline;
  let reads = 0;
  const coordinator = createRepositoryWatcherCoordinator({
    clearTimeoutImpl: (timer) => {
      (timer as (typeof timers)[number]).cleared = true;
    },
    readSnapshot: async (root) => {
      reads += 1;
      return { ...current, root };
    },
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, cleared: false, delay };
      timers.push(timer);
      return timer;
    },
  });

  await coordinator.attach({
    getState: () => states.get(1) as SubscriberState,
    id: 1,
    notify: () => notifications.push(1),
    root: '/repo',
  });
  await coordinator.attach({
    getState: () => states.get(2) as SubscriberState,
    id: 2,
    notify: () => notifications.push(2),
    root: '/repo',
  });

  expect(reads).toBe(1);
  expect(coordinator.getWatcherCount()).toBe(1);
  expect(coordinator.getWatcherSubscriberCount('/repo')).toBe(2);
  expect(timers.filter(({ cleared }) => !cleared).at(-1)?.delay).toBe(2500);

  states.set(1, { focused: false, visible: true });
  coordinator.visibilityChanged(1);
  expect(timers.filter(({ cleared }) => !cleared).at(-1)?.delay).toBe(10_000);

  coordinator.focus(2);
  expect(timers.filter(({ cleared }) => !cleared).at(-1)?.delay).toBe(0);

  current = {
    ...baseline,
    pathSignatures: {
      ...baseline.pathSignatures,
      'src/app.ts': 'external-change',
    },
  };
  await coordinator.checkNow(1);
  expect(notifications).toEqual([1, 2]);

  coordinator.detach(1);
  coordinator.detach(2);
  expect(coordinator.getWatcherCount()).toBe(0);
});

test('resetting one subscriber preserves change notifications for other windows', async () => {
  let current = baseline;
  const notifications: Array<number> = [];
  const coordinator = createRepositoryWatcherCoordinator({
    readSnapshot: async () => current,
  });
  await coordinator.attach({
    getState: () => ({ focused: true, visible: true }),
    id: 1,
    notify: () => notifications.push(1),
    root: '/repo',
  });
  await coordinator.attach({
    getState: () => ({ focused: true, visible: true }),
    id: 2,
    notify: () => notifications.push(2),
    root: '/repo',
  });

  current = {
    ...baseline,
    pathSignatures: {
      ...baseline.pathSignatures,
      'src/app.ts': 'first-external-change',
    },
  };
  await coordinator.reset(1, '/repo');
  expect(notifications).toEqual([2]);

  current = {
    ...current,
    pathSignatures: {
      ...current.pathSignatures,
      'src/app.ts': 'second-external-change',
    },
  };
  await coordinator.checkNow(1);
  expect(notifications).toEqual([2, 1]);

  coordinator.detach(1);
  coordinator.detach(2);
});

test('uses exact hashes while suppressing Codiff-authored writes only for their owner', async () => {
  let current = baseline;
  const exactPathReads: Array<Array<string>> = [];
  const knownDirtyPathReads: Array<Array<string>> = [];
  const notifications: Array<number> = [];
  const coordinator = createRepositoryWatcherCoordinator({
    readSnapshot: async (_root, exactPaths, knownDirtyPaths) => {
      const paths = [...exactPaths];
      exactPathReads.push(paths);
      knownDirtyPathReads.push([...knownDirtyPaths]);
      return {
        ...current,
        pathVersions: paths.includes('docs/plan.md')
          ? { 'docs/plan.md': planVersion.slice(0, 16) }
          : {},
      };
    },
  });
  await coordinator.attach({
    getState: () => ({ focused: true, visible: true }),
    id: 1,
    notify: () => notifications.push(1),
    root: '/repo',
  });
  await coordinator.attach({
    getState: () => ({ focused: true, visible: true }),
    id: 2,
    notify: () => notifications.push(2),
    root: '/repo',
  });

  const token = coordinator.beginWrite(1, 'docs/plan.md');
  current = {
    ...baseline,
    pathSignatures: {
      ...baseline.pathSignatures,
      'docs/plan.md': planSignature,
    },
  };
  coordinator.finishWrite(token, planVersion);
  await coordinator.checkNow(1);

  expect(exactPathReads.at(-1)).toEqual(['docs/plan.md']);
  expect(knownDirtyPathReads.at(-1)).toEqual(['docs/plan.md', 'src/app.ts']);
  expect(notifications).toEqual([2]);

  current = {
    ...current,
    pathSignatures: {
      ...current.pathSignatures,
      'src/app.ts': 'external-change',
    },
  };
  await coordinator.checkNow(1);
  expect(exactPathReads.at(-1)).toEqual([]);
  expect(notifications).toEqual([2, 1]);
  coordinator.detach(1);
  coordinator.detach(2);
});

test('uses focused, background, and hidden polling intervals', () => {
  expect(getRepositoryWatcherPollInterval([{ focused: true, visible: true }])).toBe(2500);
  expect(getRepositoryWatcherPollInterval([{ focused: false, visible: true }])).toBe(10_000);
  expect(getRepositoryWatcherPollInterval([{ focused: false, visible: false }])).toBe(30_000);
});

test('clean and large dirty repository watcher polls use one Git process', async () => {
  await using directory = await createTemporaryDirectory('codiff-repository-watcher-');
  const repository = await realpath(directory.path);
  const largePath = join(repository, 'large.bin');
  const countGitProcesses = async (label: string, knownDirtyPaths: ReadonlyArray<string>) => {
    const tracePath = join(repository, '.git', `trace-${label}.jsonl`);
    await using _traceEnvironment = createTemporaryEnvironment({ GIT_TRACE2_EVENT: tracePath });
    await readRepositoryWatcherSnapshot(repository, [], knownDirtyPaths);
    return (await readFile(tracePath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: string })
      .filter(({ event }) => event === 'version').length;
  };

  await git(repository, ['init']);
  await writeFile(largePath, Buffer.alloc(largeTestFileSize, 1));
  await git(repository, ['add', 'large.bin']);
  await git(repository, ['commit', '-m', 'initial']);

  const cleanProcessCount = await countGitProcesses('clean', []);
  await writeFile(largePath, Buffer.alloc(largeTestFileSize, 2));
  const initialDirtySnapshot = await readRepositoryWatcherSnapshot(repository);
  const dirtyProcessCount = await countGitProcesses(
    'dirty',
    Object.keys(initialDirtySnapshot.pathSignatures),
  );
  await writeFile(join(repository, 'new.txt'), 'new\n');
  const combinedSnapshot = await readRepositoryWatcherSnapshot(repository, [], ['large.bin']);
  const snapshot = await readRepositoryWatcherSnapshot(repository, ['large.bin'], ['large.bin']);

  expect(cleanProcessCount).toBe(1);
  expect(dirtyProcessCount).toBe(1);
  expect(initialDirtySnapshot.pathVersions).toEqual({});
  expect(Object.keys(combinedSnapshot.pathSignatures).sort()).toEqual(['large.bin', 'new.txt']);
  expect(snapshot.pathSignatures['large.bin'].split('\0')).toHaveLength(7);
  expect(snapshot.pathVersions?.['large.bin']).toHaveLength(16);
}, 15_000);

test('detects same-size edits when the modification time is preserved', async () => {
  await using directory = await createTemporaryDirectory('codiff-preserved-mtime-');
  const repository = await realpath(directory.path);
  const path = join(repository, 'same-size.txt');
  const fixedTime = 1_700_000_000;

  await git(repository, ['init']);
  await writeFile(path, 'first\n');
  await utimes(path, fixedTime, fixedTime);
  const before = await readRepositoryWatcherSnapshot(repository);
  const beforeStat = await stat(path);

  await new Promise((resolve) => setTimeout(resolve, 10));
  await writeFile(path, 'other\n');
  await utimes(path, fixedTime, fixedTime);
  const afterStat = await stat(path);
  const after = await readRepositoryWatcherSnapshot(
    repository,
    [],
    Object.keys(before.pathSignatures),
  );

  expect(afterStat.size).toBe(beforeStat.size);
  expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  expect(after.signature).not.toBe(before.signature);
});

test('preserves literal backslashes in POSIX repository paths', async () => {
  if (process.platform === 'win32') {
    return;
  }

  await using directory = await createTemporaryDirectory('codiff-backslash-path-');
  const repository = await realpath(directory.path);
  const path = 'foo\\bar.txt';

  await git(repository, ['init']);
  await writeFile(join(repository, path), 'dirty\n');
  const before = await readRepositoryWatcherSnapshot(repository);
  const after = await readRepositoryWatcherSnapshot(
    repository,
    [],
    Object.keys(before.pathSignatures),
  );

  expect(Object.keys(before.pathSignatures)).toEqual([path]);
  expect(Object.keys(after.pathSignatures)).toEqual([path]);
  expect(after.signature).toBe(before.signature);
});
