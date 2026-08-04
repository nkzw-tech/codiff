/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { RepositoryReviewHost } from '../app/RepositoryReviewHost.tsx';
import { createDefaultConfig } from '../config/defaults.ts';
import { resolveRepositoryReviewBootstrap } from '../lib/repository-review-bootstrap.ts';
import type {
  CodiffLaunchOptions,
  DiffImageContentRequest,
  GitSha,
  NarrativeWalkthrough,
  NarrativeWalkthroughResult,
  RepositoryHistory,
  RepositoryState,
  ReviewVersionEvolutionProgressEvent,
  ReviewVersionOption,
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
  launchOptions: CodiffLaunchOptions = { repositoryPathProvided: true, walkthrough: false },
) =>
  resolveRepositoryReviewBootstrap({
    launchOptions,
    reloadSelection: null,
    state: repositoryState,
  });
const createVersionBridge = () => ({
  cancelReviewVersionEvolution: vi.fn(async () => {}),
  getReviewVersions: vi.fn(async () => ({ versions: [] })),
  getUpdateStatus: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
  onReviewVersionEvolutionProgress: vi.fn(() => unsubscribe),
  onUpdateStatusChanged: vi.fn(() => unsubscribe),
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
    ...createVersionBridge(),
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
    ...createVersionBridge(),
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
    ...createVersionBridge(),
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    cancelDiffContentRequest: vi.fn(),
    dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
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

test('requests commit-by-commit generation with canonical commits and the immutable range', async () => {
  const baseSha = '0'.repeat(40) as GitSha;
  const firstSha = 'a'.repeat(40) as GitSha;
  const secondSha = 'b'.repeat(40) as GitSha;
  const range = {
    base: { label: { kind: 'commit' as const, text: 'main' }, sha: baseSha },
    head: { label: { kind: 'commit' as const, text: 'Head' }, sha: secondSha },
  };
  const getNarrativeWalkthrough = vi.fn(async () => ({
    reason: 'Stop after capturing the request.',
    status: 'unavailable' as const,
  }));
  window.codiff = {
    ...createVersionBridge(),
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    cancelDiffContentRequest: vi.fn(),
    dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    getNarrativeWalkthrough,
    getReviewComments: vi.fn(async () => []),
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
  const file = createChangedFile('src/review.ts');
  const source = {
    description: 'Please review each commit.',
    headSha: secondSha,
    number: 42,
    provider: 'github',
    targetBranch: 'main',
    title: 'Review the commit stack',
    type: 'pull-request',
    url: 'https://github.com/example/review/pull/42',
  } as const;
  const pullRequestState = {
    ...state,
    files: [
      {
        ...file,
        sections: file.sections.map((section) => ({ ...section, range })),
      },
    ],
    source,
  } satisfies RepositoryState;

  const view = await renderReact(
    <RepositoryReviewHost
      bootstrap={bootstrapFor(pullRequestState, {
        repositoryPathProvided: true,
        walkthrough: true,
      })}
      config={createDefaultConfig()}
      disableCodeViewWorkerPool
      gitIdentity={null}
      gitIdentityReady
      initialHistory={[
        {
          author: 'Ada',
          committedAt: 0,
          parentShas: [],
          scope: 'base',
          sha: baseSha,
          subject: 'Prepare main',
        },
        {
          author: 'Ada',
          committedAt: 1,
          parentShas: [baseSha],
          scope: 'pull-request',
          sha: firstSha,
          subject: 'Add model',
        },
        {
          author: 'Ada',
          committedAt: 2,
          parentShas: [firstSha],
          scope: 'pull-request',
          sha: secondSha,
          subject: 'Test model',
        },
      ]}
      launchOptions={{ repositoryPathProvided: true, walkthrough: true }}
    />,
  );
  try {
    await waitFor(() => expect(getNarrativeWalkthrough).toHaveBeenCalledOnce());
    expect(getNarrativeWalkthrough).toHaveBeenCalledWith({
      commits: [
        expect.objectContaining({ sha: firstSha, subject: 'Add model' }),
        expect.objectContaining({ sha: secondSha, subject: 'Test model' }),
      ],
      kind: 'target-comparison',
      selection: { range, relation: 'target-comparison', structure: 'commit-by-commit' },
      source,
    });
  } finally {
    await view.cleanup();
  }
});

test('loads an oldest-first commit range after host-side ancestry validation', async () => {
  const baseSha = '0'.repeat(40) as GitSha;
  const firstSha = 'a'.repeat(40) as GitSha;
  const secondSha = 'b'.repeat(40) as GitSha;
  const headSha = 'c'.repeat(40) as GitSha;
  const rangedFile = createChangedFile('src/range.ts');
  const getRepositoryState = vi.fn(
    async (source: Parameters<Window['codiff']['getRepositoryState']>[0]) => ({
      ...state,
      files: [rangedFile],
      source: source ?? { type: 'working-tree' },
    }),
  );
  window.codiff = {
    ...createVersionBridge(),
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    cancelDiffContentRequest: vi.fn(),
    dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    getRepositoryState,
    getReviewComments: vi.fn(async () => []),
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
  const initialFile = createChangedFile('src/review.ts');
  const pullRequestState = {
    ...state,
    files: [
      {
        ...initialFile,
        sections: initialFile.sections.map((section) => ({
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
          author: 'Ada',
          committedAt: 3,
          diffStat: { additions: 7, deletions: 3, filesChanged: 2 },
          parentShas: [secondSha],
          scope: 'pull-request',
          sha: headSha,
          subject: 'Commit C',
        },
        {
          author: 'Ada',
          committedAt: 2,
          parentShas: [firstSha],
          scope: 'pull-request',
          sha: secondSha,
          subject: 'Commit B',
        },
        {
          author: 'Ada',
          committedAt: 1,
          parentShas: [baseSha],
          scope: 'pull-request',
          sha: firstSha,
          subject: 'Commit A',
        },
        {
          author: 'Grace',
          committedAt: 0,
          parentShas: [],
          scope: 'base',
          sha: baseSha,
          subject: 'Prepare main',
        },
      ]}
      launchOptions={{ repositoryPathProvided: true, walkthrough: false }}
    />,
  );
  try {
    await waitFor(() => expect(view.container.textContent).toContain('Compare to main'));
    expect(view.container.textContent).toContain('From · main');
    expect(view.container.textContent).toContain('To · Head');

    const viewRangeButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
      ({ textContent }) => textContent?.trim() === 'View commit range',
    );
    expect(viewRangeButton).toBeDefined();
    await act(async () => viewRangeButton?.click());
    const rows = view.container.querySelectorAll<HTMLButtonElement>('.commit-range-row');
    expect([...rows].map((row) => row.textContent)).toEqual([
      expect.stringContaining('Commit A'),
      expect.stringContaining('Commit B'),
      expect.stringContaining('Commit C'),
    ]);

    await act(async () => rows[0]!.click());
    await act(async () => rows[2]!.click());
    await waitFor(() =>
      expect(getRepositoryState).toHaveBeenCalledWith({
        base: baseSha,
        head: headSha,
        symmetric: false,
        type: 'range',
      }),
    );
    await waitFor(() => expect(view.container.textContent).toContain('src/range.ts'));
    const selectedRows = view.container.querySelectorAll('.commit-range-row[aria-pressed="true"]');
    expect(selectedRows).toHaveLength(3);
    await act(async () =>
      selectedRows[2]?.querySelector<HTMLElement>('.git-commit-ref-trigger')?.focus(),
    );
    await waitFor(() =>
      expect(document.body.querySelector('.git-commit-tooltip-diffstat')?.textContent).toBe('+7−3'),
    );
  } finally {
    await view.cleanup();
  }
});

test('starts and cancels one shared version comparison run with progress', async () => {
  const baseSha = '0'.repeat(40) as GitSha;
  const beforeSha = 'a'.repeat(40) as GitSha;
  const afterSha = 'b'.repeat(40) as GitSha;
  const version = (number: number, headSha: GitSha) => ({
    createdAt: `2026-08-0${number}T12:00:00.000Z`,
    isHead: number === 2,
    number,
    range: {
      base: { label: { kind: 'version' as const, text: 'Base' }, sha: baseSha },
      head: { label: { kind: 'version' as const, text: `v${number}` }, sha: headSha },
    },
    versionId: `version-${number}` as ReviewVersionOption['versionId'],
  });
  const versions = [
    version(1, beforeSha),
    version(2, afterSha),
  ] satisfies ReadonlyArray<ReviewVersionOption>;
  const aggregate = deferred<Awaited<ReturnType<Window['codiff']['getReviewVersionAggregate']>>>();
  const evolution = deferred<Awaited<ReturnType<Window['codiff']['getReviewVersionEvolution']>>>();
  let progressListener: ((event: ReviewVersionEvolutionProgressEvent) => void) | null = null;
  const cancelReviewVersionEvolution = vi.fn<Window['codiff']['cancelReviewVersionEvolution']>(
    async () => {},
  );
  const getReviewVersionAggregate = vi.fn<Window['codiff']['getReviewVersionAggregate']>(
    () => aggregate.promise,
  );
  const getReviewVersionEvolution = vi.fn<Window['codiff']['getReviewVersionEvolution']>(
    () => evolution.promise,
  );
  window.codiff = {
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    cancelDiffContentRequest: vi.fn(),
    cancelReviewVersionEvolution,
    dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    getReviewComments: vi.fn(async () => []),
    getReviewVersionAggregate,
    getReviewVersionEvolution,
    getReviewVersions: vi.fn(async () => ({ versions })),
    getUpdateStatus: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    isWindowFullScreen: vi.fn(async () => false),
    onConfigChanged: vi.fn(() => unsubscribe),
    onCopyPendingCommentsRequest: vi.fn(() => unsubscribe),
    onFindInDiffs: vi.fn(() => unsubscribe),
    onNarrativeWalkthroughUpdated: vi.fn(() => unsubscribe),
    onOpenReviewSource: vi.fn(() => unsubscribe),
    onRefreshRequest: vi.fn(() => unsubscribe),
    onRepositoryChanged: vi.fn(() => unsubscribe),
    onReviewVersionEvolutionProgress: vi.fn((listener) => {
      progressListener = listener;
      return unsubscribe;
    }),
    onUpdateStatusChanged: vi.fn(() => unsubscribe),
    onWalkthroughProgress: vi.fn(() => unsubscribe),
    onWindowFullScreenChanged: vi.fn(() => unsubscribe),
    openRepositoryFolder: vi.fn(async () => {}),
    resolvePullRequestUrl: vi.fn(async (value: string) => value),
  } as unknown as Window['codiff'];
  const file = createChangedFile('src/version.ts');
  const pullRequestState = {
    ...state,
    files: [file],
    source: {
      headSha: afterSha,
      number: 42,
      provider: 'github',
      targetBranch: 'main',
      title: 'Review versions',
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
      launchOptions={{ repositoryPathProvided: true, walkthrough: false }}
    />,
  );

  try {
    await waitFor(() => {
      const button = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
        ({ textContent }) => textContent?.trim() === 'Compare versions',
      );
      expect(button?.disabled).toBe(false);
    });
    const compareVersions = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
      ({ textContent }) => textContent?.trim() === 'Compare versions',
    )!;
    await act(async () => compareVersions.click());
    await waitFor(() => expect(getReviewVersionAggregate).toHaveBeenCalledOnce());
    expect(getReviewVersionEvolution).toHaveBeenCalledOnce();
    const aggregateRequest = getReviewVersionAggregate.mock.calls[0]![0];
    expect(aggregateRequest).toMatchObject({
      fromVersionId: versions[0].versionId,
      source: pullRequestState.source,
      toVersionId: versions[1].versionId,
    });
    expect(getReviewVersionEvolution.mock.calls[0]![0]).toEqual(aggregateRequest);

    await act(async () => {
      progressListener?.({
        progress: { message: 'Matching commit evidence', phase: 'reading-mr-evidence' },
        requestId: aggregateRequest.requestId!,
      });
    });
    expect(view.container.textContent).toContain('Matching commit evidence');

    const compareTarget = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
      ({ textContent }) => textContent?.includes('Compare to main'),
    );
    await act(async () => compareTarget?.click());
    expect(cancelReviewVersionEvolution).toHaveBeenCalledWith(aggregateRequest.requestId);
  } finally {
    await view.cleanup();
  }
});

test('reports first usable before initial history and deferred completion after it', async () => {
  const history = deferred<RepositoryHistory>();
  const getRepositoryHistory = vi.fn(() => history.promise);
  const reportInitialLoadMilestone = vi.fn();
  window.codiff = {
    ...createVersionBridge(),
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
    ...createVersionBridge(),
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
    ...createVersionBridge(),
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
    ...createVersionBridge(),
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
    ...createVersionBridge(),
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
