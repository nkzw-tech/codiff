/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { RepositoryReviewHost } from '../app/RepositoryReviewHost.tsx';
import { createDefaultConfig } from '../config/defaults.ts';
import { resolveRepositoryReviewBootstrap } from '../lib/repository-review-bootstrap.ts';
import type {
  DiffImageContentRequest,
  GitSha,
  NarrativeWalkthrough,
  NarrativeWalkthroughResult,
  RepositoryHistory,
  RepositoryState,
} from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

const state = {
  branch: 'main',
  files: [],
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source: { type: 'working-tree' },
} satisfies RepositoryState;

const unsubscribe = () => {};
const bootstrapFor = (
  repositoryState: RepositoryState,
  launchOptions = { repositoryPathProvided: true, walkthrough: false } as const,
) =>
  resolveRepositoryReviewBootstrap({
    launchOptions,
    reloadSelection: null,
    state: repositoryState,
  });
const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const installCommitWindowApi = () => {
  window.codiff = {
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    cancelDiffContentRequest: vi.fn(),
    createWalkthroughCommit: vi.fn(async () => ({ status: 'committed' })),
    dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    getUpdateStatus: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    isWindowFullScreen: vi.fn(async () => false),
    onConfigChanged: vi.fn(() => unsubscribe),
    onCopyPendingCommentsRequest: vi.fn(() => unsubscribe),
    onFindInDiffs: vi.fn(() => unsubscribe),
    onNarrativeWalkthroughUpdated: vi.fn(() => unsubscribe),
    onOpenReviewSource: vi.fn(() => unsubscribe),
    onRefreshRequest: vi.fn(() => unsubscribe),
    onRepositoryChanged: vi.fn(() => unsubscribe),
    onUpdateStatusChanged: vi.fn(() => unsubscribe),
    onWalkthroughCommitOutput: vi.fn(() => unsubscribe),
    onWalkthroughProgress: vi.fn(() => unsubscribe),
    onWindowFullScreenChanged: vi.fn(() => unsubscribe),
    openRepositoryFolder: vi.fn(async () => {}),
    resolvePullRequestUrl: vi.fn(async (value: string) => value),
    updateWalkthroughCommitMessage: vi.fn(async () => ({ status: 'unavailable' })),
  } as unknown as Window['codiff'];
};

test('RepositoryReviewHost renders local reviews through the shared surface', async () => {
  window.codiff = {
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    cancelDiffContentRequest: vi.fn(),
    dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    getUpdateStatus: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    isWindowFullScreen: vi.fn(async () => false),
    onConfigChanged: vi.fn(() => unsubscribe),
    onCopyPendingCommentsRequest: vi.fn(() => unsubscribe),
    onFindInDiffs: vi.fn(() => unsubscribe),
    onNarrativeWalkthroughUpdated: vi.fn(() => unsubscribe),
    onOpenReviewSource: vi.fn(() => unsubscribe),
    onRefreshRequest: vi.fn(() => unsubscribe),
    onRepositoryChanged: vi.fn(() => unsubscribe),
    onUpdateStatusChanged: vi.fn(() => unsubscribe),
    onWalkthroughProgress: vi.fn(() => unsubscribe),
    onWindowFullScreenChanged: vi.fn(() => unsubscribe),
    openRepositoryFolder: vi.fn(async () => {}),
    resolvePullRequestUrl: vi.fn(async (value: string) => value),
  } as unknown as Window['codiff'];

  const view = await renderReact(
    <RepositoryReviewHost
      bootstrap={bootstrapFor(state)}
      config={createDefaultConfig()}
      disableCodeViewWorkerPool
      gitIdentity={null}
      gitIdentityReady
      launchOptions={{ repositoryPathProvided: true, walkthrough: false }}
    />,
  );
  try {
    await waitFor(() => expect(view.container.querySelector('.review-surface')).not.toBeNull());
    expect(view.container.querySelector('main.review')).not.toBeNull();
    expect(view.container.querySelector('aside.sidebar')).not.toBeNull();
  } finally {
    await view.cleanup();
  }
});

