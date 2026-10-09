/** @vitest-environment jsdom */
import {
  DiffHunksRenderer,
  parseDiffFromFile,
  parsePatchFiles,
  preloadHighlighter,
  type CodeViewDiffItem,
  type FileDiffLoadedFiles,
} from '@pierre/diffs';
import { CodeView, EditProvider, type CodeViewHandle } from '@pierre/diffs/react';
import { act, useMemo, useRef, useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import {
  createCodeEditor,
  createCodeEditingStore,
  useCodeEditing,
  type CodeEditingStore,
} from '../app/hooks/useCodeEditing.ts';
import type { CodeViewItemMetadata, ReviewAnnotationMetadata } from '../lib/app-types.ts';
import { getDiffParseOptions, loadSectionContents } from '../lib/diff.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

const file = createChangedFile('source.txt');
const item: CodeViewDiffItem<ReviewAnnotationMetadata> = {
  fileDiff: {
    ...parseDiffFromFile(
      { contents: 'old\n', name: file.path },
      { contents: 'new\n', name: file.path },
    ),
    cacheKey: 'editing-fixture',
  },
  id: file.sections[0]!.id,
  type: 'diff',
};
const metadata: CodeViewItemMetadata = {
  blockId: 'source',
  canEditMarkdown: false,
  canRenderMarkdown: false,
  comments: [],
  file,
  isCollapsed: false,
  isMarkdownPreview: false,
  isSelected: true,
  isViewed: false,
  lineCount: { additions: 1, countable: true, deletions: 1 },
  reviewIdentity: { fingerprint: file.fingerprint, key: file.path },
  section: file.sections[0]!,
  sectionCount: 1,
};
const otherFile = createChangedFile('other.txt');
const otherItem: CodeViewDiffItem<ReviewAnnotationMetadata> = {
  ...item,
  fileDiff: {
    ...parseDiffFromFile(
      { contents: 'old\n', name: otherFile.path },
      { contents: 'new\n', name: otherFile.path },
    ),
    cacheKey: 'editing-other-fixture',
  },
  id: otherFile.sections[0]!.id,
};
const otherMetadata: CodeViewItemMetadata = {
  ...metadata,
  file: otherFile,
  reviewIdentity: { fingerprint: otherFile.fingerprint, key: otherFile.path },
  section: otherFile.sections[0]!,
};
const loaded = {
  newFile: { contents: 'new\n', name: file.path },
  oldFile: { contents: 'old\n', name: file.path },
};
const refresh = vi.fn(async () => true);
let handle: CodeViewHandle<ReviewAnnotationMetadata, undefined> | null;
let preparation: Promise<void> | null;
let testStore: CodeEditingStore;

function Harness({
  contents = 'new\n',
  diffStyle = 'split',
  editMetadata = metadata,
  fileDiff,
  hidden = false,
  loadContents,
  multiple = false,
  oldContents = contents.replace(/^new/, 'old'),
  onRefresh = refresh,
  selectedItemId,
  showWhitespace = true,
  sourceKey = 'working-tree',
  store = testStore,
}: {
  contents?: string;
  diffStyle?: 'split' | 'unified';
  editMetadata?: CodeViewItemMetadata;
  fileDiff?: CodeViewDiffItem<ReviewAnnotationMetadata>['fileDiff'];
  hidden?: boolean;
  loadContents?: () => Promise<FileDiffLoadedFiles>;
  multiple?: boolean;
  oldContents?: string;
  onRefresh?: () => Promise<boolean>;
  selectedItemId?: string;
  showWhitespace?: boolean;
  sourceKey?: string;
  store?: CodeEditingStore;
}) {
  const ref = useRef<CodeViewHandle<ReviewAnnotationMetadata, undefined>>(null);
  const codeItem = useMemo(
    () =>
      fileDiff
        ? { ...item, fileDiff }
        : contents === 'new\n'
          ? item
          : {
              ...item,
              fileDiff: parseDiffFromFile(
                { contents: oldContents, name: file.path },
                { contents, name: file.path },
              ),
            },
    [contents, fileDiff, oldContents],
  );
  const load =
    loadContents ??
    (async () =>
      contents === 'new\n'
        ? loaded
        : {
            newFile: { contents, name: file.path },
            oldFile: { contents: oldContents, name: file.path },
          });
  const editing = useCodeEditing({
    codeViewRef: ref,
    items: hidden ? [] : multiple ? [codeItem, otherItem] : [codeItem],
    onLoadSectionContents: load,
    onRefresh,
    selectedItemId,
    sourceKey,
    store,
  });
  return (
    <>
      <button
        onClick={() => {
          preparation = editing.prepareEdit(codeItem, editMetadata);
        }}
        type="button"
      >
        Prepare
      </button>
      <button
        disabled={!editing.canStartEdit(codeItem.id, editMetadata.file.path)}
        onClick={() =>
          void editing.startEdit(
            editing.items.find((candidate) => candidate.id === codeItem.id) ?? codeItem,
            editMetadata,
          )
        }
        type="button"
      >
        Edit
      </button>
      <button onClick={() => void editing.doneEdit(item.id)} type="button">
        Done
      </button>
      <button onClick={() => void editing.revertEdit(item.id)} type="button">
        Revert
      </button>
      {editing.getError(item.id) ? <div role="alert">{editing.getError(item.id)}</div> : null}
      {multiple ? (
        <>
          <button
            disabled={!editing.canStartEdit(otherItem.id, otherFile.path)}
            onClick={() => void editing.startEdit(otherItem, otherMetadata)}
            type="button"
          >
            Edit other.txt
          </button>
          <button onClick={() => void editing.doneEdit(otherItem.id)} type="button">
            Done other.txt
          </button>
          <button onClick={() => void editing.revertEdit(otherItem.id)} type="button">
            Revert other.txt
          </button>
          {editing.getError(otherItem.id) ? (
            <div role="alert">other.txt: {editing.getError(otherItem.id)}</div>
          ) : null}
        </>
      ) : null}
      <EditProvider createEditor={createCodeEditor}>
        <CodeView
          className="code-view"
          disableWorkerPool
          editorOptions={editing.editorOptions}
          items={editing.items}
          onItemEditChange={editing.onItemEditChange}
          onItemEditComplete={editing.onItemEditComplete}
          options={{
            diffStyle,
            disableErrorHandling: true,
            loadDiffFiles: () => loadSectionContents(editMetadata.file, editMetadata.section, load),
            parseDiffOptions: getDiffParseOptions(showWhitespace),
            stickyHeaders: true,
            theme: 'github-dark',
            themeType: 'dark',
            useTokenTransformer: true,
          }}
          ref={(value) => {
            ref.current = value;
            handle = value;
          }}
        />
      </EditProvider>
    </>
  );
}

beforeEach(async () => {
  testStore = createCodeEditingStore();
  // jsdom does not measure text. Use fixed monospace metrics while exercising
  // Pierre's real editor, document, diff renderer, and completion callbacks.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 8 }),
  } as unknown as CanvasRenderingContext2D);
  await preloadHighlighter({ langs: ['text'], themes: ['github-dark'] });
  refresh.mockReset().mockResolvedValue(true);
  preparation = null;
  window.codiff = {
    getRepositoryFile: vi.fn(async (path) => ({
      content: 'new\n',
      path,
      root: '/repo',
      version: 'version',
    })),
    saveRepositoryFile: vi.fn(async (request) => ({
      document: { ...request, version: 'saved-version' },
      status: 'saved',
    })),
  } as unknown as Window['codiff'];
});

