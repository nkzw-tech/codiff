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
import type {
  ChangedFile,
  DefinitionSearchResult,
  PullRequestCodeQualityFinding,
  ReviewSource,
} from '../types.ts';
import { createChangedFile, createChangedFileWithPatch } from './helpers/fixtures.ts';
import { renderReact, setInputValue, waitFor } from './helpers/react.tsx';
import {
  codeViewMock,
  resetCodeViewMock,
  ReviewCodeViewHarness,
  type ReviewDiffBlock,
} from './helpers/review-code-view.tsx';

const markdownEditorMock = vi.hoisted(() => ({
  flush: vi.fn<() => Promise<boolean>>(async () => true),
  heightByAriaLabel: new Map<string, number>(),
  heightReportLimit: Number.POSITIVE_INFINITY,
  heightReports: 0,
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
        if (
          onHeightChange &&
          markdownEditorMock.heightReports < markdownEditorMock.heightReportLimit
        ) {
          markdownEditorMock.heightReports += 1;
          onHeightChange(markdownEditorMock.heightByAriaLabel.get(props.ariaLabel ?? '') ?? 100);
        }
      }, [onHeightChange, props.ariaLabel]);
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
  markdownEditorMock.heightByAriaLabel.clear();
  markdownEditorMock.heightReportLimit = Number.POSITIVE_INFINITY;
  markdownEditorMock.heightReports = 0;
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

test('generated files are collapsed by default and can be explicitly expanded per review', async () => {
  const file = createChangedFile('src/__generated__/api.ts');
  const reviewKey = 'walkthrough:generated-api';
  const blocks: ReadonlyArray<ReviewDiffBlock> = [
    {
      file,
      id: reviewKey,
      reviewIdentity: {
        fingerprint: file.fingerprint,
        key: reviewKey,
      },
    },
  ];
  await using view = await renderReact(<ReviewCodeViewHarness blocks={blocks} files={[]} />);

  await waitFor(() => {
    expect(
      view.container.querySelector('[aria-label="Expand file"]')?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(view.container.querySelector('.codiff-generated-badge')?.textContent).toBe('Generated');
  });
  await view.rerender(
    <ReviewCodeViewHarness
      blocks={blocks}
      expandedGenerated={new Set([reviewKey])}
      files={[]}
      itemVersionByKey={{ [reviewKey]: 1 }}
    />,
  );
  await waitFor(() => {
    expect(
      view.container.querySelector('[aria-label="Collapse file"]')?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(view.container.querySelector('.codiff-generated-badge')?.textContent).toBe('Generated');
  });
});

test('explicit generated metadata can keep generated-looking paths expanded', async () => {
  const file = {
    ...createChangedFile('src/__generated__/api.ts'),
    generated: false,
  };
  await using view = await renderReact(<ReviewCodeViewHarness files={[file]} />);

  await waitFor(() => {
    expect(
      view.container.querySelector('[aria-label="Collapse file"]')?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(view.container.querySelector('.codiff-generated-badge')).toBeNull();
  });
});

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
    root.render(<Harness />);
  });
  expect(container.querySelector('[aria-label="Edit plan.md"]')).not.toBeNull();
  const diffButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    ({ textContent }) => textContent === 'View as Diff',
  );
  expect(diffButton).not.toBeUndefined();
  expect(diffButton?.classList.contains('codiff-button')).toBe(true);
  await act(async () => {
    diffButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() => {
    expect(container.querySelector('[aria-label="Edit plan.md"]')).toBeNull();
  });
  expect(order).toEqual(['flush', 'refresh']);
  expect(JSON.stringify(codeViewMock.lastItems)).toContain('# Saved');
});

test('combined branch Markdown edits only the final working-tree section', async () => {
  const order: Array<string> = [];
  const createCombinedFile = (contents: string, fingerprint: string) => {
    const file = createLoadedMarkdownFile(contents, fingerprint);
    const section = file.sections[0]!;
    return {
      ...file,
      sections: [
        {
          ...section,
          id: 'plan.md:commit',
          kind: 'commit' as const,
          newFile: {
            contents: '# Committed\n',
            name: file.path,
          },
          patch: 'diff --git a/plan.md b/plan.md\n@@ -1 +1 @@\n-# Original\n+# Committed\n',
        },
        {
          ...section,
          id: 'plan.md:unstaged',
          kind: 'unstaged' as const,
          oldFile: {
            contents: '# Committed\n',
            name: file.path,
          },
        },
      ],
    } satisfies ChangedFile;
  };
  const initialFile = createCombinedFile('# Edited\n', 'plan.md:combined-initial');
  const refreshedFile = createCombinedFile('# Saved\n', 'plan.md:combined-refreshed');
  const combinedSource = {
    baseRef: 'base123',
    headRef: 'head123',
    ref: 'main',
    type: 'branch-working-tree',
  } satisfies ReviewSource;

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
        source={combinedSource}
      />
    );
  }

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
});