test('RepositoryReviewHost renders provider reviews through the shared surface', async () => {
  window.codiff = {
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    cancelDiffContentRequest: vi.fn(),
    dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    getUpdateStatus: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    isWindowFullScreen: vi.fn(async () => false),
    onConfigChanged: vi.fn(() => unsubscribe),
    onCopyPendingCommentsRequest: vi.fn(() => unsubscribe),
    onFindInDiffs: vi.fn(() => unsubscribe),
    onNarrativeWalkthroughUpdated: vi.fn(() => unsubscribe),
    onOpenReviewSource: vi.fn(() => unsubscribe),
    onRefreshRequest: vi.fn(() => unsubscribe),
    onRepositoryChanged: vi.fn(() => unsubscribe),
    onUpdateStatusChanged: vi.fn(() => unsubscribe),
    onWalkthroughProgress: vi.fn(() => unsubscribe),
    onWindowFullScreenChanged: vi.fn(() => unsubscribe),
    openRepositoryFolder: vi.fn(async () => {}),
    resolvePullRequestUrl: vi.fn(async (value: string) => value),
  } as unknown as Window['codiff'];
  const pullRequestState = {
    ...state,
    files: [createChangedFile('src/review.ts')],
    source: {
      headSha: 'c'.repeat(40),
      number: 42,
      provider: 'github',
      targetBranch: 'main',
      title: 'Review the shared host',
      type: 'pull-request',
      url: 'https://github.com/example/review/pull/42',
    },
  } satisfies RepositoryState;

  const view = await renderReact(
    <RepositoryReviewHost
      bootstrap={bootstrapFor(pullRequestState)}
      config={createDefaultConfig()}
      disableCodeViewWorkerPool
      gitIdentity={null}
      gitIdentityReady
      initialHistory={[
        {
          author: 'Ada Lovelace',
          committedAt: 1,
          parentShas: [],
          sha: 'd'.repeat(40) as GitSha,
          subject: 'Review commit',
        },
      ]}
      launchOptions={{ repositoryPathProvided: true, walkthrough: false }}
    />,
  );
  try {
    await waitFor(() =>
      expect(view.container.querySelector('.merge-request-shell')).not.toBeNull(),
    );
    expect(view.container.textContent).toContain('Review the shared host');
    expect(view.container.textContent).toContain('src/review.ts');
    expect(view.container.querySelector('.sidebar-commit-button')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Back to Codiff"]')).toBeNull();

    const historyButton = Array.from(view.container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'History',
    );
    await act(async () => historyButton?.click());
    await waitFor(() => expect(view.container.querySelector('.history-list')).not.toBeNull());
    expect(
      Array.from(view.container.querySelectorAll('.history-entry-subject')).map(
        (entry) => entry.textContent,
      ),
    ).toEqual(['Review the shared host', 'Review commit']);
    expect(view.container.textContent).not.toContain('Uncommitted changes');
  } finally {
    await view.cleanup();
  }
});

test('working-tree reviews open the standalone commit view with generated seed text', async () => {
  installCommitWindowApi();
  const file = createChangedFile('src/commit.ts');
  const workingState = { ...state, files: [file] } satisfies RepositoryState;
  const walkthrough = {
    agent: 'claude',
    chapters: [],
    commit: { body: 'Explain why this commit exists.', title: 'Prepare the standalone commit' },
    focus: 'Review the commit.',
    generatedAt: '2026-08-05T00:00:00.000Z',
    kind: 'narrative',
    repo: { branch: workingState.branch, root: workingState.root },
    source: workingState.source,
    support: [],
    title: 'Commit walkthrough',
    version: 4,
  } satisfies NarrativeWalkthrough;
  const view = await renderReact(
    <RepositoryReviewHost
      bootstrap={bootstrapFor(workingState)}
      config={createDefaultConfig()}
      disableCodeViewWorkerPool
      gitIdentity={null}
      gitIdentityReady
      initialWalkthroughResult={{ status: 'ready', walkthrough }}
      launchOptions={{ repositoryPathProvided: true, walkthrough: false }}
    />,
  );

  try {
    await waitFor(() =>
      expect(view.container.querySelector('.sidebar-commit-button')).not.toBeNull(),
    );
    await act(async () => {
      (view.container.querySelector('.sidebar-commit-button') as HTMLButtonElement).click();
    });
    await waitFor(() => expect(view.container.querySelector('.wt-commit')).not.toBeNull());
    expect(
      (view.container.querySelector('.wt-commit-subject-field') as HTMLInputElement).value,
    ).toBe('Prepare the standalone commit');
    expect(
      (view.container.querySelector('.wt-commit-msg-input') as HTMLTextAreaElement).value,
    ).toBe('Explain why this commit exists.');
    expect(view.container.querySelector('.sidebar-commit-button')?.textContent).toBe('Tree');

    await act(async () => {
      (view.container.querySelector('.sidebar-commit-button') as HTMLButtonElement).click();
    });
    await waitFor(() => expect(view.container.querySelector('.wt-commit')).toBeNull());
  } finally {
    await view.cleanup();
  }
});

test('working-tree reviews restore the standalone commit view from bootstrap state', async () => {
  installCommitWindowApi();
  const workingState = {
    ...state,
    files: [createChangedFile('src/restored-commit.ts')],
  } satisfies RepositoryState;
  const bootstrap = {
    ...bootstrapFor(workingState),
    mainMode: 'commit' as const,
  };
  await using view = await renderReact(
    <RepositoryReviewHost
      bootstrap={bootstrap}
      config={createDefaultConfig()}
      disableCodeViewWorkerPool
      gitIdentity={null}
      gitIdentityReady
      launchOptions={{ repositoryPathProvided: true, walkthrough: false }}
    />,
  );

  await waitFor(() => expect(view.container.querySelector('.wt-commit')).not.toBeNull());
});

test('standalone commit preparation remains available without a ready walkthrough', async () => {
  const unavailable = {
    reason: 'Walkthrough generation is unavailable.',
    status: 'unavailable',
  } satisfies NarrativeWalkthroughResult;

  for (const initialWalkthroughResult of [undefined, unavailable]) {
    installCommitWindowApi();
    const workingState = {
      ...state,
      files: [createChangedFile('src/standalone.ts')],
    } satisfies RepositoryState;
    const view = await renderReact(
      <RepositoryReviewHost
        bootstrap={bootstrapFor(workingState)}
        config={createDefaultConfig()}
        disableCodeViewWorkerPool
        gitIdentity={null}
        gitIdentityReady
        initialWalkthroughResult={initialWalkthroughResult}
        launchOptions={{ repositoryPathProvided: true, walkthrough: false }}
      />,
    );
    try {
      await waitFor(() =>
        expect(view.container.querySelector('.sidebar-commit-button')).not.toBeNull(),
      );
      await act(async () => {
        (view.container.querySelector('.sidebar-commit-button') as HTMLButtonElement).click();
      });
      await waitFor(() => expect(view.container.querySelector('.wt-commit')).not.toBeNull());
    } finally {
      await view.cleanup();
    }
  }
});

test('reports first usable before initial history and deferred completion after it', async () => {
  const history = deferred<RepositoryHistory>();
  const getRepositoryHistory = vi.fn(() => history.promise);
  const reportInitialLoadMilestone = vi.fn();
  window.codiff = {
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    cancelDiffContentRequest: vi.fn(),
    dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    getRepositoryHistory,
    getUpdateStatus: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    isWindowFullScreen: vi.fn(async () => false),
    onConfigChanged: vi.fn(() => unsubscribe),
    onCopyPendingCommentsRequest: vi.fn(() => unsubscribe),
    onFindInDiffs: vi.fn(() => unsubscribe),
    onNarrativeWalkthroughUpdated: vi.fn(() => unsubscribe),
    onOpenReviewSource: vi.fn(() => unsubscribe),
    onRefreshRequest: vi.fn(() => unsubscribe),
    onRepositoryChanged: vi.fn(() => unsubscribe),
    onUpdateStatusChanged: vi.fn(() => unsubscribe),
    onWalkthroughProgress: vi.fn(() => unsubscribe),
    onWindowFullScreenChanged: vi.fn(() => unsubscribe),
    openRepositoryFolder: vi.fn(async () => {}),
    reportInitialLoadMilestone,
    resolvePullRequestUrl: vi.fn(async (value: string) => value),
  } as unknown as Window['codiff'];

  const render = (gitIdentityReady: boolean) => (
    <RepositoryReviewHost
      bootstrap={bootstrapFor(state)}
      config={createDefaultConfig()}
      disableCodeViewWorkerPool
      gitIdentity={null}
      gitIdentityReady={gitIdentityReady}
      initialHistoryLoading
      launchOptions={{ repositoryPathProvided: true, walkthrough: false }}
    />
  );
  const view = await renderReact(render(false));
  try {
    await waitFor(() =>
      expect(reportInitialLoadMilestone).toHaveBeenCalledWith('first-usable-review-rendered'),
    );
    await waitFor(() => expect(getRepositoryHistory).toHaveBeenCalledOnce());
    expect(reportInitialLoadMilestone.mock.invocationCallOrder[0]!).toBeLessThan(
      getRepositoryHistory.mock.invocationCallOrder[0]!,
    );
    expect(reportInitialLoadMilestone).not.toHaveBeenCalledWith('deferred-review-data-complete');

    await act(async () => history.resolve({ entries: [], root: '/repo' }));
    expect(reportInitialLoadMilestone).not.toHaveBeenCalledWith('deferred-review-data-complete');

    await view.rerender(render(true));
    await waitFor(() =>
      expect(reportInitialLoadMilestone).toHaveBeenCalledWith('deferred-review-data-complete'),
    );
  } finally {
    await view.cleanup();
  }
});

test('RepositoryReviewHost hydrates deferred provider comments', async () => {
  const file = createChangedFile('src/review.ts');
  const source = {
    headSha: 'c'.repeat(40),
    number: 42,
    provider: 'github',
    targetBranch: 'main',
    title: 'Review the shared host',
    type: 'pull-request',
    url: 'https://github.com/example/review/pull/42',
  } as const;
  const pullRequestState = {
    ...state,
    files: [file],
    reviewCommentsLoadState: 'not-loaded' as const,
    source,
  } satisfies RepositoryState;
  const getReviewComments = vi.fn(async (_source: typeof source, _requestId?: string) => [
    {
      author: { login: 'reviewer' },
      body: 'Loaded through the R04 review-comments capability.',
      filePath: file.path,
      id: 'github:1',
      lineNumber: 1,
      side: 'additions' as const,
      threadId: '1',
    },
  ]);
  window.codiff = {
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    cancelDiffContentRequest: vi.fn(),
    dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    getReviewComments,
    getUpdateStatus: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    isWindowFullScreen: vi.fn(async () => false),
    onConfigChanged: vi.fn(() => unsubscribe),
    onCopyPendingCommentsRequest: vi.fn(() => unsubscribe),
    onFindInDiffs: vi.fn(() => unsubscribe),
    onNarrativeWalkthroughUpdated: vi.fn(() => unsubscribe),
    onOpenReviewSource: vi.fn(() => unsubscribe),
    onRefreshRequest: vi.fn(() => unsubscribe),
    onRepositoryChanged: vi.fn(() => unsubscribe),
    onUpdateStatusChanged: vi.fn(() => unsubscribe),
    onWalkthroughProgress: vi.fn(() => unsubscribe),
    onWindowFullScreenChanged: vi.fn(() => unsubscribe),
    openRepositoryFolder: vi.fn(async () => {}),
    reportInitialLoadMilestone: vi.fn(),
    resolvePullRequestUrl: vi.fn(async (value: string) => value),
  } as unknown as Window['codiff'];

  await using view = await renderReact(
    <RepositoryReviewHost
      bootstrap={bootstrapFor(pullRequestState)}
      config={createDefaultConfig()}
      disableCodeViewWorkerPool
      gitIdentity={null}
      gitIdentityReady
      launchOptions={{ repositoryPathProvided: true, walkthrough: false }}
    />,
  );

  await waitFor(() => {
    expect(getReviewComments).toHaveBeenCalledWith(
      source,
      expect.stringMatching(/^review-comments:/),
    );
    expect(view.container.textContent).toContain(
      'Loaded through the R04 review-comments capability.',
    );
  });
});

test('RepositoryReviewHost cancels active bulk provider hydration on unmount', async () => {
  const file = {
    ...createChangedFile('src/lazy.ts'),
    sections: [
      {
        binary: false,
        id: 'src/lazy.ts:pull-request',
        kind: 'pull-request' as const,
        loadState: 'deferred' as const,
        patch: '',
        summary: { canLoad: true, reason: 'Load exact contents.' },
      },
    ],
  };
  const pullRequestState = {
    ...state,
    files: [file],
    reviewCommentsLoadState: 'loaded' as const,
    source: {
      headSha: 'c'.repeat(40),
      number: 42,
      provider: 'github' as const,
      targetBranch: 'main',
      title: 'Lazy content',
      type: 'pull-request' as const,
      url: 'https://github.com/example/review/pull/42',
    },
  } satisfies RepositoryState;
  const getDiffSectionsContent = vi.fn((_request: { requestId?: string }) => new Promise(() => {}));
  const cancelDiffContentRequest = vi.fn();
  window.codiff = {
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    cancelDiffContentRequest,
    dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    getDiffSectionsContent,
    getUpdateStatus: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    isWindowFullScreen: vi.fn(async () => false),
    onConfigChanged: vi.fn(() => unsubscribe),
    onCopyPendingCommentsRequest: vi.fn(() => unsubscribe),
    onFindInDiffs: vi.fn(() => unsubscribe),
    onNarrativeWalkthroughUpdated: vi.fn(() => unsubscribe),
    onOpenReviewSource: vi.fn(() => unsubscribe),
    onRefreshRequest: vi.fn(() => unsubscribe),
    onRepositoryChanged: vi.fn(() => unsubscribe),
    onUpdateStatusChanged: vi.fn(() => unsubscribe),
    onWalkthroughProgress: vi.fn(() => unsubscribe),
    onWindowFullScreenChanged: vi.fn(() => unsubscribe),
    openRepositoryFolder: vi.fn(async () => {}),
    resolvePullRequestUrl: vi.fn(async (value: string) => value),
  } as unknown as Window['codiff'];

  const view = await renderReact(
    <RepositoryReviewHost
      bootstrap={bootstrapFor(pullRequestState)}
      config={createDefaultConfig()}
      disableCodeViewWorkerPool
      gitIdentity={null}
      gitIdentityReady
      launchOptions={{ repositoryPathProvided: true, walkthrough: false }}
    />,
  );
  await waitFor(() => expect(getDiffSectionsContent).toHaveBeenCalledOnce());
  const requestId = getDiffSectionsContent.mock.calls[0]![0].requestId;
  expect(requestId).toMatch(/^bulk-sections:/);
  await view.cleanup();
  expect(cancelDiffContentRequest).toHaveBeenCalledWith(requestId);
});

test('RepositoryReviewHost cancels an active image request on unmount', async () => {
  const file = {
    ...createChangedFile('image.png'),
    sections: [
      {
        binary: true,
        id: 'image.png:pull-request',
        kind: 'pull-request' as const,
        loadState: 'binary' as const,
        patch: 'Binary files a/image.png and b/image.png differ',
      },
    ],
  };
  const pullRequestState = {
    ...state,
    files: [file],
    reviewCommentsLoadState: 'loaded' as const,
    source: {
      headSha: 'c'.repeat(40),
      number: 42,
      provider: 'github' as const,
      targetBranch: 'main',
      title: 'Image content',
      type: 'pull-request' as const,
      url: 'https://github.com/example/review/pull/42',
    },
  } satisfies RepositoryState;
  const getDiffImageContent = vi.fn((_request: DiffImageContentRequest) => new Promise(() => {}));
  const cancelDiffContentRequest = vi.fn();
  window.codiff = {
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    cancelDiffContentRequest,
    dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    getDiffImageContent,
    getUpdateStatus: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    isWindowFullScreen: vi.fn(async () => false),
    onConfigChanged: vi.fn(() => unsubscribe),
    onCopyPendingCommentsRequest: vi.fn(() => unsubscribe),
    onFindInDiffs: vi.fn(() => unsubscribe),
    onNarrativeWalkthroughUpdated: vi.fn(() => unsubscribe),
    onOpenReviewSource: vi.fn(() => unsubscribe),
    onRefreshRequest: vi.fn(() => unsubscribe),
    onRepositoryChanged: vi.fn(() => unsubscribe),
    onUpdateStatusChanged: vi.fn(() => unsubscribe),
    onWalkthroughProgress: vi.fn(() => unsubscribe),
    onWindowFullScreenChanged: vi.fn(() => unsubscribe),
    openRepositoryFolder: vi.fn(async () => {}),
    resolvePullRequestUrl: vi.fn(async (value: string) => value),
  } as unknown as Window['codiff'];

  const view = await renderReact(
    <RepositoryReviewHost
      bootstrap={bootstrapFor(pullRequestState)}
      config={createDefaultConfig()}
      disableCodeViewWorkerPool
      gitIdentity={null}
      gitIdentityReady
      launchOptions={{ repositoryPathProvided: true, walkthrough: false }}
    />,
  );
  await waitFor(() => expect(getDiffImageContent).toHaveBeenCalledOnce());
  const requestId = getDiffImageContent.mock.calls[0]![0].requestId;
  expect(requestId).toMatch(/^image:/);
  await view.cleanup();
  expect(cancelDiffContentRequest).toHaveBeenCalledWith(requestId);
});

test('RepositoryReviewHost cancels provider comment enrichment on source replacement', async () => {
  const source = {
    headSha: 'c'.repeat(40),
    number: 42,
    provider: 'github' as const,
    targetBranch: 'main',
    title: 'Cancelable comments',
    type: 'pull-request' as const,
    url: 'https://github.com/example/review/pull/42',
  };
  const firstState = {
    ...state,
    files: [createChangedFile('src/review.ts')],
    reviewCommentsLoadState: 'not-loaded' as const,
    source,
  } satisfies RepositoryState;
  const commitSha = 'd'.repeat(40) as GitSha;
  const secondState = {
    ...state,
    files: [],
    source: { sha: commitSha, type: 'commit' as const },
  } satisfies RepositoryState;
  const getReviewComments = vi.fn(
    (_source: typeof source, _requestId?: string) => new Promise<never>(() => {}),
  );
  const getRepositoryState = vi.fn(async () => secondState);
  const cancelDiffContentRequest = vi.fn();
  window.codiff = {
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    cancelDiffContentRequest,
    cancelNarrativeWalkthrough: vi.fn(async () => {}),
    dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    getRepositoryHistory: vi.fn(async () => ({ entries: [], root: '/repo' })),
    getRepositoryState,
    getReviewComments,
    getUpdateStatus: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    isWindowFullScreen: vi.fn(async () => false),
    onConfigChanged: vi.fn(() => unsubscribe),
    onCopyPendingCommentsRequest: vi.fn(() => unsubscribe),
    onFindInDiffs: vi.fn(() => unsubscribe),
    onNarrativeWalkthroughUpdated: vi.fn(() => unsubscribe),
    onOpenReviewSource: vi.fn(() => unsubscribe),
    onRefreshRequest: vi.fn(() => unsubscribe),
    onRepositoryChanged: vi.fn(() => unsubscribe),
    onUpdateStatusChanged: vi.fn(() => unsubscribe),
    onWalkthroughCommitOutput: vi.fn(() => unsubscribe),
    onWalkthroughProgress: vi.fn(() => unsubscribe),
    onWindowFullScreenChanged: vi.fn(() => unsubscribe),
    openRepositoryFolder: vi.fn(async () => {}),
    reportInitialLoadMilestone: vi.fn(),
    resolvePullRequestUrl: vi.fn(async (value: string) => value),
  } as unknown as Window['codiff'];

  await using view = await renderReact(
    <RepositoryReviewHost
      bootstrap={bootstrapFor(firstState)}
      config={createDefaultConfig()}
      disableCodeViewWorkerPool
      gitIdentity={null}
      gitIdentityReady
      initialHistory={[
        {
          author: 'Ada',
          committedAt: 1,
          parentShas: [],
          scope: 'pull-request',
          sha: commitSha,
          subject: 'Commit source',
        },
      ]}
      launchOptions={{ repositoryPathProvided: true, walkthrough: false }}
    />,
  );

  await waitFor(() => expect(getReviewComments).toHaveBeenCalledOnce());
  const requestId = getReviewComments.mock.calls[0]![1];
  expect(requestId).toMatch(/^review-comments:/);
  const historyButton = Array.from(view.container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === 'History',
  );
  await act(async () => historyButton?.click());
  let commitButton: HTMLButtonElement | undefined;
  await waitFor(() => {
    commitButton = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>('.history-entry'),
    ).find((candidate) => candidate.title === 'Commit source');
    expect(commitButton).not.toBeUndefined();
  });
  await act(async () => commitButton!.click());
  await waitFor(() => {
    expect(getRepositoryState).toHaveBeenCalledWith({ ref: commitSha, type: 'commit' });
    expect(cancelDiffContentRequest).toHaveBeenCalledWith(requestId);
  });
});
