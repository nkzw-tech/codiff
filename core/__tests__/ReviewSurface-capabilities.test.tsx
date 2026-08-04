/**
 * @vitest-environment jsdom
 */

import { act, useState, type Dispatch, type SetStateAction } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, expectTypeOf, test, vi } from 'vite-plus/test';
import { createDefaultConfig } from '../config/defaults.ts';
import { getShortcutLabel } from '../config/keymap.ts';
import type { ReviewComment } from '../lib/app-types.ts';
import {
  buildSharedReviewSnapshot,
  ReviewSurface,
  type ProviderReviewCommentCapabilities,
  type ReviewSurfaceCommandBridge,
  type ReviewSurfaceProps,
  type ShareReviewCommentCapabilities,
} from '../SharedWalkthroughApp.tsx';
import type {
  CommitMetadata,
  HistoryEntry,
  NarrativeWalkthrough,
  RepositoryState,
  SharedWalkthroughSnapshot,
} from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { waitFor } from './helpers/react.tsx';

const reactActEnvironment = globalThis as typeof globalThis & {
  ResizeObserver?: typeof ResizeObserver;
};
reactActEnvironment.ResizeObserver ??= class ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
};
HTMLElement.prototype.scrollBy ??= function scrollBy() {};
HTMLElement.prototype.scrollIntoView ??= function scrollIntoView() {};
HTMLElement.prototype.scrollTo ??= function scrollTo() {};

const snapshot = {
  branch: 'main',
  codiffVersion: 'test',
  exportedAt: '2026-08-04T00:00:00.000Z',
  files: [createChangedFile('src/app.ts')],
  kind: 'codiff-walkthrough-share',
  preferences: {
    codeFontFamily: 'Fira Code',
    codeFontSize: 13,
    diffStyle: 'split',
    showWhitespace: false,
    theme: 'system',
    wordWrap: false,
  },
  repository: { root: '/repo', source: { type: 'working-tree' } },
  version: 1,
  walkthrough: {
    agent: 'codex',
    chapters: [],
    focus: 'Review capability boundaries.',
    generatedAt: '2026-08-04T00:00:00.000Z',
    kind: 'narrative',
    repo: { branch: 'main', root: '/repo' },
    source: { type: 'working-tree' },
    support: [],
    title: 'Capability review',
    version: 4,
  },
} satisfies SharedWalkthroughSnapshot;

const createShareComments = (
  overrides: Partial<ShareReviewCommentCapabilities> = {},
): ShareReviewCommentCapabilities => ({
  anchorPolicy: 'share-snapshot',
  authoring: {},
  destination: 'share',
  inline: {},
  ...overrides,
});

const createProviderComments = (
  overrides: Partial<ProviderReviewCommentCapabilities> = {},
): ProviderReviewCommentCapabilities => ({
  anchorPolicy: 'provider-target',
  authoring: {},
  destination: 'provider',
  inline: {},
  ...overrides,
});

const providerSnapshot = {
  ...snapshot,
  repository: {
    root: '/repo',
    source: {
      number: 7,
      owner: 'cloudflare',
      provider: 'github',
      repo: 'codiff',
      type: 'pull-request',
      url: 'https://github.com/cloudflare/codiff/pull/7',
    },
  },
  walkthrough: {
    ...snapshot.walkthrough,
    source: {
      number: 7,
      owner: 'cloudflare',
      provider: 'github',
      repo: 'codiff',
      type: 'pull-request',
      url: 'https://github.com/cloudflare/codiff/pull/7',
    },
  },
} satisfies SharedWalkthroughSnapshot;

type WithOptionalSnapshot<Props> = Props extends unknown
  ? Omit<Props, 'snapshot'> & { snapshot?: SharedWalkthroughSnapshot }
  : never;
type OptionalSnapshotProps = WithOptionalSnapshot<ReviewSurfaceProps>;

const renderSurface = async (props: OptionalSnapshotProps = {}) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (nextProps: OptionalSnapshotProps) => {
    const { snapshot: nextSnapshot = snapshot, ...rest } = nextProps;
    await act(async () => root.render(<ReviewSurface {...rest} snapshot={nextSnapshot} />));
  };
  await render(props);
  return {
    container,
    render,
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
};

const findButton = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === label,
  );

const findModeButton = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')).find((button) =>
    (button.getAttribute('aria-label') ?? button.textContent?.trim())?.startsWith(label),
  );

const openCommandBar = async () => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'p' }));
  });
};

