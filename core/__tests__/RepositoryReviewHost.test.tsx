/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { RepositoryReviewHost } from '../app/RepositoryReviewHost.tsx';
import { createDefaultConfig } from '../config/defaults.ts';
import { resolveRepositoryReviewBootstrap } from '../lib/repository-review-bootstrap.ts';
import type {
  GitSha,
  NarrativeWalkthrough,
  NarrativeWalkthroughResult,
  RepositoryHistory,
  RepositoryState,
  RevisionContentBatchRequest,
  RevisionContentBatchResult,
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

test('provider reviews load exact contents before their first usable render', async () => {
  const content = deferred<RevisionContentBatchResult>();
  const readRevisionContent = vi.fn((_request: RevisionContentBatchRequest) => content.promise);
  const reportInitialLoadMilestone = vi.fn();
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
    readRevisionContent,
    reportInitialLoadMilestone,
    resolvePullRequestUrl: vi.fn(async (value: string) => value),
  } as unknown as Window['codiff'];
  const baseSha = 'b'.repeat(40) as GitSha;
  const headSha = 'c'.repeat(40) as GitSha;
  const range = {
    base: { label: { kind: 'commit' as const, text: 'base' }, sha: baseSha },
    head: { label: { kind: 'commit' as const, text: 'head' }, sha: headSha },
  };
  const deferredFile = createChangedFile('src/deferred.ts', { kind: 'pull-request' });
  const patchFile = createChangedFile('src/patch.ts', { kind: 'pull-request' });
  const pullRequestState = {
    ...state,
    files: [
      {
        ...deferredFile,
        sections: [
          {
            ...deferredFile.sections[0]!,
            loadState: 'deferred' as const,
            patch: '',
            range,
            summary: { canLoad: true, reason: 'Load exact contents.' },
          },
        ],
      },
      {
        ...patchFile,
        sections: [
          {
            ...patchFile.sections[0]!,
            loadState: 'ready' as const,
            newFile: undefined,
            oldFile: undefined,
            range,
          },
        ],
      },
    ],
    reviewCommentsLoadState: 'loaded' as const,
    source: {
      headSha,
      number: 42,
      provider: 'github' as const,
      targetBranch: 'main',
      title: 'Exact review content',
      type: 'pull-request' as const,
      url: 'https://github.com/example/review/pull/42',
    },
  } satisfies RepositoryState;

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

  await waitFor(() => expect(readRevisionContent).toHaveBeenCalledOnce());
  expect(readRevisionContent.mock.calls[0]![0].requests).toHaveLength(4);
  expect(view.container.querySelector('.review-surface')).toBeNull();
  expect(reportInitialLoadMilestone).not.toHaveBeenCalledWith('first-usable-review-rendered');

  const request = readRevisionContent.mock.calls[0]![0];
  await act(async () =>
    content.resolve({
      results: request.requests.map((item) => ({
        key: item.key,
        status: 'ready' as const,
        value: {
          bytes: new TextEncoder().encode(item.revision === range.head ? 'new\n' : 'old\n'),
          cacheKey: item.key,
          path: item.path,
          provenance: 'native-git' as const,
          size: 4,
        },
      })),
    }),
  );
  await waitFor(() => expect(view.container.querySelector('.review-surface')).not.toBeNull());
  expect(reportInitialLoadMilestone).toHaveBeenCalledWith('first-usable-review-rendered');
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
  const file = createChangedFile('src/review.ts', { kind: 'pull-request' });
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
  const getReviewComments = vi.fn(async (_source: typeof source, _requestId?: string) => ({
    generalComments: [
      {
        comments: [
          {
            author: { login: 'overview-reviewer' },
            body: 'Loaded overview feedback with the inline thread.',
            id: 'github:overview:1',
          },
        ],
        id: 'overview-thread',
      },
    ],
    reviewComments: [
      {
        author: { login: 'reviewer' },
        body: 'Loaded through the R04 review-comments capability.',
        filePath: file.path,
        id: 'github:1',
        lineNumber: 1,
        position: { range: file.sections[0]!.range! },
        side: 'additions' as const,
        threadId: '1',
      },
    ],
  }));
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
  const commentsButton = Array.from(view.container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('Comments'),
  );
  await act(async () => commentsButton?.click());
  await waitFor(() => {
    expect(view.container.querySelector('main.review')?.textContent).toContain(
      'Loaded overview feedback with the inline thread.',
    );
    expect(view.container.querySelector('main.review')?.textContent).toContain(
      'Loaded through the R04 review-comments capability.',
    );
  });
});

