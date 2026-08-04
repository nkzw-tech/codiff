/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import App from '../App.tsx';
import { createDefaultConfig } from '../config/defaults.ts';
import type {
  GitIdentity,
  GitSha,
  NarrativeWalkthroughResult,
  RepositoryHistory,
  RepositoryState,
} from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

const reactActEnvironment = globalThis as typeof globalThis & {
  ResizeObserver?: typeof ResizeObserver;
  Worker?: typeof Worker;
};
reactActEnvironment.ResizeObserver ??= class ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
};
HTMLElement.prototype.scrollBy ??= function scrollBy() {};
HTMLElement.prototype.scrollIntoView ??= function scrollIntoView() {};
HTMLElement.prototype.scrollTo ??= function scrollTo() {};
class StubWorker extends EventTarget {
  constructor(_scriptURL: string | URL, _options?: WorkerOptions) {
    super();
  }
  onerror = null;
  onmessage = null;
  postMessage() {}
  terminate() {}
}
reactActEnvironment.Worker ??= StubWorker as unknown as typeof Worker;

const deferred = <Value,>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
};
const unsubscribe = () => {};
const gitSha = (character: string) => character.repeat(40) as GitSha;

const repositoryState = {
  branch: 'main',
  files: [createChangedFile('src/startup.ts')],
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source: { type: 'working-tree' },
} satisfies RepositoryState;

const createAppApi = (overrides: Record<string, unknown> = {}) => ({
  applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
  askReviewAssistant: vi.fn(async () => ({ reason: 'Not used.', status: 'unavailable' as const })),
  cancelNarrativeWalkthrough: vi.fn(async () => {}),
  completePlan: vi.fn(async () => {}),
  createWalkthroughCommit: vi.fn(async () => ({
    sha: gitSha('a'),
    status: 'committed' as const,
  })),
  dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
  getAgentSkillStatus: vi.fn(async () => ({ installed: true, path: '/skill' })),
  getConfig: vi.fn(async () => createDefaultConfig()),
  getDiffImageContent: vi.fn(async () => ({ reason: 'Not used.', status: 'unavailable' as const })),
  getDiffSectionContent: vi.fn(async () => {
    throw new Error('Unexpected diff section load.');
  }),
  getDiffSectionsContent: vi.fn(async () => ({ sections: [] })),
  getFeatureFlags: vi.fn(async () => ({ planSharing: false, walkthroughSharing: false })),
  getGitIdentity: vi.fn(async () => ({ email: 'reviewer@example.com', name: 'Reviewer' })),
  getLaunchOptions: vi.fn(async () => ({ repositoryPathProvided: true, walkthrough: false })),
  getMarkdownDocument: vi.fn(async () => ({
    content: '# Plan\n',
    id: 'plan:/tmp/plan.md',
    kind: 'plan' as const,
    path: '/tmp/plan.md',
    version: 'plan-version',
  })),
  getNarrativeWalkthrough: vi.fn(async () => ({
    reason: 'Not used.',
    status: 'unavailable' as const,
  })),
  getPlanReview: vi.fn(async () => null),
  getRepositoryHistory: vi.fn(async () => ({ entries: [], root: '/repo' })),
  getRepositoryState: vi.fn(async () => repositoryState),
  getReviewComments: vi.fn(async () => []),
  getTerminalHelperStatus: vi.fn(async () => ({
    command: 'codiff',
    installed: true,
    path: '/usr/local/bin/codiff',
  })),
  getUpdateStatus: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
  isWindowFullScreen: vi.fn(async () => false),
  markPlanReady: vi.fn(async () => {}),
  onConfigChanged: vi.fn(() => unsubscribe),
  onCopyPendingCommentsRequest: vi.fn(() => unsubscribe),
  onFindInDiffs: vi.fn(() => unsubscribe),
  onMarkdownDocumentChanged: vi.fn(() => unsubscribe),
  onOpenReviewSource: vi.fn(() => unsubscribe),
  onPlanCloseRequested: vi.fn(() => unsubscribe),
  onRefreshRequest: vi.fn(() => unsubscribe),
  onRepositoryChanged: vi.fn(() => unsubscribe),
  onUpdateStatusChanged: vi.fn(() => unsubscribe),
  onWalkthroughCommitOutput: vi.fn(() => unsubscribe),
  onWalkthroughProgress: vi.fn(() => unsubscribe),
  onWindowFullScreenChanged: vi.fn(() => unsubscribe),
  openConfigFile: vi.fn(async () => {}),
  openFile: vi.fn(async () => {}),
  openRepositoryFolder: vi.fn(async () => {}),
  reportInitialLoadMilestone: vi.fn(),
  resolvePullRequestUrl: vi.fn(async (value: string) => value),
  saveMarkdownDocument: vi.fn(async (request: { content: string; kind: 'plan'; path: string }) => ({
    document: {
      content: request.content,
      id: `${request.kind}:${request.path}`,
      kind: request.kind,
      path: request.path,
      version: 'next-version',
    },
    status: 'saved' as const,
  })),
  savePlanReview: vi.fn(async (review) => review),
  setDiffStyle: vi.fn(async () => {}),
  setShowOutdated: vi.fn(async () => {}),
  setWordWrap: vi.fn(async () => {}),
  sharePlan: vi.fn(async () => ({ status: 'uploaded' as const, url: 'https://example.test/p' })),
  shareWalkthrough: vi.fn(async () => ({
    status: 'uploaded' as const,
    url: 'https://example.test/w',
  })),
  submitPullRequestComment: vi.fn(async () => {
    throw new Error('Not used.');
  }),
  submitPullRequestReview: vi.fn(async () => {}),
  updateWalkthroughCommitMessage: vi.fn(async () => ({
    reason: 'Not used.',
    status: 'unavailable' as const,
  })),
  ...overrides,
});