test('omits modes and commands whose capabilities are absent', async () => {
  await using view = await renderSurface({
    initialMode: 'tree',
    keymap: { ...createDefaultConfig().keymap, commandBar: 'Ctrl+p' },
  });

  const modes = Array.from(view.container.querySelectorAll('[role="tab"]')).map((tab) =>
    tab.textContent?.trim(),
  );
  expect(modes).toEqual(['Walkthrough', 'Tree']);

  await openCommandBar();
  expect(view.container.querySelector('.command-bar')?.textContent).not.toContain('Host action');
});

test('keeps a controlled mode unchanged until its parent supplies a new value', async () => {
  const onModeChange = vi.fn();
  const history = {
    currentSource: { type: 'working-tree' } as const,
    entries: [],
    hasMore: false,
    loading: false,
    onLoadMore: vi.fn(),
    onSelectSource: vi.fn(),
  };
  await using view = await renderSurface({
    activeMode: { onChange: onModeChange, value: 'tree' },
    capabilities: { history },
  });

  await act(async () => findButton(view.container, 'History')?.click());
  expect(onModeChange).toHaveBeenCalledWith('history');
  expect(findButton(view.container, 'Tree')?.getAttribute('aria-selected')).toBe('true');
  expect(findButton(view.container, 'History')?.getAttribute('aria-selected')).toBe('false');

  await view.render({
    activeMode: { onChange: onModeChange, value: 'history' },
    capabilities: { history },
  });
  expect(findButton(view.container, 'Tree')?.getAttribute('aria-selected')).toBe('false');
  expect(findButton(view.container, 'History')?.getAttribute('aria-selected')).toBe('true');
});

test('uses initialMode only for a surface that owns its later mode changes', async () => {
  const history = {
    currentSource: { type: 'working-tree' } as const,
    entries: [],
    hasMore: false,
    loading: false,
    onLoadMore: vi.fn(),
    onSelectSource: vi.fn(),
  };
  await using view = await renderSurface({ capabilities: { history }, initialMode: 'history' });

  expect(findButton(view.container, 'History')?.getAttribute('aria-selected')).toBe('true');
  await act(async () => findButton(view.container, 'Tree')?.click());
  expect(findButton(view.container, 'Tree')?.getAttribute('aria-selected')).toBe('true');
});

test('rejects simultaneous controlled and uncontrolled mode inputs at the type boundary', () => {
  type ConflictingModeProps = {
    activeMode: { onChange: (mode: 'tree') => void; value: 'tree' };
    initialMode: 'history';
    snapshot: SharedWalkthroughSnapshot;
  };

  expectTypeOf<ConflictingModeProps>().not.toMatchTypeOf<ReviewSurfaceProps>();

  type ConflictingAnnotationProps = {
    capabilities: {
      comments: ShareReviewCommentCapabilities;
      localReviewNotes: { canCreateInline: true };
    };
    snapshot: SharedWalkthroughSnapshot;
  };
  expectTypeOf<ConflictingAnnotationProps>().not.toMatchTypeOf<ReviewSurfaceProps>();
});

test('exposes Comments through persisted-comment capabilities independent of source', async () => {
  await using local = await renderSurface({
    capabilities: { localReviewNotes: { canCreateInline: true } },
    initialMode: 'tree',
  });
  expect(findModeButton(local.container, 'Comments')).toBeUndefined();

  await using share = await renderSurface({
    capabilities: { comments: createShareComments() },
    initialMode: 'tree',
  });
  expect(findModeButton(share.container, 'Comments')).not.toBeUndefined();

  await using provider = await renderSurface({
    capabilities: { comments: createProviderComments() },
    initialMode: 'tree',
    snapshot: providerSnapshot,
  });
  expect(findModeButton(provider.container, 'Comments')).not.toBeUndefined();

  await using readOnly = await renderSurface({
    initialMode: 'tree',
    snapshot: {
      ...snapshot,
      reviewComments: [
        {
          author: { login: 'reviewer' },
          body: 'Existing read-only comment.',
          filePath: snapshot.files[0]!.path,
          id: 'existing-read-only',
          lineNumber: 1,
          side: 'additions',
        },
      ],
    },
  });
  expect(findModeButton(readOnly.container, 'Comments')).not.toBeUndefined();
});