test('combined branch-only Markdown sections remain read-only', async () => {
  const loadedFile = createLoadedMarkdownFile('# Committed\n', 'plan.md:commit-only');
  const file = {
    ...loadedFile,
    sections: loadedFile.sections.map((section) => ({
      ...section,
      id: 'plan.md:commit',
      kind: 'commit' as const,
    })),
  } satisfies ChangedFile;
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
      <ReviewCodeViewHarness
        files={[file]}
        source={{
          baseRef: 'base123',
          headRef: 'head123',
          ref: 'main',
          type: 'branch-working-tree',
        }}
      />,
    );
  });
  expect(container.querySelector('[aria-label="Edit plan.md"]')).toBeNull();
  const markdownButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    ({ textContent }) => textContent === 'View as Markdown',
  );
  expect(markdownButton).not.toBeUndefined();
  await act(async () => {
    markdownButton?.click();
  });
  await waitFor(() => {
    expect(container.querySelector('[aria-label="Preview plan.md"]')).not.toBeNull();
  });
  expect(container.querySelector('[aria-label="Edit plan.md"]')).toBeNull();
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
});

test('scroll selection updates do not publish new item versions', async () => {
  const firstFile = createChangedFile('src/first.ts');
  const secondFile = createChangedFile('README.md');
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
});

test('header-only walkthrough blocks render and can be scroll targets', async () => {
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
      <ReviewCodeViewHarness
        blocks={[{ file, id: 'walkthrough:s1:0', itemIdPrefix: 'walkthrough:s1:0' }]}
        comments={[visibleComment, offHunkComment]}
        files={[file]}
      />,
    );
  });
  const textareas = [...container.querySelectorAll<HTMLTextAreaElement>('textarea')];
  expect(textareas.map((textarea) => textarea.value)).toEqual([visibleComment.body]);
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
      <ReviewCodeViewHarness
        blocks={[{ file, id: 'walkthrough:s1:0', itemIdPrefix: 'walkthrough:s1:0' }]}
        comments={[rangedComment]}
        files={[file]}
      />,
    );
  });
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
  expect(textarea?.value).toBe(rangedComment.body);
});

test('focused walkthrough blocks resolve active search matches to rendered item ids', async () => {
  const file = createChangedFileWithPatch(
    'src/search.ts',
    'diff --git a/src/search.ts b/src/search.ts\n@@ -1 +1 @@\n-old\n+needle\n',
  );

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
    renderComment({
      ...baseComment,
      body: 'Second comment body',
      id: 'comment-2',
    });
  });
  expect(textarea().value).toBe('Second comment body');
});

test('read-only review comments render safe details blocks', async () => {
  const file = createChangedFile('src/review.ts');
  const comment = {
    author: { login: 'ai-reviewer', name: 'AI Code Reviewer' },
    body: '<details>\n<summary>Review rationale</summary>\n\nThis branch needs attention.\n\n</details>',
    filePath: file.path,
    id: 'comment-details',
    isReadOnly: true,
    lineNumber: 1,
    sectionId: file.sections[0].id,
    side: 'additions',
  } satisfies ReviewComment;

  await using view = await renderReact(
    <ReviewCodeViewHarness comments={[comment]} files={[file]} supportsReviewCommentActions />,
  );

  await waitFor(() => {
    expect(view.container.querySelector('.review-comment-thread details')).not.toBeNull();
  });
  const details = view.container.querySelector<HTMLDetailsElement>(
    '.review-comment-thread details',
  );
  expect(details?.open).toBe(false);
  expect(details?.querySelector('summary')?.textContent).toBe('Review rationale');
  expect(view.container.textContent).toContain('AI Code Reviewer');
});

test('walkthrough hunk viewed state is keyed independently from file path', async () => {
  const filePath = 'src/shared.ts';
  const firstFile = {
    ...createChangedFile(filePath),
    fingerprint: 'first-hunk',
  };
  const secondFile = {
    ...createChangedFile(filePath),
    fingerprint: 'second-hunk',
  };
  const firstIdentity = {
    fingerprint: firstFile.fingerprint,
    key: 'walkthrough:s1:h1',
  };
  const secondIdentity = {
    fingerprint: secondFile.fingerprint,
    key: 'walkthrough:s2:h2',
  };

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
});

test('read-only walkthroughs can opt into the viewed control', async () => {
  const file = createChangedFile('src/shared.ts');
  const onToggleViewed = vi.fn();
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
  expect(container.querySelector('.codiff-button')).toBeNull();
  await act(async () => {
    viewedButton?.click();
  });
  expect(onToggleViewed).toHaveBeenCalledOnce();
});

test('reload scroll target is retried until the selected item renders', async () => {
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
});

