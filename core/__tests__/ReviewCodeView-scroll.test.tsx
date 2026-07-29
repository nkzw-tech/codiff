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
import { applyWalkthroughRegionHighlights } from '../lib/walkthrough-region-highlights.ts';
import type {
  AssessmentComponent,
  ChangedFile,
  DiffSection,
  GitSha,
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

const gitSha = (value: string) => value as GitSha;
const createAssessment = (
  threadId: string,
  outcome: AssessmentComponent['outcome'],
): AssessmentComponent => ({
  capturedPresentationState: { threadState: 'open' },
  identity: { codeScope: { type: 'single-diff' }, threadId },
  input: {
    codeScope: { type: 'single-diff' },
    thread: {
      comments: [{ author: { login: 'reviewer' }, body: 'Question', id: threadId }],
      id: threadId,
    },
  },
  outcome,
});

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
    baseSha: gitSha('base123'),
    headSha: gitSha('head123'),
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
          baseSha: gitSha('base123'),
          headSha: gitSha('head123'),
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

test('walkthrough region navigation scrolls to the exact diff range', async () => {
  const file = createChangedFile('src/range.ts');
  const view = await renderReact(
    <ReviewCodeViewHarness
      blocks={[{ file, id: 'walkthrough:range' }]}
      files={[]}
      scrollTarget={{
        blockId: 'walkthrough:range',
        range: { end: 4, endSide: 'additions', side: 'additions', start: 2 },
        request: -1,
      }}
    />,
  );

  try {
    await waitFor(() => {
      expect(codeViewMock.scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({
          range: { end: 4, endSide: 'additions', side: 'additions', start: 2 },
          type: 'range',
        }),
      );
    });
  } finally {
    await view.cleanup();
  }
});

test('renders ready, failed, and pending assessments beside matching threads', async () => {
  const file = createChangedFileWithPatch(
    'src/assessment.ts',
    'diff --git a/src/assessment.ts b/src/assessment.ts\n@@ -1 +1 @@\n-old\n+new\n',
  );
  const comments = [
    {
      author: { login: 'reviewer' },
      body: 'Does this still apply?',
      destination: 'provider' as const,
      filePath: file.path,
      id: 'comment-ready',
      isReadOnly: true,
      kind: 'submitted-comment' as const,
      lineNumber: 1,
      resolvedSectionId: file.sections[0]!.id,
      side: 'additions' as const,
      threadId: 'thread-ready',
    },
    {
      author: { login: 'reviewer' },
      body: 'Check the failure path.',
      destination: 'provider' as const,
      filePath: file.path,
      id: 'comment-failed',
      isReadOnly: true,
      kind: 'submitted-comment' as const,
      lineNumber: 1,
      resolvedSectionId: file.sections[0]!.id,
      side: 'additions' as const,
      threadId: 'thread-failed',
    },
    {
      author: { login: 'reviewer' },
      body: 'Check this while assessment runs.',
      destination: 'provider' as const,
      filePath: file.path,
      id: 'comment-pending',
      isReadOnly: true,
      kind: 'submitted-comment' as const,
      lineNumber: 1,
      resolvedSectionId: file.sections[0]!.id,
      side: 'additions' as const,
      threadId: 'thread-pending',
    },
  ] satisfies ReadonlyArray<ReviewComment>;
  const view = await renderReact(
    <ReviewCodeViewHarness
      assessmentComponents={
        new Map([
          [
            'thread-ready',
            createAssessment('thread-ready', {
              generationMetadata: {
                agent: 'codex',
                generatedAt: '2026-01-01T00:00:00.000Z',
                model: 'gpt-5',
                profile: {
                  agent: 'codex',
                  authoringVersion: 'walkthrough-assessment-1',
                  modelCandidates: ['gpt-5'],
                  settings: {},
                },
              },
              result: { disposition: 'still-applies', explanation: 'The branch is unchanged.' },
              status: 'ready',
            }),
          ],
          [
            'thread-failed',
            createAssessment('thread-failed', {
              error: 'The model timed out.',
              status: 'failed',
            }),
          ],
        ])
      }
      comments={comments}
      files={[file]}
      liveReviewState={{
        currentThreadStateById: new Map([['thread-ready', 'resolved']]),
        pendingAssessmentThreadIds: new Set(['thread-pending']),
      }}
    />,
  );

  try {
    expect(view.container.textContent).toContain('Still applies');
    expect(view.container.textContent).toContain('The branch is unchanged.');
    expect(view.container.textContent).toContain('Currently resolved');
    expect(view.container.textContent).toContain('Failed to assess comment: The model timed out.');
    expect(view.container.textContent).toContain('Assessing');
  } finally {
    await view.cleanup();
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
    kind: 'local-note',
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
    kind: 'local-note',
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
    kind: 'local-note',
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
    destination: 'provider',
    filePath: file.path,
    id: 'comment-details',
    isReadOnly: true,
    kind: 'submitted-comment',
    lineNumber: 1,
    resolvedSectionId: file.sections[0].id,
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
  expect(container.querySelector('[title="Open file in editor"]')).not.toBeNull();
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
    kind: 'local-note',
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
    kind: 'local-note',
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
  expect(onAskCodex).toHaveBeenCalledWith({
    ...comment,
    body: 'Please check this.',
  });
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
    kind: 'local-note',
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
  expect(onAskCodex).toHaveBeenCalledWith(
    expect.objectContaining({ body: 'Explain this change.', id: 'comment-1' }),
  );
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
    kind: 'local-note',
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
            status: 'ready' as const,
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
    kind: 'provider-draft',
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
    kind: 'share-draft',
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

test('file comments can be created for GitLab merge requests and GitHub pull requests', async () => {
  const file: ChangedFile = createChangedFile('src/comment.ts');
  const range = {
    base: { label: { kind: 'commit' as const, text: 'base' }, sha: gitSha('a'.repeat(40)) },
    head: { label: { kind: 'commit' as const, text: 'head' }, sha: gitSha('b'.repeat(40)) },
  };
  file.sections[0]!.range = range;
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
    position: { range },
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
  const gitHubFileCommentButton = view.container.querySelector<HTMLButtonElement>(
    '.codiff-file-comment-button',
  );
  expect(gitHubFileCommentButton).not.toBeNull();
  await act(async () => gitHubFileCommentButton?.click());
  expect(onCreateComment).toHaveBeenLastCalledWith({
    anchor: 'file',
    filePath: 'src/comment.ts',
    position: { range },
    sectionId: 'src/comment.ts:unstaged',
  });
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
          destination: 'provider',
          filePath: file.path,
          id: 'gitlab:file',
          isReadOnly: true,
          kind: 'submitted-comment',
          resolvedSectionId: 'src/comment.ts:unstaged',
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

test('walkthrough regions render as grounded line annotations', async () => {
  const file = createChangedFile('src/app.ts');
  const region = {
    endLine: 1,
    hunkId: 'src/app.ts:unstaged:h1',
    id: 'new-call',
    side: 'additions' as const,
    startLine: 1,
    title: 'New call',
    tooltip: 'This invokes the `replacement` path.',
  };
  const blocks: ReadonlyArray<ReviewDiffBlock> = [
    { file, id: 'walkthrough:stop:0', regions: [region] },
  ];
  const view = await renderReact(<ReviewCodeViewHarness blocks={blocks} files={[]} />);

  try {
    expect(view.container.querySelector('.walkthrough-region-annotation')?.textContent).toContain(
      'New call',
    );
    expect(
      view.container.querySelector('.walkthrough-region-annotation .walkthrough-inline-code')
        ?.textContent,
    ).toBe('replacement');
    const item = codeViewMock.lastItems.find((candidate) =>
      (
        candidate as {
          annotations?: ReadonlyArray<{ metadata: { type: string } }>;
        }
      ).annotations?.some((annotation) => annotation.metadata.type === 'walkthrough-region'),
    ) as
      | {
          annotations?: ReadonlyArray<{
            lineNumber: number;
            metadata: { region?: typeof region; type: string };
            side: string;
          }>;
        }
      | undefined;
    expect(
      item?.annotations?.filter(({ metadata }) => metadata.type === 'walkthrough-region'),
    ).toEqual([
      {
        lineNumber: 1,
        metadata: { active: false, region, type: 'walkthrough-region' },
        side: 'additions',
      },
    ]);

    await view.rerender(<ReviewCodeViewHarness blocks={blocks} files={[]} showWhitespace />);
    expect(
      (
        codeViewMock.lastItems.find((candidate) => candidate.type === 'diff') as {
          annotations?: ReadonlyArray<{ metadata: { type: string } }>;
        }
      ).annotations?.some(({ metadata }) => metadata.type === 'walkthrough-region'),
    ).toBe(true);
  } finally {
    await view.cleanup();
  }
});

test('walkthrough regions highlight their complete side-specific ranges', () => {
  const root = document.createElement('div');
  for (const sideName of ['additions', 'deletions'] as const) {
    const side = document.createElement('div');
    side.dataset[sideName] = '';
    for (let lineNumber = 1; lineNumber <= 4; lineNumber += 1) {
      const line = document.createElement('div');
      line.dataset.line = String(lineNumber);
      const number = document.createElement('div');
      number.dataset.columnNumber = String(lineNumber);
      side.append(line, number);
    }
    root.append(side);
  }
  const regions = [
    {
      endLine: 3,
      hunkId: 'additions-hunk',
      id: 'unit-1:additions',
      side: 'additions' as const,
      startLine: 2,
      title: 'Added range',
      tooltip: 'Added range details.',
    },
    {
      endLine: 2,
      hunkId: 'deletions-hunk',
      id: 'unit-1:deletions',
      side: 'deletions' as const,
      startLine: 1,
      title: 'Deleted range',
      tooltip: 'Deleted range details.',
    },
  ];

  applyWalkthroughRegionHighlights(root, regions, 'unit-1:deletions');

  expect(root.querySelectorAll('[data-additions] [data-walkthrough-region]')).toHaveLength(4);
  expect(root.querySelectorAll('[data-deletions] [data-walkthrough-region]')).toHaveLength(4);
  expect(root.querySelectorAll('[data-walkthrough-region-active]')).toHaveLength(4);
  expect(
    root.querySelector('[data-additions] [data-line="1"][data-walkthrough-region]'),
  ).toBeNull();
  expect(
    root.querySelector('[data-deletions] [data-line="3"][data-walkthrough-region]'),
  ).toBeNull();
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

test('line content clicks create review comments unless text is selected', async () => {
  const onCreateComment = vi.fn();
  const file: ChangedFile = createChangedFileWithPatch(
    'src/click.ts',
    'diff --git a/src/click.ts b/src/click.ts\n@@ -1 +1 @@\n-old\n+new\n',
  );
  const reviewRange = {
    base: { kind: 'index' as const, label: { kind: 'review-marker' as const, text: 'Index' } },
    head: {
      kind: 'working-copy' as const,
      label: { kind: 'review-marker' as const, text: 'Working copy' },
    },
  };
  file.sections[0]!.range = reviewRange;
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
    position: { range: reviewRange },
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
    position: { range: reviewRange },
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

test('read-only patch context resolves through the optional host capability without mutation', async () => {
  const partialFile = createChangedFileWithPatch(
    'src/context.ts',
    'diff --git a/src/context.ts b/src/context.ts\n@@ -2 +2 @@\n-old\n+new\n',
  );
  const file = {
    ...partialFile,
    sections: partialFile.sections.map((section) => ({
      ...section,
      range: {
        base: { label: { kind: 'commit' as const, text: 'base' }, sha: 'a'.repeat(40) as GitSha },
        head: { label: { kind: 'commit' as const, text: 'head' }, sha: 'b'.repeat(40) as GitSha },
      },
    })),
  } satisfies ChangedFile;
  const source = {
    host: 'gitlab.example.com',
    projectPath: 'example/repo',
    provider: 'gitlab' as const,
    type: 'pull-request' as const,
    url: 'https://gitlab.example.com/example/repo/-/merge_requests/1',
  };
  const before = JSON.stringify(file);
  const resolveReviewContext = vi.fn(async () => ({
    newFile: { contents: 'before\nnew\nafter\n', name: file.path },
    oldFile: { contents: 'before\nold\nafter\n', name: file.path },
    status: 'ready' as const,
  }));
  const view = await renderReact(
    <ReviewCodeViewHarness
      files={[file]}
      isReadOnly
      resolveReviewContext={resolveReviewContext}
      source={source}
    />,
  );

  try {
    const item = codeViewMock.lastItems.find((candidate) => candidate.type === 'diff') as
      | { fileDiff: unknown }
      | undefined;
    const loadDiffFiles = codeViewMock.lastOptions?.loadDiffFiles as
      | ((fileDiff: unknown) => Promise<unknown>)
      | undefined;
    expect(loadDiffFiles).toBeTypeOf('function');
    await expect(loadDiffFiles?.(item?.fileDiff)).resolves.toMatchObject({
      newFile: { contents: 'before\nnew\nafter\n' },
      oldFile: { contents: 'before\nold\nafter\n' },
    });
    expect(resolveReviewContext).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: file.path,
        range: file.sections[0]?.range,
        source,
      }),
    );
    expect(JSON.stringify(file)).toBe(before);
  } finally {
    await view.cleanup();
  }
});

test('coverage warnings do not disable immutable context expansion for real files', async () => {
  const partialFile = createChangedFileWithPatch(
    'src/truncated.ts',
    'diff --git a/src/truncated.ts b/src/truncated.ts\n@@ -2 +2 @@\n-old\n+new\n',
  );
  const range = {
    base: {
      label: { kind: 'commit' as const, text: 'base' },
      sha: 'a'.repeat(40) as GitSha,
    },
    head: {
      label: { kind: 'commit' as const, text: 'head' },
      sha: 'b'.repeat(40) as GitSha,
    },
  };
  const file = {
    ...partialFile,
    sections: partialFile.sections.map((section) => ({
      ...section,
      kind: 'pull-request' as const,
      loadState: 'ready' as const,
      range,
    })),
  } satisfies ChangedFile;
  const warning = {
    fingerprint: 'review-range-incomplete:7',
    path: 'Review diff incomplete',
    sections: [
      {
        binary: false,
        id: 'review-range-incomplete:7',
        kind: 'pull-request' as const,
        loadState: 'error' as const,
        patch: '',
        summary: {
          canLoad: false,
          reason: 'GitLab returned only the first changed file.',
        },
      },
    ],
    status: 'modified' as const,
  } satisfies ChangedFile;
  const source = {
    host: 'gitlab.example.com',
    projectPath: 'example/repo',
    provider: 'gitlab' as const,
    type: 'pull-request' as const,
    url: 'https://gitlab.example.com/example/repo/-/merge_requests/7',
  };
  const resolveReviewContext = vi.fn(async () => ({
    newFile: { contents: 'before\nnew\nafter\n', name: file.path },
    oldFile: { contents: 'before\nold\nafter\n', name: file.path },
    status: 'ready' as const,
  }));
  await using view = await renderReact(
    <ReviewCodeViewHarness
      files={[file, warning]}
      isReadOnly
      resolveReviewContext={resolveReviewContext}
      source={source}
    />,
  );

  const diffItems = codeViewMock.lastItems.filter(
    (candidate) => candidate.type === 'diff',
  ) as unknown as Array<{
    fileDiff: { isPartial?: boolean; name?: string };
  }>;
  const realItem = diffItems.find((item) => item.fileDiff.name === file.path);
  const warningItem = diffItems.find((item) => item.fileDiff.name === warning.path);
  const loadDiffFiles = codeViewMock.lastOptions?.loadDiffFiles as
    | ((fileDiff: unknown) => Promise<unknown>)
    | undefined;

  expect(loadDiffFiles).toBeTypeOf('function');
  await expect(loadDiffFiles?.(realItem?.fileDiff)).resolves.toMatchObject({
    newFile: { contents: 'before\nnew\nafter\n' },
    oldFile: { contents: 'before\nold\nafter\n' },
  });
  expect(resolveReviewContext).toHaveBeenCalledWith(
    expect.objectContaining({ filePath: file.path, range, source }),
  );
  expect(view.container.textContent).toContain(warning.path);
  expect(warningItem?.fileDiff.isPartial).toBe(false);
  expect(resolveReviewContext).toHaveBeenCalledTimes(1);
});

test('mutable local sections retain context expansion through the host loader', async () => {
  const partialFile = createChangedFileWithPatch(
    'src/local-context.ts',
    'diff --git a/src/local-context.ts b/src/local-context.ts\n@@ -2 +2 @@\n-old\n+new\n',
  );
  const originalSection = partialFile.sections[0]!;
  const file = {
    ...partialFile,
    sections: [
      { ...originalSection, id: 'src/local-context.ts:staged', kind: 'staged' as const },
      { ...originalSection, id: 'src/local-context.ts:unstaged', kind: 'unstaged' as const },
    ],
  } satisfies ChangedFile;
  const onLoadSectionContents = vi.fn(async (_file: ChangedFile, section: DiffSection) => ({
    newFile: { contents: `before\n${section.kind} new\nafter\n`, name: file.path },
    oldFile: { contents: `before\n${section.kind} old\nafter\n`, name: file.path },
  }));
  const resolveReviewContext = vi.fn(async () => ({
    reason: 'Immutable context should not handle mutable sections.',
    status: 'unavailable' as const,
  }));
  await using _view = await renderReact(
    <ReviewCodeViewHarness
      files={[file]}
      onLoadSectionContents={onLoadSectionContents}
      resolveReviewContext={resolveReviewContext}
      source={{ type: 'working-tree' }}
    />,
  );

  const diffItems = codeViewMock.lastItems.filter(
    (candidate) => candidate.type === 'diff',
  ) as unknown as Array<{ fileDiff: unknown }>;
  const loadDiffFiles = codeViewMock.lastOptions?.loadDiffFiles as
    | ((fileDiff: unknown) => Promise<unknown>)
    | undefined;
  expect(loadDiffFiles).toBeTypeOf('function');
  for (const item of diffItems) {
    await expect(loadDiffFiles?.(item.fileDiff)).resolves.toMatchObject({
      newFile: { contents: expect.stringContaining('new') },
      oldFile: { contents: expect.stringContaining('old') },
    });
  }
  expect(onLoadSectionContents).toHaveBeenCalledTimes(2);
  expect(onLoadSectionContents.mock.calls.map(([, section]) => section.kind)).toEqual([
    'staged',
    'unstaged',
  ]);
  expect(resolveReviewContext).not.toHaveBeenCalled();
});

test('unavailable host context leaves the origin-independent patch review intact', async () => {
  const partialFile = createChangedFile('src/unavailable-context.ts');
  const file = {
    ...partialFile,
    sections: partialFile.sections.map((section) => ({
      ...section,
      range: {
        base: { label: { kind: 'commit' as const, text: 'base' }, sha: 'c'.repeat(40) as GitSha },
        head: { label: { kind: 'commit' as const, text: 'head' }, sha: 'd'.repeat(40) as GitSha },
      },
    })),
  } satisfies ChangedFile;
  const view = await renderReact(
    <ReviewCodeViewHarness
      files={[file]}
      isReadOnly
      resolveReviewContext={async () => ({
        reason: "GitLab could not load before contents for 'src/unavailable-context.ts'.",
        status: 'unavailable',
      })}
      source={{
        host: 'gitlab.example.com',
        projectPath: 'example/repo',
        provider: 'gitlab',
        type: 'pull-request',
        url: 'https://gitlab.example.com/example/repo/-/merge_requests/1',
      }}
    />,
  );

  try {
    const item = codeViewMock.lastItems.find((candidate) => candidate.type === 'diff') as
      | { fileDiff: unknown }
      | undefined;
    const loadDiffFiles = codeViewMock.lastOptions?.loadDiffFiles as (
      fileDiff: unknown,
    ) => Promise<unknown>;
    await expect(loadDiffFiles(item?.fileDiff)).rejects.toThrow(
      "GitLab could not load before contents for 'src/unavailable-context.ts'.",
    );
    expect(codeViewMock.lastItems.some((candidate) => candidate.type === 'diff')).toBe(true);
  } finally {
    await view.cleanup();
  }
});
