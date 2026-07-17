/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test, vi } from 'vite-plus/test';
import { ReviewTopBar } from '../app/components/ReviewTopBar.tsx';
import { ReviewSurface, type ReviewCommenting } from '../SharedWalkthroughApp.tsx';
import type { NarrativeWalkthrough, SharedWalkthroughSnapshot } from '../types.ts';
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
