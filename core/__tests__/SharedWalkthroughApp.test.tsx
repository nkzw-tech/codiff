/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test, vi } from 'vite-plus/test';
import { ReviewTopBar } from '../app/components/ReviewTopBar.tsx';
import { getVisibleDiffSections } from '../lib/diff.ts';
import {
  ReviewSurface,
  type ReviewCommenting,
  type ReviewContentLoader,
  type ReviewSurfaceProps,
} from '../react.ts';
import type {
  ChangedFile,
  DiffSection,
  NarrativeWalkthrough,
  SharedWalkthroughSnapshot,
} from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact, setInputValue, waitFor } from './helpers/react.tsx';

const reactActEnvironment = globalThis as typeof globalThis & {
  ResizeObserver?: typeof ResizeObserver;
};
reactActEnvironment.ResizeObserver ??= class ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
};
HTMLElement.prototype.scrollBy ??= function scrollBy() {};
HTMLElement.prototype.scrollTo ??= function scrollTo() {};

const createMarkdownFile = (path = 'README.md') =>
  ({
    ...createChangedFile(path),
    sections: [
      {
        binary: false,
        id: `${path}:unstaged`,
        kind: 'unstaged',
        loadState: 'ready',
        newFile: {
          contents: '# Shared Markdown\n\nRendered in the shared walkthrough.\n',
          name: path,
        },
        oldFile: {
          contents: '# Old heading\n',
          name: path,
        },
        patch: `diff --git a/${path} b/${path}
@@ -1 +1,3 @@
-# Old heading
+# Shared Markdown
+
+Rendered in the shared walkthrough.
`,
      },
    ],
  }) satisfies SharedWalkthroughSnapshot['files'][number];

const commenting = {
  canComment: false,
  onDeleteComment: async () => {},
  onDeleteGeneralComment: async () => {},
  onReplyGeneralComment: async () => {},
  onResolveDiscussion: async () => {},
  onSignIn: () => {},
  onSubmitComment: async () => {
    throw new Error('Not used by this test.');
  },
  onSubmitGeneralComment: async () => {},
  onUpdateComment: async () => {},
  onUpdateGeneralComment: async () => {},
} satisfies ReviewCommenting;

const sharedWalkthroughSource = { type: 'working-tree' } as const;
const sharedWalkthroughSnapshot = {
  branch: 'main',
  codiffVersion: '1.4.1',
  exportedAt: '2026-06-19T00:00:00.000Z',
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
  repository: { root: '/Users/ada/dev/codiff-web', source: sharedWalkthroughSource },
  version: 1,
  walkthrough: {
    agent: 'codex',
    chapters: [],
    focus: 'Focus on the implementation.',
    generatedAt: '2026-06-19T00:00:00.000Z',
    kind: 'narrative',
    repo: { branch: 'main', root: '/Users/ada/dev/codiff-web' },
    source: sharedWalkthroughSource,
    support: [],
    title: 'Shared walkthrough',
    version: 4,
  },
} satisfies SharedWalkthroughSnapshot;

