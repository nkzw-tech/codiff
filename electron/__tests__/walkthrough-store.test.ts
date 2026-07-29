import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);

let home = '';
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'codiff-walkthrough-store-'));
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
    chapters: [
      {
        blurb: '',
        icon: 'gear',
        id: 'runtime',
        stops: [
          {
            added: 1,
            deleted: 1,
            hunkIds: ['src/app.ts:staged:h1'],
            hunks: [
              {
                added: 1,
                deleted: 1,
                id: 'src/app.ts:staged:h1',
                path: 'src/app.ts',
                status: 'modified',
              },
            ],
            id: 'behavior',
            importance: 'normal',
            prose: 'Review the behavior.',
            title: 'Behavior',
          },
        ],
        title: 'Runtime',
      },
    ],
    focus: 'Walk through the change.',
    generatedAt: '2026-01-01T00:00:00.000Z',
    kind: 'narrative',
    repo: { branch: 'main', root: '/repo' },
    source: { type: 'working-tree' },
    support: [],
    title: 'Walkthrough',
    version: 4,
  }) as never;

const sampleAssessment = (overrides: Record<string, unknown> = {}) =>
  ({
    capturedPresentationState: { threadState: 'open' },
    identity: {
      codeScope: { type: 'single-diff' },
      threadId: 'thread-1',
    },
    input: {
      codeScope: { type: 'single-diff' },
      thread: {
        comments: [{ author: { login: 'reviewer' }, body: 'Check this.', id: 'comment-1' }],
        id: 'thread-1',
      },
    },
    outcome: { error: 'First failure.', status: 'failed' },
    ...overrides,
  }) as never;

const sampleV5Walkthrough = (items: ReadonlyArray<ReturnType<typeof sampleAssessment>>) =>
  ({
    assessments: { items },
    capturedContext: { branch: 'main', files: [], source: { type: 'working-tree' } },
    generationRequest: {
      review: { relation: 'single-diff', structure: 'single-diff' },
    },
    narrative: {
      content: {
        agent: 'codex',
        chapters: [],
        focus: 'Focus',
        generatedAt: '2026-01-01T00:00:00.000Z',
        kind: 'narrative',
        repo: { branch: 'main' },
        source: { type: 'working-tree' },
        support: [],
        title: 'Walkthrough',
      },
      generationMetadata: {
        agent: 'codex',
        generatedAt: '2026-01-01T00:00:00.000Z',
        model: 'gpt-5',
        profile: {
          agent: 'codex',
          authoringVersion: 'walkthrough-1',
          modelCandidates: ['gpt-5'],
          settings: {},
        },
      },
      structure: 'single-diff',
    },
    version: 5,
  }) as never;

test('round-trips an exact cache entry', () => {
  const store = loadStore();
  const cacheKey = 'exact-input-key';
  store.writeStoredWalkthrough(cacheKey, sampleWalkthrough());

  expect(existsSync(store.getWalkthroughStorePath(cacheKey))).toBe(true);
  expect(store.readStoredWalkthrough(cacheKey)?.title).toBe('Walkthrough');
  expect(store.readStoredWalkthrough('different-input-key')).toBe(null);
});

test('replaces an existing cache entry', () => {
  const store = loadStore();
  const cacheKey = 'exact-input-key';
  store.writeStoredWalkthrough(cacheKey, sampleWalkthrough());
  store.writeStoredWalkthrough(cacheKey, {
    ...sampleWalkthrough(),
    title: 'Updated walkthrough',
  });

  expect(store.readStoredWalkthrough(cacheKey)?.title).toBe('Updated walkthrough');
});

test('rejects malformed and incompatible cache records', () => {
  const store = loadStore();
  const cacheKey = 'exact-input-key';
  const path = store.getWalkthroughStorePath(cacheKey);
  mkdirSync(join(home, '.codiff', 'walkthroughs'), { recursive: true });

  writeFileSync(path, '{ not json');
  expect(store.readStoredWalkthrough(cacheKey)).toBe(null);

  writeFileSync(
    path,
    JSON.stringify({
      cacheKey,
      version: 2,
      walkthrough: sampleWalkthrough(),
    }),
  );
  expect(store.readStoredWalkthrough(cacheKey)).toBe(null);

  writeFileSync(
    path,
    JSON.stringify({
      cacheKey,
      version: 1,
      walkthrough: { ...sampleWalkthrough(), version: 3 },
    }),
  );
  expect(store.readStoredWalkthrough(cacheKey)).toBe(null);
});

test('replaces only the expected assessment identity and exposes retry failures', () => {
  const store = loadStore();
  const cacheKey = 'assessment-replacement';
  const first = sampleAssessment();
  const sibling = sampleAssessment({
    identity: { ...first.identity, threadId: 'thread-2' },
    input: { ...first.input, thread: { ...first.input.thread, id: 'thread-2' } },
  });
  store.writeStoredWalkthrough(cacheKey, sampleV5Walkthrough([first, sibling]));

  const retriedFailure = sampleAssessment({
    outcome: { error: 'Retry also failed.', status: 'failed' },
  });
  const result = store.replaceStoredAssessment(cacheKey, {
    component: retriedFailure,
    expectedComponent: first,
  });

  expect(result.status).toBe('replaced');
  expect(result.walkthrough?.assessments?.items).toEqual([retriedFailure, sibling]);
});

test('rejects stale completion and treats duplicate completion as idempotent', () => {
  const store = loadStore();
  const cacheKey = 'assessment-cas';
  const original = sampleAssessment();
  const current = sampleAssessment({
    input: {
      ...original.input,
      thread: {
        ...original.input.thread,
        comments: [{ ...original.input.thread.comments[0], body: 'Updated comment.' }],
      },
    },
  });
  const stale = sampleAssessment({ outcome: { error: 'Obsolete result.', status: 'failed' } });
  store.writeStoredWalkthrough(cacheKey, sampleV5Walkthrough([current]));

  expect(
    store.replaceStoredAssessment(cacheKey, {
      component: stale,
      expectedComponent: original,
    }).status,
  ).toBe('stale');
  expect(
    store.replaceStoredAssessment(cacheKey, {
      component: current,
      expectedComponent: original,
    }).status,
  ).toBe('idempotent');
  expect(store.readStoredWalkthrough(cacheKey)?.assessments?.items).toEqual([current]);
});
