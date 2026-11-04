/** @vitest-environment jsdom */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { usePullRequestViewedSync } from '../app/hooks/usePullRequestViewedSync.ts';
import {
  getWalkthroughReviewIdentity,
  updateReviewIdentityViewed,
} from '../lib/review-identity.ts';
import { readViewedForState } from '../lib/viewed.ts';
import type { RepositoryState, ReviewSource } from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact } from './helpers/react.tsx';

const file = createChangedFile('src/app.ts', {
  patch:
    'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-before\n+after\n',
});
const source = {
  provider: 'github',
  type: 'pull-request',
  url: 'https://github.com/acme/repo/pull/1',
} as const;
const repository: RepositoryState = {
  branch: null,
  files: [file],
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source,
  viewedFiles: {},
};

const createHarness = () => {
  const stateRef: { current: RepositoryState | null } = { current: repository };
  const viewedRef = { current: {} as Record<string, string> };
  const setViewed = vi.fn(
    (value: Parameters<Parameters<typeof usePullRequestViewedSync>[0]['setViewed']>[0]) => {
      viewedRef.current = typeof value === 'function' ? value(viewedRef.current) : value;
    },
  );
  const syncRef: { current: ReturnType<typeof usePullRequestViewedSync> | null } = {
    current: null,
  };
  const onSync = (sync: ReturnType<typeof usePullRequestViewedSync>) => {
    syncRef.current = sync;
  };
  function Harness() {
    const sync = usePullRequestViewedSync({ setViewed, stateRef, viewedRef });
    onSync(sync);
    return null;
  }
  return { getSync: () => syncRef.current!, Harness, setViewed, stateRef, viewedRef };
};

test('only syncs whole-file transitions as walkthrough hunks are reviewed', async () => {
  const setPullRequestFileViewed = vi.fn(async () => {});
  window.codiff = {
    getRepositoryState: vi.fn(async () => repository),
    setPullRequestFileViewed,
  } as unknown as Window['codiff'];
  const harness = createHarness();
  await using _view = await renderReact(<harness.Harness />);
  const first = getWalkthroughReviewIdentity(file, [`${file.sections[0].id}:h1`]);
  const second = getWalkthroughReviewIdentity(file, [`${file.sections[0].id}:h2`]);
  const toggle = (identity: typeof first, isViewed: boolean) => {
    const previous = harness.viewedRef.current;
    const next = updateReviewIdentityViewed(previous, identity, isViewed);
    harness.viewedRef.current = next;
    harness
      .getSync()
      .syncViewed({ ...file, fingerprint: `${file.fingerprint}:focused` }, previous, next);
  };
  await act(async () => toggle(first, false));
  expect(setPullRequestFileViewed).not.toHaveBeenCalled();
  await act(async () => toggle(second, false));
  expect(setPullRequestFileViewed).toHaveBeenLastCalledWith({
    path: file.path,
    source,
    viewed: true,
  });
  await act(async () => toggle(first, true));
  expect(setPullRequestFileViewed).toHaveBeenLastCalledWith({
    path: file.path,
    source,
    viewed: false,
  });
  expect(setPullRequestFileViewed).toHaveBeenCalledTimes(2);
});

test('serializes rapid checkbox changes and waits for them before refreshing', async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const setPullRequestFileViewed = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const getRepositoryState = vi.fn(async () => repository);
  window.codiff = { getRepositoryState, setPullRequestFileViewed } as unknown as Window['codiff'];
  const harness = createHarness();
  await using _view = await renderReact(<harness.Harness />);
  const viewed = { [file.path]: file.fingerprint };
  harness.getSync().syncViewed(file, {}, viewed);
  harness.getSync().syncViewed(file, viewed, {});
  const refresh = harness.getSync().getRepositoryState(source);
  await act(async () => {});
  expect(setPullRequestFileViewed).toHaveBeenCalledTimes(1);
  expect(getRepositoryState).not.toHaveBeenCalled();
  await act(async () => first.resolve());
  expect(setPullRequestFileViewed).toHaveBeenCalledTimes(2);
  expect(getRepositoryState).not.toHaveBeenCalled();
  await act(async () => second.resolve());
  expect((await refresh).viewedFiles).toEqual({});
  expect(getRepositoryState).toHaveBeenCalledOnce();
});