test('composes implicit inline reply permission with the host reply capability', async () => {
  const file = snapshot.files[0]!;
  const comment = {
    author: { login: 'reviewer' },
    body: 'Reply to this existing thread.',
    filePath: file.path,
    id: 'existing-comment',
    lineNumber: 1,
    sectionId: file.sections[0]!.id,
    side: 'additions' as const,
    threadId: 'existing-thread',
  };
  const snapshotWithThread = {
    ...snapshot,
    reviewComments: [comment],
  } satisfies SharedWalkthroughSnapshot;
  const onSubmit = vi.fn(async () => {
    throw new Error('Not used by this test.');
  });
  const capabilities = {
    comments: createShareComments({
      authoring: { canCreateInline: true },
      inline: { onSubmit },
    }),
  };
  await using view = await renderSurface({
    capabilities,
    initialMode: 'tree',
    snapshot: snapshotWithThread,
  });

  await waitFor(() => expect(findButton(view.container, 'Reply')).not.toBeUndefined());

  await view.render({
    capabilities,
    initialMode: 'tree',
    snapshot: {
      ...snapshotWithThread,
      reviewComments: [{ ...comment, canReplyThread: false }],
    },
  });
  await waitFor(() => expect(findButton(view.container, 'Reply')).toBeUndefined());

  await view.render({
    capabilities: {
      comments: createShareComments({
        authoring: { canCreateInline: true },
        inline: {},
      }),
    },
    initialMode: 'tree',
    snapshot: snapshotWithThread,
  });
  await waitFor(() => expect(findButton(view.container, 'Reply')).toBeUndefined());
});

test('copies local notes with the local label and Markdown heading', async () => {
  const file = snapshot.files[0]!;
  const draft = {
    body: 'Keep this local note.',
    filePath: file.path,
    id: 'local-note',
    lineNumber: 1,
    sectionId: file.sections[0]!.id,
    side: 'additions',
  } satisfies ReviewComment;
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  const bridge = { current: null as ReviewSurfaceCommandBridge | null };
  await using view = await renderSurface({
    capabilities: {
      localReviewNotes: {
        drafts: { onChange: vi.fn(), value: [draft] },
      },
    },
    initialMode: 'tree',
    onCommandBridgeChange: (value) => {
      bridge.current = value;
    },
  });

  const copyButton = view.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Copy Review Notes"]',
  );
  expect(copyButton).not.toBeNull();
  expect(bridge.current?.copyPendingCommentsLabel).toBe('Copy Review Notes');
  const markdown = bridge.current?.copyPendingComments();
  expect(markdown).toContain('# Address these Review Notes');
  await act(async () => copyButton?.click());
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown));
});

test('copies provider drafts with the provider label and Markdown heading', async () => {
  const file = providerSnapshot.files[0]!;
  const draft = {
    body: 'Submit this provider draft.',
    filePath: file.path,
    id: 'provider-draft',
    lineNumber: 1,
    sectionId: file.sections[0]!.id,
    side: 'additions',
  } satisfies ReviewComment;
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  const bridge = { current: null as ReviewSurfaceCommandBridge | null };
  await using view = await renderSurface({
    capabilities: {
      comments: createProviderComments({
        authoring: { drafts: { onChange: vi.fn(), value: [draft] } },
      }),
    },
    initialMode: 'tree',
    onCommandBridgeChange: (value) => {
      bridge.current = value;
    },
    snapshot: providerSnapshot,
  });

  const copyButton = view.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Copy Pending Review Comments"]',
  );
  expect(copyButton).not.toBeNull();
  expect(bridge.current?.copyPendingCommentsLabel).toBe('Copy Pending Review Comments');
  const markdown = bridge.current?.copyPendingComments();
  expect(markdown).toContain('# Address these Pending Review Comments');
  await act(async () => copyButton?.click());
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown));
});

test('hides the persistent copy action while a desktop source switch is pending', async () => {
  const file = snapshot.files[0]!;
  await using view = await renderSurface({
    capabilities: {
      desktop: { isSwitchingSource: true },
      localReviewNotes: {
        drafts: {
          onChange: vi.fn(),
          value: [
            {
              body: 'Keep this note through the source switch.',
              filePath: file.path,
              id: 'switching-note',
              lineNumber: 1,
              sectionId: file.sections[0]!.id,
              side: 'additions',
            },
          ],
        },
      },
    },
    initialMode: 'tree',
  });

  expect(view.container.querySelector('.copy-comments-button')).toBeNull();
});

test('shows the configured sidebar shortcut in the collapse tooltip', async () => {
  const keymap = { ...createDefaultConfig().keymap, toggleSidebar: 'Alt+b' };
  await using view = await renderSurface({ initialMode: 'tree', keymap });
  const toggle = view.container.querySelector<HTMLButtonElement>('.sidebar-toggle-button');
  expect(toggle?.title).toBe(`Collapse sidebar (${getShortcutLabel(keymap, 'toggleSidebar')})`);
  await act(async () => toggle?.click());
  expect(toggle?.title).toBe(`Expand sidebar (${getShortcutLabel(keymap, 'toggleSidebar')})`);
});

