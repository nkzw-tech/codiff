/**
 * @vitest-environment jsdom
 */

import { expect, test, vi } from 'vite-plus/test';
import { createDefaultConfig } from '../config/defaults.ts';
import { writeReloadSelection } from '../lib/reload-selection.ts';
import type { GitSha, RepositoryState } from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

const hostProps = vi.hoisted(() => vi.fn());

vi.mock('../app/RepositoryReviewHost.tsx', () => ({
  RepositoryReviewHost: (props: unknown) => {
    hostProps(props);
    return <div>Repository host</div>;
  },
}));

import App from '../App.tsx';

const state = {
  branch: 'main',
  files: [],
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source: { type: 'working-tree' },
} satisfies RepositoryState;
const gitSha = (character: string) => character.repeat(40) as GitSha;

const installAppApi = ({
  launchOptions = { repositoryPathProvided: true, walkthrough: false },
  repositoryState = state,
}: {
  launchOptions?: Awaited<ReturnType<Window['codiff']['getLaunchOptions']>>;
  repositoryState?: RepositoryState;
} = {}) => {
  const config = createDefaultConfig();
  const api = {
    getAgentSkillStatus: vi.fn(async () => ({ installed: true, path: '/skill' })),
    getConfig: vi.fn(async () => config),
    getFeatureFlags: vi.fn(async () => ({ planSharing: false, walkthroughSharing: false })),
    getGitIdentity: vi.fn(async () => null),
    getLaunchOptions: vi.fn(async () => launchOptions),
    getRepositoryHistory: vi.fn(async () => ({ entries: [], root: '/repo' })),
    getRepositoryState: vi.fn(async () => repositoryState),
    getTerminalHelperStatus: vi.fn(async () => ({
      command: 'codiff',
      installed: true,
      path: '/usr/local/bin/codiff',
    })),
    onConfigChanged: vi.fn(() => () => {}),
  };
  window.codiff = api as unknown as Window['codiff'];
  return { api, config };
};

test('App bootstraps the desktop shell before mounting the repository host', async () => {
  const config = createDefaultConfig();
  window.codiff = {
    getAgentSkillStatus: vi.fn(async () => ({ installed: true, path: '/skill' })),
    getConfig: vi.fn(async () => config),
    getFeatureFlags: vi.fn(async () => ({ planSharing: false, walkthroughSharing: true })),
    getGitIdentity: vi.fn(async () => ({ email: 'reviewer@example.com', name: 'Reviewer' })),
    getLaunchOptions: vi.fn(async () => ({ repositoryPathProvided: true, walkthrough: false })),
    getRepositoryHistory: vi.fn(async () => ({ entries: [], root: '/repo' })),
    getRepositoryState: vi.fn(async () => state),
    getTerminalHelperStatus: vi.fn(async () => ({
      command: 'codiff',
      installed: true,
      path: '/usr/local/bin/codiff',
    })),
    onConfigChanged: vi.fn(() => () => {}),
  } as unknown as Window['codiff'];

  const view = await renderReact(<App />);
  try {
    await waitFor(() => expect(view.container.textContent).toContain('Repository host'));
    expect(hostProps).toHaveBeenCalledWith(
      expect.objectContaining({
        bootstrap: expect.objectContaining({
          historySource: null,
          mainMode: 'review',
          selectedPath: null,
          sidebarMode: 'history',
          state,
        }),
        config,
        initialHistoryLoading: true,
        launchOptions: expect.objectContaining({ walkthrough: false }),
        walkthroughSharingEnabled: true,
      }),
    );
  } finally {
    await view.cleanup();
  }
});

test('App restores a valid working-tree commit mode after reload', async () => {
  hostProps.mockClear();
  const config = createDefaultConfig();
  const changedState = {
    ...state,
    files: [createChangedFile('src/commit.ts')],
  } satisfies RepositoryState;
  writeReloadSelection(changedState, 'src/commit.ts', null, 'commit');
  window.codiff = {
    getAgentSkillStatus: vi.fn(async () => ({ installed: true, path: '/skill' })),
    getConfig: vi.fn(async () => config),
    getFeatureFlags: vi.fn(async () => ({ planSharing: false, walkthroughSharing: false })),
    getGitIdentity: vi.fn(async () => null),
    getLaunchOptions: vi.fn(async () => ({ repositoryPathProvided: true, walkthrough: false })),
    getRepositoryHistory: vi.fn(async () => ({ entries: [], root: '/repo' })),
    getRepositoryState: vi.fn(async () => changedState),
    getTerminalHelperStatus: vi.fn(async () => ({
      command: 'codiff',
      installed: true,
      path: '/usr/local/bin/codiff',
    })),
    onConfigChanged: vi.fn(() => () => {}),
  } as unknown as Window['codiff'];

  await using view = await renderReact(<App />);
  await waitFor(() => expect(view.container.textContent).toContain('Repository host'));
  expect(hostProps.mock.lastCall?.[0]).toMatchObject({
    bootstrap: {
      initialScrollTarget: { behavior: 'instant', path: 'src/commit.ts', request: 1 },
      mainMode: 'commit',
      selectedPath: 'src/commit.ts',
    },
  });
});