test('keeps the merge request header interactive through walkthrough generation and retry', async () => {
  const source = {
    canEditDescription: true,
    canEditTitle: true,
    description: 'Review this change while the walkthrough is generated.',
    host: 'gitlab.example.com',
    number: 42,
    provider: 'gitlab',
    title: 'Keep the header available',
    type: 'pull-request',
    url: 'https://gitlab.example.com/team/project/-/merge_requests/42',
  } as const;
  const snapshot: SharedWalkthroughSnapshot = {
    ...sharedWalkthroughSnapshot,
    repository: { ...sharedWalkthroughSnapshot.repository, source },
    walkthrough: {
      ...sharedWalkthroughSnapshot.walkthrough,
      chapters: [
        {
          blurb: 'Review the change.',
          icon: 'gear',
          id: 'implementation',
          stops: [
            {
              added: 1,
              deleted: 1,
              hunkIds: ['src/app.ts:unstaged:h1'],
              hunks: [],
              id: 'implementation-path',
              importance: 'normal',
              prose: 'Review the implementation.',
              title: 'Implementation path',
            },
          ],
          title: 'Implementation',
        },
      ],
      source,
    },
  };
  const onGenerateWalkthrough = vi.fn(async () => {});
  const interactive = {
    onGenerateWalkthrough,
    onHome: () => {},
    onSubmitComment: commenting.onSubmitComment,
    onSubmitGeneralComment: commenting.onSubmitGeneralComment,
    onSubmitReview: vi.fn(async () => {}),
    onUpdateComment: commenting.onUpdateComment,
    onUpdateDescription: vi.fn(async () => {}),
    onUpdateGeneralComment: commenting.onUpdateGeneralComment,
    onUpdateTitle: vi.fn(async () => {}),
    walkthroughStatus: 'generating',
  } satisfies NonNullable<ReviewSurfaceProps['interactive']>;
  const renderSurface = (walkthroughStatus: 'failed' | 'generating' | 'ready') => (
    <ReviewSurface
      initialMode="walkthrough"
      interactive={{ ...interactive, walkthroughError: 'Please retry.', walkthroughStatus }}
      snapshot={
        walkthroughStatus === 'ready'
          ? snapshot
          : { ...snapshot, walkthrough: { ...snapshot.walkthrough, chapters: [] } }
      }
      sourceDescriptionFooterAside={<button type="button">Manage reviewers</button>}
    />
  );
  await using view = await renderReact(renderSurface('generating'));
  const main = view.container.querySelector('main')!;
  await waitFor(() => {
    expect(main.querySelector('textarea[aria-label="Edit title"]')).not.toBeNull();
    expect(main.textContent).toContain('Generating walkthrough');
  });
  const title = main.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit title"]')!;
  expect(title.value).toBe(source.title);
  expect(main.textContent).toContain('Manage reviewers');
  expect(main.querySelector('.wt-arc')).toBeNull();
  const editDescription = [...main.querySelectorAll('button')].find(
    (button) => button.textContent === 'Edit',
  );
  expect(editDescription?.disabled).toBe(false);
  const approve = [...main.querySelectorAll('button')].find(
    (button) => button.textContent === 'Approve',
  );
  expect(approve?.disabled).toBe(false);
  await act(async () => approve!.click());
  expect(interactive.onSubmitReview).toHaveBeenCalledWith('APPROVE', []);
  await setInputValue(title, 'An unsaved title edit');
  title.focus();
  title.setSelectionRange(3, 9);

  await view.rerender(renderSurface('failed'));
  await waitFor(() => expect(main.textContent).toContain('Walkthrough unavailable'));
  expect(main.querySelector('textarea[aria-label="Edit title"]')).toBe(title);
  expect(title.value).toBe('An unsaved title edit');
  expect(document.activeElement).toBe(title);
  expect([title.selectionStart, title.selectionEnd]).toEqual([3, 9]);
  const retry = [...main.querySelectorAll('button')].find(
    (button) => button.textContent === 'Try again',
  )!;
  await act(async () => retry.click());
  expect(onGenerateWalkthrough).toHaveBeenCalledOnce();

  await view.rerender(renderSurface('generating'));
  expect(main.querySelector('textarea[aria-label="Edit title"]')).toBe(title);
  await act(async () => editDescription!.click());
  await waitFor(() => {
    expect(main.querySelector('.source-description-edit-shell.ready')).not.toBeNull();
  });
  const description = main.querySelector<HTMLElement>(
    '[contenteditable="true"][aria-label="Edit source description"]',
  )!;
  expect(description).not.toBeNull();
  await act(async () => {
    description.focus();
    const text = description.querySelector('p span')!.firstChild!;
    text.textContent = 'An unsaved description edit';
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(text, 3, text, 9);
    description.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  const saveDescription = [...main.querySelectorAll('button')].find(
    (button) => button.textContent === 'Save',
  )!;
  await waitFor(() => expect(saveDescription.disabled).toBe(false));
  await view.rerender(renderSurface('ready'));
  await waitFor(() => expect(main.querySelector('.wt-arc')).not.toBeNull());
  expect(main.querySelector('textarea[aria-label="Edit title"]')).toBe(title);
  expect(title.value).toBe('An unsaved title edit');
  expect(main.querySelector('[contenteditable="true"][aria-label="Edit source description"]')).toBe(
    description,
  );
  expect(description.textContent).toBe('An unsaved description edit');
  expect(document.activeElement).toBe(description);
  expect(window.getSelection()?.toString()).toBe('unsave');
  expect(main.querySelectorAll('.codiff-source-description-panel')).toHaveLength(1);
  expect(main.textContent).not.toContain('Generating walkthrough');
  expect(main.textContent).not.toContain('Walkthrough unavailable');
  await act(async () => saveDescription.click());
  expect(interactive.onUpdateDescription).toHaveBeenCalledWith('An unsaved description edit');

  await view.rerender(renderSurface('generating'));
  title.focus();
  title.setSelectionRange(3, 9);
  await view.rerender(renderSurface('ready'));
  expect(main.querySelector('textarea[aria-label="Edit title"]')).toBe(title);
  expect(title.value).toBe('An unsaved title edit');
  expect(document.activeElement).toBe(title);
  expect([title.selectionStart, title.selectionEnd]).toEqual([3, 9]);
});

test.each([
  { iconTransform: null, position: 'left' },
  { iconTransform: 'scale(-1, 1)', position: 'right' },
] as const)('review top bar places its sidebar control on the $position', async (testCase) => {
  await using view = await renderReact(
    <ReviewTopBar
      leading={
        <button className="codiff-logo" type="button">
          Codiff
        </button>
      }
      mode="tree"
      modes={[{ icon: null, label: 'Tree', value: 'tree' }]}
      onModeChange={() => {}}
      onToggleSidebar={() => {}}
      repository="cloudflare/voidzero/codiff-web"
      sidebarCollapsed={false}
      sidebarPosition={testCase.position}
      toggleTitle="Collapse sidebar"
    />,
  );

  const leftRegion = view.container.querySelector('.review-top-bar-left');
  expect(leftRegion?.firstElementChild?.className).toBe('codiff-logo');
  expect(leftRegion?.nextElementSibling?.classList.contains('review-mode-control')).toBe(true);
  expect(leftRegion?.nextElementSibling?.nextElementSibling?.className).toBe(
    'review-top-bar-right',
  );
  const toggle = view.container.querySelector(
    `.review-top-bar-${testCase.position} > .sidebar-toggle-button`,
  );
  expect(toggle).not.toBeNull();
  expect(toggle?.querySelector('svg')?.getAttribute('transform')).toBe(testCase.iconTransform);
});

test.each([
  { columns: '292px 0px minmax(0px, 1fr)', position: 'left' },
  { columns: 'minmax(0px, 1fr) 0px 292px', position: 'right' },
] as const)('$position review surface layout', async (testCase) => {
  window.localStorage.clear();
  await using view = await renderReact(
    <ReviewSurface sidebarPosition={testCase.position} snapshot={sharedWalkthroughSnapshot} />,
  );

  const shell = view.container.querySelector<HTMLElement>('.app-shell');
  expect(shell?.dataset.sidebarPosition).toBe(testCase.position);
  await waitFor(() => {
    expect(shell?.style.gridTemplateColumns).toBe(testCase.columns);
  });
});

test('review surface starts with the sidebar collapsed on mobile viewports', async () => {
  window.localStorage.clear();
  const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      ({
        addEventListener() {},
        addListener() {},
        dispatchEvent: () => false,
        matches: query === '(max-width: 720px)',
        media: query,
        onchange: null,
        removeEventListener() {},
        removeListener() {},
      }) as MediaQueryList,
  );

  try {
    await using view = await renderReact(<ReviewSurface snapshot={sharedWalkthroughSnapshot} />);

    await waitFor(() => {
      expect(
        view.container.querySelector('.app-shell')?.classList.contains('sidebar-collapsed'),
      ).toBe(true);
      expect(
        view.container
          .querySelector<HTMLButtonElement>('.sidebar-toggle-button')
          ?.getAttribute('aria-label'),
      ).toBe('Expand sidebar');
    });

    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('.sidebar-toggle-button')?.click();
    });
    expect(
      view.container.querySelector('.app-shell')?.classList.contains('sidebar-collapsed'),
    ).toBe(false);
    expect(
      JSON.parse(window.localStorage.getItem('codiff:web-review-surface-preferences:v1') ?? '{}'),
    ).toEqual({ sidebarCollapsed: false });

    await using persistedView = await renderReact(
      <ReviewSurface snapshot={sharedWalkthroughSnapshot} />,
    );
    await waitFor(() => {
      expect(
        persistedView.container
          .querySelector('.app-shell')
          ?.classList.contains('sidebar-collapsed'),
      ).toBe(false);
    });
  } finally {
    window.localStorage.clear();
    matchMedia.mockRestore();
  }
});

