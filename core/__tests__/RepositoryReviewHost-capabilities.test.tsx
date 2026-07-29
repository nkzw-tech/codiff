/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { beforeEach, expect, test, vi } from 'vite-plus/test';
import type { CodiffConfig } from '../config/types.ts';
import { parseWalkthroughModel } from '../lib/narrative-walkthrough-schema.ts';
import {
  resolveRepositoryReviewBootstrap,
  type RepositoryReviewBootstrap,
} from '../lib/repository-review-bootstrap.ts';
import type { ReviewSurfaceProps } from '../SharedWalkthroughApp.tsx';
import type {
  CodiffLaunchOptions,
  DiffSectionsContentResult,
  GitSha,
  NarrativeWalkthrough,
  NarrativeWalkthroughResult,
  RepositoryHistory,
  RepositoryState,
  ReviewContextRequest,
  ResolvedReviewSource,
  WalkthroughProgressEvent,
} from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

const surfaceProps = vi.hoisted(() => vi.fn());
const writeReloadSelection = vi.hoisted(() => vi.fn());

vi.mock('../SharedWalkthroughApp.tsx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../SharedWalkthroughApp.tsx')>()),
  ReviewSurface: (props: ReviewSurfaceProps) => {
    surfaceProps(props);
    return <div data-testid="review-surface">{props.capabilities?.desktop?.beforeContent}</div>;
  },
}));

vi.mock('../lib/reload-selection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/reload-selection.ts')>()),
  writeReloadSelection,
}));

import { RepositoryReviewHost } from '../app/RepositoryReviewHost.tsx';
import { createDefaultConfig } from '../config/defaults.ts';

const createMemoryStorage = () => {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: createMemoryStorage(),
});

beforeEach(() => {
  window.localStorage.clear();
});

const unsubscribe = () => {};
const gitSha = (character: string) => character.repeat(40) as GitSha;
const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
};

const stateFor = (
  source: ResolvedReviewSource,
  files: RepositoryState['files'] = [],
): RepositoryState => ({
  branch: 'main',
  files,
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source,
});

const installWindowApi = (overrides: Record<string, unknown> = {}) => {
  let findInDiffs: (() => void) | null = null;
  let copyPendingComments: (() => string | Promise<string>) | null = null;
  let refreshRequest: (() => void) | null = null;
  let repositoryChanged: (() => void) | null = null;
  let walkthroughProgress: ((progress: WalkthroughProgressEvent) => void) | null = null;
  let windowFullScreenChanged: ((isFullScreen: boolean) => void) | null = null;
  const api = {
    applyUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    askReviewAssistant: vi.fn(async () => ({ reply: 'Checked.', status: 'ready' as const })),
    cancelDiffContentRequest: vi.fn(),
    cancelNarrativeWalkthrough: vi.fn(async () => {}),
    createWalkthroughCommit: vi.fn(async () => ({ status: 'committed' as const })),
    dismissUpdate: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    getDiffImageContent: vi.fn(async () => ({ reason: 'Not used.', status: 'unavailable' })),
    getDiffSectionContent: vi.fn(async (request: { kind: string; path: string }) => ({
      binary: false,
      id: `${request.path}:${request.kind}`,
      kind: request.kind,
      loadState: 'ready',
      patch: '@@ -1 +1 @@\n-old\n+new\n',
    })),
    getDiffSectionsContent: vi.fn(async () => ({ sections: [] })),
    getNarrativeWalkthrough: vi.fn(
      async (): Promise<NarrativeWalkthroughResult> => ({
        reason: 'Not used.',
        status: 'unavailable',
      }),
    ),
    getRepositoryHistory: vi.fn(
      async (): Promise<RepositoryHistory> => ({ entries: [], root: '/repo' }),
    ),
    getRepositoryState: vi.fn(async () => stateFor({ type: 'working-tree' })),
    getReviewComments: vi.fn(async () => []),
    getUpdateStatus: vi.fn(async () => ({ currentVersion: '0.0.0', phase: 'idle' as const })),
    isWindowFullScreen: vi.fn(async () => false),
    onCopyPendingCommentsRequest: vi.fn((callback: () => string | Promise<string>) => {
      copyPendingComments = callback;
      return unsubscribe;
    }),
    onFindInDiffs: vi.fn((callback: () => void) => {
      findInDiffs = callback;
      return unsubscribe;
    }),
    onNarrativeWalkthroughUpdated: vi.fn(() => unsubscribe),
    onOpenReviewSource: vi.fn(() => unsubscribe),
    onRefreshRequest: vi.fn((callback: () => void) => {
      refreshRequest = callback;
      return unsubscribe;
    }),
    onRepositoryChanged: vi.fn((callback: () => void) => {
      repositoryChanged = callback;
      return unsubscribe;
    }),
    onUpdateStatusChanged: vi.fn(() => unsubscribe),
    onWalkthroughCommitOutput: vi.fn(() => unsubscribe),
    onWalkthroughProgress: vi.fn((callback: (progress: WalkthroughProgressEvent) => void) => {
      walkthroughProgress = callback;
      return unsubscribe;
    }),
    onWindowFullScreenChanged: vi.fn((callback: (isFullScreen: boolean) => void) => {
      windowFullScreenChanged = callback;
      return unsubscribe;
    }),
    openConfigFile: vi.fn(async () => {}),
    openFile: vi.fn(async () => {}),
    openRepositoryFolder: vi.fn(async () => {}),
    reportInitialLoadMilestone: vi.fn(),
    resolvePullRequestUrl: vi.fn(async (value: string) => value),
    resolveReviewContext: vi.fn(async () => ({ reason: 'Not used.', status: 'unavailable' })),
    setDiffStyle: vi.fn(async () => {}),
    setShowOutdated: vi.fn(async () => {}),
    setWordWrap: vi.fn(async () => {}),
    shareWalkthrough: vi.fn(async () => ({ status: 'shared', url: 'https://example.test' })),
    submitPullRequestComment: vi.fn(async () => ({})),
    submitPullRequestReview: vi.fn(async () => ({ status: 'submitted', submittedDraftIds: [] })),
    updateWalkthroughCommitMessage: vi.fn(async () => ({ status: 'unavailable' })),
    ...overrides,
  };
  window.codiff = api as unknown as Window['codiff'];
  return {
    api,
    copyPendingComments: () => copyPendingComments,
    findInDiffs: () => findInDiffs,
    refreshRequest: () => refreshRequest,
    repositoryChanged: () => repositoryChanged,
    walkthroughProgress: () => walkthroughProgress,
    windowFullScreenChanged: () => windowFullScreenChanged,
  };
};

type RenderHostOptions = {
  bootstrap?: Partial<RepositoryReviewBootstrap>;
  initialHistoryLoading?: boolean;
  initialWalkthroughFileError?: { path: string; reason: string } | null;
  initialWalkthroughLoading?: boolean;
  initialWalkthroughResult?: NarrativeWalkthroughResult;
  launchOptions?: CodiffLaunchOptions;
};

const renderHost = async (
  state: RepositoryState,
  config = createDefaultConfig(),
  options: RenderHostOptions = {},
) => {
  const resolvedLaunchOptions = options.launchOptions ?? {
    repositoryPathProvided: true,
    walkthrough: false,
  };
  const bootstrap = {
    ...resolveRepositoryReviewBootstrap({
      launchOptions: resolvedLaunchOptions,
      reloadSelection: null,
      state,
    }),
    ...options.bootstrap,
  };
  const render = (nextConfig: CodiffConfig) => (
    <RepositoryReviewHost
      bootstrap={bootstrap}
      config={nextConfig}
      disableCodeViewWorkerPool
      gitIdentity={null}
      gitIdentityReady
      initialHistoryLoading={options.initialHistoryLoading}
      initialWalkthroughFileError={options.initialWalkthroughFileError}
      initialWalkthroughLoading={options.initialWalkthroughLoading}
      initialWalkthroughResult={options.initialWalkthroughResult}
      launchOptions={resolvedLaunchOptions}
      walkthroughSharingEnabled
    />
  );
  const view = await renderReact(render(config));
  return {
    ...view,
    rerenderConfig: (nextConfig: CodiffConfig) => view.rerender(render(nextConfig)),
  };
};