afterEach(() => {
  testStore.clear();
  vi.restoreAllMocks();
});

const click = async (container: HTMLElement, label: string) => {
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === label)
      ?.click();
  });
};
const edit = async (itemId = item.id, newText = 'updated') => {
  await act(async () => {
    handle?.getInstance()?.render(true);
  });
  await waitFor(() => expect(handle?.getEditor(itemId)?.getFile()).toBeDefined());
  await act(async () => {
    handle!.getEditor(itemId)!.applyEdits([
      {
        newText,
        range: { end: { character: 3, line: 0 }, start: { character: 0, line: 0 } },
      },
    ]);
  });
};

test('starting an edit reuses highlighted markup without highlighting the file again', async () => {
  const fileDiff = {
    ...item.fileDiff,
    cacheKey: 'editing-highlight-fixture',
    lang: 'tsx' as const,
  };
  const highlight = vi.spyOn(DiffHunksRenderer.prototype, 'renderDiffWithHighlighter');
  await using view = await renderReact(<Harness fileDiff={fileDiff} />);
  await click(view.container, 'Prepare');
  await act(async () => {
    await preparation;
    handle?.getInstance()?.render(true);
  });
  await waitFor(() =>
    expect(highlight.mock.calls.some(([, , plainText]) => !plainText)).toBe(true),
  );
  highlight.mockClear();
  await click(view.container, 'Edit');
  await act(async () => handle?.getInstance()?.render(true));
  await waitFor(() => expect(handle?.getEditor(item.id)?.getFile()).toBeDefined());
  expect(highlight).not.toHaveBeenCalled();
});