test('scroll targets issue one command per request even before render visibility catches up', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;
  const scrollTarget = {
    behavior: 'smooth' as const,
    path: 'src/second.ts',
    request: 1,
  };

  const renderView = () => (
    <ReviewCodeViewHarness
      files={[createChangedFile('src/first.ts'), createChangedFile('src/second.ts')]}
      scrollTarget={scrollTarget}
    />
  );

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
});

test('hunk navigation skips stale requests when the review view remounts', async () => {
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
  await using app = await renderReact(
    <ReviewCodeViewHarness
      diffStyle="unified"
      files={[file]}
      hunkNavigation={{ direction: 1, request: 1 }}
      source={source}
    />,
  );

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
  await using app = await renderReact(
    <ReviewCodeViewHarness
      files={[markdownFile]}
      initialMarkdownPreviewSectionIds={new Set([markdownSectionId])}
      isReadOnly
      source={source}
    />,
  );

  const markdownItemId = `diff:${markdownSectionId}`;
  const initialMarkdownVersion = getCodeViewItemVersion(markdownItemId);
  const markdownPreview = app.container.querySelector<HTMLElement>(
    '[aria-label="Preview plan.md"]',
  );
  // The source description renders in CodeView's header region, where height
  // changes are observed by the viewer directly instead of item versions.
  const sourceDescription = app.container.querySelector<HTMLElement>(
    '[data-diffs-code-view-header] [aria-label="Preview source description"]',
  );
  expect(markdownPreview).not.toBeNull();
  expect(sourceDescription).not.toBeNull();
  expect(
    sourceDescription?.closest('[data-diffs-code-view-header]')?.closest('[slot="header-custom"]'),
  ).toBeNull();
  await act(async () => {
    markdownPreview?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await waitFor(() => {
    expect(getCodeViewItemVersion(markdownItemId)).not.toBe(initialMarkdownVersion);
  });
});

test('source description remains visible when a review has no diff items', async () => {
  const source = {
    description: 'No file changes are needed.',
    number: 13,
    provider: 'github',
    title: 'Empty pull request',
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/13',
  } satisfies ReviewSource;
  await using app = await renderReact(
    <ReviewCodeViewHarness files={[]} isReadOnly source={source} />,
  );

  const sourceDescription = app.container.querySelector(
    '[data-diffs-code-view-header] [aria-label="Preview source description"]',
  );
  expect(sourceDescription).not.toBeNull();
  expect(
    sourceDescription?.closest('[data-diffs-code-view-header]')?.closest('[slot="header-custom"]'),
  ).toBeNull();
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
  const onCommentDraftChange = vi.fn();
  const onUpdateComment = vi.fn();
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
      <ReviewCodeViewHarness
        comments={[comment]}
        diffStyle="unified"
        files={[file]}
        onAskCodex={onAskCodex}
        onCommentDraftChange={onCommentDraftChange}
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
  expect(onCommentDraftChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ body: 'Please check this.', id: 'comment-1' }),
  );
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
});

const renderLocalReviewComment = async ({
  body,
  onAskCodex,
  onCommentDraftChange,
  onDeleteComment,
  onUpdateComment,
}: {
  body: string;
  onAskCodex: () => void;
  onCommentDraftChange?: () => void;
  onDeleteComment?: () => void;
  onUpdateComment: () => void;
}) => {
  const file = createChangedFile('src/comment.ts');
  const comment = {
    body,
    filePath: file.path,
    id: 'comment-1',
    lineNumber: 1,
    sectionId: file.sections[0].id,
    side: 'additions',
  } satisfies ReviewComment;
  const view = await renderReact(
    <ReviewCodeViewHarness
      comments={[comment]}
      files={[file]}
      onAskCodex={onAskCodex}
      onCommentDraftChange={onCommentDraftChange}
      onDeleteComment={onDeleteComment}
      onUpdateComment={onUpdateComment}
    />,
  );
  const textarea = view.container.querySelector<HTMLTextAreaElement>('.review-comment-input');
  if (!textarea) {
    throw new Error('Expected review comment textarea.');
  }

  textarea.focus();
  return { textarea, view };
};

const pressCommentShortcut = async (textarea: HTMLTextAreaElement, altKey: boolean) => {
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        altKey,
        bubbles: true,
        cancelable: true,
        key: 'Enter',
        metaKey: true,
      }),
    );
  });
};

test('local review comments are added with Mod+Enter instead of asking the agent', async () => {
  const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
  const onAskCodex = vi.fn();
  const onCommentDraftChange = vi.fn();
  const onUpdateComment = vi.fn();
  const { textarea, view } = await renderLocalReviewComment({
    body: '',
    onAskCodex,
    onCommentDraftChange,
    onUpdateComment,
  });

  await using _view = view;
  await using _resource = {
    async [Symbol.asyncDispose]() {
      platform.mockRestore();
    },
  };
  await setInputValue(textarea, 'Please check this.');
  await pressCommentShortcut(textarea, false);
  expect(onUpdateComment).toHaveBeenCalledWith('comment-1', 'Please check this.');
  expect(onAskCodex).not.toHaveBeenCalled();
  expect(document.activeElement).not.toBe(textarea);
  expect(onCommentDraftChange).toHaveBeenLastCalledWith(null);
});

