import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vite-plus/test';
import { getDiffSearchResult } from '../lib/diff-search.ts';
import {
  canRenderImagePreview,
  getDiffLineCount,
  getMarkdownPreviewContents,
  getTotalDiffLineCount,
  getVisibleDiffSections,
  fileHasVisibleDiff,
  shouldLoadDiffSectionContents,
} from '../lib/diff.ts';
import { isDiffSearchShortcut } from '../lib/keyboard.ts';
import { renderInlineMarkdown, sanitizeMarkdownImages } from '../lib/markdown.tsx';
import {
  buildReviewCommentsMarkdown,
  shouldDiscardReviewCommentOnEscape,
} from '../lib/review-comments.ts';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  readSidebarWidth,
  writeSidebarWidth,
} from '../lib/sidebar-width.ts';
import { getRepositoryLoadError } from '../lib/source.ts';
import type { ChangedFile } from '../types.ts';

const createStorage = (initialValue?: string) => {
  let value = initialValue ?? null;

  return {
    getItem: () => value,
    setItem: (_key: string, nextValue: string) => {
      value = nextValue;
    },
  };
};

test('pure renames are visible without content hunks', () => {
  const file = {
    fingerprint: 'rename-only',
    oldPath: 'old.txt',
    path: 'new.txt',
    sections: [
      {
        binary: false,
        id: 'new.txt:staged',
        kind: 'staged',
        newFile: {
          contents: 'same contents\n',
          name: 'new.txt',
        },
        oldFile: {
          contents: 'same contents\n',
          name: 'old.txt',
        },
        patch:
          'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n',
      },
    ],
    status: 'renamed',
  } satisfies ChangedFile;

  const visibleSections = getVisibleDiffSections(file, false);

  expect(visibleSections).toHaveLength(1);
  expect(visibleSections[0].fileDiff.hunks).toHaveLength(0);
  expect(fileHasVisibleDiff(file, false)).toBe(true);
});

test('patch-only text sections are loadable for full context expansion', () => {
  expect(
    shouldLoadDiffSectionContents({
      binary: false,
      id: 'src/app.ts:unstaged',
      kind: 'unstaged',
      loadState: 'ready',
      patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
    }),
  ).toBe(true);

  expect(
    shouldLoadDiffSectionContents({
      binary: false,
      id: 'src/app.ts:unstaged',
      kind: 'unstaged',
      loadState: 'ready',
      newFile: {
        contents: 'new\n',
        name: 'src/app.ts',
      },
      oldFile: {
        contents: 'old\n',
        name: 'src/app.ts',
      },
      patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
    }),
  ).toBe(false);

  expect(
    shouldLoadDiffSectionContents({
      binary: false,
      id: 'src/app.ts:unstaged',
      kind: 'unstaged',
      loadState: 'ready',
      patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
      summary: {
        canLoad: false,
        reason: 'Codiff could not load full file context.',
      },
    }),
  ).toBe(false);
});