test('a resolved general discussion stays collapsed unless its hash targets the thread', async () => {
  let finishResolve: (() => void) | null = null;
  const onResolveDiscussion = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishResolve = resolve;
      }),
  );
  const resolvedSnapshot = {
    ...sharedWalkthroughSnapshot,
    repository: {
      ...sharedWalkthroughSnapshot.repository,
      generalComments: [
        {
          canReply: true,
          canResolve: true,
          comments: [
            {
              author: { login: 'reviewer' },
              body: 'This conversation is resolved.',
              id: 'gitlab:200',
              url: 'https://gitlab.example.com/group/project/-/merge_requests/1#note_200',
            },
          ],
          id: 'general-discussion',
          isResolved: true,
        },
      ],
    },
  } satisfies SharedWalkthroughSnapshot;

  window.history.replaceState(null, '', '/review');
  await using collapsedView = await renderReact(
    <ReviewSurface
      commenting={{ ...commenting, canComment: true, onResolveDiscussion }}
      initialMode="comments"
      snapshot={resolvedSnapshot}
    />,
  );
  expect(
    collapsedView.container
      .querySelector<HTMLButtonElement>('.resolved-thread-toggle')
      ?.getAttribute('aria-expanded'),
  ).toBe('false');
  expect(collapsedView.container.querySelector('.resolved-thread-content')).toBeNull();

  window.history.replaceState(null, '', '/review#general-discussion');
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await waitFor(() => {
    expect(
      collapsedView.container
        .querySelector<HTMLButtonElement>('.resolved-thread-toggle')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(collapsedView.container.textContent).toContain('This conversation is resolved.');
  });

  const reopen = [...collapsedView.container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Reopen',
  );
  await act(async () => reopen?.click());
  expect(onResolveDiscussion).toHaveBeenCalledWith('general-discussion', false);
  expect(collapsedView.container.querySelector('.resolved-thread-toggle')).toBeNull();
  expect(
    [...collapsedView.container.querySelectorAll<HTMLButtonElement>('button')].some(
      (button) => button.textContent === 'Reply',
    ),
  ).toBe(false);

  await act(async () => finishResolve?.());
  expect(
    [...collapsedView.container.querySelectorAll<HTMLButtonElement>('button')].some(
      (button) => button.textContent === 'Reply',
    ),
  ).toBe(true);
  window.history.replaceState(null, '', '/');
});

