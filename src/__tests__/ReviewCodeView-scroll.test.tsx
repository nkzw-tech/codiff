/**
 * @vitest-environment jsdom
 */

import type { CodeViewItem } from '@pierre/diffs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test, vi } from 'vite-plus/test';
import { ReviewCodeView } from '../app/components/ReviewCodeView.tsx';
import { defaultKeymap } from '../config/defaults.ts';
import type { ChangedFile, CommitMetadata, ReviewSource } from '../types.ts';

const codeViewMock = vi.hoisted(() => ({
  scrollTo: vi.fn(),
}));

vi.mock('@pierre/diffs/react', async () => {
  const React = await import('react');

  return {
    CodeView: React.forwardRef(function MockCodeView(
      props: {
        className?: string;
        items: Array<CodeViewItem<unknown>>;
        onScroll?: (scrollTop: number, viewer: unknown) => void;
        renderAnnotation?: (
          annotation: { metadata: unknown },
          item: CodeViewItem<unknown>,
        ) => React.ReactNode;
        renderCustomHeader?: (item: CodeViewItem<unknown>) => React.ReactNode;
      },
      ref: React.ForwardedRef<unknown>,
    ) {
      const itemsRef = React.useRef(props.items);
      const renderedIdsRef = React.useRef(new Set<string>());
      const scrollAttemptByIdRef = React.useRef(new Map<string, number>());
      const scrollTopRef = React.useRef(0);
      itemsRef.current = props.items;

      const viewer = React.useMemo(
        () => ({
          getRenderedItems: () =>
            itemsRef.current
              .filter((item) => renderedIdsRef.current.has(item.id))
              .map((item) => ({
                element: document.createElement('div'),
                id: item.id,
                instance: {},
                item,
                type: item.type,
                version: item.version,
              })),
          getScrollTop: () => scrollTopRef.current,
          getTopForItem: (id: string) => {
            const index = itemsRef.current.findIndex((item) => item.id === id);
            return index === -1 ? undefined : index * 200 + 20;
          },
        }),
        [],
      );

      React.useImperativeHandle(
        ref,
        () => ({
          clearSelectedLines: () => {},
          getInstance: () => viewer,
          scrollTo: (target: { behavior?: string; id: string; offset?: number }) => {
            codeViewMock.scrollTo(target);
            const attempts = (scrollAttemptByIdRef.current.get(target.id) ?? 0) + 1;
            scrollAttemptByIdRef.current.set(target.id, attempts);
            const itemTop = viewer.getTopForItem(target.id) ?? 0;
            scrollTopRef.current = Math.max(0, itemTop - (target.offset ?? 0));
            if (attempts >= 2) {
              renderedIdsRef.current.add(target.id);
            }
            props.onScroll?.(scrollTopRef.current, viewer);
          },
        }),
        [props, viewer],
      );

      return React.createElement(
        'div',
        { className: props.className },
        props.items.map((item) =>
          React.createElement(
            'div',
            { key: item.id },
            props.renderCustomHeader ? props.renderCustomHeader(item) : null,
            'annotations' in item && Array.isArray(item.annotations)
              ? item.annotations.map((annotation, index) =>
                  React.createElement(
                    React.Fragment,
                    { key: index },
                    props.renderAnnotation?.(annotation, item),
                  ),
                )
              : null,
          ),
        ),
      );
    }),
    WorkerPoolContextProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

const createChangedFile = (path: string) =>
  ({
    fingerprint: `${path}:1`,
    path,
    sections: [
      {
        binary: false,
        id: `${path}:unstaged`,
        kind: 'unstaged',
        patch: `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
      },
    ],
    status: 'modified',
  }) satisfies ChangedFile;

const source = { type: 'working-tree' } satisfies ReviewSource;
const commitSource = { ref: 'abc1234', type: 'commit' } satisfies ReviewSource;
const commitMetadata = {
  author: {
    date: '2026-01-01T12:00:00Z',
    email: 'author@example.com',
    name: 'Author',
  },
  body: '',
  committer: {
    date: '2026-01-01T12:00:00Z',
    email: 'committer@example.com',
    name: 'Committer',
  },
  files: [
    {
      additions: 1,
      binary: false,
      deletions: 1,
      path: 'src/second.ts',
      status: 'modified' as const,
    },
    {
      additions: 1,
      binary: false,
      deletions: 0,
      path: 'src/hidden.ts',
      status: 'modified' as const,
    },
  ],
  parents: ['parent-sha'],
  ref: 'abc1234',
  refs: ['main'],
  shortRef: 'abc1234',
  signature: {
    status: 'N',
  },
  stats: {
    additions: 2,
    binaryFiles: 0,
    deletions: 1,
    files: 2,
    renamedFiles: 0,
  },
  subject: 'Commit subject',
  trailers: [],
} satisfies CommitMetadata;

const waitFor = async (assertion: () => void) => {
  let lastError: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  throw lastError;
};

test('reload scroll target is retried until the selected item renders', async () => {
  codeViewMock.scrollTo.mockClear();

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ReviewCodeView
          activeSearchMatch={null}
          collapsed={new Set()}
          comments={[]}
          commitMetadata={null}
          diffStyle="split"
          files={[createChangedFile('src/first.ts'), createChangedFile('src/second.ts')]}
          focusCommentId={null}
          focusCommentRequest={0}
          forceExpandedPaths={new Set()}
          gitIdentity={null}
          isPullRequest={false}
          itemVersionByPath={{}}
          keymap={defaultKeymap}
          loadingSectionIds={new Set()}
          onAskCodex={() => {}}
          onCreateComment={() => {}}
          onDeleteComment={() => {}}
          onLoadSection={() => {}}
          onOpenFile={() => {}}
          onSelectPathFromScroll={() => {}}
          onSubmitComment={() => {}}
          onToggleCollapsed={() => {}}
          onToggleViewed={() => {}}
          onUpdateComment={() => {}}
          scrollTarget={{ path: 'src/second.ts', request: 1 }}
          searchQuery=""
          selectedPath="src/second.ts"
          showWhitespace={false}
          source={source}
          viewed={{}}
          walkthroughNotes={new Map()}
          wordWrap={false}
        />,
      );
    });

    await waitFor(() => {
      expect(codeViewMock.scrollTo).toHaveBeenCalledTimes(2);
    });
    expect(codeViewMock.scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({
        behavior: 'instant',
        id: 'diff:src/second.ts:unstaged',
        type: 'item',
      }),
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('commit metadata file rows scroll to the matching diff', async () => {
  codeViewMock.scrollTo.mockClear();

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ReviewCodeView
          activeSearchMatch={null}
          collapsed={new Set()}
          comments={[]}
          commitMetadata={commitMetadata}
          diffStyle="split"
          files={[createChangedFile('src/first.ts'), createChangedFile('src/second.ts')]}
          focusCommentId={null}
          focusCommentRequest={0}
          forceExpandedPaths={new Set()}
          gitIdentity={null}
          isPullRequest={false}
          itemVersionByPath={{}}
          keymap={defaultKeymap}
          loadingSectionIds={new Set()}
          onAskCodex={() => {}}
          onCreateComment={() => {}}
          onDeleteComment={() => {}}
          onLoadSection={() => {}}
          onOpenFile={() => {}}
          onSelectPathFromScroll={() => {}}
          onSubmitComment={() => {}}
          onToggleCollapsed={() => {}}
          onToggleViewed={() => {}}
          onUpdateComment={() => {}}
          scrollTarget={null}
          searchQuery=""
          selectedPath={null}
          showWhitespace={false}
          source={commitSource}
          viewed={{}}
          walkthroughNotes={new Map()}
          wordWrap={false}
        />,
      );
    });

    const fileButtons = [...container.querySelectorAll<HTMLButtonElement>('.commit-details-file')];
    const fileButton = fileButtons.find((button) => button.textContent?.includes('src/second.ts'));
    if (!fileButton) {
      throw new Error('Expected commit metadata file button.');
    }
    const hiddenFileButton = fileButtons.find((button) =>
      button.textContent?.includes('src/hidden.ts'),
    );
    if (!hiddenFileButton) {
      throw new Error('Expected hidden commit metadata file button.');
    }

    expect(hiddenFileButton.disabled).toBe(true);
    expect(hiddenFileButton.title).toContain('hidden by current filters');

    await act(async () => {
      hiddenFileButton.click();
    });

    expect(codeViewMock.scrollTo).not.toHaveBeenCalled();

    await act(async () => {
      fileButton.click();
    });

    expect(codeViewMock.scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({
        behavior: 'smooth',
        id: 'diff:src/second.ts:unstaged',
        type: 'item',
      }),
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});