test('App rejects persisted commit mode for an empty working tree', async () => {
  hostProps.mockClear();
  const config = createDefaultConfig();
  writeReloadSelection(state, null, null, 'commit');
  window.codiff = {
    getAgentSkillStatus: vi.fn(async () => ({ installed: true, path: '/skill' })),
    getConfig: vi.fn(async () => config),
    getFeatureFlags: vi.fn(async () => ({ planSharing: false, walkthroughSharing: false })),
    getGitIdentity: vi.fn(async () => null),
    getLaunchOptions: vi.fn(async () => ({ repositoryPathProvided: true, walkthrough: false })),
    getRepositoryHistory: vi.fn(async () => ({ entries: [], root: '/repo' })),
    getRepositoryState: vi.fn(async () => state),
    getTerminalHelperStatus: vi.fn(async () => ({
      command: 'codiff',
      installed: true,
      path: '/usr/local/bin/codiff',
    })),
    onConfigChanged: vi.fn(() => () => {}),
  } as unknown as Window['codiff'];

  await using view = await renderReact(<App />);
  await waitFor(() => expect(view.container.textContent).toContain('Repository host'));
  expect(hostProps.mock.lastCall?.[0]).toMatchObject({ bootstrap: { mainMode: 'review' } });
});

test('App restores branch History scope and reload deltas as one bootstrap value', async () => {
  hostProps.mockClear();
  const branchSource = {
    baseSha: gitSha('a'),
    headSha: gitSha('b'),
    ref: 'feature',
    type: 'branch-diff',
  } as const;
  const previousState = {
    ...state,
    files: [createChangedFile('src/branch.ts', { fingerprint: 'before' })],
    source: { ...branchSource, type: 'branch-working-tree' as const },
  } satisfies RepositoryState;
  const nextState = {
    ...previousState,
    files: [createChangedFile('src/branch.ts', { fingerprint: 'after' })],
  } satisfies RepositoryState;
  writeReloadSelection(previousState, 'src/branch.ts', branchSource, 'review');
  const { api } = installAppApi({ repositoryState: nextState });

  await using view = await renderReact(<App />);
  await waitFor(() => expect(view.container.textContent).toContain('Repository host'));
  expect(api.getRepositoryState).toHaveBeenCalledWith({
    ref: 'feature',
    type: 'branch-working-tree',
  });
  expect(api.getRepositoryHistory).not.toHaveBeenCalled();
  expect(hostProps.mock.lastCall?.[0]).toMatchObject({
    bootstrap: {
      historySource: branchSource,
      reloadDeltaPaths: new Set(['src/branch.ts']),
      selectedPath: 'src/branch.ts',
    },
    initialHistoryLoading: true,
  });
});

test('App lets an explicit launch source override stale stored selection', async () => {
  hostProps.mockClear();
  const staleState = {
    ...state,
    files: [createChangedFile('src/stale.ts')],
  } satisfies RepositoryState;
  writeReloadSelection(staleState, 'src/stale.ts');
  const commitSource = { ref: gitSha('c'), type: 'commit' } as const;
  const commitState = {
    ...state,
    files: [createChangedFile('src/commit.ts')],
    source: { sha: gitSha('c'), type: 'commit' as const },
  } satisfies RepositoryState;
  const { api } = installAppApi({
    launchOptions: {
      repositoryPathProvided: true,
      source: commitSource,
      walkthrough: false,
    },
    repositoryState: commitState,
  });

  await using view = await renderReact(<App />);
  await waitFor(() => expect(view.container.textContent).toContain('Repository host'));
  expect(api.getRepositoryState).toHaveBeenCalledWith(undefined);
  expect(hostProps.mock.lastCall?.[0]).toMatchObject({
    bootstrap: { source: commitState.source, state: commitState },
  });
});