test('warming an editor preserves the highlighted partial diff while preparing a separate full copy', async () => {
  await preloadHighlighter({ langs: ['tsx'], themes: ['github-dark'] });
  const oldContents =
    'const first = 1;\nconst second = 2;\nconst value = "old";\nconst last = 4;\n';
  const contents = oldContents.replace('"old"', '"new"');
  const fileDiff = {
    ...parsePatchFiles(
      `diff --git a/source.txt b/source.txt
--- a/source.txt
+++ b/source.txt
@@ -2,3 +2,3 @@
 const second = 2;
-const value = "old";
+const value = "new";
 const last = 4;
`,
      'highlight-warmup',
    )[0]!.files[0]!,
    lang: 'tsx' as const,
  };
  const editMetadata = {
    ...metadata,
    file: { ...file, fingerprint: 'highlight-warmup' },
  };
  vi.mocked(window.codiff.getRepositoryFile).mockResolvedValue({
    content: contents,
    path: file.path,
    root: '/repo',
    version: 'version',
  });
  await using view = await renderReact(
    <Harness
      contents={contents}
      editMetadata={editMetadata}
      fileDiff={fileDiff}
      oldContents={oldContents}
    />,
  );
  const rendered = handle!.getInstance()!.getRenderedItems()[0]!;
  if (rendered.type !== 'diff') {
    throw new Error('Expected a diff');
  }
  await waitFor(() =>
    expect(rendered.element.shadowRoot!.querySelector('[data-content] span[style]')).not.toBeNull(),
  );
  const markup = () =>
    [...rendered.element.shadowRoot!.querySelectorAll('[data-content]')].map(
      (node) => node.innerHTML,
    );
  const before = markup();
  const original = structuredClone(fileDiff);
  const pending = Promise.withResolvers<void>();
  const prime = vi
    .spyOn(rendered.instance, 'primeHighlightCache')
    .mockImplementationOnce(() => pending.promise);
  await click(view.container, 'Prepare');
  await waitFor(() => expect(prime).toHaveBeenCalledOnce());
  const prepared = prime.mock.calls[0]![0]!;
  expect(prepared).not.toBe(fileDiff);
  expect(prepared.isPartial).toBe(false);
  expect(prepared.additionLines.join('')).toBe(contents);
  expect(fileDiff).toEqual(original);
  // Other startup updates can render while the full-file worker is pending.
  await act(async () => handle?.getInstance()?.render(true));
  expect(markup()).toEqual(before);
  await act(async () => {
    pending.resolve();
    await preparation;
  });
  expect(fileDiff).toEqual(original);
  expect(markup()).toEqual(before);
  await click(view.container, 'Edit');
  await waitFor(() => expect(handle?.getEditor(item.id)?.getFile()).toBeDefined());
  expect(prime.mock.calls.at(-1)![0]!.cacheKey).toBe(prepared.cacheKey);
});

test.each([true, false])(
  'editing reuses prepared contents and checks disk concurrently (prepared: %s)',
  async (prepareFirst) => {
    const oldContents = 'first\nsecond\nold\nfourth\nfifth\n';
    const contents = oldContents.replace('old', 'new');
    const patch = `diff --git a/source.txt b/source.txt
--- a/source.txt
+++ b/source.txt
@@ -2,3 +2,3 @@
 second
-old
+new
 fourth
`;
    const fileDiff = parsePatchFiles(patch)[0]!.files[0]!;
    const editMetadata = {
      ...metadata,
      file: { ...file, fingerprint: `prepared-edit:${prepareFirst}` },
    };
    const pending = Promise.withResolvers<FileDiffLoadedFiles>();
    const loadContents = vi.fn(() => pending.promise);
    vi.mocked(window.codiff.getRepositoryFile).mockResolvedValue({
      content: contents,
      path: file.path,
      root: '/repo',
      version: 'version',
    });
    await using view = await renderReact(
      <Harness
        contents={contents}
        editMetadata={editMetadata}
        fileDiff={fileDiff}
        loadContents={loadContents}
      />,
    );
    if (prepareFirst) {
      await click(view.container, 'Prepare');
      expect(loadContents).toHaveBeenCalledOnce();
      expect(window.codiff.getRepositoryFile).not.toHaveBeenCalled();
    } else {
      await click(view.container, 'Edit');
      // Reading disk must start without waiting for the Git contents request.
      expect(window.codiff.getRepositoryFile).toHaveBeenCalledOnce();
    }
    await act(async () => {
      pending.resolve({
        newFile: { contents, name: file.path },
        oldFile: { contents: oldContents, name: file.path },
      });
      await preparation;
    });
    if (prepareFirst) {
      await click(view.container, 'Edit');
    }
    await act(async () => handle?.getInstance()?.render(true));
    await waitFor(() => expect(handle?.getEditor(item.id)?.getText()).toBe(contents));
    expect(loadContents).toHaveBeenCalledOnce();
    expect(window.codiff.getRepositoryFile).toHaveBeenCalledOnce();

    await click(view.container, 'Revert');
    vi.mocked(window.codiff.getRepositoryFile).mockResolvedValue({
      content: 'changed outside Codiff\n',
      path: file.path,
      root: '/repo',
      version: 'external-version',
    });
    await click(view.container, 'Edit');
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'changed on disk',
    );
    expect(handle?.getEditor(item.id)).toBeUndefined();
    expect(loadContents).toHaveBeenCalledOnce();
    expect(window.codiff.getRepositoryFile).toHaveBeenCalledTimes(2);
  },
);