test('a resolved inline discussion expands when its note hash is targeted', async () => {
  const resolvedSnapshot = {
    ...sharedWalkthroughSnapshot,
    reviewComments: [
      {
        author: { login: 'reviewer' },
        body: 'This inline conversation is resolved.',
        canResolveThread: true,
        filePath: 'src/app.ts',
        id: 'gitlab:99',
        isThreadResolved: true,
        lineNumber: 1,
        side: 'additions',
        threadId: 'line-discussion',
        url: 'https://gitlab.example.com/group/project/-/merge_requests/1#note_99',
      },
    ],
  } satisfies SharedWalkthroughSnapshot;

  window.history.replaceState(null, '', '/review#note_99');
  await using view = await renderReact(
    <ReviewSurface commenting={commenting} initialMode="tree" snapshot={resolvedSnapshot} />,
  );

  await waitFor(() => {
    expect(
      view.container
        .querySelector<HTMLButtonElement>('.resolved-thread-toggle')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(view.container.textContent).toContain('This inline conversation is resolved.');
  });
  window.history.replaceState(null, '', '/');
});

test('share viewer shows the complete repository path when there is no repository link', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;
  await using _resource = {
    async [Symbol.asyncDispose]() {
      if (root) {
        await act(async () => root?.unmount());
      }
      container.remove();
    },
  };
  await act(async () => {
    root = createRoot(container);
    root.render(
      <ReviewSurface snapshot={sharedWalkthroughSnapshot} title="Review shared walkthrough" />,
    );
  });

  await waitFor(() => {
    expect(container.querySelector('.review-top-bar-repository')).not.toBeNull();
  });
  expect(container.querySelector('.review-top-bar-repository')?.textContent).toBe(
    '~/dev/codiff-web',
  );
});