test('RepositoryReviewHost renders historical comment regions and falls back after content failure', async () => {
  const currentFile = createChangedFile('src/history.ts', { kind: 'pull-request' });
  const source = {
    headSha: 'b'.repeat(40),
    number: 43,
    provider: 'github',
    targetBranch: 'main',
    title: 'Review historical anchors',
    type: 'pull-request',
    url: 'https://github.com/example/review/pull/43',
  } as const;
  const pullRequestState = {
    ...state,
    files: [currentFile],
    reviewCommentsLoadState: 'not-loaded' as const,
    source,
  } satisfies RepositoryState;
  const historicalRange = {
    base: {
      label: { kind: 'commit' as const, text: 'ccccccc' },
      sha: 'c'.repeat(40) as GitSha,
    },
    head: {
      label: { kind: 'commit' as const, text: 'ddddddd' },
      sha: 'd'.repeat(40) as GitSha,
    },
  };
  const failedRange = {
    base: {
      label: { kind: 'commit' as const, text: 'eeeeeee' },
      sha: 'e'.repeat(40) as GitSha,
    },
    head: {
      label: { kind: 'commit' as const, text: 'fffffff' },
      sha: 'f'.repeat(40) as GitSha,
    },
  };
  const getReviewComments = vi.fn(async () => ({
    generalComments: [],
    reviewComments: [
      {
        author: { login: 'historical-reviewer' },
        body: 'Render this against the historical code.',
        filePath: currentFile.path,
        id: 'github:historical',
        isOutdated: true,
        lineNumber: 2,
        position: { range: historicalRange },
        side: 'additions' as const,
        threadId: 'historical-thread',
      },
      {
        author: { login: 'failed-reviewer' },
        body: 'Keep this thread when historical content cannot load.',
        filePath: 'src/unavailable-history.ts',
        id: 'github:failed-history',
        isOutdated: true,
        lineNumber: 2,
        position: { range: failedRange },
        side: 'additions' as const,
        threadId: 'failed-thread',
      },
    ],
  }));
  const readRevisionContent = vi.fn(async (request: RevisionContentBatchRequest) => ({
    results: request.requests.map((item) => {
      if ('sha' in item.revision && ['e'.repeat(40), 'f'.repeat(40)].includes(item.revision.sha)) {
        return {
          key: item.key,
          reason: 'Historical object is unavailable.',
          status: 'unavailable' as const,
        };
      }
      const contents =
        'sha' in item.revision && item.revision.sha === historicalRange.base.sha
          ? 'one\nold value\nthree\n'
          : 'one\nnew value\nthree\n';
      const bytes = new TextEncoder().encode(contents);
      return {
        key: item.key,
        status: 'ready' as const,
        value: {
          bytes,
          cacheKey: `${item.key}:cache`,
          path: item.path,
          provenance: 'native-git' as const,
          size: bytes.byteLength,
        },
      };
    }),
  }));
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
    readRevisionContent,
    reportInitialLoadMilestone: vi.fn(),
    resolvePullRequestUrl: vi.fn(async (value: string) => value),
  } as unknown as Window['codiff'];
  const config = createDefaultConfig();
  config.settings.showOutdated = true;

  await using view = await renderReact(
    <RepositoryReviewHost
      bootstrap={bootstrapFor(pullRequestState)}
      config={config}
      disableCodeViewWorkerPool
      gitIdentity={null}
      gitIdentityReady
      launchOptions={{ repositoryPathProvided: true, walkthrough: false }}
    />,
  );

  await waitFor(() => expect(getReviewComments).toHaveBeenCalledOnce());
  expect(readRevisionContent).not.toHaveBeenCalled();
  await waitFor(() => {
    const commentsTab = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((button) => button.textContent?.includes('Comments'));
    expect(commentsTab?.getAttribute('aria-label')).toBe('Comments (2)');
  });
  const commentsButton = Array.from(view.container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('Comments'),
  );
  await act(async () => commentsButton?.click());
  const historicalButton = Array.from(view.container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('Render this against the historical code.'),
  );
  await act(async () => historicalButton?.click());
  await waitFor(() => expect(readRevisionContent).toHaveBeenCalledOnce());
  await waitFor(() => {
    const main = view.container.querySelector('main.review');
    expect(
      main?.querySelectorAll('.codiff-file-header:not(.codiff-source-description-header)'),
    ).toHaveLength(1);
  });
  await act(async () => commentsButton?.click());
  const failedButton = Array.from(view.container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('Keep this thread when historical content cannot load.'),
  );
  await act(async () => failedButton?.click());
  await waitFor(() => expect(readRevisionContent).toHaveBeenCalledTimes(2));
  const requestedShas = readRevisionContent.mock.calls.flatMap(([request]) =>
    request.requests.flatMap((item) => ('sha' in item.revision ? [item.revision.sha] : [])),
  );
  expect(requestedShas).toEqual(
    expect.arrayContaining([
      historicalRange.base.sha,
      historicalRange.head.sha,
      failedRange.base.sha,
      failedRange.head.sha,
    ]),
  );
});

test('RepositoryReviewHost hydrates provider content before mounting and cancels on unmount', async () => {
  const baseFile = createChangedFile('src/lazy.ts', { kind: 'pull-request' });
  const file = {
    ...baseFile,
    sections: [
      {
        ...baseFile.sections[0]!,
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
  const readRevisionContent = vi.fn(
    (_request: RevisionContentBatchRequest) => new Promise<RevisionContentBatchResult>(() => {}),
  );
  const cancelDiffContentRequest = vi.fn();
  window.codiff = {
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    cancelDiffContentRequest,
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
    readRevisionContent,
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
  await waitFor(() => expect(readRevisionContent).toHaveBeenCalledOnce());
  expect(view.container.querySelector('main.review')).toBeNull();
  await view.cleanup();
  expect(cancelDiffContentRequest).toHaveBeenCalledWith(
    readRevisionContent.mock.calls[0]![0].requestId,
  );
});

test('RepositoryReviewHost cancels an active image request on unmount', async () => {
  const baseFile = createChangedFile('image.png', { kind: 'pull-request' });
  const file = {
    ...baseFile,
    sections: [
      {
        ...baseFile.sections[0]!,
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
  const readRevisionContent = vi.fn(
    (_request: RevisionContentBatchRequest) => new Promise<RevisionContentBatchResult>(() => {}),
  );
  const cancelDiffContentRequest = vi.fn();
  window.codiff = {
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    cancelDiffContentRequest,
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
    readRevisionContent,
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
  await waitFor(() => expect(readRevisionContent).toHaveBeenCalledOnce());
  const requestId = readRevisionContent.mock.calls[0]![0].requestId;
  expect(requestId).toMatch(/^revision-content:/);
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