const walkthroughFor = (
  state: RepositoryState,
  title: string,
  agent: NarrativeWalkthrough['agent'] = 'codex',
): NarrativeWalkthrough => ({
  agent,
  chapters: [],
  focus: 'Review the generated change.',
  generatedAt: '2026-08-05T00:00:00.000Z',
  kind: 'narrative',
  repo: { branch: state.branch, root: state.root },
  source: state.source,
  support: [],
  title,
  version: 4,
});

const getSurfaceProps = () => {
  const props = surfaceProps.mock.lastCall?.[0] as ReviewSurfaceProps | undefined;
  expect(props).toBeDefined();
  return props!;
};
const getSurfaceWalkthrough = () => parseWalkthroughModel(getSurfaceProps().snapshot.walkthrough);

test('routes every resolved Electron review source through the shared surface', async () => {
  const sources = [
    { type: 'working-tree' },
    { baseSha: gitSha('a'), headSha: gitSha('b'), ref: 'feature', type: 'branch-diff' },
    {
      baseSha: gitSha('a'),
      headSha: gitSha('b'),
      ref: 'feature',
      type: 'branch-working-tree',
    },
    { base: 'main', head: 'feature', symmetric: true, type: 'range' },
    { sha: gitSha('c'), type: 'commit' },
    {
      headSha: gitSha('d'),
      number: 12,
      provider: 'github',
      type: 'pull-request',
      url: 'https://github.com/example/repo/pull/12',
    },
    {
      headSha: gitSha('e'),
      number: 23,
      projectPath: 'example/repo',
      provider: 'gitlab',
      type: 'pull-request',
      url: 'https://gitlab.example.com/example/repo/-/merge_requests/23',
    },
    {
      headSha: gitSha('f'),
      number: 24,
      type: 'pull-request',
      url: 'https://reviews.example.com/example/repo/24',
    },
  ] satisfies ReadonlyArray<ResolvedReviewSource>;

  for (const source of sources) {
    surfaceProps.mockClear();
    installWindowApi();
    const view = await renderHost(stateFor(source));
    try {
      await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
      const props = getSurfaceProps();
      expect(props.snapshot.repository.source).toEqual(source);
      expect(props.capabilities?.desktop).toBeDefined();
      expect(props.capabilities?.history?.currentSource).toEqual(source);
      expect(props.capabilities?.content?.onLoadSection).toEqual(expect.any(Function));
      const hasProviderDestination =
        source.type === 'pull-request' &&
        (source.provider === 'github' || source.provider === 'gitlab');
      expect(props.capabilities?.comments?.destination === 'provider').toBe(hasProviderDestination);
      expect(
        props.capabilities?.comments?.destination === 'provider' &&
          props.capabilities.comments.reviewSession != null,
      ).toBe(hasProviderDestination);
      expect(props.capabilities?.localReviewNotes != null).toBe(source.type !== 'pull-request');
      if (source.type === 'pull-request' && !hasProviderDestination) {
        expect(props.capabilities?.comments).toBeUndefined();
        expect(props.capabilities?.localReviewNotes).toBeUndefined();
      }
    } finally {
      await view.cleanup();
    }
  }
});

test('wires desktop commands, persistence, preferences, loading, and exact provider operations', async () => {
  surfaceProps.mockClear();
  writeReloadSelection.mockClear();
  const { api, copyPendingComments, findInDiffs } = installWindowApi();
  const config = createDefaultConfig();
  config.settings.reviewCommentsPrefix = 'Team review notes';
  config.settings.showOutdated = false;
  config.settings.wordWrap = true;
  const source = {
    headSha: gitSha('f'),
    number: 12,
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/example/repo/pull/12',
  } as const;
  const view = await renderHost(stateFor(source), config);

  try {
    await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
    const props = getSurfaceProps();
    const capabilities = props.capabilities!;
    const commandIds = capabilities.desktop?.commands?.map((command) => command.id) ?? [];
    expect(commandIds).toEqual(
      expect.arrayContaining([
        'copy-comments',
        'decrease-code-font-size',
        'increase-code-font-size',
        'open-config-file',
        'open-file',
        'reload',
        'reset-code-font-size',
        'toggle-diff-layout',
        'toggle-outdated-comments',
        'toggle-viewed',
      ]),
    );
    expect(
      capabilities.desktop?.commands?.find((command) => command.id === 'copy-comments')?.title,
    ).toBe('Copy Pending Review Comments');
    expect(
      capabilities.desktop?.commands?.find((command) => command.id === 'copy-comments-and-close')
        ?.title,
    ).toBe('Copy Pending Review Comments and Close');
    const imageRequest = { kind: 'pull-request' as const, path: 'image.png', source };
    await capabilities.content?.onLoadImageContent?.(imageRequest);
    expect(api.getDiffImageContent).toHaveBeenCalledWith({
      ...imageRequest,
      requestId: 'image:1',
    });
    const comments = capabilities.comments;
    expect(comments?.destination).toBe('provider');
    if (!comments || comments.destination !== 'provider') {
      throw new Error('Expected provider comment capabilities.');
    }
    expect(comments.authoring.onAsk).toEqual(expect.any(Function));
    expect(capabilities.desktop?.onOpenFile).toEqual(expect.any(Function));
    expect(capabilities.history).toBeDefined();
    expect(capabilities.walkthrough?.onShare).toEqual(expect.any(Function));

    const copyPacket = vi.fn(() => '# Pending provider packet');
    const bridge = {
      copyPendingComments: copyPacket,
      copyPendingCommentsLabel: 'Copy Pending Review Comments',
      getPersistenceState: () => ({ mode: 'tree' as const, selectedPath: 'src/provider.ts' }),
      openDiffSearch: vi.fn(),
    };
    await act(async () => props.onCommandBridgeChange?.(bridge));
    findInDiffs()?.();
    expect(bridge.openDiffSearch).toHaveBeenCalledTimes(1);
    expect(copyPendingComments()?.()).toBe('# Pending provider packet');
    expect(copyPacket).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('beforeunload'));
    expect(writeReloadSelection).toHaveBeenCalledWith(
      expect.objectContaining({ source }),
      'src/provider.ts',
      source,
      'review',
    );

    await capabilities.preferences?.wordWrap?.onChange(false);
    await capabilities.preferences?.outdatedVisibility?.onChange(true);
    expect(api.setWordWrap).toHaveBeenCalledWith(false);
    expect(api.setShowOutdated).toHaveBeenCalledWith(true);
    expect(capabilities.preferences?.wordWrap?.value).toBe(true);
    expect(capabilities.preferences?.outdatedVisibility?.value).toBe(false);
    expect(capabilities.preferences?.pendingCommentPrefix?.value).toBe('Team review notes');

    expect(comments).toMatchObject({
      anchorPolicy: 'provider-target',
      authoring: { canCreateInline: true, onAsk: expect.any(Function) },
      destination: 'provider',
      inline: { onSubmit: expect.any(Function) },
      reviewSession: {
        drafts: { onChange: expect.any(Function), value: expect.any(Array) },
        submit: expect.any(Function),
      },
    });
    expect(comments.general).toBeUndefined();

    const comment = {
      body: 'Submit this comment.',
      filePath: 'src/provider.ts',
      lineNumber: 1,
      localDraftId: 'provider-draft',
      position: {
        range: {
          base: { label: { kind: 'commit' as const, text: 'base' }, sha: gitSha('e') },
          head: { label: { kind: 'commit' as const, text: 'head' }, sha: gitSha('f') },
        },
      },
      side: 'additions' as const,
    };
    await comments.inline.onSubmit?.(comment);
    expect(api.submitPullRequestComment).toHaveBeenCalledWith({ comment, source });
    await comments.reviewSession?.submit({
      comments: [comment],
      outcome: 'request-changes',
      summary: 'Please address the inline feedback.',
    });
    expect(api.submitPullRequestReview).toHaveBeenCalledWith({
      body: 'Please address the inline feedback.',
      comments: [comment],
      event: 'REQUEST_CHANGES',
      source,
    });
  } finally {
    await view.cleanup();
  }
});