test.each(['split', 'unified'] as const)(
  'starting an edit preserves the displayed hunk and context in %s view',
  async (diffStyle) => {
    const getRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.hasAttribute('data-diffs-header')) {
        return new DOMRect(0, 0, 1024, 54);
      }
      if (this.hasAttribute('data-line')) {
        return new DOMRect(0, 84 + (Number(this.dataset.line) - 103) * 20, 900, 20);
      }
      return getRect.call(this);
    });
    const oldLines = Array.from({ length: 180 }, (_, index) => `line ${index + 1}\n`);
    oldLines[101] = 'ref,\n';
    oldLines[102] = '() => ({\n';
    oldLines[103] = 'clearSelectedLines: () => {},\n';
    oldLines[104] = 'getInstance: () => viewer,\n';
    const newLines = [...oldLines];
    newLines.splice(105, 0, '\t  getItem: id => items.find(item => item.id === id),\n');
    // The full document can include changes outside a focused review hunk.
    newLines[160] = 'another change\n';
    const contents = newLines.join('');
    const fileDiff = parsePatchFiles(
      `diff --git a/source.txt b/source.txt
--- a/source.txt
+++ b/source.txt
@@ -103,6 +103,7 @@
 () => ({
 clearSelectedLines: () => {},
 getInstance: () => viewer,
+\t  getItem: id => items.find(item => item.id === id),
 line 106
 line 107
 line 108
`,
    )[0]!.files[0]!;
    expect(fileDiff.isPartial).toBe(true);
    vi.mocked(window.codiff.getRepositoryFile).mockResolvedValue({
      content: contents,
      path: file.path,
      root: '/repo',
      version: 'version',
    });
    await using view = await renderReact(
      <Harness
        contents={contents}
        diffStyle={diffStyle}
        fileDiff={fileDiff}
        oldContents={oldLines.join('')}
      />,
    );
    const renderedLines = () =>
      Array.from(
        handle!
          .getInstance()!
          .getRenderedItems()[0]!
          .element.shadowRoot!.querySelectorAll('[data-line]'),
        (line) => line.getAttribute('data-line'),
      );
    await act(async () => handle?.getInstance()?.render(true));
    await waitFor(() => expect(renderedLines()).toContain('103'));
    const before = renderedLines();
    expect(before).not.toContain('102');
    await click(view.container, 'Edit');
    await act(async () => {
      handle?.getInstance()?.render(true);
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
      );
    });
    await waitFor(() => expect(handle?.getEditor(item.id)?.getFile()).toBeDefined());
    await waitFor(() =>
      expect(handle?.getEditor(item.id)?.getViewState().selections?.[0]?.start).toEqual({
        character: 3,
        line: 105,
      }),
    );
    expect(renderedLines()).toEqual(before);
    expect(handle!.getEditor(item.id)!.getText()).toBe(contents);
    expect(fileDiff.isPartial).toBe(true);
  },
);

test('starting an edit targets the first change in the visible hunk instead of earlier hunks', async () => {
  const oldLines = Array.from({ length: 180 }, (_, index) => `line ${index + 1}\n`);
  const newLines = [...oldLines];
  newLines[105] = 'first change\n';
  newLines[160] = 'visible change\n';
  const contents = newLines.join('');
  const fileDiff = parseDiffFromFile(
    { contents: oldLines.join(''), name: file.path },
    { contents, name: file.path },
    { context: 3 },
  );
  const getRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute('data-diffs-header')) {
      return new DOMRect(0, 0, 1024, 54);
    }
    if (this.hasAttribute('data-line')) {
      const line = Number(this.dataset.line);
      return new DOMRect(
        0,
        line < 150 ? -200 + (line - 103) * 20 : 80 + (line - 158) * 20,
        900,
        20,
      );
    }
    return getRect.call(this);
  });
  vi.mocked(window.codiff.getRepositoryFile).mockResolvedValue({
    content: contents,
    path: file.path,
    root: '/repo',
    version: 'version',
  });
  await using view = await renderReact(<Harness contents={contents} fileDiff={fileDiff} />);
  await click(view.container, 'Edit');
  await act(async () => {
    handle?.getInstance()?.render(true);
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
    );
  });
  await waitFor(() =>
    expect(handle?.getEditor(item.id)?.getViewState().selections?.[0]?.start).toEqual({
      character: 0,
      line: 160,
    }),
  );
});

test('starting an edit focuses visible code below the sticky header without scrolling', async () => {
  const contents = 'new\nsecond\nthird\nfourth\nfifth\n';
  vi.mocked(window.codiff.getRepositoryFile).mockResolvedValue({
    content: contents,
    path: file.path,
    root: '/repo',
    version: 'version',
  });
  const getRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute('data-diffs-header')) {
      return new DOMRect(0, 0, 1024, 54);
    }
    if (this.hasAttribute('data-line')) {
      return new DOMRect(0, 10 + Number(this.dataset.line) * 20, 900, 20);
    }
    return getRect.call(this);
  });
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  try {
    await using view = await renderReact(<Harness contents={contents} />);
    const viewport = view.container.querySelector<HTMLElement>('.code-view')!;
    viewport.scrollTop = 160;
    await click(view.container, 'Edit');
    await act(async () => {
      handle?.getInstance()?.render(true);
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
      );
    });
    await waitFor(() =>
      expect(handle?.getEditor(item.id)?.getViewState().selections?.[0]?.start.line).toBe(2),
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(160);
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  }
});

