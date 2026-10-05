/** @vitest-environment jsdom */
import { act, useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import { createCodeEditingStore, type CodeEditingStore } from '../app/hooks/code-editing-store.ts';
import type { CodeViewItemMetadata } from '../lib/app-types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact, waitFor } from './helpers/react.tsx';
import {
  codeViewMock,
  resetCodeViewMock,
  ReviewCodeViewHarness,
} from './helpers/review-code-view.tsx';

const file = createChangedFile('core/a/long/directory/important-file.txt');
const meta: CodeViewItemMetadata = {
  blockId: 'source',
  canEditMarkdown: false,
  canRenderMarkdown: false,
  comments: [],
  file,
  isCollapsed: false,
  isMarkdownPreview: false,
  isSelected: false,
  isViewed: false,
  lineCount: { additions: 1, countable: true, deletions: 1 },
  reviewIdentity: { fingerprint: file.fingerprint, key: file.path },
  section: file.sections[0]!,
  sectionCount: 1,
};
let store: CodeEditingStore;
const refresh = vi.fn(async () => true);

beforeEach(() => {
  resetCodeViewMock();
  store = createCodeEditingStore();
  refresh.mockClear();
  vi.stubGlobal('codiff', {
    getRepositoryFile: vi.fn(),
    saveRepositoryFile: vi.fn(async (request) => ({
      document: { ...request, version: 'saved-version' },
      status: 'saved',
    })),
  });
});

afterEach(() => {
  store.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const startEditing = () => {
  const item = codeViewMock.lastItems[0]!;
  if (item.type !== 'diff') {
    throw new Error('Expected an editable diff');
  }
  return store.start({
    dirty: false,
    document: { content: 'new\n', path: file.path, root: '/repo', version: 'version' },
    hasChanges: false,
    item: { ...item, annotations: [], edit: true },
    metadata: meta,
    originalContent: 'new\n',
    sourceKey: 'working-tree',
  })!;
};

const headerButtons = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLButtonElement>('.codiff-file-details button'),
];

test('Cancel precedes Done without destructive styling; typing and auto-save keep Revert red', async () => {
  await using view = await renderReact(
    <ReviewCodeViewHarness codeEditingStore={store} files={[file]} onRefreshMarkdown={refresh} />,
  );
  let entry: ReturnType<typeof startEditing>;
  await act(async () => {
    entry = startEditing();
  });
  const labels = () => headerButtons(view.container).map((button) => button.textContent);
  expect(labels().indexOf('Cancel')).toBeLessThan(labels().indexOf('Done'));
  expect(
    headerButtons(view.container)
      .find((button) => button.textContent === 'Cancel')
      ?.classList.contains('codiff-button-destructive'),
  ).toBe(false);
  await act(async () => entry!.setDraft('typed\n'));
  const revert = () =>
    headerButtons(view.container).find((button) => button.textContent === 'Revert');
  expect(labels().indexOf('Revert')).toBeLessThan(labels().indexOf('Done'));
  expect(revert()?.classList.contains('codiff-button-destructive')).toBe(true);
  await act(async () => {
    await entry!.flush();
  });
  expect(revert()).toBeDefined();
  expect(entry!.getSnapshot()?.dirty).toBe(false);
  expect(view.container.querySelector('.codiff-status-badge')).toBeNull();
  await act(async () => revert()!.click());
  expect(window.codiff.saveRepositoryFile).toHaveBeenLastCalledWith(
    expect.objectContaining({ baseVersion: 'saved-version', content: 'new\n' }),
  );
  expect(store.getSnapshot().size).toBe(0);
});

test('Cancel without edits closes without writing or refreshing the review', async () => {
  await using view = await renderReact(
    <ReviewCodeViewHarness codeEditingStore={store} files={[file]} onRefreshMarkdown={refresh} />,
  );
  await act(async () => {
    startEditing();
  });
  await act(async () =>
    headerButtons(view.container)
      .find((button) => button.textContent === 'Cancel')!
      .click(),
  );
  expect(window.codiff.saveRepositoryFile).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(store.getSnapshot().size).toBe(0);
});

test.each(['MacIntel', 'Win32'])(
  'the edit shortcut opens the highlighted file and expands it on %s',
  async (platform) => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue(platform);
    const otherFile = createChangedFile('other.txt');
    const selectedFile = {
      ...file,
      sections: [...createChangedFile(file.path, { kind: 'staged' }).sections, ...file.sections],
    };
    vi.mocked(window.codiff.getRepositoryFile).mockResolvedValue({
      content: 'new\n',
      path: file.path,
      root: '/repo',
      version: 'version',
    });
    const onToggleCollapsed = vi.fn();
    function CollapsedHarness() {
      const [collapsed, setCollapsed] = useState(new Set([file.path]));
      return (
        <ReviewCodeViewHarness
          codeEditingStore={store}
          collapsed={collapsed}
          files={[otherFile, selectedFile]}
          onLoadSectionContents={async () => ({
            newFile: { contents: 'new\n', name: file.path },
            oldFile: { contents: 'old\n', name: file.path },
          })}
          onToggleCollapsed={(...args) => {
            onToggleCollapsed(...args);
            setCollapsed(new Set());
          }}
          selectedPath={file.path}
        />
      );
    }
    await using view = await renderReact(<CollapsedHarness />);
    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        cancelable: true,
        ctrlKey: platform === 'Win32',
        key: 'e',
        metaKey: platform === 'MacIntel',
      });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
    await waitFor(() => expect(store.hasFile(file.path)).toBe(true));
    expect(store.hasFile(otherFile.path)).toBe(false);
    expect(window.codiff.getRepositoryFile).toHaveBeenCalledWith(file.path);
    expect(onToggleCollapsed).toHaveBeenCalledWith(selectedFile, true, file.path);
    expect(view.container.querySelector(`[aria-label="Done editing ${file.path}"]`)).not.toBeNull();
  },
);