test('filters History by author without showing synthetic scope rows or loading more', async () => {
  const entries = [
    {
      author: 'Ada Lovelace',
      committedAt: Date.now(),
      parentShas: [],
      sha: 'a'.repeat(40) as HistoryEntry['sha'],
      subject: 'Fix parser',
    },
    {
      author: 'Grace Hopper',
      committedAt: Date.now(),
      parentShas: [],
      sha: 'b'.repeat(40) as HistoryEntry['sha'],
      subject: 'Update docs',
    },
  ] satisfies ReadonlyArray<HistoryEntry>;
  const onLoadMore = vi.fn();
  await using view = await renderSurface({
    capabilities: {
      history: {
        currentSource: { type: 'working-tree' },
        entries,
        hasMore: true,
        loading: false,
        onLoadMore,
        onSelectSource: vi.fn(),
      },
    },
    initialMode: 'history',
  });
  const historySubjects = () =>
    Array.from(view.container.querySelectorAll('.history-entry-subject')).map(
      (element) => element.textContent,
    );
  expect(historySubjects()).toEqual(['Uncommitted changes', 'Fix parser', 'Update docs']);

  const input = view.container.querySelector<HTMLInputElement>('.sidebar-search');
  const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setInputValue?.call(input, 'grace');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(historySubjects()).toEqual(['Update docs']);
  await act(async () => {
    view.container.querySelector('.history-list')?.dispatchEvent(new Event('scroll'));
  });
  expect(onLoadMore).not.toHaveBeenCalled();
});

test('does not render a Back to Codiff action from desktop capabilities', async () => {
  await using view = await renderSurface({
    capabilities: { desktop: {} },
    initialMode: 'tree',
    snapshot: providerSnapshot,
  });

  expect(
    view.container.querySelector<HTMLButtonElement>('button[aria-label="Back to Codiff"]'),
  ).toBeNull();
});

test('preserves structured walkthrough failure metadata', async () => {
  await using view = await renderSurface({
    capabilities: {
      walkthrough: {
        error: { code: 'PI_NOT_FOUND', reason: 'Pi CLI was not found.' },
        status: 'failed',
      },
    },
    initialMode: 'walkthrough',
  });
  expect(view.container.textContent).toContain('Pi CLI was not found.');
});

test('renders tailored recovery for every unavailable agent executable', async () => {
  for (const { agent, code, displayLabel, reasonLabel } of [
    { agent: 'codex', code: 'CODEX_NOT_FOUND', displayLabel: 'Codex', reasonLabel: 'Codex' },
    {
      agent: 'claude',
      code: 'CLAUDE_NOT_FOUND',
      displayLabel: 'Claude Code',
      reasonLabel: 'Claude',
    },
    {
      agent: 'opencode',
      code: 'OPENCODE_NOT_FOUND',
      displayLabel: 'OpenCode',
      reasonLabel: 'OpenCode',
    },
    { agent: 'pi', code: 'PI_NOT_FOUND', displayLabel: 'Pi', reasonLabel: 'Pi' },
  ] as const) {
    await using view = await renderSurface({
      capabilities: {
        walkthrough: {
          error: { code, reason: `${reasonLabel} CLI was not found.` },
          status: 'failed',
        },
      },
      initialMode: 'walkthrough',
      snapshot: {
        ...snapshot,
        walkthrough: { ...snapshot.walkthrough, agent },
      },
    });

    expect(view.container.textContent).toContain(`${displayLabel} CLI not found`);
    expect(view.container.textContent).toContain(`${reasonLabel} CLI was not found.`);
    expect(findButton(view.container, 'Review Files')).not.toBeUndefined();
    expect(findButton(view.container, 'Try again')).toBeUndefined();
    await act(async () => findButton(view.container, 'Review Files')?.click());
    expect(findButton(view.container, 'Tree')?.getAttribute('aria-selected')).toBe('true');
  }
});