test('uses source-aware copy labels and default Markdown headings', async () => {
  for (const source of [
    { type: 'working-tree' } as const,
    {
      headSha: gitSha('f'),
      number: 12,
      provider: 'github',
      type: 'pull-request',
      url: 'https://github.com/example/repo/pull/12',
    } as const,
  ]) {
    surfaceProps.mockClear();
    installWindowApi();
    const view = await renderHost(stateFor(source));
    try {
      await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
      const capabilities = getSurfaceProps().capabilities!;
      const provider = source.type === 'pull-request';
      expect(
        capabilities.desktop?.commands?.find((command) => command.id === 'copy-comments')?.title,
      ).toBe(provider ? 'Copy Pending Review Comments' : 'Copy Review Notes');
      expect(capabilities.preferences?.pendingCommentPrefix?.value).toBe(
        provider ? '# Address these Pending Review Comments' : '# Address these Review Notes',
      );
    } finally {
      await view.cleanup();
    }
  }
});

test('asks the review assistant with the flushed note value supplied by the surface', async () => {
  surfaceProps.mockClear();
  const { api } = installWindowApi();
  const file = createChangedFile('src/immediate-ask.ts');
  const state = stateFor({ type: 'working-tree' }, [file]);
  const view = await renderHost(state);

  try {
    await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
    await act(async () => {
      getSurfaceProps().capabilities?.localReviewNotes?.onAsk?.({
        body: 'Check the just-flushed draft.',
        filePath: file.path,
        id: 'immediate-note',
        kind: 'local-note',
        lineNumber: 1,
        sectionId: file.sections[0]!.id,
        side: 'additions',
      });
    });
    expect(api.askReviewAssistant).toHaveBeenCalledWith({
      comment: {
        body: 'Check the just-flushed draft.',
        filePath: file.path,
        lineNumber: 1,
        sectionId: file.sections[0]!.id,
        side: 'additions',
      },
      source: state.source,
    });
  } finally {
    await view.cleanup();
  }
});

test('hydrates all ordinary provider files once after first usable render', async () => {
  surfaceProps.mockClear();
  const pending = deferred<DiffSectionsContentResult>();
  const getDiffSectionsContent = vi.fn(() => pending.promise);
  const { api } = installWindowApi({ getDiffSectionsContent });
  const source = {
    headSha: gitSha('b'),
    number: 12,
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/example/repo/pull/12',
  } as const;
  const files = ['src/first.ts', 'src/second.ts'].map((path) => {
    const file = createChangedFile(path, { kind: 'pull-request' });
    return {
      ...file,
      sections: file.sections.map((section) => ({
        ...section,
        loadState: 'deferred' as const,
        summary: { canLoad: true, reason: 'Exact contents are queued.' },
      })),
    };
  });
  const view = await renderHost(stateFor(source, files));

  try {
    await waitFor(() => expect(getDiffSectionsContent).toHaveBeenCalledTimes(1));
    expect(getDiffSectionsContent).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^bulk-sections:/),
      source,
    });
    expect(api.reportInitialLoadMilestone).toHaveBeenCalledWith('first-usable-review-rendered');
    expect(api.reportInitialLoadMilestone).not.toHaveBeenCalledWith(
      'deferred-review-data-complete',
    );
    expect(api.reportInitialLoadMilestone.mock.invocationCallOrder[0]).toBeLessThan(
      getDiffSectionsContent.mock.invocationCallOrder[0]!,
    );

    await act(async () => {
      pending.resolve({
        headSha: source.headSha,
        sections: files.map((file) => ({
          path: file.path,
          section: {
            ...file.sections[0]!,
            loadState: 'ready',
            newFile: { contents: `new ${file.path}`, name: file.path },
            oldFile: { contents: `old ${file.path}`, name: file.path },
          },
        })),
      });
      await pending.promise;
    });
    await waitFor(() =>
      expect(
        getSurfaceProps().snapshot.files.every((file) => file.sections[0]?.loadState === 'ready'),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(api.reportInitialLoadMilestone).toHaveBeenCalledWith('deferred-review-data-complete'),
    );
    expect(getDiffSectionsContent).toHaveBeenCalledTimes(1);
  } finally {
    await view.cleanup();
  }
});

test('turns bulk provider failures into explicit retryable file evidence', async () => {
  surfaceProps.mockClear();
  const getDiffSectionsContent = vi.fn(async () => {
    throw new Error('Git object batch failed.');
  });
  const { api } = installWindowApi({ getDiffSectionsContent });
  const source = {
    headSha: gitSha('c'),
    number: 13,
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/example/repo/pull/13',
  } as const;
  const file = createChangedFile('src/retry.ts', { kind: 'pull-request' });
  const deferredFile = {
    ...file,
    sections: file.sections.map((section) => ({
      ...section,
      loadState: 'deferred' as const,
      summary: { canLoad: true, reason: 'Exact contents are queued.' },
    })),
  };
  const view = await renderHost(stateFor(source, [deferredFile]));

  try {
    await waitFor(() => {
      expect(getSurfaceProps().snapshot.files[0]?.sections[0]).toMatchObject({
        loadState: 'error',
        summary: {
          canLoad: true,
          reason: expect.stringContaining('Git object batch failed.'),
        },
      });
    });
    expect(getDiffSectionsContent).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(api.reportInitialLoadMilestone).toHaveBeenCalledWith('deferred-review-data-complete'),
    );
  } finally {
    await view.cleanup();
  }
});

test('cancels bulk hydration and discards its result after the source changes', async () => {
  surfaceProps.mockClear();
  const pending = deferred<DiffSectionsContentResult>();
  const getDiffSectionsContent = vi.fn((_request: { requestId?: string }) => pending.promise);
  const { api } = installWindowApi({ getDiffSectionsContent });
  const source = {
    headSha: gitSha('d'),
    number: 14,
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/example/repo/pull/14',
  } as const;
  const file = createChangedFile('src/stale-provider.ts', { kind: 'pull-request' });
  const deferredFile = {
    ...file,
    sections: file.sections.map((section) => ({
      ...section,
      loadState: 'deferred' as const,
      summary: { canLoad: true, reason: 'Exact contents are queued.' },
    })),
  };
  const nextSource = { sha: gitSha('e'), type: 'commit' } as const;
  const nextRequest = { ref: nextSource.sha, type: 'commit' } as const;
  api.getRepositoryState.mockResolvedValueOnce(
    stateFor(nextSource, [createChangedFile('src/current.ts', { kind: 'commit' })]),
  );
  const view = await renderHost(stateFor(source, [deferredFile]));

  try {
    await waitFor(() => expect(getDiffSectionsContent).toHaveBeenCalledTimes(1));
    const requestId = getDiffSectionsContent.mock.calls[0]![0].requestId;
    await act(async () => getSurfaceProps().capabilities?.history?.onSelectSource(nextRequest));
    await waitFor(() => expect(getSurfaceProps().snapshot.repository.source).toEqual(nextSource));
    expect(api.cancelDiffContentRequest).toHaveBeenCalledWith(requestId);

    await act(async () => {
      pending.resolve({
        headSha: source.headSha,
        sections: [
          {
            path: deferredFile.path,
            section: { ...deferredFile.sections[0]!, loadState: 'ready' },
          },
        ],
      });
      await pending.promise;
    });
    expect(getSurfaceProps().snapshot.files.map(({ path }) => path)).toEqual(['src/current.ts']);
  } finally {
    await view.cleanup();
  }
});