test('Done saves complete Pierre contents; Revert discards a draft before auto-save', async () => {
  await using view = await renderReact(<Harness />);
  await click(view.container, 'Edit');
  await edit();
  expect(handle!.getEditor(item.id)!.getText()).toBe('updated\n');
  expect(item.fileDiff.additionLines.join('')).toBe('new\n');
  expect(window.codiff.saveRepositoryFile).not.toHaveBeenCalled();
  await click(view.container, 'Done');
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(window.codiff.saveRepositoryFile).toHaveBeenCalledWith(
    expect.objectContaining({ baseVersion: 'version', content: 'updated\n', path: file.path }),
  );
  expect(handle?.getEditor(item.id)).toBeUndefined();
  vi.mocked(window.codiff.getRepositoryFile).mockResolvedValue({
    content: 'updated\n',
    path: file.path,
    root: '/repo',
    version: 'saved-version',
  });
  await click(view.container, 'Edit');
  await edit();
  await click(view.container, 'Revert');
  expect(window.codiff.saveRepositoryFile).toHaveBeenCalledOnce();
  expect(handle?.getEditor(item.id)).toBeUndefined();
  expect(handle?.getItem(item.id)?.edit).toBeFalsy();
});

test('auto-save keeps Pierre editing and the hunk stable; Revert restores the starting content', async () => {
  await using view = await renderReact(<Harness />);
  await click(view.container, 'Edit');
  await edit();
  const editor = handle!.getEditor(item.id)!;
  const editedItem = handle!.getItem(item.id)!;
  if (editedItem.type !== 'diff') {
    throw new Error('Expected an editable diff');
  }
  const selection = editor.getViewState().selections;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  expect(window.codiff.saveRepositoryFile).toHaveBeenCalledOnce();
  expect(handle?.getEditor(item.id)).toBe(editor);
  const savedItem = handle?.getItem(item.id);
  expect(savedItem?.type === 'diff' ? savedItem.fileDiff : undefined).toBe(editedItem.fileDiff);
  expect(editor.getViewState().selections).toEqual(selection);
  expect(refresh).not.toHaveBeenCalled();
  await click(view.container, 'Revert');
  expect(window.codiff.saveRepositoryFile).toHaveBeenLastCalledWith(
    expect.objectContaining({ baseVersion: 'saved-version', content: 'new\n' }),
  );
  expect(refresh).toHaveBeenCalledOnce();
  expect(handle?.getEditor(item.id)).toBeUndefined();
});

test.each(['Done', 'Revert'])(
  '%s installs the finished diff before repository refresh completes',
  async (action) => {
    const pending = Promise.withResolvers<boolean>();
    refresh.mockImplementationOnce(() => pending.promise);
    await using view = await renderReact(<Harness />);
    await click(view.container, 'Edit');
    await edit(item.id, 'updated\nextra line');
    await act(async () => {
      await testStore.flush('working-tree');
    });
    await click(view.container, action);
    expect(refresh).toHaveBeenCalledOnce();
    expect(handle?.getEditor(item.id)).toBeUndefined();
    expect(testStore.getSnapshot().size).toBe(0);
    const completed = handle!.getItem(item.id)!;
    expect(completed.type === 'diff' && completed.fileDiff.additionLines.join('')).toBe(
      action === 'Done' ? 'updated\nextra line\n' : 'new\n',
    );
    await act(async () => pending.resolve(true));
    await view.rerender(<Harness />);
    const retained = handle!.getItem(item.id)!;
    expect(retained.type === 'diff' && retained.fileDiff).toBe(
      completed.type === 'diff' && completed.fileDiff,
    );
  },
);

test('a failed repository refresh keeps the accepted diff and reports the saved state', async () => {
  refresh.mockResolvedValueOnce(false);
  await using view = await renderReact(<Harness />);
  await click(view.container, 'Edit');
  await edit();
  await click(view.container, 'Done');
  expect(handle?.getEditor(item.id)).toBeUndefined();
  const completed = handle!.getItem(item.id)!;
  expect(completed.type === 'diff' && completed.fileDiff.additionLines.join('')).toBe('updated\n');
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('File saved');
  expect(testStore.getSnapshot().size).toBe(0);
  expect(window.codiff.saveRepositoryFile).toHaveBeenCalledOnce();
});