test('keeps generic and task-level generation failures retryable', async () => {
  const onGenerate = vi.fn(async () => {});
  await using generic = await renderSurface({
    capabilities: {
      walkthrough: {
        error: { reason: 'Generation stopped.' },
        onGenerate,
        status: 'failed',
      },
    },
    initialMode: 'walkthrough',
  });
  expect(findButton(generic.container, 'Try again')).not.toBeUndefined();
  await act(async () => findButton(generic.container, 'Try again')?.click());
  expect(onGenerate).toHaveBeenCalledTimes(1);

  const retryFailedTasks = vi.fn(async () => {});
  await using partial = await renderSurface({
    capabilities: {
      walkthrough: {
        error: { reason: 'One task failed.' },
        generationProgress: {
          completed: 1,
          phase: 'generating-units',
          summary: 'One walkthrough task failed.',
          total: 2,
          units: [
            { id: 'ready', label: 'Ready task', status: 'ready' },
            {
              detail: 'Model request failed.',
              id: 'failed',
              label: 'Failed task',
              status: 'failed',
            },
          ],
        },
        onGenerate: retryFailedTasks,
        status: 'failed',
      },
    },
    initialMode: 'walkthrough',
  });
  expect(partial.container.textContent).toContain('Model request failed.');
  expect(findButton(partial.container, 'Retry failed tasks')).not.toBeUndefined();
  await act(async () => findButton(partial.container, 'Retry failed tasks')?.click());
  expect(retryFailedTasks).toHaveBeenCalledTimes(1);
  await partial.render({
    capabilities: { walkthrough: { status: 'ready' } },
    initialMode: 'walkthrough',
  });
  expect(findButton(partial.container, 'Retry failed tasks')).toBeUndefined();
});

test('renders the walkthrough unread indicator from host capability state', async () => {
  await using view = await renderSurface({
    capabilities: { walkthrough: { unread: true } },
    initialMode: 'tree',
  });
  expect(view.container.querySelector('.review-mode-dot')).not.toBeNull();

  await view.render({
    capabilities: { walkthrough: { unread: false } },
    initialMode: 'tree',
  });
  expect(view.container.querySelector('.review-mode-dot')).toBeNull();
});

test('composes host commands while keeping controlled preferences authoritative', async () => {
  const onModeChange = vi.fn();
  const onWordWrapChange = vi.fn();
  const hostAction = vi.fn();
  const bridge = { current: null as ReviewSurfaceCommandBridge | null };
  await using view = await renderSurface({
    activeMode: { onChange: onModeChange, value: 'tree' },
    capabilities: {
      comments: createProviderComments({ onSignIn: () => {} }),
      desktop: {
        commands: [{ execute: hostAction, id: 'host-action', title: 'Host action' }],
      },
      history: {
        currentSource: { type: 'working-tree' },
        entries: [],
        hasMore: false,
        loading: false,
        onLoadMore: () => {},
        onSelectSource: () => {},
      },
      preferences: {
        wordWrap: { onChange: onWordWrapChange, value: true },
      },
    },
    keymap: {
      ...createDefaultConfig().keymap,
      commandBar: 'Ctrl+p',
      toggleWordWrap: 'Ctrl+Alt+w',
    },
    onCommandBridgeChange: (value) => {
      bridge.current = value;
    },
    snapshot: providerSnapshot,
  });

  expect(
    Array.from(view.container.querySelectorAll('[role="tab"]')).map((tab) =>
      tab.textContent?.trim(),
    ),
  ).toEqual(['Walkthrough', 'Tree', 'History', 'Comments']);

  await act(async () => findButton(view.container, 'Comments')?.click());
  expect(onModeChange).toHaveBeenCalledWith('comments');
  expect(findButton(view.container, 'Tree')?.getAttribute('aria-selected')).toBe('true');
  expect(bridge.current?.getPersistenceState().mode).toBe('tree');

  await openCommandBar();
  await act(async () => findButton(view.container, 'Host action')?.click());
  expect(hostAction).toHaveBeenCalledTimes(1);

  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { altKey: true, bubbles: true, ctrlKey: true, key: 'w' }),
    );
  });
  expect(onWordWrapChange).toHaveBeenCalledWith(false);
});