test('local review comments ask the agent with Mod+Alt+Enter', async () => {
  const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
  const onAskCodex = vi.fn();
  const onUpdateComment = vi.fn();
  const { textarea, view } = await renderLocalReviewComment({
    body: '',
    onAskCodex,
    onUpdateComment,
  });

  await using _view = view;
  await using _resource = {
    async [Symbol.asyncDispose]() {
      platform.mockRestore();
    },
  };
  await setInputValue(textarea, 'Explain this change.');
  await pressCommentShortcut(textarea, true);
  expect(onAskCodex).toHaveBeenCalledWith('comment-1');
  expect(onUpdateComment).toHaveBeenCalledWith('comment-1', 'Explain this change.');
  expect(document.activeElement).toBe(textarea);
});

test('adding an empty local review comment with Mod+Enter discards it', async () => {
  const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
  const onAskCodex = vi.fn();
  const onDeleteComment = vi.fn();
  const onUpdateComment = vi.fn();
  const { textarea, view } = await renderLocalReviewComment({
    body: '',
    onAskCodex,
    onDeleteComment,
    onUpdateComment,
  });

  await using _view = view;
  await using _resource = {
    async [Symbol.asyncDispose]() {
      platform.mockRestore();
    },
  };
  await pressCommentShortcut(textarea, false);
  expect(onUpdateComment).not.toHaveBeenCalled();
  expect(onAskCodex).not.toHaveBeenCalled();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(onDeleteComment).toHaveBeenCalledTimes(1);
  expect(onDeleteComment).toHaveBeenCalledWith('comment-1');
});

test('a Codex reply does not repeatedly invalidate the diff item layout', async () => {
  const file = createChangedFile('src/comment.ts');
  const comment = {
    body: 'Please explain this change.',
    filePath: file.path,
    id: 'comment-1',
    lineNumber: 1,
    sectionId: 'src/comment.ts:unstaged',
    side: 'additions',
  } satisfies ReviewComment;
  markdownEditorMock.heightByAriaLabel.set('Comment on src/comment.ts New line 1', 100);
  markdownEditorMock.heightByAriaLabel.set('Codex reply', 320);
  markdownEditorMock.heightReportLimit = 6;
  await using view = await renderReact(
    <ReviewCodeViewHarness comments={[comment]} files={[file]} />,
  );

  const renderCountBeforeReply = codeViewMock.renderCount;
  await view.rerender(
    <ReviewCodeViewHarness
      comments={[
        {
          ...comment,
          codexReply: {
            body: 'This reply is tall enough to use a different markdown measurement.',
            status: 'ready',
          },
        },
      ]}
      files={[file]}
    />,
  );
  expect(view.container.querySelector('[aria-label="Codex reply"]')).not.toBeNull();
  expect(codeViewMock.renderCount).toBe(renderCountBeforeReply + 1);
});

test('failed pull request comments keep their draft and can be retried', async () => {
  const file = createChangedFile('src/comment.ts');
  const comment = {
    body: 'Keep this comment.',
    filePath: file.path,
    id: 'comment-1',
    lineNumber: 1,
    remoteSubmit: {
      error:
        'You already have a pending GitHub review on this pull request. Submit or discard it on GitHub, then retry. Your comment draft is still here.',
      status: 'error' as const,
    },
    sectionId: 'src/comment.ts:unstaged',
    side: 'additions' as const,
  } satisfies ReviewComment;
  const onSubmitComment = vi.fn();
  const onUpdateComment = vi.fn();
  await using view = await renderReact(
    <ReviewCodeViewHarness
      comments={[comment]}
      files={[file]}
      onSubmitComment={onSubmitComment}
      onUpdateComment={onUpdateComment}
      supportsReviewCommentActions
    />,
  );

  const textarea = view.container.querySelector<HTMLTextAreaElement>('.review-comment-input');
  expect(textarea?.value).toBe('Keep this comment.');
  expect(view.container.querySelector('.review-comment-error')?.textContent).toBe(
    comment.remoteSubmit.error,
  );
  const commentButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Comment',
  );
  if (!commentButton) {
    throw new Error('Expected Comment button.');
  }
  await act(async () => {
    commentButton.click();
  });
  expect(onUpdateComment).not.toHaveBeenCalled();
  expect(onSubmitComment).toHaveBeenCalledWith(comment.id);
  expect(textarea?.value).toBe(comment.body);
});