test('shared walkthroughs switch between walkthrough and tree review modes', async () => {
  const onDeleteShare = vi.fn();
  const confirmDelete = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const file = createChangedFile('src/app.ts');
  const markdownFile = createMarkdownFile();
  const source = {
    number: 31,
    projectPath: 'cloudflare/voidzero/codiff-web',
    provider: 'gitlab',
    type: 'pull-request',
    url: 'https://gitlab.example.com/cloudflare/voidzero/codiff-web/-/merge_requests/31',
  } as const;
  const walkthrough = {
    agent: 'codex',
    chapters: [
      {
        blurb: 'Review the implementation.',
        icon: 'gear',
        id: 'implementation',
        stops: [
          {
            added: 1,
            deleted: 1,
            hunkIds: ['src/app.ts:unstaged:h1'],
            hunks: [
              {
                added: 1,
                anchor: {
                  display: 'src/app.ts',
                  sectionId: 'src/app.ts:unstaged',
                  side: 'both',
                },
                deleted: 1,
                id: 'src/app.ts:unstaged:h1',
                path: 'src/app.ts',
                status: 'modified',
              },
            ],
            id: 'implementation-path',
            importance: 'critical',
            prose: 'Review the implementation.',
            title: 'Implementation path',
          },
        ],
        title: 'Implementation',
      },
    ],
    focus: 'Focus on the implementation.',
    generatedAt: '2026-06-19T00:00:00.000Z',
    kind: 'narrative',
    repo: { branch: 'main', root: '/repo' },
    source,
    support: [],
    title: 'Shared walkthrough',
    version: 4,
  } satisfies NarrativeWalkthrough;
  const snapshot = {
    branch: 'main',
    codiffVersion: '1.4.1',
    exportedAt: '2026-06-19T00:00:00.000Z',
    files: [file, markdownFile],
    kind: 'codiff-walkthrough-share',
    preferences: {
      codeFontFamily: 'Fira Code',
      codeFontSize: 13,
      diffStyle: 'split',
      showWhitespace: false,
      theme: 'system',
      wordWrap: false,
    },
    repository: {
      root: 'cloudflare/voidzero/codiff-web',
      source,
    },
    version: 1,
    walkthrough,
  } satisfies SharedWalkthroughSnapshot;

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  await using _resource = {
    async [Symbol.asyncDispose]() {
      if (root) {
        await act(async () => root?.unmount());
      }
      container.remove();
    },
  };
  await act(async () => {
    root = createRoot(container);
    root.render(
      <ReviewSurface
        commenting={commenting}
        onDeleteShare={onDeleteShare}
        providerLabel="GitLab"
        repositoryUrl="/cloudflare/voidzero/codiff-web"
        snapshot={snapshot}
        title="Review shared walkthrough"
      />,
    );
  });
  await waitFor(() => {
    expect(container.querySelector('.walkthrough-list')).not.toBeNull();
  });
  const searchInput = container.querySelector<HTMLInputElement>('.sidebar-search');
  expect(searchInput).not.toBeNull();
  const deleteShare = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Delete shared walkthrough"]',
  );
  expect(deleteShare?.closest('.review-top-bar-actions')).not.toBeNull();
  await act(async () => deleteShare?.click());
  expect(confirmDelete).toHaveBeenCalledWith(
    'Delete this shared walkthrough? This cannot be undone.',
  );
  expect(onDeleteShare).not.toHaveBeenCalled();
  confirmDelete.mockReturnValue(true);
  await act(async () => deleteShare?.click());
  await waitFor(() => expect(onDeleteShare).toHaveBeenCalledOnce());
  expect(searchInput?.placeholder).toBe('Filter files');
  const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  const tablist = container.querySelector('[role="tablist"]');
  expect(tablist?.classList.contains('review-mode-control')).toBe(true);
  const topBar = tablist?.closest('.review-top-bar');
  expect(topBar).not.toBeNull();
  expect(topBar?.textContent).not.toContain('Review shared walkthrough');
  expect(topBar?.textContent).not.toContain('·');
  const repositoryLink = container.querySelector<HTMLAnchorElement>('.review-top-bar-repository');
  expect(repositoryLink?.getAttribute('href')).toBe('/cloudflare/voidzero/codiff-web');
  expect(repositoryLink?.textContent).toContain('cloudflare/voidzero/codiff-web');
  expect(repositoryLink?.closest('.review-top-bar-left')).not.toBeNull();
  const branchBadge = container.querySelector<HTMLElement>('.review-top-bar-branch');
  expect(branchBadge?.textContent).toBe('main');
  expect(branchBadge?.closest('.review-top-bar-right')).not.toBeNull();
  expect(topBar?.textContent).not.toContain('(main)');
  const sourceLink = container.querySelector<HTMLAnchorElement>('.review-top-bar-source');
  expect(sourceLink?.getAttribute('href')).toBe(
    'https://gitlab.example.com/cloudflare/voidzero/codiff-web/-/merge_requests/31',
  );
  expect(sourceLink?.textContent).toBe('MR #31');
  expect(sourceLink?.querySelector('svg')).not.toBeNull();
  expect(sourceLink?.closest('.review-top-bar-right')).not.toBeNull();
  expect(container.querySelector('.review-top-bar-actions a')).toBeNull();
  expect(deleteShare?.closest('.review-top-bar-right')).not.toBeNull();
  const tabs = tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [];
  expect(tabs).toHaveLength(3);
  expect(tabs[0]?.textContent).toBe('Walkthrough');
  expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
  expect(tabs[1]?.textContent).toBe('Tree');
  expect(tabs[1]?.getAttribute('aria-selected')).toBe('false');
  expect(tabs[2]?.textContent).toBe('Comments');
  await act(async () => {
    tabs[1]?.click();
  });
  await waitFor(() => {
    expect(container.querySelector('.file-tree-shell')).not.toBeNull();
    expect(container.querySelector('.walkthrough-list')).toBeNull();
  });
  expect(container.querySelector('.codiff-markdown-diff')).not.toBeNull();
  expect(
    [...container.querySelectorAll<HTMLButtonElement>('button')].some(
      ({ textContent }) => textContent === 'View as Diff',
    ),
  ).toBe(true);
  expect(tabs[0]?.getAttribute('aria-selected')).toBe('false');
  expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
  const sidebarToggle = container.querySelector<HTMLButtonElement>(
    '.review-top-bar .sidebar-toggle-button',
  );
  expect(sidebarToggle?.getAttribute('aria-label')).toBe('Collapse sidebar');
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        ctrlKey: !navigator.platform.toLowerCase().includes('mac'),
        key: 'b',
        metaKey: navigator.platform.toLowerCase().includes('mac'),
        shiftKey: true,
      }),
    );
  });
  expect(container.querySelector('.app-shell')?.classList.contains('sidebar-collapsed')).toBe(true);
  expect(container.querySelector('.review-top-bar')).not.toBeNull();
  expect(sidebarToggle?.getAttribute('aria-label')).toBe('Expand sidebar');
  await act(async () => sidebarToggle?.click());
  expect(container.querySelector('.app-shell')?.classList.contains('sidebar-collapsed')).toBe(
    false,
  );
  await act(async () => {
    if (!searchInput) {
      return;
    }
    setInputValue?.call(searchInput, 'does-not-exist');
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitFor(() => {
    expect(container.querySelector('.empty-panel')?.textContent).toContain('No matching files');
    expect(container.querySelector('.empty-panel')?.textContent).toContain('does-not-exist');
  });
  await act(async () => {
    if (!searchInput) {
      return;
    }
    setInputValue?.call(searchInput, 'readme');
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitFor(() => {
    expect(container.querySelector('.empty-panel')).toBeNull();
    expect(container.textContent).toContain('README.md');
    expect(container.textContent).not.toContain('src/app.ts');
  });
  await act(async () => {
    tabs[0]?.click();
  });
  await waitFor(() => {
    expect(container.querySelector('.walkthrough-list')).not.toBeNull();
    expect(container.querySelector('.file-tree-shell')).toBeNull();
  });
});

test('shared walkthroughs initially preview Markdown when other files are generated', async () => {
  const file = createMarkdownFile();
  const generatedFile = {
    ...createChangedFile('src/api.ts'),
    generated: true,
  };
  const source = { type: 'working-tree' } as const;
  const walkthrough = {
    agent: 'codex',
    chapters: [],
    focus: 'Review the Markdown.',
    generatedAt: '2026-06-19T00:00:00.000Z',
    kind: 'narrative',
    repo: { branch: 'main', root: '/repo' },
    source,
    support: [],
    title: 'Shared Markdown walkthrough',
    version: 4,
  } satisfies NarrativeWalkthrough;
  const snapshot = {
    branch: 'main',
    codiffVersion: '1.4.1',
    exportedAt: '2026-06-19T00:00:00.000Z',
    files: [file, generatedFile],
    kind: 'codiff-walkthrough-share',
    preferences: {
      codeFontFamily: 'Fira Code',
      codeFontSize: 13,
      diffStyle: 'split',
      showWhitespace: false,
      theme: 'system',
      wordWrap: false,
    },
    repository: {
      root: 'Shared Codiff review',
      source,
    },
    version: 1,
    walkthrough,
  } satisfies SharedWalkthroughSnapshot;

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  await using _resource = {
    async [Symbol.asyncDispose]() {
      if (root) {
        await act(async () => root?.unmount());
      }
      container.remove();
    },
  };
  await act(async () => {
    root = createRoot(container);
    root.render(<ReviewSurface snapshot={snapshot} />);
  });
  const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  await act(async () => {
    tabs[1]?.click();
  });
  await waitFor(() => {
    const preview = container.querySelector('.codiff-markdown-preview');
    expect(preview).not.toBeNull();
    expect(preview?.querySelector('h1 ins')?.textContent).toBe('Shared');
    expect(preview?.querySelector('h1 del')?.textContent).toBe('Old');
    expect(preview?.textContent).toContain('Rendered in the shared walkthrough.');
  });
  const diffButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    ({ textContent }) => textContent === 'View as Diff',
  );
  expect(diffButton).not.toBeUndefined();
  await act(async () => {
    diffButton?.click();
  });
  await waitFor(() => {
    expect(container.querySelector('.codiff-markdown-preview')).toBeNull();
  });
  const markdownButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    ({ textContent }) => textContent === 'View as Markdown',
  );
  expect(markdownButton).not.toBeUndefined();
  await act(async () => {
    markdownButton?.click();
  });
  await waitFor(() => {
    expect(container.querySelector('.codiff-markdown-preview')).not.toBeNull();
  });
});

