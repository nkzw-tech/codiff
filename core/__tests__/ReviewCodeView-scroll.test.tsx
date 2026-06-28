/**
 * @vitest-environment jsdom
 */

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, expect, test, vi } from 'vite-plus/test';
import type { ReviewComment, ReviewIdentity } from '../lib/app-types.ts';
import {
  updateReviewIdentityCollapsed,
  updateReviewIdentityViewed,
} from '../lib/review-identity.ts';
import type { ChangedFile, ReviewSource } from '../types.ts';
import { createChangedFile, createChangedFileWithPatch } from './helpers/fixtures.ts';
import { renderReact, setInputValue, waitFor } from './helpers/react.tsx';
import {
  codeViewMock,
  commitMetadata,
  commitSource,
  resetCodeViewMock,
  ReviewCodeViewHarness,
  type ReviewDiffBlock,
} from './helpers/review-code-view.tsx';

const markdownEditorMock = vi.hoisted(() => ({
  flush: vi.fn<() => Promise<boolean>>(async () => true),
}));

vi.mock('../app/components/MarkdownDocumentEditor.tsx', async () => {
  const React = await import('react');

  return {
    RepositoryMarkdownEditor: React.forwardRef(function MockRepositoryMarkdownEditor(
      { path }: { path: string },
      ref: React.ForwardedRef<{ flush: () => Promise<boolean> }>,
    ) {
      React.useImperativeHandle(ref, () => ({
        flush: markdownEditorMock.flush,
      }));
      return <div aria-label={`Edit ${path}`}>Markdown editor</div>;
    }),
  };
});

vi.mock('@nkzw/mdx-editor', async () => {
  const React = await import('react');
  type MockEditorProps = {
    ariaLabel?: string;
    className?: string;
    contentClassName?: string;
    onBlur?: () => void;
    onChange?: (value: string) => void;
    onFocus?: () => void;
    onHeightChange?: (height: number) => void;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
    placeholder?: string;
    readOnly?: boolean;
    value?: string;
  };

  return {
    MarkdownEditor: React.forwardRef<
      {
        focus: () => void;
      },
      MockEditorProps
    >((props, ref) => {
      const inputRef = React.useRef<HTMLTextAreaElement>(null);
      const { onHeightChange } = props;
      React.useImperativeHandle(ref, () => ({
        focus: () => inputRef.current?.focus(),
      }));
      React.useEffect(() => {
        onHeightChange?.(100);
      }, [onHeightChange]);
      return (
        <textarea
          aria-label={props.ariaLabel}
          className={props.contentClassName ?? props.className}
          onBlur={props.onBlur}
          onChange={(event) => props.onChange?.(event.currentTarget.value)}
          onDoubleClick={() => onHeightChange?.(200)}
          onFocus={props.onFocus}
          onKeyDown={(event) =>
            props.onKeyDown?.(event as unknown as React.KeyboardEvent<HTMLDivElement>)
          }
          placeholder={props.placeholder}
          readOnly={props.readOnly}
          ref={inputRef}
          value={props.value}
        />
      );
    }),
  };
});

beforeEach(() => {
  resetCodeViewMock();
  markdownEditorMock.flush.mockClear();
  markdownEditorMock.flush.mockResolvedValue(true);
});

const getCodeViewItemVersion = (id: string) =>
  (codeViewMock.lastItems.find((item) => item.id === id) as { version?: number } | undefined)
    ?.version;

const createLoadedMarkdownFile = (contents: string, fingerprint: string) => {
  const file = createChangedFileWithPatch(
    'plan.md',
    `diff --git a/plan.md b/plan.md\n@@ -1 +1 @@\n-# Original\n+${contents}`,
  );
  return {
    ...file,
    fingerprint,
    sections: file.sections.map((section) => ({
      ...section,
      loadState: 'ready' as const,
      newFile: {
        contents,
        name: file.path,
      },
      oldFile: {
        contents: '# Original\n',
        name: file.path,
      },
    })),
  };
};