test('loads deferred section content for supported Electron sources', async () => {
  surfaceProps.mockClear();
  const { api } = installWindowApi();
  const file = createChangedFile('src/local.ts');
  const deferredFile = {
    ...file,
    sections: file.sections.map((section) => ({
      ...section,
      loadState: 'deferred' as const,
      summary: { canLoad: true, reason: 'Load local contents.' },
    })),
  };
  const view = await renderHost(stateFor({ type: 'working-tree' }, [deferredFile]));

  try {
    await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
    await waitFor(() => expect(api.getDiffSectionContent).toHaveBeenCalledTimes(1));
    expect(api.getDiffSectionContent).toHaveBeenCalledWith({
      force: true,
      kind: 'unstaged',
      path: 'src/local.ts',
      requestId: 'section:1',
      showWhitespace: false,
      source: { type: 'working-tree' },
    });
    await waitFor(() =>
      expect(getSurfaceProps().capabilities?.content?.itemVersionByKey).toEqual({
        'src/local.ts': 1,
      }),
    );
  } finally {
    await view.cleanup();
  }
});

test('cancels active immutable review context work on unmount', async () => {
  surfaceProps.mockClear();
  const cancelDiffContentRequest = vi.fn();
  const resolveReviewContext = vi.fn(
    (_request: ReviewContextRequest, _requestId?: string) => new Promise(() => {}),
  );
  installWindowApi({ cancelDiffContentRequest, resolveReviewContext });
  const source = {
    headSha: gitSha('b'),
    number: 12,
    owner: 'example',
    provider: 'github',
    repo: 'repo',
    type: 'pull-request',
    url: 'https://github.com/example/repo/pull/12',
  } as const;
  const view = await renderHost(stateFor(source));
  await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
  const request = {
    baseSha: gitSha('a'),
    filePath: 'src/context.ts',
    headSha: source.headSha,
    range: {
      base: { label: { kind: 'commit', text: 'base' }, sha: gitSha('a') },
      head: { label: { kind: 'commit', text: 'head' }, sha: source.headSha },
    },
    source,
    status: 'modified',
  } satisfies ReviewContextRequest;

  void getSurfaceProps().capabilities?.content?.resolveReviewContext?.(request);
  await waitFor(() => expect(resolveReviewContext).toHaveBeenCalledOnce());
  const requestId = resolveReviewContext.mock.calls[0]![1];
  expect(requestId).toMatch(/^context:/);
  await view.cleanup();
  expect(cancelDiffContentRequest).toHaveBeenCalledWith(requestId);
});

test('bumps the mounted review key when deferred loading fails', async () => {
  surfaceProps.mockClear();
  const { api } = installWindowApi();
  api.getDiffSectionContent.mockRejectedValueOnce(new Error('content unavailable'));
  const file = createChangedFile('src/failure.ts');
  const deferredFile = {
    ...file,
    sections: file.sections.map((section) => ({
      ...section,
      loadState: 'deferred' as const,
      summary: { canLoad: true, reason: 'Load local contents.' },
    })),
  };
  const view = await renderHost(stateFor({ type: 'working-tree' }, [deferredFile]));

  try {
    await waitFor(() => expect(api.getDiffSectionContent).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(getSurfaceProps().capabilities?.content?.itemVersionByKey).toEqual({
        'src/failure.ts': 1,
      }),
    );
  } finally {
    await view.cleanup();
  }
});

test('shows the repository-change banner without reading repository state', async () => {
  surfaceProps.mockClear();
  const { api, repositoryChanged } = installWindowApi();
  const view = await renderHost(
    stateFor({ type: 'working-tree' }, [createChangedFile('src/notification.ts')]),
  );
  api.getRepositoryState.mockClear();

  try {
    await waitFor(() => expect(repositoryChanged()).toEqual(expect.any(Function)));
    await act(async () => repositoryChanged()?.());
    await waitFor(() =>
      expect(view.container.querySelector('.repository-change-banner.visible')).not.toBeNull(),
    );
    expect(api.getRepositoryState).not.toHaveBeenCalled();
  } finally {
    await view.cleanup();
  }
});

test('forwards initial and refresh-calculated reload deltas', async () => {
  surfaceProps.mockClear();
  const { api, refreshRequest } = installWindowApi();
  const initialFile = createChangedFile('src/reload.ts', { fingerprint: 'before' });
  const refreshedFile = createChangedFile('src/reload.ts', { fingerprint: 'after' });
  api.getRepositoryState.mockResolvedValueOnce(stateFor({ type: 'working-tree' }, [refreshedFile]));
  const view = await renderHost(stateFor({ type: 'working-tree' }, [initialFile]), undefined, {
    bootstrap: { reloadDeltaPaths: new Set(['src/initial.ts']) },
  });

  try {
    await waitFor(() =>
      expect(getSurfaceProps().capabilities?.desktop?.reloadDeltaPaths).toEqual(
        new Set(['src/initial.ts']),
      ),
    );
    await waitFor(() => expect(refreshRequest()).toEqual(expect.any(Function)));
    await act(async () => refreshRequest()?.());
    await waitFor(() =>
      expect(getSurfaceProps().capabilities?.desktop?.reloadDeltaPaths).toEqual(
        new Set(['src/reload.ts']),
      ),
    );
  } finally {
    await view.cleanup();
  }
});

test('refreshes repository and History state atomically', async () => {
  surfaceProps.mockClear();
  const { api, refreshRequest } = installWindowApi();
  const initialState = stateFor({ type: 'working-tree' }, [createChangedFile('src/before.ts')]);
  const refreshedState = stateFor({ type: 'working-tree' }, [createChangedFile('src/after.ts')]);
  const historyEntry = {
    author: 'Ada Lovelace',
    committedAt: Date.now(),
    parentShas: [],
    sha: gitSha('d'),
    subject: 'Refresh atomically',
  };
  api.getRepositoryState.mockResolvedValueOnce(refreshedState);
  api.getRepositoryHistory.mockResolvedValueOnce({ entries: [historyEntry], root: '/repo' });
  const view = await renderHost(initialState);

  try {
    await waitFor(() => expect(refreshRequest()).toEqual(expect.any(Function)));
    await act(async () => refreshRequest()?.());
    await waitFor(() => {
      const props = getSurfaceProps();
      expect(props.snapshot.files.map((file) => file.path)).toEqual(['src/after.ts']);
      expect(props.capabilities?.history?.entries).toEqual([historyEntry]);
    });
  } finally {
    await view.cleanup();
  }
});

test('expands changed viewed files while leaving unchanged viewed files collapsed', async () => {
  surfaceProps.mockClear();
  const { api, refreshRequest } = installWindowApi();
  const changed = createChangedFile('src/changed-viewed.ts', { fingerprint: 'before' });
  const unchanged = createChangedFile('src/unchanged-viewed.ts', { fingerprint: 'stable' });
  const initialState = stateFor({ type: 'working-tree' }, [changed, unchanged]);
  const refreshedState = stateFor({ type: 'working-tree' }, [
    { ...changed, fingerprint: 'after' },
    unchanged,
  ]);
  api.getRepositoryState.mockResolvedValueOnce(refreshedState);
  const view = await renderHost(initialState);

  try {
    await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
    await act(async () => {
      getSurfaceProps().capabilities?.desktop?.onCollapsedChange?.(
        new Set([changed.path, unchanged.path]),
      );
    });
    await waitFor(() =>
      expect(getSurfaceProps().capabilities?.desktop?.collapsed).toEqual(
        new Set([changed.path, unchanged.path]),
      ),
    );
    await act(async () => refreshRequest()?.());
    await waitFor(() =>
      expect(getSurfaceProps().capabilities?.desktop?.collapsed).toEqual(new Set([unchanged.path])),
    );
  } finally {
    await view.cleanup();
  }
});

