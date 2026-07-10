import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);

// os.homedir() honors $HOME on POSIX, so point it at a temp dir to keep the
// store out of the real ~/.codiff during tests.
let home = '';
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'codiff-wt-store-'));
  process.env.HOME = home;
});

afterEach(() => {
  if (previousHome == null) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  rmSync(home, { force: true, recursive: true });
});

const loadStore = () => {
  const path = require.resolve('../walkthrough-store.cjs');
  delete require.cache[path];
  return require('../walkthrough-store.cjs') as typeof import('../walkthrough-store.cjs');
};

const sampleWalkthrough = () =>
  ({
    agent: 'claude',
    chapters: [],
    focus: 'Walk through the change.',
    generatedAt: '2026-01-01T00:00:00.000Z',
    kind: 'narrative',
    repo: { branch: 'main', root: '/repo' },
    source: { type: 'working-tree' },
    support: [],
    title: 'Walkthrough',
    version: 4,
  }) as never;

test('returns null when no walkthrough is saved', () => {
  const store = loadStore();
  expect(store.readStoredWalkthrough('claude:/repo:working-tree')).toBe(null);
});

test('round-trips a saved walkthrough with its commit and signature', () => {
  const store = loadStore();
  const key = 'claude:/repo:working-tree';
  store.writeStoredWalkthrough(key, {
    generatedAt: '2026-01-01T00:00:00.000Z',
    head: 'abc123',
    sessionId: 'sess-1',
    signature: 'sig-1',
    version: 1,
    walkthrough: sampleWalkthrough(),
  });

  expect(existsSync(store.getWalkthroughStorePath(key))).toBe(true);
  const stored = store.readStoredWalkthrough(key);
  expect(stored?.head).toBe('abc123');
  expect(stored?.signature).toBe('sig-1');
  expect(stored?.sessionId).toBe('sess-1');
  expect(stored?.walkthrough.title).toBe('Walkthrough');
});

test('keys different repos/sources to different files', () => {
  const store = loadStore();
  expect(store.getWalkthroughStorePath('claude:/a:working-tree')).not.toBe(
    store.getWalkthroughStorePath('claude:/b:working-tree'),
  );
});

test('treats a corrupt store file as nothing saved', () => {
  const store = loadStore();
  const key = 'claude:/repo:working-tree';
  const { mkdirSync, writeFileSync } = require('node:fs');
  const path = store.getWalkthroughStorePath(key);
  mkdirSync(join(home, '.codiff', 'walkthroughs'), { recursive: true });
  writeFileSync(path, '{ not json');
  expect(store.readStoredWalkthrough(key)).toBe(null);
});