test('working-tree share comments support the Comment button and Mod+Enter', async () => {
  const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
  const file = createChangedFile('src/shared-comment.ts');
  const comment = {
    body: 'Submit this shared comment.',
    filePath: file.path,
    id: 'shared-comment',
    lineNumber: 1,
    sectionId: file.sections[0].id,
    side: 'additions',
  } satisfies ReviewComment;
  const onSubmitComment = vi.fn();
  await using view = await renderReact(
    <ReviewCodeViewHarness
      comments={[comment]}
      files={[file]}
      onSubmitComment={onSubmitComment}
      supportsReviewCommentActions
    />,
  );

  await using _resource = {
    async [Symbol.asyncDispose]() {
      platform.mockRestore();
    },
  };
  const commentButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Comment',
  );
  expect(commentButton).not.toBeNull();
  await act(async () => commentButton?.click());
  expect(onSubmitComment).toHaveBeenLastCalledWith(comment.id);
  onSubmitComment.mockClear();
  const textarea = view.container.querySelector<HTMLTextAreaElement>('.review-comment-input');
  expect(textarea).not.toBeNull();
  await act(async () => {
    textarea?.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
        metaKey: true,
      }),
    );
  });
  expect(onSubmitComment).toHaveBeenCalledWith(comment.id);
});

test('file comments can be created for GitLab merge requests but not GitHub pull requests', async () => {
  const file = createChangedFile('src/comment.ts');
  const onCreateComment = vi.fn();
  const gitLabSource = {
    provider: 'gitlab',
    type: 'pull-request',
    url: 'https://gitlab.example.com/group/project/-/merge_requests/1',
  } satisfies ReviewSource;
  const gitHubSource = {
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/example/project/pull/1',
  } satisfies ReviewSource;
  await using view = await renderReact(
    <ReviewCodeViewHarness
      files={[file]}
      onCreateComment={onCreateComment}
      source={gitLabSource}
      supportsReviewCommentActions
    />,
  );

  const fileCommentButton = view.container.querySelector<HTMLButtonElement>(
    '.codiff-file-comment-button',
  );
  expect(fileCommentButton).not.toBeNull();
  expect(fileCommentButton?.classList.contains('codiff-button')).toBe(true);
  await act(async () => fileCommentButton?.click());
  expect(onCreateComment).toHaveBeenCalledWith({
    anchor: 'file',
    filePath: 'src/comment.ts',
    sectionId: 'src/comment.ts:unstaged',
  });
  await view.rerender(
    <ReviewCodeViewHarness
      files={[file]}
      onCreateComment={onCreateComment}
      source={gitHubSource}
      supportsReviewCommentActions
    />,
  );
  expect(view.container.querySelector('.codiff-file-comment-button')).toBeNull();
});

test('file-level review comments render as measured file annotations', async () => {
  const file = createChangedFile('src/comment.ts');
  await using view = await renderReact(
    <ReviewCodeViewHarness
      comments={[
        {
          anchor: 'file',
          author: { login: 'reviewer' },
          body: 'Review this file as a whole.',
          filePath: file.path,
          id: 'gitlab:file',
          isReadOnly: true,
          sectionId: 'src/comment.ts:unstaged',
        },
      ]}
      files={[file]}
      source={{
        provider: 'gitlab',
        type: 'pull-request',
        url: 'https://gitlab.example.com/group/project/-/merge_requests/1',
      }}
      supportsReviewCommentActions
    />,
  );

  const fileComments = view.container.querySelector('.review-comment-thread');
  expect(fileComments?.textContent).toContain('Review this file as a whole.');
  expect(fileComments?.closest('.codiff-file-header')).toBeNull();
  const item = codeViewMock.lastItems.find(
    (candidate) => candidate.id === 'diff:src/comment.ts:unstaged',
  ) as
    | {
        annotations?: ReadonlyArray<{
          lineNumber: number;
          metadata: { commentIds?: ReadonlyArray<string>; type: string };
        }>;
      }
    | undefined;
  expect(item?.annotations).toContainEqual({
    lineNumber: 0,
    metadata: {
      commentIds: ['gitlab:file'],
      type: 'review-comment',
    },
    side: 'additions',
  });
});