test('forwards controlled draft updates atomically across an asynchronous submission', async () => {
  const file = snapshot.files[0]!;
  const firstDraft: ReviewComment = {
    body: 'First draft',
    filePath: file.path,
    id: 'draft-1',
    lineNumber: 1,
    sectionId: file.sections[0]!.id,
    side: 'additions',
  };
  const secondDraft: ReviewComment = {
    ...firstDraft,
    body: 'Second draft',
    id: 'draft-2',
  };
  let completeSubmission!: (
    comment: import('../types.ts').PullRequestExistingReviewComment,
  ) => void;
  const submission = new Promise<import('../types.ts').PullRequestExistingReviewComment>(
    (resolve) => {
      completeSubmission = resolve;
    },
  );
  let setDrafts!: Dispatch<SetStateAction<ReadonlyArray<ReviewComment>>>;
  let latestDrafts: ReadonlyArray<ReviewComment> = [];

  function ControlledSurface() {
    const [drafts, updateDrafts] = useState<ReadonlyArray<ReviewComment>>([firstDraft]);
    setDrafts = updateDrafts;
    latestDrafts = drafts;
    return (
      <ReviewSurface
        capabilities={{
          comments: createProviderComments({
            authoring: {
              canCreateInline: true,
              drafts: { onChange: updateDrafts, value: drafts },
            },
            inline: { onSubmit: () => submission },
          }),
        }}
        initialMode="tree"
        snapshot={providerSnapshot}
      />
    );
  }

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ControlledSurface />));
  const commentButton = findButton(container, 'Comment');
  expect(commentButton).not.toBeUndefined();
  await act(async () => commentButton?.click());
  await act(async () => setDrafts((current) => [...current, secondDraft]));
  await act(async () =>
    completeSubmission({
      author: { login: 'ada', name: 'Ada' },
      body: firstDraft.body,
      filePath: firstDraft.filePath,
      id: 'submitted-1',
      lineNumber: firstDraft.lineNumber,
      sectionId: firstDraft.sectionId,
      side: firstDraft.side,
    }),
  );
  await waitFor(() => expect(latestDrafts.map(({ id }) => id)).toEqual(['submitted-1', 'draft-2']));
  await act(async () => root.unmount());
  container.remove();
});

test('preloads deferred files before applying diff-content search results', async () => {
  const deferredFile = {
    ...createChangedFile('src/lazy.ts', { kind: 'pull-request', patch: '' }),
    sections: [
      {
        binary: false,
        id: 'src/lazy.ts:pull-request',
        kind: 'pull-request',
        loadState: 'deferred',
        patch: '',
        summary: { canLoad: true, reason: 'Load exact contents.' },
      },
    ],
  } satisfies SharedWalkthroughSnapshot['files'][number];
  const lazySnapshot = {
    ...snapshot,
    files: [deferredFile],
    repository: {
      root: '/repo',
      source: {
        number: 7,
        owner: 'cloudflare',
        provider: 'github',
        repo: 'codiff',
        type: 'pull-request',
        url: 'https://github.com/cloudflare/codiff/pull/7',
      },
    },
  } satisfies SharedWalkthroughSnapshot;
  const onLoadSection = vi.fn();
  const bridge = { current: null as ReviewSurfaceCommandBridge | null };
  await using view = await renderSurface({
    capabilities: { content: { onLoadSection } },
    initialMode: 'tree',
    onCommandBridgeChange: (value) => {
      bridge.current = value;
    },
    snapshot: lazySnapshot,
  });

  await act(async () => bridge.current?.openDiffSearch());
  const input = view.container.querySelector<HTMLInputElement>('.diff-search-input');
  expect(input).not.toBeNull();
  const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setInputValue?.call(input, 'needle');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitFor(() =>
    expect(onLoadSection).toHaveBeenCalledWith(deferredFile, deferredFile.sections[0]),
  );
  expect(view.container.querySelector('.empty-panel')?.textContent).toContain(
    'No matches in diffs',
  );

  const loadedFile = {
    ...deferredFile,
    sections: [
      {
        ...deferredFile.sections[0],
        loadState: 'ready',
        newFile: { contents: 'const needle = true;\n', name: deferredFile.path },
        oldFile: { contents: 'const value = false;\n', name: deferredFile.path },
        patch: '@@ -1 +1 @@\n-const value = false;\n+const needle = true;\n',
      },
    ],
  } satisfies SharedWalkthroughSnapshot['files'][number];
  await view.render({
    capabilities: { content: { onLoadSection } },
    initialMode: 'tree',
    onCommandBridgeChange: (value) => {
      bridge.current = value;
    },
    snapshot: { ...lazySnapshot, files: [loadedFile] },
  });
  await waitFor(() => expect(view.container.querySelector('.empty-panel')).toBeNull());
  expect(view.container.textContent).toContain('src/lazy.ts');
});