test('a newer refresh supersedes the previous walkthrough regeneration', async () => {
  surfaceProps.mockClear();
  const { api, refreshRequest } = installWindowApi();
  const initialState = stateFor({ type: 'working-tree' }, [createChangedFile('src/initial.ts')]);
  const firstState = stateFor({ type: 'working-tree' }, [createChangedFile('src/first.ts')]);
  const secondState = stateFor({ type: 'working-tree' }, [createChangedFile('src/second.ts')]);
  const firstWalkthrough = deferred<NarrativeWalkthroughResult>();
  const secondWalkthrough = deferred<NarrativeWalkthroughResult>();
  api.getRepositoryState.mockResolvedValueOnce(firstState).mockResolvedValueOnce(secondState);
  api.getNarrativeWalkthrough
    .mockImplementationOnce(() => firstWalkthrough.promise)
    .mockImplementationOnce(() => secondWalkthrough.promise);
  const view = await renderHost(initialState, undefined, {
    initialWalkthroughResult: {
      status: 'ready',
      walkthrough: walkthroughFor(initialState, 'Initial walkthrough'),
    },
  });

  try {
    await waitFor(() => expect(refreshRequest()).toEqual(expect.any(Function)));
    await act(async () => refreshRequest()?.());
    await waitFor(() => expect(api.getNarrativeWalkthrough).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(getSurfaceProps().snapshot.files.map((file) => file.path)).toEqual(['src/first.ts']),
    );
    await act(async () => refreshRequest()?.());
    await waitFor(() => expect(api.getNarrativeWalkthrough).toHaveBeenCalledTimes(2));

    await act(async () => {
      firstWalkthrough.resolve({
        status: 'ready',
        walkthrough: walkthroughFor(firstState, 'Stale walkthrough'),
      });
      await firstWalkthrough.promise;
    });
    await act(async () => {
      secondWalkthrough.resolve({
        status: 'ready',
        walkthrough: walkthroughFor(secondState, 'Current walkthrough'),
      });
      await secondWalkthrough.promise;
    });
    await waitFor(() => expect(getSurfaceWalkthrough().title).toBe('Current walkthrough'));
  } finally {
    await view.cleanup();
  }
});

test('refresh exits commit mode for an empty tree and allows a new walkthrough after editing', async () => {
  surfaceProps.mockClear();
  const { api, refreshRequest } = installWindowApi();
  const initialState = stateFor({ type: 'working-tree' }, [createChangedFile('src/committed.ts')]);
  const emptyState = stateFor({ type: 'working-tree' });
  const editedState = stateFor({ type: 'working-tree' }, [createChangedFile('src/edited.ts')]);
  api.getRepositoryState.mockResolvedValueOnce(emptyState).mockResolvedValueOnce(editedState);
  const view = await renderHost(initialState, undefined, {
    bootstrap: { mainMode: 'commit' },
    initialWalkthroughResult: {
      status: 'ready',
      walkthrough: walkthroughFor(initialState, 'Committed walkthrough'),
    },
  });

  try {
    await waitFor(() => expect(getSurfaceProps().capabilities?.desktop?.commit?.open).toBe(true));
    await act(async () => refreshRequest()?.());
    await waitFor(() => expect(getSurfaceProps().capabilities?.desktop?.commit).toBeUndefined());

    await act(async () => refreshRequest()?.());
    await waitFor(() =>
      expect(getSurfaceProps().snapshot.files.map((file) => file.path)).toEqual(['src/edited.ts']),
    );
    api.getNarrativeWalkthrough.mockClear();
    await act(async () => getSurfaceProps().activeMode?.onChange('walkthrough'));
    await waitFor(() => expect(api.getNarrativeWalkthrough).toHaveBeenCalledTimes(1));
  } finally {
    await view.cleanup();
  }
});

test('uses the bootstrap mode and one-shot scroll target as controlled surface state', async () => {
  surfaceProps.mockClear();
  installWindowApi();
  const files = [createChangedFile('src/first.ts'), createChangedFile('src/restored.ts')];
  const view = await renderHost(stateFor({ type: 'working-tree' }, files), undefined, {
    bootstrap: {
      initialScrollTarget: {
        behavior: 'instant',
        path: 'src/restored.ts',
        request: 1,
      },
      selectedPath: 'src/restored.ts',
      sidebarMode: 'history',
    },
  });

  try {
    await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
    const props = getSurfaceProps();
    expect(props.activeMode?.value).toBe('history');
    expect(props).not.toHaveProperty('initialMode');
    expect(props.capabilities?.content?.initialScrollTarget).toEqual({
      behavior: 'instant',
      path: 'src/restored.ts',
      request: 1,
    });
    expect(props.capabilities?.preferences?.selectedPath?.value).toBe('src/restored.ts');
  } finally {
    await view.cleanup();
  }
});

test('keeps desktop file state, fullscreen state, and active walkthrough targets controlled', async () => {
  surfaceProps.mockClear();
  const { api, windowFullScreenChanged } = installWindowApi();
  const firstFile = createChangedFile('src/first.ts');
  const activeFile = createChangedFile('src/active.ts');
  const state = stateFor({ type: 'working-tree' }, [firstFile, activeFile]);
  const view = await renderHost(state, undefined, {
    bootstrap: { sidebarMode: 'walkthrough' },
    initialWalkthroughResult: { status: 'ready', walkthrough: walkthroughFor(state, 'Ready') },
  });

  try {
    await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
    expect(getSurfaceProps().capabilities?.desktop).toMatchObject({
      collapsed: new Set(),
      isWindowFullscreen: false,
      viewed: {},
    });

    await act(async () => {
      getSurfaceProps().capabilities?.desktop?.onCollapsedChange?.(new Set(['src/active.ts']));
      getSurfaceProps().capabilities?.desktop?.onViewedChange?.({
        'src/active.ts': activeFile.fingerprint,
      });
    });
    await waitFor(() =>
      expect(getSurfaceProps().capabilities?.desktop).toMatchObject({
        collapsed: new Set(['src/active.ts']),
        viewed: { 'src/active.ts': activeFile.fingerprint },
      }),
    );

    await waitFor(() => expect(windowFullScreenChanged()).toEqual(expect.any(Function)));
    await act(async () => windowFullScreenChanged()?.(true));
    await waitFor(() =>
      expect(getSurfaceProps().capabilities?.desktop?.isWindowFullscreen).toBe(true),
    );

    await act(async () => {
      getSurfaceProps().capabilities?.desktop?.onActiveWalkthroughReviewTargetChange?.({
        file: activeFile,
        reviewIdentity: { fingerprint: activeFile.fingerprint, key: 'walkthrough:active' },
      });
      getSurfaceProps().capabilities?.desktop?.onOpenSelectedFile?.();
    });
    expect(api.openFile).toHaveBeenCalledWith('src/active.ts');
  } finally {
    await view.cleanup();
  }
});

test('cancels active walkthrough work when History switches sources', async () => {
  surfaceProps.mockClear();
  const { api, walkthroughProgress } = installWindowApi();
  const sourceAState = stateFor({ type: 'working-tree' }, [createChangedFile('src/a.ts')]);
  const sourceB = { sha: gitSha('b'), type: 'commit' } as const;
  const sourceBRequest = { ref: gitSha('b'), type: 'commit' } as const;
  const sourceBState = stateFor(sourceB, [createChangedFile('src/b.ts')]);
  const pending = deferred<NarrativeWalkthroughResult>();
  api.getNarrativeWalkthrough.mockImplementationOnce(() => pending.promise);
  api.getRepositoryState.mockResolvedValueOnce(sourceBState);
  const view = await renderHost(sourceAState);

  try {
    await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
    await act(async () => {
      void getSurfaceProps().capabilities?.walkthrough?.onGenerate?.();
      await Promise.resolve();
    });
    expect(api.getNarrativeWalkthrough).toHaveBeenCalledWith({ type: 'working-tree' }, undefined);
    await act(async () =>
      walkthroughProgress()?.({
        generation: { phase: 'generating', summary: 'Source A progress.' },
      }),
    );
    expect(getSurfaceProps().capabilities?.walkthrough?.generationProgress?.summary).toBe(
      'Source A progress.',
    );

    await act(async () => getSurfaceProps().capabilities?.history?.onSelectSource(sourceBRequest));
    expect(api.cancelNarrativeWalkthrough).toHaveBeenCalledOnce();
    await waitFor(() => expect(getSurfaceProps().snapshot.repository.source).toEqual(sourceB));

    await act(async () =>
      walkthroughProgress()?.({
        generation: { phase: 'generating', summary: 'Stale source A progress.' },
        phase: 'response-received',
      }),
    );
    expect(getSurfaceProps().capabilities?.walkthrough?.generationProgress?.summary).toBe(
      'Source A progress.',
    );

    await act(async () => {
      pending.resolve({
        status: 'ready',
        walkthrough: walkthroughFor(sourceAState, 'Stale source A walkthrough'),
      });
      await pending.promise;
    });
    expect(getSurfaceProps().snapshot.repository.source).toEqual(sourceB);
    expect(getSurfaceWalkthrough().title).not.toBe('Stale source A walkthrough');
    expect(getSurfaceProps().capabilities?.walkthrough).toMatchObject({
      status: 'idle',
      unread: false,
    });
  } finally {
    await view.cleanup();
  }
});

