/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test, vi } from 'vite-plus/test';
import { ReviewTopBar } from '../app/components/ReviewTopBar.tsx';
import { createDefaultConfig } from '../config/defaults.ts';
import { ReviewSurface } from '../SharedWalkthroughApp.tsx';
import type {
  DiffComparisonView,
  EvolutionUnitId,
  GitSha,
  NarrativeWalkthrough,
  ReviewCommitEvolution,
  ReviewVersionOption,
  SharedWalkthroughSnapshot,
  WalkthroughArtifactV5,
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

const versionRevision = (sha: GitSha, text: string) => ({
  label: { kind: 'version' as const, text },
  sha,
});

const commenting = {
  canComment: false,
  onDeleteComment: async () => {},
  onDeleteGeneralComment: async () => {},
  onReplyGeneralComment: async () => {},
  onResolveDiscussion: async () => {},
  onSignIn: () => {},
  onSubmitGeneralComment: async () => {},
  onUpdateComment: async () => {},
  onUpdateGeneralComment: async () => {},
};

test('review top bar renders its leading control at the far left', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <ReviewTopBar
        leading={<button className="codiff-logo">Codiff</button>}
        mode="tree"
        modes={[{ icon: null, label: 'Tree', value: 'tree' }]}
        onModeChange={() => {}}
        onToggleSidebar={() => {}}
        repository="cloudflare/voidzero/codiff-web"
        sidebarCollapsed={false}
        toggleTitle="Collapse sidebar"
      />,
    );
  });

  const leftRegion = container.querySelector('.review-top-bar-left');
  expect(leftRegion?.firstElementChild?.className).toBe('codiff-logo');
  expect(leftRegion?.nextElementSibling?.classList.contains('review-mode-control')).toBe(true);
  expect(leftRegion?.nextElementSibling?.nextElementSibling?.className).toBe(
    'review-top-bar-right',
  );

  await act(async () => root.unmount());
  container.remove();
});

test('share viewer shows the complete repository path when there is no repository link', async () => {
  const file = createChangedFile('src/app.ts');
  const source = { type: 'working-tree' } as const;
  const snapshot = {
    branch: 'main',
    codiffVersion: '1.4.1',
    exportedAt: '2026-06-19T00:00:00.000Z',
    files: [file],
    kind: 'codiff-walkthrough-share',
    preferences: {
      codeFontFamily: 'Fira Code',
      codeFontSize: 13,
      diffStyle: 'split',
      showWhitespace: false,
      theme: 'system',
      wordWrap: false,
    },
    repository: { root: '/Users/ada/dev/codiff-web', source },
    reviewComments: [],
    version: 1,
    walkthrough: {
      agent: 'codex',
      chapters: [],
      focus: 'Review the change.',
      generatedAt: '2026-06-19T00:00:00.000Z',
      kind: 'narrative',
      repo: { branch: 'main', root: '/Users/ada/dev/codiff-web' },
      source,
      support: [],
      title: 'Review',
      version: 4,
    },
  } satisfies SharedWalkthroughSnapshot;
  const originalHome = process.env.HOME;
  process.env.HOME = '/Users/ada';
  const container = document.createElement('div');
  document.body.append(container);
  let root!: Root;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<ReviewSurface snapshot={snapshot} title="Review shared walkthrough" />);
    });
    await waitFor(() => {
      expect(container.querySelector('.review-top-bar-repository')).not.toBeNull();
    });
    expect(container.querySelector('.review-top-bar-repository')?.textContent).toBe(
      '~/dev/codiff-web',
    );
  } finally {
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await act(async () => root.unmount());
    container.remove();
  }
});