test('switching edited Markdown back to a diff flushes and refreshes it first', async () => {
  const order: Array<string> = [];
  const initialFile = createLoadedMarkdownFile('# Edited\n', 'plan.md:initial');
  const refreshedFile = {
    ...createLoadedMarkdownFile('# Saved\n', 'plan.md:refreshed'),
  };

  markdownEditorMock.flush.mockImplementation(async () => {
    order.push('flush');
    return true;
  });

  function Harness() {
    const [file, setFile] = useState(initialFile);
    return (
      <ReviewCodeViewHarness
        files={[file]}
        onRefreshMarkdown={async () => {
          order.push('refresh');
          setFile(refreshedFile);
          return true;
        }}
      />
    );
  }

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness />);
    });

    expect(container.querySelector('[aria-label="Edit plan.md"]')).not.toBeNull();
    const diffButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      ({ textContent }) => textContent === 'View as Diff',
    );
    expect(diffButton).not.toBeUndefined();

    await act(async () => {
      diffButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Edit plan.md"]')).toBeNull();
    });
    expect(order).toEqual(['flush', 'refresh']);
    expect(JSON.stringify(codeViewMock.lastItems)).toContain('# Saved');
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('read-only Markdown previews render with the shared Markdown editor', async () => {
  const sectionId = 'README.md:unstaged';
  const file = {
    fingerprint: 'markdown-preview-added-lines',
    path: 'README.md',
    sections: [
      {
        binary: false,
        id: sectionId,
        kind: 'unstaged',
        loadState: 'ready',
        newFile: {
          contents: '# Title\n\nNew paragraph.\n',
          name: 'README.md',
        },
        oldFile: {
          contents: '# Title\n\nOld paragraph.\n',
          name: 'README.md',
        },
        patch: '',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ReviewCodeViewHarness
          files={[file]}
          initialMarkdownPreviewSectionIds={new Set([sectionId])}
          isReadOnly
        />,
      );
    });

    await waitFor(() => {
      const preview = container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Preview README.md"]',
      );
      expect(preview).not.toBeNull();
      expect(preview?.readOnly).toBe(true);
      expect(preview?.value).toBe('# Title\n\nNew paragraph.\n');
    });
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('scroll selection updates do not publish new item versions', async () => {
  const firstFile = createChangedFile('src/first.ts');
  const secondFile = createChangedFile('README.md');
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ReviewCodeViewHarness files={[firstFile, secondFile]} selectedPath={firstFile.path} />,
      );
    });

    const firstVersions = codeViewMock.lastItems.map((item) => item.version);
    expect(codeViewMock.postRenderNodes[0]?.classList.contains('codiff-selected-item')).toBe(true);
    expect(codeViewMock.postRenderNodes[1]?.classList.contains('codiff-selected-item')).toBe(false);

    await act(async () => {
      root?.render(
        <ReviewCodeViewHarness files={[firstFile, secondFile]} selectedPath={secondFile.path} />,
      );
    });

    expect(codeViewMock.lastItems.map((item) => item.version)).toEqual(firstVersions);
    expect(codeViewMock.postRenderNodes[0]?.classList.contains('codiff-selected-item')).toBe(false);
    expect(codeViewMock.postRenderNodes[1]?.classList.contains('codiff-selected-item')).toBe(true);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('walkthrough header chrome does not leak inline styles onto reused diff nodes', async () => {
  const file = createChangedFile('src/reused.ts');
  const headerBlock: ReviewDiffBlock = {
    file,
    header: <div>Header</div>,
    id: 'walkthrough-stop',
  };

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<ReviewCodeViewHarness blocks={[headerBlock]} files={[file]} />);
    });

    expect(
      codeViewMock.postRenderNodes[0]?.classList.contains('codiff-walkthrough-header-item'),
    ).toBe(true);

    await act(async () => {
      root?.render(<ReviewCodeViewHarness files={[file]} />);
    });

    const reusedNode = codeViewMock.postRenderNodes[0];
    expect(reusedNode?.classList.contains('codiff-walkthrough-header-item')).toBe(false);
    expect(container.textContent).not.toContain('Header');
    expect(container.querySelector('.codiff-file-header')).not.toBeNull();
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('header-only walkthrough blocks render and can be scroll targets', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ReviewCodeViewHarness
          blocks={[
            {
              header: <div>Missing stop</div>,
              id: 'walkthrough:s1:missing',
              selected: true,
            },
          ]}
          files={[]}
          scrollTarget={{ blockId: 'walkthrough:s1:missing', request: 1 }}
        />,
      );
    });

    expect(container.textContent).toContain('Missing stop');
    await waitFor(() => {
      expect(codeViewMock.scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'walkthrough:s1:missing:walkthrough-header',
          type: 'item',
        }),
      );
    });
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('focused walkthrough blocks render only global comments visible in the focused patch', async () => {
  const file = createChangedFileWithPatch(
    'src/commented.ts',
    'diff --git a/src/commented.ts b/src/commented.ts\n@@ -1 +1 @@\n-old\n+focused\n',
  );
  const visibleComment = {
    body: 'Visible focused comment.',
    filePath: file.path,
    id: 'visible-comment',
    lineNumber: 1,
    sectionId: file.sections[0].id,
    side: 'additions',
  } satisfies ReviewComment;
  const offHunkComment = {
    ...visibleComment,
    body: 'Off-hunk comment should stay out.',
    id: 'off-hunk-comment',
    lineNumber: 20,
  } satisfies ReviewComment;

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ReviewCodeViewHarness
          blocks={[{ file, id: 'walkthrough:s1:0', itemIdPrefix: 'walkthrough:s1:0' }]}
          comments={[visibleComment, offHunkComment]}
          files={[file]}
        />,
      );
    });

    const textareas = [...container.querySelectorAll<HTMLTextAreaElement>('textarea')];
    expect(textareas.map((textarea) => textarea.value)).toEqual([visibleComment.body]);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('focused walkthrough blocks keep cross-side comments when their rendered anchor is visible', async () => {
  const file = createChangedFileWithPatch(
    'src/ranged-comment.ts',
    'diff --git a/src/ranged-comment.ts b/src/ranged-comment.ts\n@@ -8,3 +8,3 @@\n context\n-old\n+new\n',
  );
  const rangedComment = {
    body: 'Cross-side comment.',
    filePath: file.path,
    id: 'cross-side-comment',
    lineNumber: 10,
    sectionId: file.sections[0].id,
    side: 'additions',
    startLineNumber: 7,
    startSide: 'deletions',
  } satisfies ReviewComment;

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ReviewCodeViewHarness
          blocks={[{ file, id: 'walkthrough:s1:0', itemIdPrefix: 'walkthrough:s1:0' }]}
          comments={[rangedComment]}
          files={[file]}
        />,
      );
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea?.value).toBe(rangedComment.body);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('focused walkthrough blocks resolve active search matches to rendered item ids', async () => {
  const file = createChangedFileWithPatch(
    'src/search.ts',
    'diff --git a/src/search.ts b/src/search.ts\n@@ -1 +1 @@\n-old\n+needle\n',
  );

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ReviewCodeViewHarness
          activeSearchMatch={{
            filePath: file.path,
            itemId: `diff:${file.sections[0].id}`,
            lineNumber: 1,
            side: 'additions',
          }}
          blocks={[{ file, id: 'walkthrough:s1:0', itemIdPrefix: 'walkthrough:s1:0' }]}
          files={[file]}
        />,
      );
    });

    await waitFor(() => {
      expect(codeViewMock.scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({
          id: `walkthrough:s1:0:diff:${file.sections[0].id}`,
          lineNumber: 1,
          side: 'additions',
          type: 'line',
        }),
      );
    });
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('review comment drafts resync clean external updates and reset on comment switch', async () => {
  const file = createChangedFile('src/draft.ts');
  const baseComment = {
    body: 'Original body',
    filePath: file.path,
    id: 'comment-1',
    lineNumber: 1,
    sectionId: file.sections[0].id,
    side: 'additions',
  } satisfies ReviewComment;
  const onUpdateComment = vi.fn();

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;
  const renderComment = (comment: ReviewComment) =>
    root?.render(
      <ReviewCodeViewHarness
        comments={[comment]}
        files={[file]}
        focusCommentId={comment.id}
        onUpdateComment={onUpdateComment}
      />,
    );

  try {
    await act(async () => {
      root = createRoot(container);
      renderComment(baseComment);
    });

    const textarea = () => container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(textarea().value).toBe('Original body');

    await act(async () => {
      renderComment({ ...baseComment, body: 'Clean external body' });
    });
    expect(textarea().value).toBe('Clean external body');

    await setInputValue(textarea(), 'Unsaved local draft');
    expect(textarea().value).toBe('Unsaved local draft');

    await act(async () => {
      renderComment({ ...baseComment, body: 'Ignored while dirty' });
    });
    expect(textarea().value).toBe('Unsaved local draft');

    await act(async () => {
      renderComment({ ...baseComment, body: 'Second comment body', id: 'comment-2' });
    });
    expect(textarea().value).toBe('Second comment body');
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('walkthrough hunk viewed state is keyed independently from file path', async () => {
  const filePath = 'src/shared.ts';
  const firstFile = { ...createChangedFile(filePath), fingerprint: 'first-hunk' };
  const secondFile = { ...createChangedFile(filePath), fingerprint: 'second-hunk' };
  const firstIdentity = { fingerprint: firstFile.fingerprint, key: 'walkthrough:s1:h1' };
  const secondIdentity = { fingerprint: secondFile.fingerprint, key: 'walkthrough:s2:h2' };

  function Harness() {
    const [viewed, setViewed] = useState<Record<string, string>>({});
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
    const [itemVersionByKey, setItemVersionByKey] = useState<Record<string, number>>({});

    const toggleViewed = (
      _file: ChangedFile,
      isViewed: boolean,
      reviewIdentity: ReviewIdentity,
    ) => {
      setViewed((current) => updateReviewIdentityViewed(current, reviewIdentity, isViewed));
      setCollapsed((current) => updateReviewIdentityCollapsed(current, reviewIdentity, isViewed));
      setItemVersionByKey((current) => ({
        ...current,
        [reviewIdentity.key]: (current[reviewIdentity.key] ?? 0) + 1,
      }));
    };

    return (
      <>
        <ReviewCodeViewHarness
          collapsed={collapsed}
          files={[firstFile]}
          itemVersionByKey={itemVersionByKey}
          onToggleViewed={toggleViewed}
          reviewIdentityByPath={new Map([[filePath, firstIdentity]])}
          viewed={viewed}
        />
        <ReviewCodeViewHarness
          collapsed={collapsed}
          files={[secondFile]}
          itemVersionByKey={itemVersionByKey}
          onToggleViewed={toggleViewed}
          reviewIdentityByPath={new Map([[filePath, secondIdentity]])}
          viewed={viewed}
        />
      </>
    );
  }

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness />);
    });

    const viewedButtons = () => [
      ...container.querySelectorAll<HTMLButtonElement>('.codiff-viewed-button'),
    ];
    expect(viewedButtons()).toHaveLength(2);

    await act(async () => {
      viewedButtons()[0].click();
    });

    await waitFor(() => {
      expect(viewedButtons()[0].getAttribute('aria-pressed')).toBe('true');
      expect(viewedButtons()[1].getAttribute('aria-pressed')).toBe('false');
    });
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('read-only walkthroughs can opt into the viewed control', async () => {
  const file = createChangedFile('src/shared.ts');
  const onToggleViewed = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ReviewCodeViewHarness
          allowViewedToggle
          files={[file]}
          isReadOnly
          onToggleViewed={onToggleViewed}
        />,
      );
    });

    const viewedButton = container.querySelector<HTMLButtonElement>('.codiff-viewed-button');
    expect(viewedButton).not.toBeNull();
    expect(container.querySelector('.codiff-open-button')).toBeNull();

    await act(async () => {
      viewedButton?.click();
    });

    expect(onToggleViewed).toHaveBeenCalledOnce();
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('reload scroll target is retried until the selected item renders', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ReviewCodeViewHarness
          files={[createChangedFile('src/first.ts'), createChangedFile('src/second.ts')]}
          scrollTarget={{ path: 'src/second.ts', request: 1 }}
          selectedPath="src/second.ts"
        />,
      );
    });

    await waitFor(() => {
      expect(codeViewMock.scrollTo).toHaveBeenCalledTimes(1);
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

test('scroll targets issue one command per request even before render visibility catches up', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;
  const scrollTarget = { behavior: 'smooth' as const, path: 'src/second.ts', request: 1 };

  const renderView = () => (
    <ReviewCodeViewHarness
      files={[createChangedFile('src/first.ts'), createChangedFile('src/second.ts')]}
      scrollTarget={scrollTarget}
    />
  );

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(renderView());
    });

    await waitFor(() => {
      expect(codeViewMock.scrollTo).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      root?.render(renderView());
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(codeViewMock.scrollTo).toHaveBeenCalledTimes(1);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('commit metadata file rows scroll to the matching diff', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ReviewCodeViewHarness
          commitMetadata={commitMetadata}
          files={[createChangedFile('src/first.ts'), createChangedFile('src/second.ts')]}
          source={commitSource}
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

test('hunk navigation skips stale requests when the review view remounts', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ReviewCodeViewHarness
          diffStyle="unified"
          files={[createChangedFile('src/first.ts')]}
          hunkNavigation={{ direction: 1, request: 1 }}
        />,
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(codeViewMock.scrollTo).not.toHaveBeenCalled();

    await act(async () => {
      root?.render(
        <ReviewCodeViewHarness
          diffStyle="unified"
          files={[createChangedFile('src/first.ts')]}
          hunkNavigation={{ direction: 1, request: 2 }}
        />,
      );
    });

    expect(codeViewMock.scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'diff:src/first.ts:unstaged',
        lineNumber: 1,
        side: 'additions',
        type: 'line',
      }),
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('hunk navigation skips pull request description source context', async () => {
  const source = {
    description: '## Intent\n\nOrient the reviewer before the diff.',
    number: 12,
    provider: 'github',
    title: 'Review source context',
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/12',
  } satisfies ReviewSource;
  const file = createChangedFile('src/first.ts');
  const app = await renderReact(
    <ReviewCodeViewHarness
      diffStyle="unified"
      files={[file]}
      hunkNavigation={{ direction: 1, request: 1 }}
      source={source}
    />,
  );

  try {
    codeViewMock.scrollTo.mockClear();

    await app.rerender(
      <ReviewCodeViewHarness
        diffStyle="unified"
        files={[file]}
        hunkNavigation={{ direction: 1, request: 2 }}
        source={source}
      />,
    );

    const target = codeViewMock.scrollTo.mock.lastCall?.[0];
    expect(target?.id).toBe('diff:src/first.ts:unstaged');
    expect(target).toEqual(
      expect.objectContaining({
        lineNumber: 1,
        side: 'additions',
        type: 'line',
      }),
    );
  } finally {
    await app.cleanup();
  }
});

test('read-only markdown previews trigger CodeView layout remeasurement after height change', async () => {
  const markdownFile = createLoadedMarkdownFile(
    '![diagram](https://example.com/diagram.png)\n',
    'markdown-image-layout',
  );
  const markdownSectionId = 'plan.md:unstaged';
  const source = {
    description: '![flow](https://example.com/flow.png)',
    number: 12,
    provider: 'github',
    title: 'Images in source context',
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/12',
  } satisfies ReviewSource;
  const app = await renderReact(
    <ReviewCodeViewHarness
      files={[markdownFile]}
      initialMarkdownPreviewSectionIds={new Set([markdownSectionId])}
      isReadOnly
      source={source}
    />,
  );

  try {
    const markdownItemId = `diff:${markdownSectionId}`;
    const sourceItemId = 'source-description:github:https://github.com/nkzw-tech/codiff/pull/12';
    const initialMarkdownVersion = getCodeViewItemVersion(markdownItemId);
    const initialSourceVersion = getCodeViewItemVersion(sourceItemId);

    const markdownPreview = app.container.querySelector<HTMLElement>(
      '[aria-label="Preview plan.md"]',
    );
    const sourceDescription = app.container.querySelector<HTMLElement>(
      '[aria-label="Preview source description"]',
    );

    expect(markdownPreview).not.toBeNull();
    expect(sourceDescription).not.toBeNull();

    await act(async () => {
      markdownPreview?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      sourceDescription?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    await waitFor(() => {
      expect(getCodeViewItemVersion(markdownItemId)).not.toBe(initialMarkdownVersion);
      expect(getCodeViewItemVersion(sourceItemId)).not.toBe(initialSourceVersion);
    });
  } finally {
    await app.cleanup();
  }
});

test('hunk navigation orders deletion comments before added rows in unified changes', async () => {
  const file = createChangedFileWithPatch(
    'src/first.ts',
    'diff --git a/src/first.ts b/src/first.ts\n@@ -1 +1 @@\n-old\n+new\n',
  );
  const comment = {
    body: 'Needs work.',
    filePath: 'src/first.ts',
    id: 'comment-1',
    lineNumber: 1,
    sectionId: 'src/first.ts:unstaged',
    side: 'deletions',
  } satisfies ReviewComment;

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  const render = (request: number) =>
    root?.render(
      <ReviewCodeViewHarness
        comments={[comment]}
        diffStyle="unified"
        files={[file]}
        hunkNavigation={{ direction: 1, request }}
      />,
    );

  try {
    await act(async () => {
      root = createRoot(container);
      render(0);
    });
    codeViewMock.scrollTo.mockClear();

    await act(async () => {
      render(1);
    });

    expect(codeViewMock.scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lineNumber: 1,
        side: 'deletions',
        type: 'line',
      }),
    );

    await act(async () => {
      render(2);
    });

    expect(codeViewMock.scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lineNumber: 1,
        side: 'additions',
        type: 'line',
      }),
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('review comment typing stays local until a comment action commits it', async () => {
  const file = createChangedFile('src/comment.ts');
  const comment = {
    body: '',
    filePath: file.path,
    id: 'comment-1',
    lineNumber: 1,
    sectionId: 'src/comment.ts:unstaged',
    side: 'additions',
  } satisfies ReviewComment;
  const onAskCodex = vi.fn();
  const onUpdateComment = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ReviewCodeViewHarness
          comments={[comment]}
          diffStyle="unified"
          files={[file]}
          onAskCodex={onAskCodex}
          onUpdateComment={onUpdateComment}
        />,
      );
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('.review-comment-input');
    if (!textarea) {
      throw new Error('Expected review comment textarea.');
    }

    await setInputValue(textarea, 'Please check this.');

    expect(onUpdateComment).not.toHaveBeenCalled();

    const askButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Ask',
    );
    if (!askButton) {
      throw new Error('Expected Ask button.');
    }

    await act(async () => {
      askButton.click();
    });

    expect(onUpdateComment).toHaveBeenCalledWith('comment-1', 'Please check this.');
    expect(onAskCodex).toHaveBeenCalledWith('comment-1');
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

test('Enter on a focused review control is not converted into a hunk comment', async () => {
  const onCreateComment = vi.fn();
  const onOpenFile = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  const render = (request: number) =>
    root?.render(
      <ReviewCodeViewHarness
        diffStyle="unified"
        files={[createChangedFile('src/first.ts')]}
        hunkNavigation={{ direction: 1, request }}
        onCreateComment={onCreateComment}
        onOpenFile={onOpenFile}
      />,
    );

  try {
    await act(async () => {
      root = createRoot(container);
      render(0);
    });
    await act(async () => {
      render(1);
    });

    const openButton = container.querySelector<HTMLButtonElement>('.codiff-open-button');
    if (!openButton) {
      throw new Error('Expected the open file button.');
    }

    openButton.focus();
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    });
    openButton.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onCreateComment).not.toHaveBeenCalled();
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  }
});

type ReviewLineClickHandler = (
  line: { annotationSide: 'additions' | 'deletions'; event: unknown; lineNumber: number },
  context: { item: unknown },
) => void;

type ReviewLineRangeHandler = (
  range: { end: number; side: 'additions' | 'deletions'; start: number },
  context: { item: unknown },
) => void;

const getReviewCodeViewHandlers = () => {
  const options = codeViewMock.lastOptions;
  const item = codeViewMock.lastItems.find((candidate) => candidate.type === 'diff');
  if (!options || !item) {
    throw new Error('Expected CodeView options and a diff item.');
  }

  return {
    item,
    onGutterUtilityClick: options.onGutterUtilityClick as unknown as ReviewLineRangeHandler,
    onLineClick: options.onLineClick as unknown as ReviewLineClickHandler,
    onLineSelectionEnd: options.onLineSelectionEnd as unknown as ReviewLineRangeHandler,
  };
};

const nonInteractivePointerEvent = { composedPath: () => [] };

test('line content clicks create review comments unless text is selected', async () => {
  const onCreateComment = vi.fn();
  const file = createChangedFileWithPatch(
    'src/click.ts',
    'diff --git a/src/click.ts b/src/click.ts\n@@ -1 +1 @@\n-old\n+new\n',
  );
  const container = document.createElement('div');
  const selectionHost = document.createElement('span');
  selectionHost.textContent = 'selected code';
  document.body.append(container);
  document.body.append(selectionHost);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<ReviewCodeViewHarness files={[file]} onCreateComment={onCreateComment} />);
    });

    const { item, onGutterUtilityClick, onLineClick, onLineSelectionEnd } =
      getReviewCodeViewHandlers();
    const range = { end: 1, side: 'additions' as const, start: 1 };

    await act(async () => {
      onLineClick(
        { annotationSide: 'additions', event: nonInteractivePointerEvent, lineNumber: 1 },
        { item },
      );
    });

    expect(onCreateComment).toHaveBeenCalledTimes(1);
    expect(onCreateComment).toHaveBeenLastCalledWith({
      filePath: 'src/click.ts',
      lineNumber: 1,
      sectionId: 'src/click.ts:unstaged',
      side: 'additions',
    });

    const selection = window.getSelection();
    const textSelection = document.createRange();
    textSelection.selectNodeContents(selectionHost);
    selection?.removeAllRanges();
    selection?.addRange(textSelection);

    await act(async () => {
      onLineClick(
        { annotationSide: 'additions', event: nonInteractivePointerEvent, lineNumber: 1 },
        { item },
      );
    });

    expect(onCreateComment).toHaveBeenCalledTimes(1);
    selection?.removeAllRanges();

    await act(async () => {
      onLineSelectionEnd(range, { item });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onCreateComment).toHaveBeenCalledTimes(2);
    expect(onCreateComment).toHaveBeenLastCalledWith({
      filePath: 'src/click.ts',
      lineNumber: 1,
      sectionId: 'src/click.ts:unstaged',
      side: 'additions',
    });

    await act(async () => {
      onGutterUtilityClick(range, { item });
      // The pointer-up after a gutter drag also ends a line selection; only
      // the gutter callback may create the comment.
      onLineSelectionEnd(range, { item });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onCreateComment).toHaveBeenCalledTimes(3);
  } finally {
    window.getSelection()?.removeAllRanges();
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
    selectionHost.remove();
  }
});