const createDeferredFile = (path: string): ChangedFile => {
  const file = createChangedFile(path);
  return {
    ...file,
    sections: file.sections.map((section) => ({
      ...section,
      loadState: 'deferred',
      patch: '',
      summary: { canLoad: true, reason: 'Large file.' },
    })),
  };
};

const createContentLoader = (loadSectionContent: ReviewContentLoader['loadSectionContent']) =>
  ({
    loadImageContent: vi.fn<ReviewContentLoader['loadImageContent']>(async ({ path }) => ({
      newImage: {
        dataUrl: 'data:image/png;base64,bmV3',
        mimeType: 'image/png',
        name: path,
        size: 3,
      },
      status: 'ready',
    })),
    loadSectionContent: vi.fn(loadSectionContent),
  }) satisfies ReviewContentLoader;

const renderTreeReview = (files: ReadonlyArray<ChangedFile>, contentLoader?: ReviewContentLoader) =>
  renderReact(
    <ReviewSurface
      contentLoader={contentLoader}
      initialMode="tree"
      snapshot={{ ...sharedWalkthroughSnapshot, files }}
    />,
  );

const getLoadButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('.codiff-load-button');

const getLineCountTitle = (container: HTMLElement) =>
  container.querySelector('.codiff-file-header .codiff-line-count')?.getAttribute('title');