test.each(['split', 'unified'] as const)(
  'Done preserves expanded context and collapsed separators in %s view',
  async (diffStyle) => {
    const oldLines = Array.from({ length: 240 }, (_, index) => `line ${index + 1}\n`);
    const newLines = [...oldLines];
    newLines[20] = 'new first\n';
    newLines[100] = 'new second\n';
    const oldContents = oldLines.join('');
    const initialContents = newLines.join('');
    vi.mocked(window.codiff.getRepositoryFile).mockResolvedValue({
      content: initialContents,
      path: file.path,
      root: '/repo',
      version: 'version',
    });
    function RefreshingHarness() {
      const [contents, setContents] = useState(initialContents);
      const fileDiff = useMemo(
        () =>
          parseDiffFromFile(
            { contents: oldContents, name: file.path },
            { contents, name: file.path },
            { context: 3 },
          ),
        [contents],
      );
      return (
        <Harness
          contents={contents}
          diffStyle={diffStyle}
          fileDiff={fileDiff}
          oldContents={oldContents}
          onRefresh={async () => {
            const completed = handle!.getItem(item.id)!;
            if (completed.type === 'diff') {
              setContents(completed.fileDiff.additionLines.join(''));
            }
            return true;
          }}
        />
      );
    }
    await using view = await renderReact(<RefreshingHarness />);
    await click(view.container, 'Edit');
    await act(async () => handle?.getInstance()?.render(true));
    await waitFor(() => expect(handle?.getEditor(item.id)?.getFile()).toBeDefined());
    const rendered = handle!.getInstance()!.getRenderedItems()[0]!;
    if (rendered.type !== 'diff') {
      throw new Error('Expected a diff');
    }
    await act(async () => {
      rendered.instance.expandHunk(1, 'up', 20);
      handle?.getInstance()?.render(true);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    await act(async () => {
      handle!.getEditor(item.id)!.applyEdits([
        {
          newText: 'updated',
          range: { end: { character: 3, line: 20 }, start: { character: 0, line: 20 } },
        },
      ]);
      handle?.getInstance()?.render(true);
    });
    const layout = () => ({
      height: handle!.getInstance()!.getScrollHeight(),
      rows: [...rendered.element.shadowRoot!.querySelectorAll('[data-content] > [data-line]')].map(
        (node) => node.getAttribute('data-line'),
      ),
      separators: [
        ...rendered.element.shadowRoot!.querySelectorAll('[data-separator-content]'),
      ].map((node) => node.textContent),
    });
    const before = layout();
    expect(before.rows).toContain('44');
    await click(view.container, 'Done');
    await act(async () => handle?.getInstance()?.render(true));
    await waitFor(() => expect(handle?.getEditor(item.id)).toBeUndefined());
    expect(layout()).toEqual(before);
  },
);

test('conflicts retain the editable draft, including when background items disappear', async () => {
  vi.mocked(window.codiff.saveRepositoryFile).mockResolvedValue({
    document: {
      content: 'external\n',
      path: file.path,
      root: '/repo',
      version: 'external-version',
    },
    status: 'conflict',
  });
  await using view = await renderReact(<Harness />);
  await click(view.container, 'Edit');
  await edit();
  await view.rerender(<Harness hidden />);
  await click(view.container, 'Done');
  await waitFor(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'changed on disk',
    ),
  );
  expect(handle!.getEditor(item.id)!.getText()).toBe('updated\n');
  expect(refresh).not.toHaveBeenCalled();
});

test('returning to a source restores its unsaved draft', async () => {
  await using view = await renderReact(<Harness />);
  await click(view.container, 'Edit');
  await edit();
  await view.rerender(<Harness hidden sourceKey="commit" />);
  expect(handle?.getEditor(item.id)).toBeUndefined();
  await view.rerender(<Harness />);
  await act(async () => {
    handle?.getInstance()?.render(true);
  });
  await waitFor(() => expect(handle?.getEditor(item.id)?.getText()).toBe('updated\n'));
  expect(window.codiff.saveRepositoryFile).not.toHaveBeenCalled();
});

test('tree and walkthrough surface remounts retain the draft in the App store', async () => {
  const store = createCodeEditingStore();
  await using view = await renderReact(<Harness store={store} />);
  await click(view.container, 'Edit');
  await edit();
  await view.rerender(<div />);
  await view.rerender(<Harness store={store} />);
  await act(async () => {
    handle?.getInstance()?.render(true);
  });
  await waitFor(() => expect(handle?.getEditor(item.id)?.getText()).toBe('updated\n'));
  await click(view.container, 'Done');
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(window.codiff.saveRepositoryFile).toHaveBeenCalledWith(
    expect.objectContaining({ content: 'updated\n' }),
  );
});

test('Revert after a source switch restores the original diff and disk contents', async () => {
  await using view = await renderReact(<Harness />);
  await click(view.container, 'Edit');
  await edit();
  await act(async () => {
    await testStore.flush('working-tree');
  });
  await view.rerender(<Harness hidden sourceKey="commit" />);
  await view.rerender(<Harness />);
  await act(async () => handle?.getInstance()?.render(true));
  await waitFor(() => expect(handle?.getEditor(item.id)?.getText()).toBe('updated\n'));
  await click(view.container, 'Revert');
  expect(handle?.getEditor(item.id)).toBeUndefined();
  const reverted = handle!.getItem(item.id)!;
  expect(reverted.type === 'diff' && reverted.fileDiff.additionLines.join('')).toBe('new\n');
  expect(window.codiff.saveRepositoryFile).toHaveBeenLastCalledWith(
    expect.objectContaining({ baseVersion: 'saved-version', content: 'new\n' }),
  );
});

test('Done drains input typed during a save using the updated disk version', async () => {
  const { promise, resolve: finishSave } =
    Promise.withResolvers<Awaited<ReturnType<Window['codiff']['saveRepositoryFile']>>>();
  vi.mocked(window.codiff.saveRepositoryFile).mockImplementationOnce(() => promise);
  await using view = await renderReact(<Harness />);
  await click(view.container, 'Edit');
  await edit();
  await click(view.container, 'Done');
  await act(async () => {
    handle!.getEditor(item.id)!.applyEdits([
      {
        newText: 'more ',
        range: { end: { character: 0, line: 0 }, start: { character: 0, line: 0 } },
      },
    ]);
    finishSave({
      document: { content: 'updated\n', path: file.path, root: '/repo', version: 'saved-version' },
      status: 'saved',
    });
  });
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(window.codiff.saveRepositoryFile).toHaveBeenLastCalledWith(
    expect.objectContaining({ baseVersion: 'saved-version', content: 'more updated\n' }),
  );
  expect(handle?.getEditor(item.id)).toBeUndefined();
});

test('different files can enter edit mode while another file is still loading', async () => {
  const pending =
    Promise.withResolvers<Awaited<ReturnType<Window['codiff']['getRepositoryFile']>>>();
  vi.mocked(window.codiff.getRepositoryFile).mockImplementationOnce(() => pending.promise);
  await using view = await renderReact(<Harness multiple />);
  await click(view.container, 'Edit');
  await click(view.container, 'Edit other.txt');
  await act(async () => handle?.getInstance()?.render(true));
  await waitFor(() => expect(handle?.getEditor(otherItem.id)?.getText()).toBe('new\n'));
  expect(handle?.getEditor(item.id)).toBeUndefined();
  await act(async () => {
    pending.resolve({ content: 'new\n', path: file.path, root: '/repo', version: 'version' });
  });
  await act(async () => handle?.getInstance()?.render(true));
  await waitFor(() => expect(handle?.getEditor(item.id)?.getText()).toBe('new\n'));
  expect(handle?.getEditor(otherItem.id)?.getText()).toBe('new\n');
});

test('two Pierre editors auto-save independently; Done and Revert only close their own file', async () => {
  await using view = await renderReact(<Harness multiple />);
  await click(view.container, 'Edit');
  await edit();
  await click(view.container, 'Edit other.txt');
  await edit(otherItem.id, 'other update');
  const otherEditor = handle!.getEditor(otherItem.id)!;
  const selection = otherEditor.getViewState().selections;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  expect(window.codiff.saveRepositoryFile).toHaveBeenCalledTimes(2);
  expect(
    vi.mocked(window.codiff.saveRepositoryFile).mock.calls.map(([request]) => request),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ baseVersion: 'version', content: 'updated\n', path: file.path }),
      expect.objectContaining({
        baseVersion: 'version',
        content: 'other update\n',
        path: otherFile.path,
      }),
    ]),
  );
  await click(view.container, 'Done');
  await view.rerender(<Harness hidden multiple />);
  await act(async () => handle?.getInstance()?.render(true));
  expect(handle?.getEditor(item.id)).toBeUndefined();
  expect(handle?.getEditor(otherItem.id)).toBe(otherEditor);
  expect(otherEditor.getText()).toBe('other update\n');
  expect(otherEditor.getViewState().selections).toEqual(selection);
  await click(view.container, 'Revert other.txt');
  expect(window.codiff.saveRepositoryFile).toHaveBeenLastCalledWith(
    expect.objectContaining({
      baseVersion: 'saved-version',
      content: 'new\n',
      path: otherFile.path,
    }),
  );
  expect(handle?.getEditor(otherItem.id)).toBeUndefined();
  expect(refresh).toHaveBeenCalledTimes(2);
});