test('renders repository state before configuration and history finish loading', async () => {
  const config = deferred<ReturnType<typeof createDefaultConfig>>();
  const history = deferred<RepositoryHistory>();
  window.codiff = {
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    getAgentSkillStatus: vi.fn(async () => ({ installed: true })),
    getConfig: vi.fn(() => config.promise),
    getFeatureFlags: vi.fn(async () => ({ planSharing: false, walkthroughSharing: false })),
    getGitIdentity: vi.fn(async () => null),
    getLaunchOptions: vi.fn(async () => ({ repositoryPathProvided: true, walkthrough: false })),
    getRepositoryHistory: vi.fn(() => history.promise),
    getRepositoryState: vi.fn(async () => ({
      branch: 'main',
      files: [],
      generatedAt: 1,
      launchPath: '/repo',
      root: '/repo',
      source: { type: 'working-tree' as const },
    })),
    getTerminalHelperStatus: vi.fn(async () => ({ installed: true })),
    getUpdateStatus: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    isWindowFullScreen: vi.fn(async () => false),
    onConfigChanged: vi.fn(() => unsubscribe),
    onCopyPendingCommentsRequest: vi.fn(() => unsubscribe),
    onFindInDiffs: vi.fn(() => unsubscribe),
    onNarrativeWalkthroughUpdated: vi.fn(() => unsubscribe),
    onOpenReviewSource: vi.fn(() => unsubscribe),
    onRefreshRequest: vi.fn(() => unsubscribe),
    onRepositoryChanged: vi.fn(() => unsubscribe),
    onReviewVersionEvolutionProgress: vi.fn(() => unsubscribe),
    onUpdateStatusChanged: vi.fn(() => unsubscribe),
    onWalkthroughProgress: vi.fn(() => unsubscribe),
    onWindowFullScreenChanged: vi.fn(() => unsubscribe),
    openRepositoryFolder: vi.fn(async () => {}),
    resolvePullRequestUrl: vi.fn(async (value: string) => value),
  } as unknown as Window['codiff'];

  const view = await renderReact(<App />);
  try {
    await waitFor(() => expect(view.container.querySelector('main.review')).not.toBeNull());
    expect(window.codiff.getRepositoryHistory).toHaveBeenCalledOnce();
    expect(view.container.textContent).toContain('Loading history');

    config.resolve(createDefaultConfig());
    history.resolve({ entries: [], root: '/repo' });
  } finally {
    await view.cleanup();
  }
});

