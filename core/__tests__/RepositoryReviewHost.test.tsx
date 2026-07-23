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
  DiffSectionContentRequest,
  GitSha,
  NarrativeWalkthrough,
  NarrativeWalkthroughResult,
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
  const getReviewComments = vi.fn(async () => [
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
    onOpenReviewSource: vi.fn(() => unsubscribe),
    onRefreshRequest: vi.fn(() => unsubscribe),
    onRepositoryChanged: vi.fn(() => unsubscribe),
    onUpdateStatusChanged: vi.fn(() => unsubscribe),
    onWalkthroughProgress: vi.fn(() => unsubscribe),
    onWindowFullScreenChanged: vi.fn(() => unsubscribe),
    openRepositoryFolder: vi.fn(async () => {}),
    resolvePullRequestUrl: vi.fn(async (value: string) => value),
  } as unknown as Window['codiff'];

  await using view = await renderReact(
    <RepositoryReviewHost
      bootstrap={bootstrapFor(pullRequestState)}
      config={createDefaultConfig()}
      disableCodeViewWorkerPool
      gitIdentity={null}
      launchOptions={{ repositoryPathProvided: true, walkthrough: false }}
    />,
  );

  await waitFor(() => {
    expect(getReviewComments).toHaveBeenCalledWith(source);
    expect(view.container.textContent).toContain(
      'Loaded through the R04 review-comments capability.',
    );
  });
});

test('RepositoryReviewHost cancels an active lazy section request on unmount', async () => {
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
  const getDiffSectionContent = vi.fn(
    (_request: DiffSectionContentRequest) => new Promise(() => {}),
  );
  const cancelDiffContentRequest = vi.fn();
  window.codiff = {
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    cancelDiffContentRequest,
    dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    getDiffSectionContent,
    getUpdateStatus: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    isWindowFullScreen: vi.fn(async () => false),
    onConfigChanged: vi.fn(() => unsubscribe),
    onCopyPendingCommentsRequest: vi.fn(() => unsubscribe),
    onFindInDiffs: vi.fn(() => unsubscribe),
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
      launchOptions={{ repositoryPathProvided: true, walkthrough: false }}
    />,
  );
  await waitFor(() => expect(getDiffSectionContent).toHaveBeenCalledOnce());
  const requestId = getDiffSectionContent.mock.calls[0]![0].requestId;
  expect(requestId).toMatch(/^section:/);
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
      launchOptions={{ repositoryPathProvided: true, walkthrough: false }}
    />,
  );
  await waitFor(() => expect(getDiffImageContent).toHaveBeenCalledOnce());
  const requestId = getDiffImageContent.mock.calls[0]![0].requestId;
  expect(requestId).toMatch(/^image:/);
  await view.cleanup();
  expect(cancelDiffContentRequest).toHaveBeenCalledWith(requestId);
});