test('empty patch-only sections are not visible or countable', () => {
  const file = {
    fingerprint: 'empty-patch-only',
    path: 'src/spacing.ts',
    sections: [
      {
        binary: false,
        id: 'src/spacing.ts:unstaged',
        kind: 'unstaged',
        loadState: 'ready',
        patch: '',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;

  expect(fileHasVisibleDiff(file, false)).toBe(false);
  expect(getDiffLineCount(file, false)).toEqual({
    additions: 0,
    countable: false,
    deletions: 0,
  });
});

test('mode-only changes are visible without content hunks', () => {
  const file = {
    fingerprint: 'mode-only',
    path: 'script.sh',
    sections: [
      {
        binary: false,
        id: 'script.sh:unstaged',
        kind: 'unstaged',
        newFile: {
          contents: '#!/bin/sh\necho hi\n',
          name: 'script.sh',
        },
        oldFile: {
          contents: '#!/bin/sh\necho hi\n',
          name: 'script.sh',
        },
        patch: 'diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755\n',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;

  const visibleSections = getVisibleDiffSections(file, false);

  expect(visibleSections).toHaveLength(1);
  expect(visibleSections[0].fileDiff.hunks).toHaveLength(0);
  expect(fileHasVisibleDiff(file, false)).toBe(true);
});

test('diff search finds content matches across sides', () => {
  const file = {
    fingerprint: 'content-search',
    path: 'src/search.ts',
    sections: [
      {
        binary: false,
        id: 'src/search.ts:unstaged',
        kind: 'unstaged',
        newFile: {
          contents: 'const label = "beta";\nconst value = "needle";\n',
          name: 'src/search.ts',
        },
        oldFile: {
          contents: 'const label = "alpha";\nconst value = "hay";\n',
          name: 'src/search.ts',
        },
        patch: '',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;

  const result = getDiffSearchResult(file, false, 'needle');

  expect(result?.matches).toEqual([
    {
      filePath: 'src/search.ts',
      itemId: 'diff:src/search.ts:unstaged',
      lineNumber: 2,
      side: 'additions',
    },
  ]);
  expect(result?.matchCount).toBe(1);
});

test('diff search includes file path matches', () => {
  const file = {
    fingerprint: 'path-search',
    path: 'src/needle.ts',
    sections: [
      {
        binary: false,
        id: 'src/needle.ts:unstaged',
        kind: 'unstaged',
        newFile: {
          contents: 'same\n',
          name: 'src/needle.ts',
        },
        oldFile: {
          contents: 'different\n',
          name: 'src/needle.ts',
        },
        patch: '',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;

  expect(getDiffSearchResult(file, false, 'needle')?.matches[0]).toEqual({
    filePath: 'src/needle.ts',
    itemId: 'diff:src/needle.ts:unstaged',
  });
});

test('diff line counts include additions and deletions across sections', () => {
  const file = {
    fingerprint: 'line-counts',
    path: 'src/counts.ts',
    sections: [
      {
        binary: false,
        id: 'src/counts.ts:staged',
        kind: 'staged',
        newFile: {
          contents: 'one\nthree\nfour\n',
          name: 'src/counts.ts',
        },
        oldFile: {
          contents: 'one\ntwo\n',
          name: 'src/counts.ts',
        },
        patch: '',
      },
      {
        binary: false,
        id: 'src/counts.ts:unstaged',
        kind: 'unstaged',
        newFile: {
          contents: 'one\nthree\nfour\nfive\n',
          name: 'src/counts.ts',
        },
        oldFile: {
          contents: 'one\nthree\nfour\n',
          name: 'src/counts.ts',
        },
        patch: '',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;

  expect(getDiffLineCount(file, false)).toEqual({
    additions: 3,
    countable: true,
    deletions: 1,
  });
});

test('diff line counts omit binary summary rows', () => {
  const file = {
    fingerprint: 'binary-counts',
    path: 'image.png',
    sections: [
      {
        binary: true,
        id: 'image.png:unstaged',
        kind: 'unstaged',
        loadState: 'binary',
        patch: '',
        summary: {
          reason: 'Binary file changed.',
        },
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;

  expect(getDiffLineCount(file, false)).toEqual({
    additions: 0,
    countable: false,
    deletions: 0,
  });
});

test('image previews include deferred image sections', () => {
  expect(
    canRenderImagePreview('screenshot.png', {
      binary: false,
      id: 'screenshot.png:unstaged',
      kind: 'unstaged',
      loadState: 'deferred',
      patch: '',
    }),
  ).toBe(true);
  expect(
    canRenderImagePreview('large.jpg', {
      binary: false,
      id: 'large.jpg:unstaged',
      kind: 'unstaged',
      loadState: 'too-large',
      patch: '',
    }),
  ).toBe(true);
  expect(
    canRenderImagePreview('large.txt', {
      binary: false,
      id: 'large.txt:unstaged',
      kind: 'unstaged',
      loadState: 'deferred',
      patch: '',
    }),
  ).toBe(false);
});

test('total diff line counts sum countable files only', () => {
  expect(
    getTotalDiffLineCount([
      {
        additions: 3,
        countable: true,
        deletions: 1,
      },
      {
        additions: 10,
        countable: false,
        deletions: 10,
      },
      {
        additions: 2,
        countable: true,
        deletions: 4,
      },
    ]),
  ).toEqual({
    additions: 5,
    countable: true,
    deletions: 5,
  });

  expect(
    getTotalDiffLineCount([
      {
        additions: 0,
        countable: false,
        deletions: 0,
      },
    ]),
  ).toEqual({
    additions: 0,
    countable: false,
    deletions: 0,
  });
});

test('markdown previews use new file contents for modified files', () => {
  const file = {
    fingerprint: 'markdown-preview-added-lines',
    path: 'README.md',
    sections: [
      {
        binary: false,
        id: 'README.md:unstaged',
        kind: 'unstaged',
        loadState: 'ready',
        newFile: {
          contents: '# Title\nnew paragraph\ncontinued\n- kept\n- added\n',
          name: 'README.md',
        },
        oldFile: {
          contents: '# Title\nold paragraph\n- kept\n',
          name: 'README.md',
        },
        patch: '',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;
  const [{ fileDiff, section }] = getVisibleDiffSections(file, false);

  const preview = getMarkdownPreviewContents(file, section, fileDiff);

  expect(preview?.contents).toBe(file.sections[0].newFile?.contents);
});

test('inline markdown shows markdown and GitHub HTML images', () => {
  const html = renderToStaticMarkup(
    <>
      {renderInlineMarkdown(
        [
          '![diagram](https://example.com/diagram.gif)',
          '',
          '<img width="334" height="399" alt="image" src="https://github.com/user-attachments/assets/c29fc8d3-f2b1-41e3-8759-83a840c6aef2" />',
          '',
          '<img alt="local" src="file:///etc/passwd" />',
        ].join('\n'),
      )}
    </>,
  );

  expect(html.match(/<img/g)).toHaveLength(2);
  expect(html).toContain('src="https://example.com/diagram.gif"');
  expect(html).toContain(
    'src="https://github.com/user-attachments/assets/c29fc8d3-f2b1-41e3-8759-83a840c6aef2"',
  );
  expect(html).toContain('width="334"');
  expect(html).toContain('height="399"');
  expect(html).not.toContain('src="file:///etc/passwd"');
});

test('markdown image sanitization keeps only web image sources', () => {
  const markdown = sanitizeMarkdownImages(
    [
      '![diagram](https://example.com/diagram.gif)',
      '<img width="334" height="399" alt="image" src="https://github.com/user-attachments/assets/c29fc8d3-f2b1-41e3-8759-83a840c6aef2" />',
      '![local](file:///etc/passwd)',
      '<img alt="secret" src="file:///etc/passwd" />',
    ].join('\n'),
  );

  expect(markdown).toContain('![diagram](https://example.com/diagram.gif)');
  expect(markdown).toContain('src="https://github.com/user-attachments/assets/');
  expect(markdown).toContain('local');
  expect(markdown).toContain('secret');
  expect(markdown).not.toContain('file:///etc/passwd');
});

test('diff search shortcut does not claim fullscreen shortcut', () => {
  const baseEvent = {
    altKey: false,
    key: 'f',
    metaKey: false,
    shiftKey: false,
  };

  expect(isDiffSearchShortcut({ ...baseEvent, ctrlKey: false, metaKey: true }, 'MacIntel')).toBe(
    true,
  );
  expect(isDiffSearchShortcut({ ...baseEvent, ctrlKey: true, metaKey: true }, 'MacIntel')).toBe(
    false,
  );
  expect(isDiffSearchShortcut({ ...baseEvent, ctrlKey: true }, 'Win32')).toBe(true);
  expect(isDiffSearchShortcut({ ...baseEvent, ctrlKey: false, metaKey: true }, 'Win32')).toBe(
    false,
  );
});

test('sidebar width clamps persisted values', () => {
  expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 20)).toBe(SIDEBAR_MIN_WIDTH);
  expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 20)).toBe(SIDEBAR_MAX_WIDTH);
  expect(clampSidebarWidth(320.6)).toBe(321);
});

test('sidebar width falls back for missing or invalid storage values', () => {
  expect(readSidebarWidth(createStorage())).toBe(SIDEBAR_DEFAULT_WIDTH);
  expect(readSidebarWidth(createStorage('wide'))).toBe(SIDEBAR_DEFAULT_WIDTH);
});

test('sidebar width reads and writes clamped storage values', () => {
  const storage = createStorage('180');

  expect(readSidebarWidth(storage)).toBe(SIDEBAR_MIN_WIDTH);

  writeSidebarWidth(900, storage);
  expect(readSidebarWidth(storage)).toBe(SIDEBAR_MAX_WIDTH);
});

test('repository load errors hide raw git output for non-repositories', () => {
  const error = getRepositoryLoadError(
    new Error('Command failed: git -C /tmp rev-parse --show-toplevel fatal: not a git repository'),
  );

  expect(error).toEqual({
    kind: 'not-a-repository',
    message:
      'Codiff was opened outside a Git repository. Run `codiff` from inside a repo, or choose File → Open Folder… to open one.',
  });
});

test('review comment markdown includes file and patch context', () => {
  const file = {
    fingerprint: 'comment-export',
    path: 'src/comment.ts',
    sections: [
      {
        binary: false,
        id: 'src/comment.ts:unstaged',
        kind: 'unstaged',
        newFile: {
          contents: 'const label = "alpha";\nconst value = "needle";\n',
          name: 'src/comment.ts',
        },
        oldFile: {
          contents: 'const label = "alpha";\nconst value = "hay";\n',
          name: 'src/comment.ts',
        },
        patch: '',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;

  const markdown = buildReviewCommentsMarkdown(
    [file],
    [
      {
        body: 'Please double-check this value.',
        filePath: 'src/comment.ts',
        id: 'comment-1',
        lineNumber: 2,
        sectionId: 'src/comment.ts:unstaged',
        side: 'additions',
      },
    ],
    false,
  );

  expect(markdown).toContain('# Address these Review Comments');
  expect(markdown).toContain('1. **src/comment.ts** (New line 2)');
  expect(markdown).toContain('Please double-check this value.');
  expect(markdown).toContain('```diff');
  expect(markdown).toContain('+   2 | const value = "needle";');
  expect(markdown.indexOf('```diff')).toBeLessThan(
    markdown.indexOf('Please double-check this value.'),
  );
});

test('review comment markdown uses custom prefix', () => {
  const file = {
    fingerprint: 'comment-export',
    path: 'src/comment.ts',
    sections: [
      {
        binary: false,
        id: 'src/comment.ts:unstaged',
        kind: 'unstaged',
        newFile: {
          contents: 'const label = "alpha";\nconst value = "needle";\n',
          name: 'src/comment.ts',
        },
        oldFile: {
          contents: 'const label = "alpha";\nconst value = "hay";\n',
          name: 'src/comment.ts',
        },
        patch: '',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;

  const markdown = buildReviewCommentsMarkdown(
    [file],
    [
      {
        body: 'Check this.',
        filePath: 'src/comment.ts',
        id: 'comment-1',
        lineNumber: 2,
        sectionId: 'src/comment.ts:unstaged',
        side: 'additions',
      },
    ],
    false,
    '## Review Notes',
  );

  expect(markdown).toMatch(/^## Review Notes\n\n/);
  expect(markdown).not.toContain('Address these Review Comments');
});

test('review comment markdown omits prefix when set to empty string', () => {
  const file = {
    fingerprint: 'comment-export',
    path: 'src/comment.ts',
    sections: [
      {
        binary: false,
        id: 'src/comment.ts:unstaged',
        kind: 'unstaged',
        newFile: {
          contents: 'const label = "alpha";\nconst value = "needle";\n',
          name: 'src/comment.ts',
        },
        oldFile: {
          contents: 'const label = "alpha";\nconst value = "hay";\n',
          name: 'src/comment.ts',
        },
        patch: '',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;

  const markdown = buildReviewCommentsMarkdown(
    [file],
    [
      {
        body: 'Check this.',
        filePath: 'src/comment.ts',
        id: 'comment-1',
        lineNumber: 2,
        sectionId: 'src/comment.ts:unstaged',
        side: 'additions',
      },
    ],
    false,
    '',
  );

  expect(markdown).toMatch(/^1\. \*\*/);
  expect(markdown).not.toContain('Address these Review Comments');
});

test('review comment markdown includes multi-line ranges', () => {
  const file = {
    fingerprint: 'comment-range-export',
    path: 'src/range.ts',
    sections: [
      {
        binary: false,
        id: 'src/range.ts:unstaged',
        kind: 'unstaged',
        newFile: {
          contents: 'const first = true;\nconst second = true;\n',
          name: 'src/range.ts',
        },
        oldFile: {
          contents: '',
          name: 'src/range.ts',
        },
        patch: '',
      },
    ],
    status: 'added',
  } satisfies ChangedFile;

  const markdown = buildReviewCommentsMarkdown(
    [file],
    [
      {
        body: 'These should be considered together.',
        filePath: 'src/range.ts',
        id: 'comment-1',
        lineNumber: 2,
        sectionId: 'src/range.ts:unstaged',
        side: 'additions',
        startLineNumber: 1,
      },
    ],
    false,
  );

  expect(markdown).toContain('1. **src/range.ts** (New lines 1-2)');
  expect(markdown).toContain('+   1 | const first = true;');
  expect(markdown).toContain('+   2 | const second = true;');
  expect(markdown).toContain('+   1 | const first = true;\n   +   2 | const second = true;');
  expect(markdown).not.toContain('const first = true;\n\n   +');
});

test('escape discards empty review comments without confirmation', () => {
  let confirmationCount = 0;

  expect(
    shouldDiscardReviewCommentOnEscape('   ', () => {
      confirmationCount += 1;
      return false;
    }),
  ).toBe(true);
  expect(confirmationCount).toBe(0);
});

test('escape confirms before discarding review comments with text', () => {
  expect(shouldDiscardReviewCommentOnEscape('Needs work.', () => false)).toBe(false);
  expect(shouldDiscardReviewCommentOnEscape('Needs work.', () => true)).toBe(true);
});
