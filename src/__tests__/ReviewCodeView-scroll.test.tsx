/**
 * @vitest-environment jsdom
 */

import type { CodeViewItem } from '@pierre/diffs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test, vi } from 'vite-plus/test';
import { ReviewCodeView } from '../app/components/ReviewCodeView.tsx';
import { defaultKeymap } from '../config/defaults.ts';
import type { ChangedFile, ReviewSource } from '../types.ts';

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
          scrollTo: (target: { id: string; offset?: number }) => {
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