test('bounds deferred diff-search preloads to three concurrent section loads', async () => {
  const files = Array.from({ length: 100 }, (_, index) => {
    const path = `src/lazy-${index}.ts`;
    return {
      ...createChangedFile(path, { kind: 'pull-request', patch: '' }),
      sections: [
        {
          binary: false,
          id: `${path}:pull-request`,
          kind: 'pull-request' as const,
          loadState: 'deferred' as const,
          patch: '',
          summary: { canLoad: true, reason: 'Load exact contents.' },
        },
      ],
    };
  }) satisfies ReadonlyArray<SharedWalkthroughSnapshot['files'][number]>;
  const lazySnapshot = {
    ...snapshot,
    files,
    repository: {
      root: '/repo',
      source: {
        number: 7,
        owner: 'cloudflare',
        provider: 'github',
        repo: 'codiff',
        type: 'pull-request',
        url: 'https://github.com/cloudflare/codiff/pull/7',
      },
    },
  } satisfies SharedWalkthroughSnapshot;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const onLoadSection = vi.fn(() => gate);
  const bridge = { current: null as ReviewSurfaceCommandBridge | null };
  await using view = await renderSurface({
    capabilities: { content: { onLoadSection } },
    initialMode: 'tree',
    onCommandBridgeChange: (value) => {
      bridge.current = value;
    },
    snapshot: lazySnapshot,
  });

  await act(async () => bridge.current?.openDiffSearch());
  const input = view.container.querySelector<HTMLInputElement>('.diff-search-input');
  const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setInputValue?.call(input, 'needle');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitFor(() => expect(onLoadSection).toHaveBeenCalledTimes(3));
  expect(onLoadSection).toHaveBeenCalledTimes(3);

  await act(async () => release());
  await waitFor(() => expect(onLoadSection).toHaveBeenCalledTimes(100));
});

test('tracks controlled collapsed and viewed state across same-source rerenders', async () => {
  const file = snapshot.files[0]!;
  const capabilities = {
    desktop: {
      collapsed: new Set<string>(),
      onCollapsedChange: vi.fn(),
      onViewedChange: vi.fn(),
      viewed: {},
    },
  } satisfies NonNullable<ReviewSurfaceProps['capabilities']>;
  await using view = await renderSurface({ capabilities, initialMode: 'tree' });
  expect(
    view.container.querySelector('[aria-label="Collapse file"]')?.getAttribute('aria-expanded'),
  ).toBe('true');

  await view.render({
    capabilities: {
      desktop: {
        ...capabilities.desktop,
        collapsed: new Set([file.path]),
        viewed: { [file.path]: file.fingerprint },
      },
    },
    initialMode: 'tree',
  });
  expect(
    view.container.querySelector('[aria-label="Expand file"]')?.getAttribute('aria-expanded'),
  ).toBe('false');
  const tree = view.container.querySelector('file-tree-container');
  const viewedStyle = tree?.shadowRoot?.querySelector<HTMLStyleElement>(
    'style[data-codiff-viewed-rows]',
  );
  expect(viewedStyle?.textContent).toContain(file.path);
});

test('distinguishes web, windowed desktop, and fullscreen desktop shell spacing', async () => {
  await using web = await renderSurface();
  expect(web.container.querySelector('.app-shell')?.className).toContain('share-shell');
  expect(web.container.querySelector('.app-shell')?.className).not.toContain('merge-request-shell');

  await using desktop = await renderSurface({ capabilities: { desktop: {} } });
  expect(desktop.container.querySelector('.app-shell')?.className).toContain('merge-request-shell');
  expect(desktop.container.querySelector('.app-shell')?.className).not.toContain(
    'window-fullscreen',
  );

  await using fullscreen = await renderSurface({
    capabilities: { desktop: { isWindowFullscreen: true } },
  });
  expect(fullscreen.container.querySelector('.app-shell')?.className).toContain(
    'window-fullscreen',
  );
});

test('preserves generated commit text when desktop commit capability is enabled', async () => {
  const file = snapshot.files[0]!;
  const seededSnapshot = {
    ...snapshot,
    walkthrough: {
      ...snapshot.walkthrough,
      chapters: [
        {
          blurb: 'Review the implementation.',
          icon: 'gear',
          id: 'implementation',
          stops: [
            {
              added: 1,
              deleted: 1,
              hunkIds: [`${file.sections[0]!.id}:h1`],
              hunks: [
                {
                  added: 1,
                  anchor: {
                    display: file.path,
                    sectionId: file.sections[0]!.id,
                    side: 'both',
                  },
                  deleted: 1,
                  id: `${file.sections[0]!.id}:h1`,
                  path: file.path,
                  status: file.status,
                },
              ],
              id: 'implementation-path',
              importance: 'critical',
              prose: 'Review this file.',
              title: 'Implementation path',
            },
          ],
          title: 'Implementation',
        },
      ],
      commit: { body: 'Keep the generated body.', title: 'Use the generated subject' },
    },
  } satisfies SharedWalkthroughSnapshot;
  await using view = await renderSurface({
    capabilities: {
      walkthrough: {
        commit: async () => ({ sha: 'a'.repeat(40) as CommitMetadata['sha'], status: 'committed' }),
        status: 'ready',
        updateCommitMessage: async (request) => ({
          body: request.body,
          status: 'ready',
          subject: request.subject,
        }),
      },
    },
    snapshot: seededSnapshot,
  });
  const commitAction = view.container.querySelector<HTMLButtonElement>('.wt-toc-commit-action');
  expect(commitAction).not.toBeNull();
  await act(async () => commitAction?.click());
  await waitFor(() => {
    expect(view.container.querySelector<HTMLInputElement>('.wt-commit-subject-field')?.value).toBe(
      'Use the generated subject',
    );
  });
  expect(view.container.querySelector<HTMLTextAreaElement>('.wt-commit-msg-input')?.value).toBe(
    'Keep the generated body.',
  );
});