test('keeps a loaded repository usable when config or feature flags fail', async () => {
  for (const failingCall of ['config', 'features'] as const) {
    const api = createAppApi(
      failingCall === 'config'
        ? {
            getConfig: vi.fn(async () => {
              throw new Error('Config unavailable.');
            }),
          }
        : {
            getFeatureFlags: vi.fn(async () => {
              throw new Error('Features unavailable.');
            }),
          },
    );
    window.codiff = api as unknown as Window['codiff'];
    await using view = await renderReact(<App />);
    await waitFor(() => expect(view.container.querySelector('main.review')).not.toBeNull());
    expect(view.container.querySelector('.repository-change-banner.visible')).toBeNull();
  }
});

test('plan startup opens without repository or ancillary bootstrap completion', async () => {
  const pending = new Promise<never>(() => {});
  const api = createAppApi({
    getAgentSkillStatus: vi.fn(() => pending),
    getConfig: vi.fn(() => pending),
    getFeatureFlags: vi.fn(() => pending),
    getGitIdentity: vi.fn(() => pending),
    getLaunchOptions: vi.fn(async () => ({
      planFile: '/tmp/plan.md',
      planResultFile: '/tmp/result.json',
      repositoryPathProvided: true,
      walkthrough: false,
    })),
    getRepositoryState: vi.fn(async () => repositoryState),
    getTerminalHelperStatus: vi.fn(() => pending),
  });
  window.codiff = api as unknown as Window['codiff'];

  await using view = await renderReact(<App />);
  await waitFor(() => expect(view.container.querySelector('.plan-shell')).not.toBeNull());
  expect(api.getRepositoryState).not.toHaveBeenCalled();
});

test('plan startup stays usable when ancillary bootstrap calls reject', async () => {
  const api = createAppApi({
    getAgentSkillStatus: vi.fn(async () => {
      throw new Error('Skill unavailable.');
    }),
    getConfig: vi.fn(async () => {
      throw new Error('Config unavailable.');
    }),
    getFeatureFlags: vi.fn(async () => {
      throw new Error('Features unavailable.');
    }),
    getLaunchOptions: vi.fn(async () => ({
      planFile: '/tmp/plan.md',
      repositoryPathProvided: true,
      walkthrough: false,
    })),
    getTerminalHelperStatus: vi.fn(async () => {
      throw new Error('Helper unavailable.');
    }),
  });
  window.codiff = api as unknown as Window['codiff'];

  await using view = await renderReact(<App />);
  await waitFor(() => expect(view.container.querySelector('.plan-shell')).not.toBeNull());
  expect(view.container.querySelector('.plan-share-button')).toBeNull();
});

test('first-run classification does not wait for or get replaced by ancillary failures', async () => {
  const pending = new Promise<never>(() => {});
  const api = createAppApi({
    getConfig: vi.fn(async () => {
      throw new Error('Config unavailable.');
    }),
    getFeatureFlags: vi.fn(async () => {
      throw new Error('Features unavailable.');
    }),
    getLaunchOptions: vi.fn(async () => ({ repositoryPathProvided: false, walkthrough: false })),
    getRepositoryState: vi.fn(async () => {
      throw new Error('not a git repository');
    }),
    getTerminalHelperStatus: vi.fn(() => pending),
  });
  window.codiff = api as unknown as Window['codiff'];

  await using view = await renderReact(<App />);
  await waitFor(() => expect(view.container.textContent).toContain('Open a Git repository'));
  expect(view.container.textContent).not.toContain('Config unavailable.');
  expect(view.container.textContent).not.toContain('Features unavailable.');
});

test('does not start a pull-request walkthrough before history classifies its structure', async () => {
  const baseSha = gitSha('a');
  const headSha = gitSha('b');
  const file = createChangedFile('src/review.ts', { kind: 'pull-request' });
  const pullRequestState = {
    ...repositoryState,
    files: [
      {
        ...file,
        sections: file.sections.map((section) => ({
          ...section,
          range: {
            base: { label: { kind: 'commit' as const, text: 'main' }, sha: baseSha },
            head: { label: { kind: 'commit' as const, text: 'Head' }, sha: headSha },
          },
        })),
      },
    ],
    source: {
      headSha,
      number: 42,
      provider: 'github' as const,
      type: 'pull-request' as const,
      url: 'https://github.com/example/repo/pull/42',
    },
  } satisfies RepositoryState;
  const history = deferred<Awaited<ReturnType<Window['codiff']['getRepositoryHistory']>>>();
  const api = createAppApi({
    getLaunchOptions: vi.fn(async () => ({ repositoryPathProvided: true, walkthrough: true })),
    getRepositoryHistory: vi.fn(() => history.promise),
    getRepositoryState: vi.fn(async () => pullRequestState),
  });
  window.codiff = api as unknown as Window['codiff'];

  await using view = await renderReact(<App />);
  await waitFor(() => expect(view.container.querySelector('main.review')).not.toBeNull());
  await waitFor(() => expect(api.getRepositoryHistory).toHaveBeenCalledOnce());
  await act(async () => {});
  expect(api.getNarrativeWalkthrough).not.toHaveBeenCalled();
});