test('multiple drafts survive source switches and review surface remounts', async () => {
  await using view = await renderReact(<Harness multiple />);
  await click(view.container, 'Edit');
  await edit();
  await click(view.container, 'Edit other.txt');
  await edit(otherItem.id, 'second draft');
  await view.rerender(<Harness hidden multiple sourceKey="commit" />);
  expect(handle?.getEditor(item.id)).toBeUndefined();
  expect(handle?.getEditor(otherItem.id)).toBeUndefined();
  await view.rerender(<div />);
  await view.rerender(<Harness multiple />);
  await act(async () => handle?.getInstance()?.render(true));
  await waitFor(() => expect(handle?.getEditor(item.id)?.getText()).toBe('updated\n'));
  await waitFor(() => expect(handle?.getEditor(otherItem.id)?.getText()).toBe('second draft\n'));
});

test('a conflict in one file leaves other files editable and saveable', async () => {
  vi.mocked(window.codiff.saveRepositoryFile).mockImplementation(async (request) => ({
    document: { ...request, version: 'saved-version' },
    status: request.path === file.path ? 'conflict' : 'saved',
  }));
  await using view = await renderReact(<Harness multiple />);
  await click(view.container, 'Edit');
  await edit();
  await click(view.container, 'Done');
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('changed on disk');
  await click(view.container, 'Edit other.txt');
  await edit(otherItem.id, 'second draft');
  await click(view.container, 'Done other.txt');
  expect(handle?.getEditor(otherItem.id)).toBeUndefined();
  expect(handle?.getEditor(item.id)?.getText()).toBe('updated\n');
  expect(refresh).toHaveBeenCalledOnce();
  expect(window.codiff.saveRepositoryFile).toHaveBeenLastCalledWith(
    expect.objectContaining({ content: 'second draft\n', path: otherFile.path }),
  );
});