test('source selection without active generation skips main-process cancellation', async () => {
  surfaceProps.mockClear();
  const { api } = installWindowApi();
  const initialState = stateFor({ type: 'working-tree' }, [createChangedFile('src/initial.ts')]);
  const nextSource = { ref: gitSha('c'), type: 'commit' } as const;
  api.getRepositoryState.mockResolvedValueOnce(
    stateFor({ sha: gitSha('c'), type: 'commit' }, [createChangedFile('src/next.ts')]),
  );
  const view = await renderHost(initialState);

  try {
    await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
    await act(async () => getSurfaceProps().capabilities?.history?.onSelectSource(nextSource));
    await waitFor(() =>
      expect(getSurfaceProps().snapshot.repository.source).toEqual({
        sha: gitSha('c'),
        type: 'commit',
      }),
    );
    expect(api.cancelNarrativeWalkthrough).not.toHaveBeenCalled();
  } finally {
    await view.cleanup();
  }
});

test('same-source mode changes do not cancel active walkthrough generation', async () => {
  surfaceProps.mockClear();
  const pending = deferred<NarrativeWalkthroughResult>();
  const { api } = installWindowApi({
    getNarrativeWalkthrough: vi.fn(() => pending.promise),
  });
  const view = await renderHost(
    stateFor({ type: 'working-tree' }, [createChangedFile('src/current.ts')]),
  );

  try {
    await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
    await act(async () => {
      void getSurfaceProps().capabilities?.walkthrough?.onGenerate?.();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(getSurfaceProps().capabilities?.walkthrough?.status).toBe('generating'),
    );

    await act(async () => getSurfaceProps().activeMode?.onChange('walkthrough'));
    await act(async () => getSurfaceProps().activeMode?.onChange('tree'));
    await act(async () => getSurfaceProps().activeMode?.onChange('comments'));
    expect(api.cancelNarrativeWalkthrough).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ reason: 'Not used.', status: 'unavailable' });
      await pending.promise;
    });
  } finally {
    await view.cleanup();
  }
});

test('ignores a deferred History result after the review source changes', async () => {
  surfaceProps.mockClear();
  const firstHistory = deferred<RepositoryHistory>();
  const secondHistory = deferred<RepositoryHistory>();
  const { api } = installWindowApi({
    getRepositoryHistory: vi
      .fn()
      .mockImplementationOnce(() => firstHistory.promise)
      .mockImplementationOnce(() => secondHistory.promise),
  });
  const initialState = stateFor({ type: 'working-tree' }, [createChangedFile('src/initial.ts')]);
  const nextSource = {
    headSha: gitSha('d'),
    number: 42,
    owner: 'example',
    provider: 'github',
    repo: 'repo',
    type: 'pull-request',
    url: 'https://github.com/example/repo/pull/42',
  } as const;
  const nextSourceRequest = nextSource;
  const nextState = stateFor(nextSource, [createChangedFile('src/next.ts')]);
  api.getRepositoryState.mockResolvedValueOnce(nextState);
  const view = await renderHost(initialState, undefined, { initialHistoryLoading: true });

  try {
    await waitFor(() => expect(api.getRepositoryHistory).toHaveBeenCalledTimes(1));
    await act(async () =>
      getSurfaceProps().capabilities?.history?.onSelectSource(nextSourceRequest),
    );
    await waitFor(() => expect(api.getRepositoryHistory).toHaveBeenCalledTimes(2));

    await act(async () => {
      firstHistory.resolve({
        entries: [
          {
            author: 'Stale',
            committedAt: Date.now(),
            parentShas: [],
            sha: gitSha('a'),
            subject: 'Stale history',
          },
        ],
        root: '/repo',
      });
      await firstHistory.promise;
    });
    expect(getSurfaceProps().capabilities?.history?.entries).toEqual([]);

    const currentEntry = {
      author: 'Current',
      committedAt: Date.now(),
      parentShas: [],
      sha: gitSha('b'),
      subject: 'Current history',
    };
    await act(async () => {
      secondHistory.resolve({ entries: [currentEntry], root: '/repo' });
      await secondHistory.promise;
    });
    await waitFor(() =>
      expect(getSurfaceProps().capabilities?.history?.entries).toEqual([currentEntry]),
    );
  } finally {
    await view.cleanup();
  }
});

test('keeps provider and local drafts in their own History source sessions', async () => {
  surfaceProps.mockClear();
  const { api } = installWindowApi();
  const pullRequestSource = {
    headSha: gitSha('f'),
    number: 12,
    owner: 'example',
    provider: 'github',
    repo: 'repo',
    type: 'pull-request',
    url: 'https://github.com/example/repo/pull/12',
  } as const;
  const commitSha = gitSha('a');
  const commitRequest = { ref: commitSha, type: 'commit' } as const;
  const commitSource = { sha: commitSha, type: 'commit' } as const;
  const pullRequestState = stateFor(pullRequestSource, [createChangedFile('src/provider.ts')]);
  const commitState = stateFor(commitSource, [createChangedFile('src/commit.ts')]);
  api.getRepositoryState
    .mockResolvedValueOnce(commitState)
    .mockResolvedValueOnce(pullRequestState)
    .mockResolvedValueOnce(commitState);
  const view = await renderHost(pullRequestState);
  const providerDraft = {
    body: 'Keep this provider draft.',
    filePath: 'src/provider.ts',
    id: 'provider-draft',
    kind: 'provider-draft' as const,
    lineNumber: 1,
    position: {
      range: {
        base: { label: { kind: 'commit' as const, text: 'base' }, sha: gitSha('e') },
        head: { label: { kind: 'commit' as const, text: 'head' }, sha: gitSha('f') },
      },
    },
    sectionId: 'src/provider.ts:unstaged',
    side: 'additions' as const,
  };
  const localNote = {
    body: 'Keep this local commit note.',
    filePath: 'src/commit.ts',
    id: 'local-note',
    kind: 'local-note' as const,
    lineNumber: 1,
    sectionId: 'src/commit.ts:unstaged',
    side: 'additions' as const,
  };

  try {
    await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
    expect(getSurfaceProps().capabilities?.desktop).not.toHaveProperty('onRetargetToWorkingTree');
    const initialComments = getSurfaceProps().capabilities?.comments;
    expect(initialComments?.destination).toBe('provider');
    if (!initialComments || initialComments.destination !== 'provider') {
      throw new Error('Expected provider comment capabilities.');
    }
    await act(async () => initialComments.reviewSession?.drafts.onChange([providerDraft]));
    await waitFor(() => {
      const comments = getSurfaceProps().capabilities?.comments;
      expect(comments?.destination).toBe('provider');
      if (comments?.destination === 'provider') {
        expect(comments.reviewSession?.drafts.value).toContainEqual(providerDraft);
      }
    });

    await act(async () => getSurfaceProps().capabilities?.history?.onSelectSource(commitRequest));
    await waitFor(() => expect(getSurfaceProps().snapshot.repository.source).toEqual(commitSource));
    expect(getSurfaceProps().capabilities?.localReviewNotes).toBeDefined();
    expect(getSurfaceProps().capabilities?.localReviewNotes?.drafts?.value).toEqual([]);
    expect(getSurfaceProps().capabilities?.history?.pullRequestSource).toEqual(pullRequestSource);
    await act(async () =>
      getSurfaceProps().capabilities?.localReviewNotes?.drafts?.onChange([localNote]),
    );
    await waitFor(() =>
      expect(getSurfaceProps().capabilities?.localReviewNotes?.drafts?.value).toContainEqual(
        localNote,
      ),
    );

    await act(async () =>
      getSurfaceProps().capabilities?.history?.onSelectSource(pullRequestSource),
    );
    await waitFor(() =>
      expect(getSurfaceProps().snapshot.repository.source).toEqual(pullRequestSource),
    );
    const restoredProviderComments = getSurfaceProps().capabilities?.comments;
    expect(restoredProviderComments?.destination).toBe('provider');
    if (restoredProviderComments?.destination === 'provider') {
      expect(restoredProviderComments.reviewSession?.drafts.value).toContainEqual(providerDraft);
    }

    await act(async () => getSurfaceProps().capabilities?.history?.onSelectSource(commitRequest));
    await waitFor(() => expect(getSurfaceProps().snapshot.repository.source).toEqual(commitSource));
    expect(getSurfaceProps().capabilities?.localReviewNotes?.drafts?.value).toContainEqual(
      localNote,
    );
  } finally {
    await view.cleanup();
  }
});