test('code quality findings render as additions annotations', async () => {
  const file = createChangedFile('src/app.ts');
  const finding = {
    description: 'Avoid an unconditional storage lookup.',
    engineName: 'eslint',
    filePath: file.path,
    fingerprint: 'code-quality-1',
    lineNumber: 1,
    severity: 'major',
    status: 'new',
  } satisfies PullRequestCodeQualityFinding;
  await using view = await renderReact(
    <ReviewCodeViewHarness
      codeQualityFindings={[
        finding,
        { ...finding, fingerprint: 'resolved', status: 'resolved' },
        { ...finding, filePath: 'src/other.ts', fingerprint: 'other-file' },
        { ...finding, fingerprint: 'hidden-line', lineNumber: 99 },
      ]}
      files={[file]}
    />,
  );

  const renderedFinding = view.container.querySelector<HTMLElement>('.code-quality-finding');
  expect(renderedFinding?.dataset.severity).toBe('major');
  expect(renderedFinding?.dataset.status).toBe('new');
  expect(renderedFinding?.textContent).toContain('Code Quality');
  expect(renderedFinding?.textContent).toContain('Major');
  expect(renderedFinding?.textContent).toContain('New');
  expect(renderedFinding?.textContent).toContain(finding.description);
  expect(renderedFinding?.textContent).toContain('eslint');
  const item = codeViewMock.lastItems.find(
    (candidate) => candidate.id === 'diff:src/app.ts:unstaged',
  ) as
    | {
        annotations?: ReadonlyArray<{
          lineNumber: number;
          metadata: { finding?: PullRequestCodeQualityFinding; type: string };
          side: string;
        }>;
      }
    | undefined;
  expect(item?.annotations?.filter(({ metadata }) => metadata.type === 'code-quality')).toEqual([
    {
      lineNumber: 1,
      metadata: {
        finding,
        type: 'code-quality',
      },
      side: 'additions',
    },
  ]);
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
    render(0);
  });
  await act(async () => {
    render(1);
  });
  const openButton = container.querySelector<HTMLButtonElement>('.codiff-button');
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
});