test('copies commit metadata into snapshots and renders the commit card', async () => {
  const sha = 'a'.repeat(40) as CommitMetadata['sha'];
  const person = {
    date: '2026-08-04T00:00:00.000Z',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
  };
  const commitMetadata = {
    author: person,
    body: 'Explain the immutable review target.',
    committer: person,
    files: [],
    parentShas: [],
    refs: ['main'],
    sha,
    shortSha: sha.slice(0, 7),
    signature: { status: 'unsigned' },
    stats: {
      additions: 1,
      binaryFiles: 0,
      deletions: 1,
      files: 1,
      renamedFiles: 0,
    },
    subject: 'Preserve commit context',
    trailers: [],
  } satisfies CommitMetadata;
  const state = {
    branch: 'main',
    commitMetadata,
    files: snapshot.files,
    generatedAt: Date.parse(snapshot.exportedAt),
    launchPath: '/repo',
    root: '/repo',
    source: { sha, type: 'commit' },
  } satisfies RepositoryState;
  const commitSnapshot = buildSharedReviewSnapshot({
    preferences: snapshot.preferences,
    state,
    title: 'Commit review',
    walkthrough: { ...snapshot.walkthrough, source: state.source },
  });
  expect(commitSnapshot.commitMetadata).toEqual(commitMetadata);

  await using view = await renderSurface({ initialMode: 'tree', snapshot: commitSnapshot });
  await waitFor(() => expect(view.container.textContent).toContain('Preserve commit context'));
  expect(view.container.textContent).toContain('Explain the immutable review target.');
  expect(view.container.textContent).toContain('Ada Lovelace');
});

test('forwards the active walkthrough review target to the desktop host', async () => {
  const file = snapshot.files[0]!;
  const walkthrough = {
    ...snapshot.walkthrough,
    chapters: [
      {
        blurb: 'Review the implementation.',
        icon: 'gear',
        id: 'implementation',
        stops: [
          {
            added: 1,
            deleted: 1,
            hunkIds: [`${file.sections[0]!.id}:h1`],
            hunks: [
              {
                added: 1,
                anchor: {
                  display: file.path,
                  sectionId: file.sections[0]!.id,
                  side: 'both',
                },
                deleted: 1,
                id: `${file.sections[0]!.id}:h1`,
                path: file.path,
                status: file.status,
              },
            ],
            id: 'implementation-path',
            importance: 'critical',
            prose: 'Review this file.',
            title: 'Implementation path',
          },
        ],
        title: 'Implementation',
      },
    ],
  } satisfies NarrativeWalkthrough;
  const onTargetChange = vi.fn();
  await using view = await renderSurface({
    capabilities: {
      desktop: { onActiveWalkthroughReviewTargetChange: onTargetChange },
    },
    initialMode: 'walkthrough',
    snapshot: { ...snapshot, walkthrough },
  });
  await act(async () => findButton(view.container, 'Implementation path')?.click());
  await waitFor(() =>
    expect(onTargetChange).toHaveBeenCalledWith(
      expect.objectContaining({
        file: expect.objectContaining({ path: file.path }),
        reviewIdentity: expect.objectContaining({ key: expect.any(String) }),
      }),
    ),
  );
});

test('distinguishes an empty source from filtered files', async () => {
  await using view = await renderSurface({
    initialMode: 'tree',
    snapshot: { ...snapshot, files: [] },
  });
  expect(view.container.querySelector('.empty-panel')?.textContent).toContain('No local changes');
  expect(view.container.querySelector('.empty-panel')?.textContent).toContain('/repo');
});