test('Cmd+S finishes the focused Pierre editor and leaves other files editing', async () => {
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
  await using view = await renderReact(<Harness multiple selectedItemId={item.id} />);
  await click(view.container, 'Edit');
  await edit();
  await click(view.container, 'Edit other.txt');
  await edit(otherItem.id, 'second draft');
  const editor = handle!.getEditor(item.id)!;
  const otherElement = handle!
    .getInstance()!
    .getRenderedItems()
    .find(({ id }) => id === otherItem.id)!.element;
  const content = otherElement.shadowRoot!.querySelector<HTMLElement>('[data-content]')!;
  // jsdom does not reflect Pierre's contentEditable property to the attribute.
  content.setAttribute('contenteditable', 'true');
  content.tabIndex = 0;
  content.focus();
  await act(async () => {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: 's',
      metaKey: true,
    });
    content.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
  expect(window.codiff.saveRepositoryFile).toHaveBeenLastCalledWith(
    expect.objectContaining({ content: 'second draft\n', path: otherFile.path }),
  );
  expect(handle?.getEditor(item.id)).toBe(editor);
  expect(handle?.getEditor(otherItem.id)).toBeUndefined();
  expect(refresh).toHaveBeenCalledOnce();
});

test('Ctrl+S finishes the highlighted file when multiple files are editing', async () => {
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
  await using view = await renderReact(<Harness multiple selectedItemId={item.id} />);
  await click(view.container, 'Edit');
  await edit();
  await click(view.container, 'Edit other.txt');
  await edit(otherItem.id, 'second draft');
  const otherEditor = handle!.getEditor(otherItem.id)!;
  await act(async () => {
    const event = new KeyboardEvent('keydown', { cancelable: true, ctrlKey: true, key: 's' });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
  expect(handle?.getEditor(item.id)).toBeUndefined();
  expect(handle?.getEditor(otherItem.id)).toBe(otherEditor);
  expect(refresh).toHaveBeenCalledOnce();
});

test('Cmd+S in another input does not finish a code edit', async () => {
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
  await using view = await renderReact(<Harness />);
  await click(view.container, 'Edit');
  await edit();
  const input = document.createElement('textarea');
  view.container.append(input);
  await act(async () => {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 's',
      metaKey: true,
    });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
  expect(handle?.getEditor(item.id)?.getText()).toBe('updated\n');
  expect(refresh).not.toHaveBeenCalled();
});

test.each([true, false])(
  'completion uses the configured whitespace policy (showWhitespace: %s)',
  async (showWhitespace) => {
    const oldContents = 'const value = 1;\n';
    const contents = 'const value = 2;\n';
    vi.mocked(window.codiff.getRepositoryFile).mockResolvedValue({
      content: contents,
      path: file.path,
      root: '/repo',
      version: 'version',
    });
    await using view = await renderReact(
      <Harness contents={contents} oldContents={oldContents} showWhitespace={showWhitespace} />,
    );
    await click(view.container, 'Edit');
    await waitFor(() => expect(handle?.getEditor(item.id)?.getFile()).toBeDefined());
    await act(async () => {
      handle!.getEditor(item.id)!.applyEdits([
        {
          newText: '  const value = 1;',
          range: { end: { character: 16, line: 0 }, start: { character: 0, line: 0 } },
        },
      ]);
    });
    await click(view.container, 'Done');
    const completed = handle!.getItem(item.id)!;
    expect(completed.type).toBe('diff');
    if (completed.type !== 'diff') {
      throw new Error('Expected a diff');
    }
    expect(completed.fileDiff.additionLines.join('')).toBe('  const value = 1;\n');
    expect(completed.fileDiff.hunks.length > 0).toBe(showWhitespace);
    expect(window.codiff.saveRepositoryFile).toHaveBeenCalledWith(
      expect.objectContaining({ content: '  const value = 1;\n' }),
    );
  },
);