test('keeps a newer walkthrough request active when an older request fails', async () => {
  surfaceProps.mockClear();
  const { api } = installWindowApi();
  const state = stateFor({ type: 'working-tree' }, [createChangedFile('src/retry.ts')]);
  const older = deferred<NarrativeWalkthroughResult>();
  const newer = deferred<NarrativeWalkthroughResult>();
  api.getNarrativeWalkthrough
    .mockImplementationOnce(() => older.promise)
    .mockImplementationOnce(() => newer.promise);
  const view = await renderHost(state);

  try {
    await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
    await act(async () => {
      void getSurfaceProps().capabilities?.walkthrough?.onGenerate?.();
      void getSurfaceProps().capabilities?.walkthrough?.onGenerate?.();
      await Promise.resolve();
    });
    expect(api.getNarrativeWalkthrough).toHaveBeenCalledTimes(2);

    await act(async () => {
      older.reject(new Error('stale failure'));
      await older.promise.catch(() => {});
    });
    expect(getSurfaceProps().capabilities?.walkthrough).toMatchObject({
      error: null,
      status: 'generating',
    });

    await act(async () => {
      newer.resolve({ status: 'ready', walkthrough: walkthroughFor(state, 'Newer result') });
      await newer.promise;
    });
    await waitFor(() => expect(getSurfaceProps().capabilities?.walkthrough?.status).toBe('ready'));
    expect(getSurfaceWalkthrough().title).toBe('Newer result');
  } finally {
    await view.cleanup();
  }
});

test('forwards complete agent-unavailable walkthrough metadata to the surface', async () => {
  for (const code of [
    'CODEX_NOT_FOUND',
    'CLAUDE_NOT_FOUND',
    'OPENCODE_NOT_FOUND',
    'PI_NOT_FOUND',
  ] as const) {
    surfaceProps.mockClear();
    installWindowApi();
    const state = stateFor({ type: 'working-tree' }, [createChangedFile(`src/${code}.ts`)]);
    const view = await renderHost(state, undefined, {
      bootstrap: { sidebarMode: 'walkthrough' },
      initialWalkthroughResult: {
        code,
        reason: `${code} unavailable.`,
        status: 'unavailable',
      },
    });
    try {
      await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
      expect(getSurfaceProps().capabilities?.walkthrough?.error).toMatchObject({
        code,
        reason: `${code} unavailable.`,
      });
    } finally {
      await view.cleanup();
    }
  }
});

test('marks background walkthrough completion unread until Walkthrough is activated', async () => {
  surfaceProps.mockClear();
  const { api } = installWindowApi();
  const state = stateFor({ type: 'working-tree' }, [createChangedFile('src/background.ts')]);
  const pending = deferred<NarrativeWalkthroughResult>();
  api.getNarrativeWalkthrough.mockImplementationOnce(() => pending.promise);
  const view = await renderHost(state);

  try {
    await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
    await act(async () => {
      getSurfaceProps().activeMode?.onChange('walkthrough');
      await Promise.resolve();
    });
    await waitFor(() => expect(api.getNarrativeWalkthrough).toHaveBeenCalledTimes(1));
    await act(async () => getSurfaceProps().activeMode?.onChange('tree'));
    await act(async () => {
      pending.resolve({ status: 'ready', walkthrough: walkthroughFor(state, 'Background ready') });
      await pending.promise;
    });
    await waitFor(() => expect(getSurfaceProps().capabilities?.walkthrough?.unread).toBe(true));

    await act(async () => getSurfaceProps().activeMode?.onChange('walkthrough'));
    await waitFor(() => expect(getSurfaceProps().capabilities?.walkthrough?.unread).toBe(false));
  } finally {
    await view.cleanup();
  }
});

test('does not mark walkthrough completion unread while Walkthrough remains active', async () => {
  surfaceProps.mockClear();
  const { api } = installWindowApi();
  const state = stateFor({ type: 'working-tree' }, [createChangedFile('src/foreground.ts')]);
  const pending = deferred<NarrativeWalkthroughResult>();
  api.getNarrativeWalkthrough.mockImplementationOnce(() => pending.promise);
  const view = await renderHost(state);

  try {
    await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
    await act(async () => {
      getSurfaceProps().activeMode?.onChange('walkthrough');
      await Promise.resolve();
    });
    await act(async () => {
      pending.resolve({ status: 'ready', walkthrough: walkthroughFor(state, 'Foreground ready') });
      await pending.promise;
    });
    await waitFor(() =>
      expect(getSurfaceProps().capabilities?.walkthrough).toMatchObject({
        status: 'ready',
        unread: false,
      }),
    );
  } finally {
    await view.cleanup();
  }
});

test('uses the configured agent for placeholder walkthroughs and honors launch overrides', async () => {
  const state = stateFor({ type: 'working-tree' });
  for (const agentBackend of ['codex', 'claude', 'opencode', 'pi'] as const) {
    surfaceProps.mockClear();
    installWindowApi();
    const config = createDefaultConfig();
    config.settings.agentBackend = agentBackend;
    const view = await renderHost(state, config);
    try {
      await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
      expect(getSurfaceWalkthrough().agent).toBe(agentBackend);
    } finally {
      await view.cleanup();
    }
  }

  surfaceProps.mockClear();
  installWindowApi();
  const config = createDefaultConfig();
  config.settings.agentBackend = 'codex';
  const view = await renderHost(state, config, {
    launchOptions: { agentBackend: 'claude', repositoryPathProvided: true, walkthrough: false },
  });
  try {
    await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
    expect(getSurfaceWalkthrough().agent).toBe('claude');

    const nextConfig = createDefaultConfig();
    nextConfig.settings.agentBackend = 'pi';
    await view.rerenderConfig(nextConfig);
    expect(getSurfaceWalkthrough().agent).toBe('claude');
  } finally {
    await view.cleanup();
  }

  surfaceProps.mockClear();
  installWindowApi();
  const configuredView = await renderHost(state, config);
  try {
    await waitFor(() => expect(surfaceProps).toHaveBeenCalled());
    const nextConfig = createDefaultConfig();
    nextConfig.settings.agentBackend = 'opencode';
    await configuredView.rerenderConfig(nextConfig);
    await waitFor(() => expect(getSurfaceWalkthrough().agent).toBe('opencode'));
  } finally {
    await configuredView.cleanup();
  }
});
test('applies non-whitespace config updates without reloading repository state', async () => {
  surfaceProps.mockClear();
  const { api } = installWindowApi();
  const state = stateFor({ type: 'working-tree' }, [createChangedFile('src/config.ts')]);
  const config = createDefaultConfig();
  const view = await renderHost(state, config);
  api.getRepositoryState.mockClear();

  try {
    const nextConfig = createDefaultConfig();
    nextConfig.settings.wordWrap = true;
    await view.rerenderConfig(nextConfig);
    await waitFor(() =>
      expect(getSurfaceProps().capabilities?.preferences?.wordWrap?.value).toBe(true),
    );
    expect(api.getRepositoryState).not.toHaveBeenCalled();
  } finally {
    await view.cleanup();
  }
});