type ReviewLineClickHandler = (
  line: {
    annotationSide: 'additions' | 'deletions';
    event: unknown;
    lineElement?: HTMLElement;
    lineNumber: number;
  },
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

test('modifier-clicking an identifier finds and opens its definition without commenting', async () => {
  const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
  const onCreateComment = vi.fn();
  const onFindDefinitions = vi.fn(async () => ({
    candidates: [
      {
        canOpenInEditor: true,
        kind: 'function',
        line: 'export function formatGreeting() {}',
        lineNumber: 1,
        path: 'src/greeting.ts',
        side: 'additions' as const,
      },
    ],
    identifier: 'formatGreeting',
    status: 'ready' as const,
  }));
  const onOpenDefinition = vi.fn();
  const file = createChangedFileWithPatch(
    'src/main.ts',
    'diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-old()\n+formatGreeting()\n',
  );
  const lineElement = document.createElement('div');
  const token = document.createElement('span');
  token.textContent = 'formatGreeting';
  lineElement.append(token, '()');
  await using _view = await renderReact(
    <ReviewCodeViewHarness
      files={[file]}
      onCreateComment={onCreateComment}
      onFindDefinitions={onFindDefinitions}
      onOpenDefinition={onOpenDefinition}
    />,
  );
  await using _platform = {
    [Symbol.dispose]() {
      platform.mockRestore();
    },
  };
  const { item, onLineClick } = getReviewCodeViewHandlers();

  await act(async () => {
    onLineClick(
      {
        annotationSide: 'additions',
        event: {
          clientX: 120,
          clientY: 80,
          composedPath: () => [],
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          target: token,
        },
        lineElement,
        lineNumber: 1,
      },
      { item },
    );
  });

  await waitFor(() => {
    expect(document.querySelector('.definition-popover-result')).not.toBeNull();
  });
  expect(onFindDefinitions).toHaveBeenCalledWith({
    identifier: 'formatGreeting',
    kind: 'unstaged',
    lineNumber: 1,
    path: 'src/main.ts',
    side: 'additions',
    source: { type: 'working-tree' },
  });
  expect(onCreateComment).not.toHaveBeenCalled();

  await act(async () => {
    document.querySelector<HTMLButtonElement>('.definition-popover-result')?.click();
  });
  expect(onOpenDefinition).toHaveBeenCalledWith(
    expect.objectContaining({ lineNumber: 1, path: 'src/greeting.ts' }),
  );
});

test('macOS Control-click keeps the context-menu gesture instead of finding a definition', async () => {
  const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
  const onFindDefinitions = vi.fn();
  const file = createChangedFileWithPatch(
    'src/main.ts',
    'diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-old()\n+formatGreeting()\n',
  );
  const lineElement = document.createElement('div');
  const token = document.createElement('span');
  token.textContent = 'formatGreeting';
  lineElement.append(token, '()');
  await using _view = await renderReact(
    <ReviewCodeViewHarness files={[file]} onFindDefinitions={onFindDefinitions} />,
  );
  await using _platform = {
    [Symbol.dispose]() {
      platform.mockRestore();
    },
  };
  const { item, onLineClick } = getReviewCodeViewHandlers();
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();

  await act(async () => {
    onLineClick(
      {
        annotationSide: 'additions',
        event: {
          clientX: 120,
          clientY: 80,
          composedPath: () => [],
          ctrlKey: true,
          metaKey: false,
          preventDefault,
          stopPropagation,
          target: token,
        },
        lineElement,
        lineNumber: 1,
      },
      { item },
    );
  });

  expect(onFindDefinitions).not.toHaveBeenCalled();
  expect(preventDefault).not.toHaveBeenCalled();
  expect(stopPropagation).not.toHaveBeenCalled();
});

test('definition results inside the rendered diff jump in Codiff instead of opening an editor', async () => {
  const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
  const onFindDefinitions = vi.fn(async () => ({
    candidates: [
      {
        canOpenInEditor: false,
        kind: 'function',
        line: 'function formatGreeting() {}',
        lineNumber: 1,
        path: 'src/main.ts',
        side: 'additions' as const,
      },
    ],
    identifier: 'formatGreeting',
    status: 'ready' as const,
  }));
  const onOpenDefinition = vi.fn();
  const file = createChangedFileWithPatch(
    'src/main.ts',
    'diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-old()\n+formatGreeting()\n',
  );
  const lineElement = document.createElement('div');
  const token = document.createElement('span');
  token.textContent = 'formatGreeting';
  lineElement.append(token, '()');
  await using _view = await renderReact(
    <ReviewCodeViewHarness
      files={[file]}
      onFindDefinitions={onFindDefinitions}
      onOpenDefinition={onOpenDefinition}
    />,
  );
  await using _platform = {
    [Symbol.dispose]() {
      platform.mockRestore();
    },
  };
  const { item, onLineClick } = getReviewCodeViewHandlers();

  await act(async () => {
    onLineClick(
      {
        annotationSide: 'additions',
        event: {
          clientX: 120,
          clientY: 80,
          composedPath: () => [],
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          target: token,
        },
        lineElement,
        lineNumber: 1,
      },
      { item },
    );
  });

  await waitFor(() => {
    expect(document.querySelector('.definition-popover-result')).not.toBeNull();
  });
  expect(document.querySelector('[aria-label="Jump within diff"]')).not.toBeNull();

  await act(async () => {
    document.querySelector<HTMLButtonElement>('.definition-popover-result')?.click();
  });
  expect(codeViewMock.scrollTo).toHaveBeenCalledWith({
    align: 'center',
    behavior: 'smooth-auto',
    id: item.id,
    lineNumber: 1,
    offset: 11,
    side: 'additions',
    type: 'line',
  });
  expect(onOpenDefinition).not.toHaveBeenCalled();
});

test('historical definitions outside the diff do not open the current checkout', async () => {
  const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
  const onFindDefinitions = vi.fn(async () => ({
    candidates: [
      {
        canOpenInEditor: false,
        kind: 'function',
        line: 'function formatGreeting() {}',
        lineNumber: 20,
        path: 'src/greeting.ts',
        side: 'additions' as const,
      },
    ],
    identifier: 'formatGreeting',
    status: 'ready' as const,
  }));
  const onOpenDefinition = vi.fn();
  const file = createChangedFile('src/main.ts', {
    kind: 'commit',
    patch: 'diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-old()\n+formatGreeting()\n',
  });
  const lineElement = document.createElement('div');
  const token = document.createElement('span');
  token.textContent = 'formatGreeting';
  lineElement.append(token, '()');
  await using _view = await renderReact(
    <ReviewCodeViewHarness
      files={[file]}
      onFindDefinitions={onFindDefinitions}
      onOpenDefinition={onOpenDefinition}
      source={{ ref: 'abcdef0', type: 'commit' }}
    />,
  );
  await using _platform = {
    [Symbol.dispose]() {
      platform.mockRestore();
    },
  };
  const { item, onLineClick } = getReviewCodeViewHandlers();

  await act(async () => {
    onLineClick(
      {
        annotationSide: 'additions',
        event: {
          clientX: 120,
          clientY: 80,
          composedPath: () => [],
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          target: token,
        },
        lineElement,
        lineNumber: 1,
      },
      { item },
    );
  });

  await waitFor(() => {
    expect(document.querySelector('.definition-popover-result')).not.toBeNull();
  });
  const result = document.querySelector<HTMLButtonElement>('.definition-popover-result');
  expect(result?.disabled).toBe(true);
  expect(
    document.querySelector('[aria-label="Unavailable outside this historical diff"]'),
  ).not.toBeNull();
  await act(async () => result?.click());
  expect(onOpenDefinition).not.toHaveBeenCalled();
});

test('definition search rejection becomes an unavailable result', async () => {
  const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
  const onFindDefinitions = vi.fn(async () => {
    throw new Error('IPC unavailable');
  });
  const file = createChangedFileWithPatch(
    'src/main.ts',
    'diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-old()\n+formatGreeting()\n',
  );
  const lineElement = document.createElement('div');
  const token = document.createElement('span');
  token.textContent = 'formatGreeting';
  lineElement.append(token, '()');
  await using _view = await renderReact(
    <ReviewCodeViewHarness
      files={[file]}
      onFindDefinitions={onFindDefinitions}
      onOpenDefinition={() => {}}
    />,
  );
  await using _platform = {
    [Symbol.dispose]() {
      platform.mockRestore();
    },
  };
  const { item, onLineClick } = getReviewCodeViewHandlers();

  await act(async () => {
    onLineClick(
      {
        annotationSide: 'additions',
        event: {
          clientX: 120,
          clientY: 80,
          composedPath: () => [],
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          target: token,
        },
        lineElement,
        lineNumber: 1,
      },
      { item },
    );
  });

  await waitFor(() => {
    expect(document.querySelector('.definition-popover-message')?.textContent).toBe(
      'Definition search is unavailable for this repository.',
    );
  });
});

test('definition result is invalidated when the review source changes', async () => {
  const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
  let resolveSearch: ((result: DefinitionSearchResult) => void) | undefined;
  const onFindDefinitions = vi.fn(
    () =>
      new Promise<DefinitionSearchResult>((resolve) => {
        resolveSearch = resolve;
      }),
  );
  const file = createChangedFileWithPatch(
    'src/main.ts',
    'diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-old()\n+formatGreeting()\n',
  );
  const lineElement = document.createElement('div');
  const token = document.createElement('span');
  token.textContent = 'formatGreeting';
  lineElement.append(token, '()');
  await using view = await renderReact(
    <ReviewCodeViewHarness
      files={[file]}
      onFindDefinitions={onFindDefinitions}
      onOpenDefinition={() => {}}
    />,
  );
  await using _platform = {
    [Symbol.dispose]() {
      platform.mockRestore();
    },
  };
  const { item, onLineClick } = getReviewCodeViewHandlers();

  await act(async () => {
    onLineClick(
      {
        annotationSide: 'additions',
        event: {
          clientX: 120,
          clientY: 80,
          composedPath: () => [],
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          target: token,
        },
        lineElement,
        lineNumber: 1,
      },
      { item },
    );
  });
  expect(document.querySelector('.definition-popover')).not.toBeNull();

  await view.rerender(
    <ReviewCodeViewHarness
      files={[createChangedFile('src/next.ts', { kind: 'commit' })]}
      onFindDefinitions={onFindDefinitions}
      onOpenDefinition={() => {}}
      source={{ ref: 'abcdef0', type: 'commit' }}
    />,
  );
  await act(async () => {
    resolveSearch?.({ candidates: [], identifier: 'formatGreeting', status: 'ready' });
  });
  expect(document.querySelector('.definition-popover')).toBeNull();
});

test('modifier navigation follows file hosts reused by CodeView virtualization', async () => {
  const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
  const onFindDefinitions = vi.fn(async () => ({
    candidates: [],
    identifier: 'formatGreeting',
    status: 'ready' as const,
  }));
  const file = createChangedFileWithPatch(
    'src/main.ts',
    'diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-old()\n+formatGreeting()\n',
  );
  await using _view = await renderReact(
    <ReviewCodeViewHarness files={[file]} onFindDefinitions={onFindDefinitions} />,
  );
  await using _platform = {
    [Symbol.dispose]() {
      platform.mockRestore();
    },
  };
  const { item } = getReviewCodeViewHandlers();
  const onPostRender = codeViewMock.lastOptions?.onPostRender as
    | ((
        node: HTMLElement,
        instance: unknown,
        phase: 'update',
        context: { item: typeof item },
      ) => void)
    | undefined;
  const host = document.createElement('diffs-container');
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  document.body.append(host);

  await using _host = {
    [Symbol.dispose]() {
      host.remove();
    },
  };
  const renderLine = (identifier: string) => {
    const line = document.createElement('div');
    line.dataset.line = '1';
    line.textContent = `${identifier}();`;
    root.replaceChildren(line);
    onPostRender?.(host, {}, 'update', { item });
  };

  await act(async () => {
    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, metaKey: true }));
    renderLine('firstFileSymbol');
  });
  await waitFor(() => {
    expect(root.querySelector('[data-codiff-identifier]')?.textContent).toBe('firstFileSymbol');
  });

  await act(async () => renderLine('newlyVirtualizedFileSymbol'));
  await waitFor(() => {
    expect(root.querySelector('[data-codiff-identifier]')?.textContent).toBe(
      'newlyVirtualizedFileSymbol',
    );
  });
});

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

  await using _resource = {
    async [Symbol.asyncDispose]() {
      window.getSelection()?.removeAllRanges();
      if (root) {
        await act(async () => root?.unmount());
      }
      container.remove();
      selectionHost.remove();
    },
  };
  await act(async () => {
    root = createRoot(container);
    root.render(<ReviewCodeViewHarness files={[file]} onCreateComment={onCreateComment} />);
  });
  const { item, onGutterUtilityClick, onLineClick, onLineSelectionEnd } =
    getReviewCodeViewHandlers();
  const range = { end: 1, side: 'additions' as const, start: 1 };
  await act(async () => {
    onLineClick(
      {
        annotationSide: 'additions',
        event: nonInteractivePointerEvent,
        lineNumber: 1,
      },
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
      {
        annotationSide: 'additions',
        event: nonInteractivePointerEvent,
        lineNumber: 1,
      },
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
});