test('a read-only review surface loads a deferred section through its content loader', async () => {
  const file = createDeferredFile('src/large.ts');
  const loaded = Promise.withResolvers<DiffSection>();
  const contentLoader = createContentLoader(() => loaded.promise);
  await using view = await renderTreeReview([file], contentLoader);

  const loadButton = getLoadButton(view.container);
  await act(async () => {
    loadButton?.click();
    loadButton?.click();
  });
  expect(loadButton?.textContent).toBe('Loading...');
  expect(contentLoader.loadSectionContent.mock.calls).toEqual([
    [
      {
        force: true,
        kind: 'unstaged',
        path: 'src/large.ts',
        showWhitespace: false,
        source: sharedWalkthroughSource,
      },
    ],
  ]);

  await act(async () => loaded.resolve(createChangedFile('src/large.ts').sections[0]));
  await waitFor(() =>
    expect(getLineCountTitle(view.container)).toBe('1 added line, 1 removed line'),
  );
  expect(getLoadButton(view.container)).toBeNull();
});

test('a failed deferred section load stops offering the load', async () => {
  const contentLoader = createContentLoader(async () => {
    throw new Error('Offline.');
  });
  await using view = await renderTreeReview([createDeferredFile('src/large.ts')], contentLoader);

  expect(getLoadButton(view.container)).not.toBeNull();
  await act(async () => getLoadButton(view.container)?.click());

  await waitFor(() => expect(getLoadButton(view.container)).toBeNull());
  expect(getLineCountTitle(view.container)).toBeUndefined();
});

test('a deferred section result for a replaced snapshot is dropped', async () => {
  const loaded = Promise.withResolvers<DiffSection>();
  const contentLoader = createContentLoader(() => loaded.promise);
  await using view = await renderTreeReview([createDeferredFile('src/large.ts')], contentLoader);
  await act(async () => getLoadButton(view.container)?.click());

  await view.rerender(
    <ReviewSurface
      contentLoader={contentLoader}
      initialMode="tree"
      snapshot={{ ...sharedWalkthroughSnapshot, files: [createDeferredFile('src/large.ts')] }}
    />,
  );
  await act(async () => loaded.resolve(createChangedFile('src/large.ts').sections[0]));

  expect(getLoadButton(view.container)?.textContent).toBe('Load');
});

test('a read-only review surface expands patch-only context through its content loader', async () => {
  const file = createChangedFile('src/context.ts', {
    patch:
      'diff --git a/src/context.ts b/src/context.ts\n--- a/src/context.ts\n+++ b/src/context.ts\n@@ -2,3 +2,3 @@\n b\n-c\n+C\n d\n',
  });
  const contentLoader = createContentLoader(async () => ({
    ...file.sections[0],
    newFile: { contents: 'a\nb\nC\nd\ne\n', name: file.path },
    oldFile: { contents: 'a\nb\nc\nd\ne\n', name: file.path },
  }));
  await using view = await renderTreeReview([file], contentLoader);
  const getExpandButton = () =>
    [...view.container.querySelectorAll('diffs-container')]
      .map((host) => host.shadowRoot?.querySelector<HTMLElement>('[data-expand-button]'))
      .find((button) => button != null);

  await waitFor(() => expect(getExpandButton()).toBeDefined());
  await act(async () => getExpandButton()?.click());

  await waitFor(() =>
    expect(getVisibleDiffSections(file, false)[0]?.fileDiff.isPartial).toBe(false),
  );
  expect(contentLoader.loadSectionContent).toHaveBeenCalledOnce();
});

test('a read-only review surface previews images through its content loader', async () => {
  const file = createChangedFile('assets/logo.png');
  const image = {
    ...file,
    sections: file.sections.map((section) => ({ ...section, binary: true, patch: '' })),
  };
  const contentLoader = createContentLoader(async () => {
    throw new Error('Not used by this test.');
  });
  await using view = await renderTreeReview([image], contentLoader);

  await waitFor(() =>
    expect(
      view.container.querySelector<HTMLImageElement>('img[alt="New assets/logo.png"]')?.src,
    ).toBe('data:image/png;base64,bmV3'),
  );
  expect(contentLoader.loadImageContent).toHaveBeenCalledWith({
    kind: 'unstaged',
    path: 'assets/logo.png',
    source: sharedWalkthroughSource,
  });
});