test('failed queued saves restore confirmed progress while preserving other files', async () => {
  using alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  const setPullRequestFileViewed = vi.fn(async () => {
    throw new Error('Offline');
  });
  window.codiff = { setPullRequestFileViewed } as unknown as Window['codiff'];
  const harness = createHarness();
  await using _view = await renderReact(<harness.Harness />);
  const viewed = { [file.path]: file.fingerprint };
  harness.viewedRef.current = { 'other.ts': 'other-fingerprint' };
  await act(async () => {
    harness.getSync().syncViewed(file, {}, viewed);
    harness.getSync().syncViewed(file, viewed, {});
    harness.getSync().syncViewed(file, {}, viewed);
    harness.viewedRef.current = { ...harness.viewedRef.current, ...viewed };
  });
  expect(setPullRequestFileViewed).toHaveBeenCalledTimes(3);
  expect(harness.viewedRef.current).toEqual({ 'other.ts': 'other-fingerprint' });
  expect(alert).toHaveBeenCalledOnce();
  expect(alert).toHaveBeenCalledWith(expect.stringContaining('Offline'));
});

test('a stale refresh keeps checkbox changes made while the lookup is in flight', async () => {
  const lookup = Promise.withResolvers<RepositoryState>();
  const getRepositoryState = vi.fn(() => lookup.promise);
  window.codiff = {
    getRepositoryState,
    setPullRequestFileViewed: vi.fn(async () => {}),
  } as unknown as Window['codiff'];
  const harness = createHarness();
  await using _view = await renderReact(<harness.Harness />);
  const refresh = harness.getSync().getRepositoryState(source);
  await act(async () => {});
  expect(getRepositoryState).toHaveBeenCalledOnce();
  await act(async () => harness.getSync().syncViewed(file, {}, { [file.path]: file.fingerprint }));
  lookup.resolve(repository);
  expect((await refresh).viewedFiles).toEqual({ [file.path]: file.fingerprint });
});

test('does not sync local reviews or GitLab, or roll back a different PR', async () => {
  using alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  const pending = Promise.withResolvers<void>();
  const setPullRequestFileViewed = vi.fn(() => pending.promise);
  window.codiff = { setPullRequestFileViewed } as unknown as Window['codiff'];
  const harness = createHarness();
  await using _view = await renderReact(<harness.Harness />);
  for (const localSource of [
    { type: 'working-tree' },
    { ...source, provider: 'gitlab' },
  ] satisfies ReadonlyArray<ReviewSource>) {
    harness.stateRef.current = { ...repository, source: localSource };
    harness.getSync().syncViewed(file, {}, { [file.path]: file.fingerprint });
  }
  expect(setPullRequestFileViewed).not.toHaveBeenCalled();
  harness.stateRef.current = repository;
  harness.getSync().syncViewed(file, {}, { [file.path]: file.fingerprint });
  harness.stateRef.current = {
    ...repository,
    source: { ...source, url: 'https://github.com/acme/repo/pull/2' },
  };
  await act(async () => pending.reject(new Error('Offline')));
  expect(harness.setViewed).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
});

test('remote progress overrides stale whole-file marks while preserving unchanged partial hunks', () => {
  const partial = updateReviewIdentityViewed(
    {},
    getWalkthroughReviewIdentity(file, [`${file.sections[0].id}:h1`]),
    false,
  );
  expect(readViewedForState(repository, partial)).toEqual(partial);
  expect(readViewedForState(repository, { [file.path]: file.fingerprint })).toEqual({});
  expect(
    readViewedForState({ ...repository, files: [{ ...file, fingerprint: 'new' }] }, partial),
  ).toEqual({});
  expect(
    readViewedForState({ ...repository, viewedFiles: { [file.path]: file.fingerprint } }, partial),
  ).toEqual({ [file.path]: file.fingerprint });
});