test('reloads the exact active source once when showWhitespace changes', async () => {
  surfaceProps.mockClear();
  const { api } = installWindowApi();
  const source = {
    baseSha: gitSha('a'),
    headSha: gitSha('b'),
    ref: 'feature',
    type: 'branch-working-tree',
  } as const;
  const state = stateFor(source, [createChangedFile('src/whitespace.ts')]);
  api.getRepositoryState.mockResolvedValueOnce(state);
  const config = createDefaultConfig();
  const view = await renderHost(state, config);

  try {
    const nextConfig = createDefaultConfig();
    nextConfig.settings.showWhitespace = true;
    await view.rerenderConfig(nextConfig);
    await waitFor(() => expect(api.getRepositoryState).toHaveBeenCalledTimes(1));
    expect(api.getRepositoryState).toHaveBeenCalledWith({
      ref: source.ref,
      type: 'branch-working-tree',
    });
  } finally {
    await view.cleanup();
  }
});

test('discards stale repository results from rapid showWhitespace changes', async () => {
  surfaceProps.mockClear();
  const { api } = installWindowApi();
  const initialState = stateFor({ type: 'working-tree' }, [createChangedFile('src/initial.ts')]);
  const staleState = stateFor({ type: 'working-tree' }, [createChangedFile('src/stale.ts')]);
  const currentState = stateFor({ type: 'working-tree' }, [createChangedFile('src/current.ts')]);
  const stale = deferred<RepositoryState>();
  const current = deferred<RepositoryState>();
  api.getRepositoryState
    .mockImplementationOnce(() => stale.promise)
    .mockImplementationOnce(() => current.promise);
  const view = await renderHost(initialState);

  try {
    const showWhitespace = createDefaultConfig();
    showWhitespace.settings.showWhitespace = true;
    await view.rerenderConfig(showWhitespace);
    const hideWhitespace = createDefaultConfig();
    hideWhitespace.settings.showWhitespace = false;
    await view.rerenderConfig(hideWhitespace);
    await waitFor(() => expect(api.getRepositoryState).toHaveBeenCalledTimes(2));

    await act(async () => {
      current.resolve(currentState);
      await current.promise;
    });
    await waitFor(() =>
      expect(getSurfaceProps().snapshot.files.map((file) => file.path)).toEqual(['src/current.ts']),
    );
    await act(async () => {
      stale.resolve(staleState);
      await stale.promise;
    });
    expect(getSurfaceProps().snapshot.files.map((file) => file.path)).toEqual(['src/current.ts']);
  } finally {
    await view.cleanup();
  }
});

test('keeps failed whitespace reloads recoverable without applying stale state', async () => {
  surfaceProps.mockClear();
  const { api } = installWindowApi();
  const initialState = stateFor({ type: 'working-tree' }, [createChangedFile('src/kept.ts')]);
  api.getRepositoryState.mockRejectedValueOnce(new Error('Reload failed.'));
  const view = await renderHost(initialState);

  try {
    const showWhitespace = createDefaultConfig();
    showWhitespace.settings.showWhitespace = true;
    await view.rerenderConfig(showWhitespace);
    await waitFor(() => expect(view.container.textContent).toContain('Reload failed.'));

    api.getRepositoryState.mockResolvedValueOnce(initialState);
    const hideWhitespace = createDefaultConfig();
    hideWhitespace.settings.showWhitespace = false;
    await view.rerenderConfig(hideWhitespace);
    await waitFor(() => expect(view.container.textContent).not.toContain('Reload failed.'));
    expect(getSurfaceProps().snapshot.files.map((file) => file.path)).toEqual(['src/kept.ts']);
  } finally {
    await view.cleanup();
  }
});

test('hydrates provider comments after first usable and ignores a superseded source result', async () => {
  surfaceProps.mockClear();
  const firstComments = deferred<
    ReadonlyArray<{
      author: { login: string };
      body: string;
      filePath: string;
      id: string;
      lineNumber: number;
      side: 'additions';
    }>
  >();
  const secondComments = deferred<
    ReadonlyArray<{
      author: { login: string };
      body: string;
      filePath: string;
      id: string;
      lineNumber: number;
      side: 'additions';
    }>
  >();
  const firstSource = {
    headSha: gitSha('a'),
    number: 12,
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/example/repo/pull/12',
  } as const;
  const secondSource = {
    headSha: gitSha('b'),
    number: 23,
    projectPath: 'example/repo',
    provider: 'gitlab',
    type: 'pull-request',
    url: 'https://gitlab.example.com/example/repo/-/merge_requests/23',
  } as const;
  const getReviewComments = vi.fn((source: ResolvedReviewSource, _requestId?: string) =>
    source.type === 'pull-request' && source.headSha === firstSource.headSha
      ? firstComments.promise
      : secondComments.promise,
  );
  const getRepositoryState = vi.fn(async () => ({
    ...stateFor(secondSource, [createChangedFile('src/second.ts')]),
    reviewComments: [],
    reviewCommentsLoadState: 'not-loaded' as const,
  }));
  installWindowApi({ getRepositoryState, getReviewComments });
  const view = await renderHost({
    ...stateFor(firstSource, [createChangedFile('src/first.ts')]),
    reviewComments: [],
    reviewCommentsLoadState: 'not-loaded',
  });

  try {
    await waitFor(() =>
      expect(getReviewComments).toHaveBeenCalledWith(
        firstSource,
        expect.stringMatching(/^review-comments:/),
      ),
    );
    expect(surfaceProps).toHaveBeenCalled();
    const initialProps = getSurfaceProps();
    expect(initialProps.snapshot.repository.source).toEqual(firstSource);
    expect(initialProps.snapshot.reviewComments ?? []).toEqual([]);

    await act(async () => initialProps.capabilities?.history?.onSelectSource(secondSource));
    await waitFor(() => expect(getRepositoryState).toHaveBeenCalledWith(secondSource));
    await waitFor(() => expect(getSurfaceProps().snapshot.repository.source).toEqual(secondSource));
    await waitFor(() =>
      expect(getReviewComments).toHaveBeenCalledWith(
        secondSource,
        expect.stringMatching(/^review-comments:/),
      ),
    );

    await act(async () => {
      firstComments.resolve([
        {
          author: { login: 'stale-reviewer' },
          body: 'Stale comment',
          filePath: 'src/first.ts',
          id: 'stale',
          lineNumber: 1,
          side: 'additions',
        },
      ]);
      await firstComments.promise;
    });
    expect(getSurfaceProps().snapshot.reviewComments ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'stale' })]),
    );

    await act(async () => {
      secondComments.resolve([
        {
          author: { login: 'current-reviewer' },
          body: 'Current comment',
          filePath: 'src/second.ts',
          id: 'current',
          lineNumber: 1,
          side: 'additions',
        },
      ]);
      await secondComments.promise;
    });
    await waitFor(() =>
      expect(getSurfaceProps().snapshot.reviewComments).toEqual([
        expect.objectContaining({ id: 'current' }),
      ]),
    );
  } finally {
    await view.cleanup();
  }
});

test('keeps provider comment hydration failures visible and retryable', async () => {
  surfaceProps.mockClear();
  const getReviewComments = vi
    .fn()
    .mockRejectedValueOnce(new Error('Provider comments are unavailable.'))
    .mockResolvedValueOnce([]);
  installWindowApi({ getReviewComments });
  const source = {
    headSha: gitSha('c'),
    number: 31,
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/example/repo/pull/31',
  } as const;
  const view = await renderHost({
    ...stateFor(source),
    reviewComments: [],
    reviewCommentsLoadState: 'not-loaded',
  });

  try {
    await waitFor(() =>
      expect(view.container.textContent).toContain('Provider comments are unavailable.'),
    );
    const retry = Array.from(view.container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Retry',
    );
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    await waitFor(() => expect(getReviewComments).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getSurfaceProps().snapshot.repository.source).toEqual(source));
    expect(view.container.textContent).not.toContain('Provider comments are unavailable.');
  } finally {
    await view.cleanup();
  }
});