test('a review surface without a content loader offers no deferred section load', async () => {
  await using view = await renderTreeReview([createDeferredFile('src/large.ts')]);

  expect(view.container.textContent).toContain('src/large.ts');
  expect(getLoadButton(view.container)).toBeNull();
});

const historyEntry = (ref: string, subject: string) => ({
  author: 'Ada',
  committedAt: 1_780_000_000_000,
  parents: [],
  ref: ref.repeat(40),
  subject,
});

test('hosts that provide history get a History tab to pick a commit from', async () => {
  const onSelectSource = vi.fn();
  const snapshot = { ...sharedWalkthroughSnapshot, files: [] };
  await using view = await renderReact(<ReviewSurface initialMode="tree" snapshot={snapshot} />);
  const getHistoryTab = () =>
    [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) =>
      tab.textContent?.includes('History'),
    );
  expect(getHistoryTab()).toBeUndefined();

  await view.rerender(
    <ReviewSurface
      history={{
        entries: [historyEntry('a', 'Add parser'), historyEntry('b', 'Fix lexer')],
        hasMore: false,
        loading: false,
        onLoadMore: () => {},
        onSelectSource,
        source: sharedWalkthroughSource,
      }}
      initialMode="tree"
      snapshot={snapshot}
    />,
  );
  await act(async () => getHistoryTab()?.click());
  const subjects = () =>
    [...view.container.querySelectorAll('.history-entry-subject')].map(
      ({ textContent }) => textContent,
    );
  expect(subjects()).toEqual(['Uncommitted changes', 'Add parser', 'Fix lexer']);
  expect(view.container.querySelector('.history-entry.selected')?.textContent).toContain(
    'Uncommitted changes',
  );
  expect(view.container.querySelector('.empty-panel')?.textContent).toContain('No local changes');

  await setInputValue(
    view.container.querySelector<HTMLInputElement>('[placeholder="Filter history"]')!,
    'lexer',
  );
  expect(subjects()).toEqual(['Fix lexer']);
  await act(async () =>
    view.container.querySelector<HTMLButtonElement>('.history-entry[title="Fix lexer"]')?.click(),
  );
  expect(onSelectSource).toHaveBeenCalledWith({ ref: 'b'.repeat(40), type: 'commit' });
});

test('embedded pull request history has no local changes entry', async () => {
  const source = {
    number: 7,
    title: 'Provider review',
    type: 'pull-request',
    url: 'https://github.com/fixture/repo/pull/7',
  } as const;
  await using view = await renderReact(
    <ReviewSurface
      history={{
        entries: [{ ...historyEntry('a', 'Review change'), scope: 'pull-request' }],
        hasMore: false,
        loading: false,
        onLoadMore: () => {},
        onSelectSource: () => {},
        source,
      }}
      initialMode="history"
      snapshot={{
        ...sharedWalkthroughSnapshot,
        repository: { ...sharedWalkthroughSnapshot.repository, source },
      }}
    />,
  );
  expect(
    [...view.container.querySelectorAll('.history-entry-subject')].map(
      ({ textContent }) => textContent,
    ),
  ).toEqual(['Provider review', 'Review change']);
});

test('hosts can offer a refresh for local changes and mark a comparison as loading', async () => {
  const onRefresh = vi.fn();
  const commitSnapshot = {
    ...sharedWalkthroughSnapshot,
    repository: {
      ...sharedWalkthroughSnapshot.repository,
      source: { ref: 'a'.repeat(40), type: 'commit' },
    },
  } satisfies SharedWalkthroughSnapshot;
  await using view = await renderReact(
    <ReviewSurface
      initialMode="tree"
      refresh={{ changesDetected: false, onRefresh }}
      snapshot={sharedWalkthroughSnapshot}
    />,
  );
  const visibleBanner = () => view.container.querySelector('.repository-change-banner.visible');
  expect(visibleBanner()).toBeNull();

  await view.rerender(
    <ReviewSurface
      initialMode="tree"
      refresh={{ changesDetected: true, onRefresh }}
      snapshot={sharedWalkthroughSnapshot}
    />,
  );
  await act(async () =>
    visibleBanner()?.querySelector<HTMLButtonElement>('.repository-change-reload')?.click(),
  );
  expect(onRefresh).toHaveBeenCalledOnce();

  // A commit cannot change, so there is nothing to refresh.
  await view.rerender(
    <ReviewSurface
      initialMode="tree"
      refresh={{ changesDetected: true, onRefresh }}
      snapshot={commitSnapshot}
    />,
  );
  expect(visibleBanner()).toBeNull();

  expect(view.container.querySelector('.review-source-loading')).toBeNull();
  await view.rerender(
    <ReviewSurface comparisonLoading initialMode="tree" snapshot={commitSnapshot} />,
  );
  expect(view.container.querySelector('.review-source-loading')).not.toBeNull();
  expect(view.container.querySelector('.code-view')).toBeNull();
});