test('the edit shortcut respects read-only reviews and native inputs', async () => {
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
  const props = {
    codeEditingStore: store,
    files: [file],
    onLoadSectionContents: async () => ({
      newFile: { contents: 'new\n', name: file.path },
      oldFile: { contents: 'old\n', name: file.path },
    }),
    selectedPath: file.path,
  };
  await using view = await renderReact(<ReviewCodeViewHarness {...props} isReadOnly />);
  await act(async () => {
    const event = new KeyboardEvent('keydown', { cancelable: true, key: 'e', metaKey: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
  await view.rerender(<ReviewCodeViewHarness {...props} />);
  const input = document.createElement('input');
  view.container.append(input);
  await act(async () => {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'e',
      metaKey: true,
    });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
  expect(window.codiff.getRepositoryFile).not.toHaveBeenCalled();
  expect(store.getSnapshot().size).toBe(0);
});

test('narrow pane layout and sticky header metrics resize together without losing the filename', async () => {
  let width = 600;
  let resize: (() => void) | undefined;
  const getRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('code-view')
      ? new DOMRect(0, 0, width, 768)
      : getRect.call(this);
  });
  vi.stubGlobal(
    'ResizeObserver',
    class implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(element: Element) {
        if (element.classList.contains('code-view')) {
          resize = () => this.callback([], this);
        }
      }
      disconnect() {}
      unobserve() {}
    },
  );
  await using view = await renderReact(<ReviewCodeViewHarness files={[file]} />);
  const viewport = view.container.querySelector<HTMLElement>('.code-view')!;
  expect(viewport.classList.contains('compact-file-headers')).toBe(true);
  expect(codeViewMock.lastOptions?.itemMetrics).toEqual({ diffHeaderHeight: 90 });
  expect(viewport.style.getPropertyValue('--codiff-file-header-height')).toBe('90px');
  const header = view.container.querySelector('.codiff-file-header')!;
  expect(header.children[0]?.classList.contains('codiff-header-toggle')).toBe(true);
  expect(header.children[1]?.classList.contains('codiff-file-details')).toBe(true);
  expect(header.querySelector('.codiff-file-name')?.textContent).toBe('important-file.txt');
  expect(header.querySelector('.codiff-file-path')?.getAttribute('title')).toBe(file.path);
  await act(async () => {
    width = 1200;
    resize!();
  });
  expect(viewport.classList.contains('compact-file-headers')).toBe(false);
  expect(codeViewMock.lastOptions?.itemMetrics).toEqual({ diffHeaderHeight: 54 });
  expect(viewport.style.getPropertyValue('--codiff-file-header-height')).toBe('54px');
});

test('expandUnchanged only expands diffs when full file contents can be loaded', async () => {
  const loadContents = vi.fn();
  await using view = await renderReact(
    <ReviewCodeViewHarness expandUnchanged files={[file]} onLoadSectionContents={loadContents} />,
  );
  expect(codeViewMock.lastOptions?.expandUnchanged).toBe(true);

  await view.rerender(
    <ReviewCodeViewHarness
      expandUnchanged
      files={[file]}
      isReadOnly
      onLoadSectionContents={loadContents}
    />,
  );
  expect(codeViewMock.lastOptions?.expandUnchanged).toBe(false);
});
