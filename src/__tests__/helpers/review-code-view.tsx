import type { CodeViewItem } from '@pierre/diffs';
import React, { type ComponentProps } from 'react';
import { vi } from 'vite-plus/test';
import { ReviewCodeView } from '../../app/components/ReviewCodeView.tsx';
import { defaultKeymap } from '../../config/defaults.ts';
import type { ChangedFile, CommitMetadata, ReviewSource } from '../../types.ts';

export type { ReviewDiffBlock } from '../../app/components/ReviewCodeView.tsx';

const codeViewMockState = vi.hoisted(() => ({
  lastItems: [] as ReadonlyArray<{ id: string; type: string }>,
  lastOptions: null as Record<string, unknown> | null,
  postRenderNodes: [] as Array<HTMLElement>,
  scrollTo: vi.fn(),
}));
export const codeViewMock = codeViewMockState;

export const resetCodeViewMock = () => {
  codeViewMock.lastItems = [];
  codeViewMock.lastOptions = null;
  codeViewMock.postRenderNodes = [];
  codeViewMock.scrollTo.mockClear();
};

vi.mock('@pierre/diffs/react', async () => {
  const React = await import('react');

  return {
    CodeView: React.forwardRef(function MockCodeView(
      props: {
        className?: string;
        items: Array<CodeViewItem<unknown>>;
        onScroll?: (scrollTop: number, viewer: unknown) => void;
        options?: {
          onPostRender?: (
            node: HTMLElement,
            instance: unknown,
            phase: unknown,
            context: { item: CodeViewItem<unknown> },
          ) => void;
        };
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

      React.useLayoutEffect(() => {
        itemsRef.current = props.items;
        codeViewMock.lastItems = props.items;
        codeViewMock.lastOptions = props.options ?? null;
        codeViewMock.postRenderNodes.length = props.items.length;
        props.items.forEach((item, index) => {
          const node = codeViewMock.postRenderNodes[index] ?? document.createElement('div');
          codeViewMock.postRenderNodes[index] = node;
          props.options?.onPostRender?.(node, {}, 'update', { item });
        });
      }, [props.items, props.options]);

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

export const source = { type: 'working-tree' } satisfies ReviewSource;
export const commitSource = { ref: 'abc1234', type: 'commit' } satisfies ReviewSource;
export const commitMetadata = {
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

type ReviewCodeViewHarnessProps = Partial<ComponentProps<typeof ReviewCodeView>> & {
  files: ReadonlyArray<ChangedFile>;
};

export function ReviewCodeViewHarness({ files, ...overrides }: ReviewCodeViewHarnessProps) {
  return (
    <ReviewCodeView
      activeSearchMatch={null}
      agentId="codex"
      agentLabel="Codex"
      collapsed={new Set()}
      comments={[]}
      commitMetadata={null}
      diffStyle="split"
      files={files}
      focusCommentId={null}
      focusCommentRequest={0}
      forceExpandedPaths={new Set()}
      gitIdentity={null}
      hunkNavigation={null}
      isPullRequest={false}
      itemVersionByKey={{}}
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
      source={source}
      viewed={{}}
      walkthroughNotes={new Map()}
      wordWrap={false}
      {...overrides}
    />
  );
}