test('shared review surface owns configured search and portable commands', async () => {
  const file = createChangedFile('src/shared-command.ts');
  const snapshot = {
    branch: 'main',
    codiffVersion: 'test',
    exportedAt: '2026-07-29T00:00:00.000Z',
    files: [file],
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
      focus: 'Review the change.',
      generatedAt: '2026-07-29T00:00:00.000Z',
      kind: 'narrative',
      repo: { branch: 'main', root: '/repo' },
      source: { type: 'working-tree' },
      support: [],
      title: 'Review',
      version: 4,
    },
  } satisfies SharedWalkthroughSnapshot;
  const keymap = {
    ...createDefaultConfig().keymap,
    commandBar: 'Ctrl+p',
    diffSearch: 'Ctrl+g',
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(<ReviewSurface initialMode="tree" keymap={keymap} snapshot={snapshot} />);
    });
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'g' }),
      );
    });
    expect(container.querySelector('.diff-search-panel.visible')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'p' }),
      );
    });
    const commandBar = container.querySelector('.command-bar');
    expect(commandBar?.textContent).toContain('Find in Diffs');
    expect(commandBar?.textContent).not.toContain('Open File in Editor');
    expect(commandBar?.textContent).not.toContain('Open Config File');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('review threads expose provider provenance and code status navigates to the current diff', async () => {
  const firstFile = createChangedFile('src/first.ts');
  const file = createChangedFile('src/thread.ts');
  const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
  const source = {
    number: 31,
    projectPath: 'example-org/example-repo',
    provider: 'gitlab',
    type: 'pull-request',
    url: 'https://gitlab.example.com/example-org/example-repo/-/merge_requests/31',
  } as const;
  const snapshot = {
    branch: 'feature',
    codiffVersion: 'test',
    exportedAt: '2026-07-29T00:00:00.000Z',
    files: [firstFile, file],
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
      generalComments: [
        {
          comments: [
            {
              author: {
                login: 'overview-reviewer',
                name: 'Overview Reviewer',
                url: 'https://gitlab.example.com/overview-reviewer',
              },
              body: 'Overview feedback.',
              id: 'overview-comment',
              submittedAt: '2026-07-29T00:00:00.000Z',
              url: `${source.url}#note_1`,
            },
          ],
          id: 'overview-thread',
        },
      ],
      root: '/repo',
      source,
    },
    reviewComments: [
      {
        author: {
          login: 'code-reviewer',
          name: 'Code Reviewer',
          url: 'https://gitlab.example.com/code-reviewer',
        },
        body: 'This line changed later.',
        filePath: file.path,
        id: 'outdated-comment',
        isOutdated: true,
        lineNumber: 1,
        sectionId: file.sections[0]!.id,
        side: 'additions' as const,
        submittedAt: '2026-07-29T00:01:00.000Z',
        url: `${source.url}#note_2`,
      },
    ],
    version: 1,
    walkthrough: {
      agent: 'codex',
      chapters: [],
      focus: 'Review the change.',
      generatedAt: '2026-07-29T00:00:00.000Z',
      kind: 'narrative',
      repo: { branch: 'feature', root: '/repo' },
      source,
      support: [],
      title: 'Review',
      version: 4,
    },
  } satisfies SharedWalkthroughSnapshot;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <ReviewSurface
          capabilities={{
            comments: {
              anchorPolicy: 'provider-target',
              authoring: {},
              destination: 'provider',
              inline: {},
            },
            desktop: { collapsed: new Set([file.path]) },
          }}
          initialMode="comments"
          providerLabel="GitLab"
          snapshot={snapshot}
        />,
      );
    });

    expect(container.textContent).toContain('Overview comments');
    expect(container.textContent).toContain('Inline review comments');
    expect(
      [...container.querySelectorAll('[role="tab"]')]
        .find((tab) => tab.textContent?.includes('Comments'))
        ?.getAttribute('aria-label'),
    ).toBe('Comments (2)');
    expect(
      container.querySelector(`a[href="https://gitlab.example.com/overview-reviewer"]`),
    ).not.toBeNull();
    const overviewPermalink = container.querySelector<HTMLAnchorElement>(
      `a[href="${source.url}#note_1"]`,
    );
    expect(overviewPermalink?.textContent).toContain('View on GitLab');

    const outdatedStatus = [...container.querySelectorAll('span')].find(
      ({ textContent }) => textContent === 'Outdated',
    );
    expect(outdatedStatus?.getAttribute('role')).toBeNull();
    const inlineEntry = [
      ...container.querySelectorAll<HTMLButtonElement>('.sidebar-comment-entry'),
    ].find((entry) => entry.title === 'This line changed later.');
    expect(inlineEntry).not.toBeUndefined();
    await act(async () => inlineEntry?.click());
    await waitFor(() => expect(container.querySelector('.file-tree-shell')).not.toBeNull());
    await waitFor(() =>
      expect(
        container.querySelector('.codiff-file-header.selected .codiff-file-path')?.textContent,
      ).toBe(file.path),
    );
    const targetHeader = [...container.querySelectorAll<HTMLElement>('.codiff-file-header')].find(
      (header) => header.textContent?.includes(file.path),
    );
    expect(
      targetHeader
        ?.querySelector<HTMLElement>('.codiff-header-toggle')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
    await waitFor(() =>
      expect(document.activeElement?.classList.contains('review-comment-thread')).toBe(true),
    );
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  } finally {
    scrollIntoView.mockRestore();
    await act(async () => root.unmount());
    container.remove();
  }
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
        capabilities={{
          comments: {
            anchorPolicy: 'share-snapshot',
            authoring: { canCreateInline: false },
            destination: 'share',
            general: {
              onCreate: commenting.onSubmitGeneralComment,
              onDelete: commenting.onDeleteGeneralComment,
              onReply: commenting.onReplyGeneralComment,
              onResolve: commenting.onResolveDiscussion,
              onUpdate: commenting.onUpdateGeneralComment,
            },
            inline: {
              onDelete: commenting.onDeleteComment,
              onResolve: commenting.onResolveDiscussion,
              onUpdate: commenting.onUpdateComment,
            },
            onSignIn: commenting.onSignIn,
          },
        }}
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
  const walkthroughArc = container.querySelector('.wt-arc');
  const walkthroughBody = container.querySelector('.wt-hybrid');
  expect(walkthroughArc).not.toBeNull();
  expect(walkthroughBody).not.toBeNull();
  expect(walkthroughBody?.contains(walkthroughArc)).toBe(false);
  expect(walkthroughArc?.parentElement).toBe(walkthroughBody?.parentElement);
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
  expect(container.querySelector('.codiff-markdown-preview')).toBeNull();
  expect(
    [...container.querySelectorAll<HTMLButtonElement>('button')].some(
      ({ textContent }) => textContent === 'View as Markdown',
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

test('cached V5 walkthroughs explain unresolved authored code instead of omitting it', async () => {
  const source = { type: 'working-tree' } as const;
  const capturedFile = createChangedFile('src/aggregate.ts');
  const missingHunkId = 'src/missing.ts:unstaged:h1';
  const walkthrough = {
    capturedContext: {
      branch: 'feature',
      files: [capturedFile],
      source,
    },
    generationRequest: { review: { relation: 'single-diff', structure: 'single-diff' } },
    narrative: {
      content: {
        agent: 'codex',
        chapters: [
          {
            blurb: 'Review the missing evidence.',
            icon: 'path',
            id: 'implementation',
            stops: [
              {
                added: 1,
                deleted: 1,
                hunkIds: [missingHunkId],
                hunks: [
                  {
                    added: 1,
                    anchor: {
                      display: 'src/missing.ts:1',
                      sectionId: 'src/missing.ts:unstaged',
                      side: 'both',
                    },
                    deleted: 1,
                    id: missingHunkId,
                    path: 'src/missing.ts',
                    status: 'modified',
                  },
                ],
                id: 'missing-code',
                importance: 'critical',
                prose: 'This step must not appear to have loaded its code successfully.',
                title: 'Missing code',
              },
            ],
            title: 'Implementation',
          },
        ],
        focus: 'Review the captured implementation.',
        generatedAt: '2026-07-29T12:00:00.000Z',
        kind: 'narrative',
        repo: { branch: 'feature' },
        source,
        support: [],
        title: 'Cached walkthrough',
      },
      generationMetadata: {
        agent: 'codex',
        generatedAt: '2026-07-29T12:00:00.000Z',
        model: 'example-model',
        profile: {
          agent: 'codex',
          authoringVersion: 'walkthrough-v5-single-diff-1',
          modelCandidates: ['example-model'],
        },
      },
      structure: 'single-diff',
    },
    version: 5,
  } satisfies WalkthroughArtifactV5;
  const snapshot = {
    branch: 'feature',
    codiffVersion: '1.9.1',
    exportedAt: '2026-07-29T12:00:00.000Z',
    files: [capturedFile],
    kind: 'codiff-walkthrough-share',
    preferences: {
      codeFontFamily: 'Fira Code',
      codeFontSize: 13,
      diffStyle: 'split',
      showWhitespace: false,
      theme: 'system',
      wordWrap: false,
    },
    repository: { root: '/repo', source },
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
  await waitFor(() => {
    const diagnostic = container.querySelector('[role="alert"].wt-code-unavailable');
    expect(diagnostic?.textContent).toContain('Code unavailable for this walkthrough step');
    expect(diagnostic?.textContent).toContain('captured file is missing');
    expect(diagnostic?.textContent).toContain(missingHunkId);
  });
});

test('commit walkthroughs render canonical boundaries and switch structure explicitly', async () => {
  const file = createChangedFile('src/commit.ts', { kind: 'commit' });
  const source = {
    headSha: 'b'.repeat(40) as GitSha,
    number: 31,
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/example/repo/pull/31',
  } as const;
  const commitSha = '1'.repeat(40) as GitSha;
  const content = {
    agent: 'codex' as const,
    chapters: [
      {
        blurb: 'Review this commit.',
        icon: 'gear' as const,
        id: 'implementation',
        stops: [
          {
            added: 1,
            deleted: 1,
            hunkIds: ['src/commit.ts:commit:h1'],
            hunks: [
              {
                added: 1,
                anchor: {
                  display: 'src/commit.ts:1',
                  sectionId: 'src/commit.ts:commit',
                  side: 'both' as const,
                },
                deleted: 1,
                id: 'src/commit.ts:commit:h1',
                path: 'src/commit.ts',
                status: 'modified' as const,
              },
            ],
            id: 'commit-change',
            importance: 'critical' as const,
            prose: 'Review the commit behavior.',
            title: 'Commit behavior',
          },
        ],
        title: 'Commit',
      },
    ],
    focus: 'Review each commit independently.',
    generatedAt: '2026-08-04T12:00:00.000Z',
    kind: 'narrative' as const,
    repo: { branch: 'feature' },
    source,
    support: [],
    title: 'Commit walkthrough',
  };
  const walkthrough = {
    capturedContext: { branch: 'feature', files: [file], source },
    generationRequest: {
      review: {
        range: {
          base: {
            label: { kind: 'commit' as const, text: 'base' },
            sha: 'a'.repeat(40) as GitSha,
          },
          head: { label: { kind: 'commit' as const, text: 'head' }, sha: source.headSha },
        },
        relation: 'target-comparison' as const,
        structure: 'commit-by-commit' as const,
      },
    },
    narrative: {
      structure: 'commit-by-commit' as const,
      units: [
        {
          commit: {
            authoredAt: '2026-08-04T11:00:00.000Z',
            authorName: 'Ada',
            parentShas: ['a'.repeat(40) as GitSha],
            sha: commitSha,
            shortSha: commitSha.slice(0, 8),
            subject: 'Add commit walkthrough',
          },
          content,
          generationMetadata: {
            agent: 'codex' as const,
            generatedAt: '2026-08-04T12:00:00.000Z',
            model: 'model-a',
            profile: {
              agent: 'codex' as const,
              authoringVersion: 'walkthrough-v5-single-diff-1',
              modelCandidates: ['model-a'],
            },
          },
          sha: commitSha,
        },
      ],
    },
    version: 5 as const,
  } satisfies WalkthroughArtifactV5;
  const snapshot = {
    branch: 'feature',
    codiffVersion: '1.9.1',
    exportedAt: '2026-08-04T12:00:00.000Z',
    files: [file],
    kind: 'codiff-walkthrough-share',
    preferences: {
      codeFontFamily: 'Fira Code',
      codeFontSize: 13,
      diffStyle: 'split',
      showWhitespace: false,
      theme: 'system',
      wordWrap: false,
    },
    repository: { root: '/repo', source },
    reviewScope: { kind: 'merge-request', structure: 'commit-by-commit' },
    version: 1,
    walkthrough,
  } satisfies SharedWalkthroughSnapshot;
  const onGenerateWalkthrough = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <ReviewSurface
          capabilities={{
            walkthrough: {
              onGenerate: onGenerateWalkthrough,
              status: 'ready',
            },
          }}
          initialMode="walkthrough"
          snapshot={snapshot}
        />,
      );
    });

    expect(container.querySelector('.walkthrough-structure-controls')?.textContent).toContain(
      'Structured by commits',
    );
    expect(container.querySelector('.wt-unit-commit-ref')?.textContent).toContain(
      commitSha.slice(0, 8),
    );
    const switchButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      ({ textContent }) => textContent === 'Use net change',
    );
    await act(async () => switchButton?.click());
    await waitFor(() =>
      expect(onGenerateWalkthrough).toHaveBeenCalledWith({
        force: true,
        reviewStructure: 'net-change',
      }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('shows the selected commit structure before generation and waits for commit history', async () => {
  const file = createChangedFile('src/pending.ts');
  const source = {
    baseSha: 'a'.repeat(40) as GitSha,
    headSha: 'b'.repeat(40) as GitSha,
    number: 42,
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/example/repo/pull/42',
  } as const;
  const snapshot = {
    branch: 'feature',
    codiffVersion: 'test',
    exportedAt: '2026-08-18T00:00:00.000Z',
    files: [file],
    kind: 'codiff-walkthrough-share',
    preferences: {
      codeFontFamily: 'Fira Code',
      codeFontSize: 13,
      diffStyle: 'split',
      showWhitespace: false,
      theme: 'system',
      wordWrap: false,
    },
    repository: { root: '/repo', source },
    reviewScope: { kind: 'merge-request', structure: 'commit-by-commit' },
    version: 1,
    walkthrough: {
      agent: 'codex',
      chapters: [],
      focus: 'Preparing the walkthrough.',
      generatedAt: '2026-08-18T00:00:00.000Z',
      kind: 'narrative',
      repo: { branch: 'feature', root: '/repo' },
      source: {
        number: source.number,
        provider: source.provider,
        type: source.type,
        url: source.url,
      },
      support: [],
      title: 'Pending walkthrough',
      version: 4,
    },
  } satisfies SharedWalkthroughSnapshot;
  const onGenerate = vi.fn(async () => {});
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <ReviewSurface
          capabilities={{
            walkthrough: { generationReady: false, onGenerate, status: 'idle' },
          }}
          initialMode="walkthrough"
          snapshot={snapshot}
        />,
      );
    });
    expect(container.querySelector('.walkthrough-structure-controls')?.textContent).toContain(
      'Structured by commits',
    );
    expect(container.textContent).toContain('Loading commit structure…');
    expect(onGenerate).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <ReviewSurface
          capabilities={{
            walkthrough: { generationReady: true, onGenerate, status: 'idle' },
          }}
          initialMode="walkthrough"
          snapshot={snapshot}
        />,
      );
    });
    await waitFor(() =>
      expect(onGenerate).toHaveBeenCalledWith({ reviewStructure: 'commit-by-commit' }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
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
    expect(preview?.textContent).toContain('Shared Markdown');
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

test('selects review versions and loads one Evolution Unit into the Tree', async () => {
  const baseSha = '0'.repeat(40) as GitSha;
  const beforeSha = '1'.repeat(40) as GitSha;
  const afterSha = '2'.repeat(40) as GitSha;
  const unitId = 'unit-revised' as EvolutionUnitId;
  const source = {
    headSha: afterSha,
    number: 42,
    projectPath: 'example/repo',
    provider: 'gitlab',
    type: 'pull-request',
    url: 'https://gitlab.example.com/example/repo/-/merge_requests/42',
  } as const;
  const versions = [
    {
      createdAt: '2026-08-03T12:00:00.000Z',
      number: 1,
      range: { base: versionRevision(baseSha, 'Base'), head: versionRevision(beforeSha, 'v1') },
      versionId: 'version-1' as ReviewVersionOption['versionId'],
    },
    {
      createdAt: '2026-08-04T12:00:00.000Z',
      isHead: true,
      number: 2,
      previousCreatedAt: '2026-08-03T12:00:00.000Z',
      previousNumber: 1,
      range: { base: versionRevision(baseSha, 'Base'), head: versionRevision(afterSha, 'v2') },
      versionId: 'version-2' as ReviewVersionOption['versionId'],
    },
  ] satisfies ReadonlyArray<ReviewVersionOption>;
  const beforeCommit = {
    authoredAt: '2026-08-03T12:00:00.000Z',
    authorName: 'Author',
    parentShas: [baseSha],
    sha: beforeSha,
    shortSha: beforeSha.slice(0, 8),
    subject: 'Add behavior',
  };
  const afterCommit = {
    ...beforeCommit,
    authoredAt: '2026-08-04T12:00:00.000Z',
    parentShas: [beforeSha],
    sha: afterSha,
    shortSha: afterSha.slice(0, 8),
    subject: 'Refine behavior',
  };
  const evolution = {
    recommendation: {
      rationale: 'The commit changed intentionally.',
      suggestedStructure: 'commit-evolution',
    },
    summary: {
      absorbedIntoBase: 0,
      added: 0,
      ambiguous: 0,
      completeCoverage: true,
      pairingCoverage: 1,
      removed: 0,
      retained: 0,
      reviewable: 1,
      revised: 1,
      rewrittenSamePatch: 0,
      unreviewableAmbiguous: 0,
    },
    units: [
      {
        after: afterCommit,
        before: beforeCommit,
        confidence: 'high',
        kind: 'revised',
        order: 0,
        reviewable: true,
        unitId,
      },
    ],
  } satisfies ReviewCommitEvolution;
  const aggregateFile = createChangedFile('src/aggregate.ts');
  const unitFile = createChangedFile('src/unit.ts');
  const versionCompare = {
    analysis: {
      summary: {
        addedLines: 1,
        baseMoved: false,
        commentsAffected: 0,
        conflictFiles: 0,
        deletedLines: 1,
        empty: false,
        filesChanged: 1,
        intentionalFiles: 1,
        noiseFiles: 0,
      },
    },
    comparison: { after: versions[1].range, before: versions[0].range },
    files: [aggregateFile],
    from: versions[0],
    to: versions[1],
  } satisfies DiffComparisonView;
  const snapshot = {
    branch: 'feature',
    codiffVersion: 'test',
    exportedAt: '2026-08-04T12:00:00.000Z',
    files: [aggregateFile],
    kind: 'codiff-walkthrough-share',
    preferences: {
      codeFontFamily: 'Fira Code',
      codeFontSize: 13,
      diffStyle: 'split',
      showWhitespace: false,
      theme: 'system',
      wordWrap: false,
    },
    repository: { root: '/repo', source },
    version: 1,
    walkthrough: {
      agent: 'codex',
      chapters: [],
      focus: 'Review the comparison.',
      generatedAt: '2026-08-04T12:00:00.000Z',
      kind: 'narrative',
      repo: { branch: 'feature', root: '/repo' },
      source,
      support: [],
      title: 'Version comparison',
      version: 4,
    },
  } satisfies SharedWalkthroughSnapshot;
  const onLoadVersionCommitDiff = vi.fn(async () => [unitFile]);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  try {
    sessionStorage.clear();
    await act(async () => {
      root.render(
        <ReviewSurface
          capabilities={{
            desktop: {
              commitScope: {
                commits: [beforeCommit, afterCommit],
                onLoadRangeDiff: async () => [],
              },
              versionComparison: {
                commitEvolution: evolution,
                enabled: true,
                fromVersionId: versions[0].versionId,
                onExit: () => {},
                onLoadUnitDiff: onLoadVersionCommitDiff,
                onOpen: () => {},
                onRangeChange: () => {},
                result: versionCompare,
                toVersionId: versions[1].versionId,
                versions,
              },
            },
          }}
          initialMode="tree"
          snapshot={snapshot}
        />,
      );
    });

    expect(container.querySelector('.version-picker-pair')?.textContent).toContain('v1');
    expect(container.querySelector('.version-picker-pair')?.textContent).toContain('v2');
    const unitButton = [
      ...container.querySelectorAll<HTMLButtonElement>('.version-commit-unit'),
    ].find(({ textContent }) => textContent?.includes('Refine behavior'));
    await act(async () => unitButton?.click());
    await waitFor(() => expect(onLoadVersionCommitDiff).toHaveBeenCalledWith(unitId));
    await waitFor(() => expect(container.textContent).toContain('src/unit.ts'));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
