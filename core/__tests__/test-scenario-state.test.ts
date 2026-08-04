import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  assertReusableStatePath,
  createStatePersistence,
  writeStateAtomically,
} from '../../scripts/test-scenario-state.mjs';
import { createTemporaryDirectory } from './helpers/resources.ts';

test('refuses to replace live or unreadable scenario state', async () => {
  await using directory = await createTemporaryDirectory('codiff-scenario-state-');
  const statePath = join(directory.path, 'state.json');
  const liveState = {
    createdAt: '2026-08-04T00:00:00.000Z',
    reviews: [{ provider: 'github', repository: 'fixture/repo', scenario: 'current' }],
    root: directory.path,
    version: 2,
  };
  const serializedLiveState = `${JSON.stringify(liveState, null, 2)}\n`;
  await writeFile(statePath, serializedLiveState);

  await expect(assertReusableStatePath(statePath)).rejects.toThrow(
    'Refusing to replace live scenario state',
  );
  expect(await readFile(statePath, 'utf8')).toBe(serializedLiveState);

  await writeFile(statePath, '{not-json}\n');
  await expect(assertReusableStatePath(statePath)).rejects.toThrow(
    'Refusing to replace unreadable scenario state',
  );
  expect(await readFile(statePath, 'utf8')).toBe('{not-json}\n');
});

test('atomically preserves partial cleanup state after later creation failure', async () => {
  await using directory = await createTemporaryDirectory('codiff-scenario-state-');
  const statePath = join(directory.path, 'state.json');
  const state = {
    createdAt: '2026-08-04T00:00:00.000Z',
    reviews: [] as Array<Record<string, unknown>>,
    root: directory.path,
    version: 2,
  };
  const persistReview = createStatePersistence(statePath, state);
  const partialReview = {
    baseBranch: 'codiff-scenario-base',
    creationStatus: 'partial',
    featureBranch: 'codiff-scenario-feature',
    provider: 'github',
    repository: 'fixture/repo',
    scenario: 'current-commit-stack',
    url: 'https://github.com/fixture/repo',
    worktree: join(directory.path, 'worktree'),
  };

  const failAfterResourceCreation = async () => {
    await persistReview(partialReview);
    throw new Error('review creation failed');
  };
  await expect(failAfterResourceCreation()).rejects.toThrow('review creation failed');
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({
    ...state,
    reviews: [partialReview],
  });
  expect(await readdir(directory.path)).toEqual(['state.json']);

  const persistedState = await readFile(statePath, 'utf8');
  const circularState: Record<string, unknown> = {};
  circularState.self = circularState;
  await expect(writeStateAtomically(statePath, circularState)).rejects.toThrow();
  expect(await readFile(statePath, 'utf8')).toBe(persistedState);
  expect(await readdir(directory.path)).toEqual(['state.json']);
});
