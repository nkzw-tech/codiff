/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { beforeEach, expect, test, vi } from 'vite-plus/test';
import App from '../App.tsx';
import { createDefaultConfig } from '../config/defaults.ts';
import type { GitSha, PlanCommentThread, PlanReview, RepositoryState } from '../types.ts';
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

const createMemoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: createMemoryStorage(),
});
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: createMemoryStorage(),
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const repositoryState = {
  branch: 'main',
  files: [],
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source: { type: 'working-tree' },
} satisfies RepositoryState;

const createCodiffMock = (overrides: Partial<Window['codiff']> = {}): Window['codiff'] => ({
  applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
  askReviewAssistant: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
  cancelDiffContentRequest: vi.fn(),
  cancelNarrativeWalkthrough: vi.fn(async () => {}),
  completePlan: vi.fn(async () => {}),
  createWalkthroughCommit: vi.fn(async () => ({
    sha: '0'.repeat(40) as GitSha,
    status: 'committed' as const,
  })),
  decreaseCodeFontSize: vi.fn(async () => {}),
  dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
  findDefinitions: vi.fn(async () => ({
    candidates: [],
    identifier: '',
    status: 'ready' as const,
  })),
  getAgentSkillStatus: vi.fn(async () => ({ installed: true, path: '/skill' })),
  getConfig: vi.fn(async () => createDefaultConfig()),
  getDiffImageContent: vi.fn(async () => ({ reason: 'Not used.', status: 'unavailable' as const })),
  getDiffSectionContent: vi.fn(async () => {
    throw new Error('Unexpected diff section load.');
  }),
  getDiffSectionsContent: vi.fn(async () => ({ sections: [] })),
  getFeatureFlags: vi.fn(async () => ({ planSharing: false, walkthroughSharing: false })),
  getGitIdentity: vi.fn(async () => ({ email: 'reviewer@example.com', name: 'Reviewer' })),
  getKeyboardLayout: vi.fn(async () => null),
  getLaunchOptions: vi.fn(async () => ({
    planFile: '/tmp/plan.md',
    planResultFile: '/tmp/result.json',
    repositoryPathProvided: true,
    walkthrough: false,
  })),
  getMarkdownDocument: vi.fn(async () => ({
    content: '# Execute this plan\n',
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
  getPreferences: vi.fn(async () => createDefaultConfig().settings),
  getRepositoryHistory: vi.fn(async () => ({ entries: [], root: '/repo' })),
  getRepositoryState: vi.fn(async () => repositoryState),
  getReviewComments: vi.fn(async () => []),
  getTerminalHelperStatus: vi.fn(async () => ({
    command: 'codiff',
    installed: true,
    path: '/usr/local/bin/codiff',
  })),
  getUpdateStatus: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
  increaseCodeFontSize: vi.fn(async () => {}),
  installAgentSkill: vi.fn(async () => ({ installed: true, path: '/skill' })),
  installTerminalHelper: vi.fn(async () => ({
    command: 'codiff',
    installed: true,
    path: '/usr/local/bin/codiff',
  })),
  isWindowFullScreen: vi.fn(async () => false),
  markPlanReady: vi.fn(async () => {}),
  onConfigChanged: vi.fn(() => () => {}),
  onCopyPendingCommentsRequest: vi.fn(() => () => {}),
  onFindInDiffs: vi.fn(() => () => {}),
  onKeyboardLayoutChanged: vi.fn(() => () => {}),
  onMarkdownDocumentChanged: vi.fn(() => () => {}),
  onOpenReviewSource: vi.fn(() => () => {}),
  onPlanCloseRequested: vi.fn(() => () => {}),
  onRefreshRequest: vi.fn(() => () => {}),
  onRepositoryChanged: vi.fn(() => () => {}),
  onUpdateStatusChanged: vi.fn(() => () => {}),
  onWalkthroughCommitOutput: vi.fn(() => () => {}),
  onWalkthroughProgress: vi.fn(() => () => {}),
  onWindowFullScreenChanged: vi.fn(() => () => {}),
  openConfigFile: vi.fn(async () => {}),
  openFile: vi.fn(async () => {}),
  openReleasePage: vi.fn(async () => {}),
  openRepositoryFolder: vi.fn(async () => {}),
  reportInitialLoadMilestone: vi.fn(),
  resetCodeFontSize: vi.fn(async () => {}),
  resolvePullRequestUrl: vi.fn(async (value) => value),
  saveMarkdownDocument: vi.fn(async (request) => ({
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
  sharePlan: vi.fn(async () => ({
    status: 'uploaded' as const,
    url: 'https://codiff.dev/p/test',
  })),
  shareWalkthrough: vi.fn(async () => ({
    status: 'uploaded' as const,
    url: 'https://codiff.dev/w/test',
  })),
  showInFolder: vi.fn(async () => {}),
  submitPullRequestComment: vi.fn(async () => {
    throw new Error('Unexpected provider comment submission.');
  }),
  submitPullRequestReview: vi.fn(async () => ({
    status: 'submitted' as const,
    submittedDraftIds: [],
  })),
  updateWalkthroughCommitMessage: vi.fn(async () => ({
    reason: 'Not used.',
    status: 'unavailable' as const,
  })),
  ...overrides,
});

const author = {
  email: 'reviewer@example.com',
  id: 'reviewer@example.com',
  name: 'Reviewer',
};

const createThread = ({
  body,
  id,
  path = [0],
  text = 'Execute this plan',
}: {
  body: string;
  id: string;
  path?: Array<number>;
  text?: string;
}): PlanCommentThread => ({
  anchor: {
    block: {
      fingerprint: `${id}-fingerprint`,
      path,
      text,
      type: 'heading',
    },
    kind: 'block',
    version: 1,
  },
  createdAt: '2026-06-24T00:00:00.000Z',
  createdBy: author,
  id,
  messages: [
    {
      author,
      body,
      createdAt: '2026-06-24T00:00:00.000Z',
      id: `${id}-message`,
      updatedAt: '2026-06-24T00:00:00.000Z',
    },
  ],
  status: 'open',
  updatedAt: '2026-06-24T00:00:00.000Z',
});

const createReview = (threads: ReadonlyArray<PlanCommentThread>): PlanReview => ({
  document: {
    id: 'plan:/tmp/plan.md',
    path: '/tmp/plan.md',
    version: 'plan-version',
  },
  threads,
  version: 1,
});

test('plan mode opens the Markdown editor without loading repository state', async () => {
  const getRepositoryState = vi.fn(async () => repositoryState);
  const completePlan = vi.fn(async (_review: PlanReview, _status: 'closed' | 'done') => {});
  const markPlanReady = vi.fn(async () => {});
  const sharePlan = vi.fn(async (_review: PlanReview) => ({
    status: 'uploaded' as const,
    url: 'https://codiff.dev/p/shared-plan',
  }));
  const storedReview = createReview([
    createThread({ body: 'Keep the rollout steps explicit.', id: 'thread-1' }),
    createThread({ body: '   ', id: 'empty-thread' }),
  ]);
  window.codiff = createCodiffMock({
    completePlan,
    getFeatureFlags: vi.fn(async () => ({ planSharing: true, walkthroughSharing: false })),
    getMarkdownDocument: vi.fn(async () => ({
      content: '# Execute this plan\n\n- First\n- Second\n',
      id: 'plan:/tmp/plan.md',
      kind: 'plan' as const,
      path: '/tmp/plan.md',
      version: 'plan-version',
    })),
    getPlanReview: vi.fn(async () => storedReview),
    getRepositoryState,
    markPlanReady,
    sharePlan,
  });

  await using view = await renderReact(<App />);
  await waitFor(() => expect(view.container.querySelector('.plan-shell')).not.toBeNull());
  expect(getRepositoryState).not.toHaveBeenCalled();
  expect(markPlanReady).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector('.plan-title')?.textContent).toContain('plan.md');
  await waitFor(() =>
    expect(view.container.querySelector('.plan-comment-thread')?.textContent).toContain(
      'Keep the rollout steps explicit.',
    ),
  );

  await act(async () =>
    view.container.querySelector<HTMLButtonElement>('.plan-share-button')?.click(),
  );
  await waitFor(() => expect(sharePlan).toHaveBeenCalledTimes(1));
  expect(sharePlan.mock.calls[0]?.[0].threads).toHaveLength(1);

  await act(async () =>
    view.container.querySelector<HTMLButtonElement>('.plan-done-button')?.click(),
  );
  await waitFor(() => expect(completePlan).toHaveBeenCalledTimes(1));
  expect(completePlan).toHaveBeenCalledWith(
    expect.objectContaining({
      document: {
        id: 'plan:/tmp/plan.md',
        path: '/tmp/plan.md',
        version: 'plan-version',
      },
      threads: [expect.objectContaining({ id: 'thread-1' })],
      version: 1,
    }),
    'done',
  );
});

test('plan mode resolves stored comments whose anchors were already removed', async () => {
  const savePlanReview = vi.fn(async (review: PlanReview) => review);
  window.codiff = createCodiffMock({
    getMarkdownDocument: vi.fn(async () => ({
      content: '# Current plan\n',
      id: 'plan:/tmp/plan.md',
      kind: 'plan' as const,
      path: '/tmp/plan.md',
      version: 'plan-version',
    })),
    getPlanReview: vi.fn(async () =>
      createReview([
        createThread({
          body: 'Keep this comment as history.',
          id: 'detached-thread',
          path: [99],
          text: 'Removed heading',
        }),
      ]),
    ),
    savePlanReview,
  });

  await using view = await renderReact(<App />);
  await waitFor(() =>
    expect(savePlanReview).toHaveBeenCalledWith(
      expect.objectContaining({
        threads: [
          expect.objectContaining({
            id: 'detached-thread',
            resolution: expect.objectContaining({ reason: 'anchor-removed' }),
            status: 'resolved',
          }),
        ],
      }),
    ),
  );
  const resolvedSection =
    view.container.querySelector<HTMLDetailsElement>('.plan-resolved-comments');
  expect(resolvedSection?.querySelector('summary')?.textContent).toBe('Resolved comments (1)');
  expect(view.container.querySelector('.plan-comment-thread.resolved')?.textContent).toContain(
    'Resolved after target removal',
  );
});

test('plan mode keeps comments open when their anchors are removed during the current review', async () => {
  let publishMarkdownChange: Parameters<Window['codiff']['onMarkdownDocumentChanged']>[0] | null =
    null;
  const savePlanReview = vi.fn(async (review: PlanReview) => review);
  window.codiff = createCodiffMock({
    getMarkdownDocument: vi.fn(async () => ({
      content: '# Current plan\n',
      id: 'plan:/tmp/plan.md',
      kind: 'plan' as const,
      path: '/tmp/plan.md',
      version: 'plan-version',
    })),
    getPlanReview: vi.fn(async () =>
      createReview([
        createThread({
          body: 'The agent still needs to process this.',
          id: 'live-thread',
          text: 'Current plan',
        }),
      ]),
    ),
    onMarkdownDocumentChanged: vi.fn((callback) => {
      publishMarkdownChange = callback;
      return () => {
        publishMarkdownChange = null;
      };
    }),
    savePlanReview,
  });

  await using view = await renderReact(<App />);
  await waitFor(() => {
    expect(
      view.container.querySelector('[data-mdx-annotation-block~="live-thread"]'),
    ).not.toBeNull();
    expect(publishMarkdownChange).not.toBeNull();
  });
  savePlanReview.mockClear();
  await act(async () =>
    publishMarkdownChange?.({
      deleted: false,
      document: {
        content: '# Replacement plan\n',
        id: 'plan:/tmp/plan.md',
        kind: 'plan',
        path: '/tmp/plan.md',
        version: 'next-plan-version',
      },
      id: 'plan:/tmp/plan.md',
    }),
  );
  await waitFor(() =>
    expect(view.container.querySelector('[data-mdx-annotation-block~="live-thread"]')).toBeNull(),
  );
  expect(view.container.querySelector('.plan-resolved-comments')).toBeNull();
  expect(
    view.container.querySelector('.plan-comment-position .plan-comment-thread'),
  ).not.toBeNull();
  expect(
    savePlanReview.mock.calls.some(
      ([review]) =>
        review.threads.find((thread) => thread.id === 'live-thread')?.status === 'resolved',
    ),
  ).toBe(false);
});

test('closing plan mode flushes and returns a closed handoff', async () => {
  const completePlan = vi.fn(async (_review: PlanReview, _status: 'closed' | 'done') => {});
  let blockPlanReviewSave = false;
  let resolvePlanReviewSave: (() => void) | null = null;
  const savePlanReview = vi.fn((review: PlanReview) => {
    if (!blockPlanReviewSave) {
      return Promise.resolve(review);
    }
    return new Promise<PlanReview>((resolveSave) => {
      resolvePlanReviewSave = () => resolveSave(review);
    });
  });
  let requestClose: (() => void) | null = null;
  window.codiff = createCodiffMock({
    completePlan,
    getPlanReview: vi.fn(async () =>
      createReview([createThread({ body: 'Keep this requirement.', id: 'thread-1' })]),
    ),
    onPlanCloseRequested: vi.fn((callback) => {
      requestClose = callback;
      return () => {
        requestClose = null;
      };
    }),
    savePlanReview,
  });

  await using view = await renderReact(<App />);
  await waitFor(() => {
    expect(view.container.querySelector('.plan-shell')).not.toBeNull();
    expect(requestClose).not.toBeNull();
    expect(view.container.querySelector('.plan-comment-thread')).not.toBeNull();
  });
  await act(async () => {
    await new Promise((resolveWait) => setTimeout(resolveWait, 75));
  });
  savePlanReview.mockClear();
  blockPlanReviewSave = true;
  await act(async () => requestClose?.());
  await waitFor(() => expect(savePlanReview).toHaveBeenCalledTimes(1));
  expect(completePlan).not.toHaveBeenCalled();
  expect(view.container.querySelector<HTMLButtonElement>('.review-comment-delete')?.disabled).toBe(
    true,
  );
  await act(async () => resolvePlanReviewSave?.());
  await waitFor(() => expect(completePlan).toHaveBeenCalledTimes(1));
  expect(completePlan).toHaveBeenCalledWith(
    expect.objectContaining({ threads: [expect.objectContaining({ id: 'thread-1' })] }),
    'closed',
  );
});

test('plan mode recovers from an unreadable review sidecar', async () => {
  const markPlanReady = vi.fn(async () => {});
  window.codiff = createCodiffMock({
    getPlanReview: vi.fn(async () => {
      throw new Error('Invalid plan review.');
    }),
    markPlanReady,
  });

  await using view = await renderReact(<App />);
  await waitFor(() => expect(view.container.querySelector('.plan-shell')).not.toBeNull());
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
    'Invalid plan review.',
  );
  expect(view.container.querySelector('[contenteditable="true"]')).not.toBeNull();
  expect(markPlanReady).toHaveBeenCalledTimes(1);
});