test('an asynchronous walkthrough-file failure switches the controlled mode to History', async () => {
  const walkthrough = deferred<NarrativeWalkthroughResult>();
  const api = createAppApi({
    getLaunchOptions: vi.fn(async () => ({
      repositoryPathProvided: true,
      walkthrough: false,
      walkthroughFile: '/tmp/walkthrough.json',
    })),
    getNarrativeWalkthrough: vi.fn(() => walkthrough.promise),
  });
  window.codiff = api as unknown as Window['codiff'];

  await using view = await renderReact(<App />);
  await waitFor(() =>
    expect(
      Array.from(view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        .find((button) => button.textContent?.includes('Walkthrough'))
        ?.getAttribute('aria-selected'),
    ).toBe('true'),
  );
  walkthrough.resolve({ reason: 'The walkthrough no longer matches.', status: 'unavailable' });
  await waitFor(() => expect(view.container.textContent).toContain('Showing history instead.'));
  const historyTab = Array.from(
    view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).find((button) => button.textContent?.includes('History'));
  await waitFor(() => expect(historyTab?.getAttribute('aria-selected')).toBe('true'));
  expect(api.getNarrativeWalkthrough).toHaveBeenCalledTimes(1);
});

test('waits for Git identity resolution before reporting deferred completion', async () => {
  const identity = deferred<GitIdentity | null>();
  const api = createAppApi({
    getGitIdentity: vi.fn(() => identity.promise),
  });
  window.codiff = api as unknown as Window['codiff'];

  await using view = await renderReact(<App />);
  await waitFor(() => expect(view.container.querySelector('main.review')).not.toBeNull());
  await waitFor(() =>
    expect(api.reportInitialLoadMilestone).toHaveBeenCalledWith('first-usable-review-rendered'),
  );
  await waitFor(() => expect(api.getRepositoryHistory).toHaveBeenCalledOnce());
  expect(api.reportInitialLoadMilestone).not.toHaveBeenCalledWith('deferred-review-data-complete');

  await act(async () => {
    identity.resolve({ email: 'reviewer@example.com', name: 'Reviewer' });
  });
  await waitFor(() =>
    expect(api.reportInitialLoadMilestone).toHaveBeenCalledWith('deferred-review-data-complete'),
  );
  expect(
    api.reportInitialLoadMilestone.mock.calls.filter(
      ([milestone]) => milestone === 'deferred-review-data-complete',
    ),
  ).toHaveLength(1);
});

test('Git identity failure settles deferred completion without blocking first usable', async () => {
  const identity = deferred<GitIdentity | null>();
  const api = createAppApi({
    getGitIdentity: vi.fn(() => identity.promise),
  });
  window.codiff = api as unknown as Window['codiff'];

  await using view = await renderReact(<App />);
  await waitFor(() => expect(view.container.querySelector('main.review')).not.toBeNull());
  await waitFor(() =>
    expect(api.reportInitialLoadMilestone).toHaveBeenCalledWith('first-usable-review-rendered'),
  );
  await waitFor(() => expect(api.getRepositoryHistory).toHaveBeenCalledOnce());
  expect(api.reportInitialLoadMilestone).not.toHaveBeenCalledWith('deferred-review-data-complete');

  await act(async () => {
    identity.reject(new Error('Identity unavailable.'));
  });
  await waitFor(() =>
    expect(api.reportInitialLoadMilestone).toHaveBeenCalledWith('deferred-review-data-complete'),
  );
  expect(
    api.reportInitialLoadMilestone.mock.calls.filter(
      ([milestone]) => milestone === 'deferred-review-data-complete',
    ),
  ).toHaveLength(1);
});
