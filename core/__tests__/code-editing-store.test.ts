/** @vitest-environment jsdom */
import { parseDiffFromFile } from '@pierre/diffs';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import {
  CODE_AUTOSAVE_DELAY,
  createCodeEditingStore,
  type CodeEditingSession,
  type CodeEditingStore,
  type EditSession,
} from '../app/hooks/code-editing-store.ts';
import type { SaveRepositoryFileResult } from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';

const originalContent = 'before editing\n';
const file = createChangedFile('source.txt');
const session: EditSession = {
  dirty: false,
  document: { content: originalContent, path: file.path, root: '/repo', version: 'version-0' },
  hasChanges: false,
  item: {
    fileDiff: parseDiffFromFile(
      { contents: 'git baseline\n', name: file.path },
      { contents: originalContent, name: file.path },
    ),
    id: file.sections[0]!.id,
    type: 'diff',
  },
  metadata: {
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
  },
  originalContent,
  originalDiff: parseDiffFromFile(
    { contents: 'git baseline\n', name: file.path },
    { contents: originalContent, name: file.path },
  ),
  sourceKey: 'working-tree',
};
let registry: CodeEditingStore;
let store: CodeEditingSession;

beforeEach(() => {
  vi.useFakeTimers();
  registry = createCodeEditingStore();
  store = registry.start(session)!;
  let version = 0;
  window.codiff = {
    saveRepositoryFile: vi.fn(async (request) => ({
      document: { ...request, version: `version-${++version}` },
      status: 'saved',
    })),
  } as unknown as Window['codiff'];
});

afterEach(() => {
  registry.clear();
  vi.useRealTimers();
});

const waitForAutosave = () => vi.advanceTimersByTimeAsync(CODE_AUTOSAVE_DELAY);
const saved = (content: string, version = 'version-1'): SaveRepositoryFileResult => ({
  document: { ...session.document, content, version },
  status: 'saved',
});

test('typing coalesces writes after a pause and keeps the original content for Revert', async () => {
  store.setDraft('first');
  await vi.advanceTimersByTimeAsync(CODE_AUTOSAVE_DELAY - 1);
  store.setDraft('second');
  await vi.advanceTimersByTimeAsync(CODE_AUTOSAVE_DELAY - 1);
  expect(window.codiff.saveRepositoryFile).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(window.codiff.saveRepositoryFile).toHaveBeenCalledOnce();
  expect(window.codiff.saveRepositoryFile).toHaveBeenLastCalledWith(
    expect.objectContaining({ baseVersion: 'version-0', content: 'second' }),
  );
  expect(store.getSnapshot()?.document.content).toBe('second');
  expect(store.getSnapshot()?.originalContent).toBe(originalContent);
  expect(store.getSnapshot()?.saving).toBe(false);
});

test('writes serialize and later keystrokes use the last saved version', async () => {
  const pending = Promise.withResolvers<SaveRepositoryFileResult>();
  vi.mocked(window.codiff.saveRepositoryFile).mockImplementationOnce(() => pending.promise);
  store.setDraft('first');
  await waitForAutosave();
  expect(store.getSnapshot()?.saving).toBe(true);
  store.setDraft('second');
  await waitForAutosave();
  expect(window.codiff.saveRepositoryFile).toHaveBeenCalledOnce();
  pending.resolve(saved('first'));
  expect(await store.flush()).toBe(true);
  expect(window.codiff.saveRepositoryFile).toHaveBeenCalledTimes(2);
  expect(window.codiff.saveRepositoryFile).toHaveBeenLastCalledWith(
    expect.objectContaining({ baseVersion: 'version-1', content: 'second' }),
  );
  expect(store.draftRef.current).toBe('second');
});

test('Done flushes immediately and clears the debounce before closing', async () => {
  store.setDraft('last keystroke');
  expect(await store.finish(false)).toBe(true);
  expect(window.codiff.saveRepositoryFile).toHaveBeenCalledOnce();
  expect(store.getSnapshot()).toBeNull();
  await waitForAutosave();
  expect(window.codiff.saveRepositoryFile).toHaveBeenCalledOnce();
});

test('Done completes the saved session before removing it from the store', async () => {
  store.setDraft('last draft');
  const beforeClose = vi.fn(() => {
    expect(store.getSnapshot()?.finishing).toBe('done');
    expect(store.getSnapshot()?.document.content).toBe('last draft');
  });
  expect(await store.finish(false, beforeClose)).toBe(true);
  expect(beforeClose).toHaveBeenCalledOnce();
  expect(store.getSnapshot()).toBeNull();
});

test('Revert before auto-save cancels the pending write', async () => {
  store.setDraft('draft');
  expect(await store.finish(true)).toBe(true);
  await waitForAutosave();
  expect(window.codiff.saveRepositoryFile).not.toHaveBeenCalled();
  expect(store.getSnapshot()).toBeNull();
});

test('Revert waits for an in-flight save and restores the starting working-tree content', async () => {
  const pending = Promise.withResolvers<SaveRepositoryFileResult>();
  vi.mocked(window.codiff.saveRepositoryFile).mockImplementationOnce(() => pending.promise);
  store.setDraft('first');
  await waitForAutosave();
  store.setDraft('second');
  const reverted = store.finish(true);
  expect(store.getSnapshot()?.finishing).toBe('revert');
  await waitForAutosave();
  expect(window.codiff.saveRepositoryFile).toHaveBeenCalledOnce();
  pending.resolve(saved('first'));
  expect(await reverted).toBe(true);
  expect(window.codiff.saveRepositoryFile).toHaveBeenCalledTimes(2);
  expect(window.codiff.saveRepositoryFile).toHaveBeenLastCalledWith(
    expect.objectContaining({ baseVersion: 'version-1', content: originalContent }),
  );
  expect(store.getSnapshot()).toBeNull();
});

test('undoing while a save is running persists the undone content afterward', async () => {
  const pending = Promise.withResolvers<SaveRepositoryFileResult>();
  vi.mocked(window.codiff.saveRepositoryFile).mockImplementationOnce(() => pending.promise);
  store.setDraft('temporary');
  await waitForAutosave();
  store.setDraft(originalContent);
  pending.resolve(saved('temporary'));
  await store.flush();
  expect(window.codiff.saveRepositoryFile).toHaveBeenLastCalledWith(
    expect.objectContaining({ baseVersion: 'version-1', content: originalContent }),
  );
  expect(store.getSnapshot()?.document.content).toBe(originalContent);
});

test('auto-save continues after the review surface unsubscribes', async () => {
  const listener = vi.fn();
  const unsubscribe = registry.subscribe(listener);
  store.setDraft('draft');
  unsubscribe();
  listener.mockClear();
  await waitForAutosave();
  expect(window.codiff.saveRepositoryFile).toHaveBeenCalledOnce();
  expect(store.getSnapshot()?.document.content).toBe('draft');
  expect(listener).not.toHaveBeenCalled();
});

test('a conflict keeps the draft and stops automatic retries', async () => {
  vi.mocked(window.codiff.saveRepositoryFile).mockResolvedValue({
    document: { ...session.document, content: 'external', version: 'external-version' },
    status: 'conflict',
  });
  store.setDraft('draft');
  await waitForAutosave();
  expect(store.getSnapshot()?.saveError).toContain('changed on disk');
  expect(store.getSnapshot()?.document).toBe(session.document);
  expect(store.getSnapshot()?.saving).toBe(false);
  store.setDraft('more typing');
  await waitForAutosave();
  expect(window.codiff.saveRepositoryFile).toHaveBeenCalledOnce();
  expect(store.draftRef.current).toBe('more typing');
  expect(await store.finish(false)).toBe(false);
  expect(store.getSnapshot()?.finishing).toBeUndefined();
  expect(store.draftRef.current).toBe('more typing');
});

test('a failed Revert preserves the editable draft and saved version for retrying', async () => {
  store.setDraft('saved edit');
  await waitForAutosave();
  store.setDraft('new unsaved edit');
  vi.mocked(window.codiff.saveRepositoryFile).mockRejectedValueOnce(new Error('Disk full'));
  expect(await store.finish(true)).toBe(false);
  expect(store.draftRef.current).toBe('new unsaved edit');
  expect(store.getSnapshot()?.document.content).toBe('saved edit');
  expect(store.getSnapshot()?.saveError).toBe('Disk full');
  expect(store.getSnapshot()?.finishing).toBeUndefined();
  expect(await store.finish(true)).toBe(true);
  expect(window.codiff.saveRepositoryFile).toHaveBeenLastCalledWith(
    expect.objectContaining({ baseVersion: 'version-1', content: originalContent }),
  );
  expect(store.getSnapshot()).toBeNull();
});

const startOtherFile = () => {
  const otherFile = createChangedFile('other.txt');
  return registry.start({
    ...session,
    document: { ...session.document, content: 'other original', path: otherFile.path },
    item: {
      ...session.item,
      fileDiff: parseDiffFromFile(
        { contents: 'old', name: otherFile.path },
        { contents: 'other original', name: otherFile.path },
      ),
      id: otherFile.sections[0]!.id,
    },
    metadata: { ...session.metadata, file: otherFile, section: otherFile.sections[0]! },
    originalContent: 'other original',
  })!;
};

test('a slow save in one file cannot delay another file or mix their versions and Revert baselines', async () => {
  const pending = Promise.withResolvers<SaveRepositoryFileResult>();
  vi.mocked(window.codiff.saveRepositoryFile).mockImplementationOnce(() => pending.promise);
  const other = startOtherFile();
  store.setDraft('first draft');
  await waitForAutosave();
  other.setDraft('second draft');
  await waitForAutosave();
  expect(window.codiff.saveRepositoryFile).toHaveBeenCalledTimes(2);
  expect(store.getSnapshot()?.saving).toBe(true);
  expect(other.getSnapshot()?.document.content).toBe('second draft');
  expect(registry.hasUnsavedEdits()).toBe(true);
  expect(await other.finish(true)).toBe(true);
  expect(window.codiff.saveRepositoryFile).toHaveBeenLastCalledWith(
    expect.objectContaining({
      baseVersion: 'version-1',
      content: 'other original',
      path: 'other.txt',
    }),
  );
  expect(registry.getSnapshot().size).toBe(1);
  expect(store.getSnapshot()?.saving).toBe(true);
  pending.resolve(saved('first draft', 'first-file-version'));
  expect(await store.finish(true)).toBe(true);
  expect(window.codiff.saveRepositoryFile).toHaveBeenLastCalledWith(
    expect.objectContaining({
      baseVersion: 'first-file-version',
      content: originalContent,
      path: file.path,
    }),
  );
  expect(registry.getSnapshot().size).toBe(0);
  expect(registry.hasUnsavedEdits()).toBe(false);
});

test('unsaved edits in any file block closing, including undo while an earlier write is running', async () => {
  const other = startOtherFile();
  const pending = Promise.withResolvers<SaveRepositoryFileResult>();
  vi.mocked(window.codiff.saveRepositoryFile).mockImplementationOnce(() => pending.promise);
  expect(registry.hasUnsavedEdits()).toBe(false);
  other.setDraft('second draft');
  expect(registry.hasUnsavedEdits()).toBe(true);
  await waitForAutosave();
  other.setDraft('other original');
  expect(registry.hasUnsavedEdits()).toBe(true);
  pending.resolve({
    document: {
      ...session.document,
      content: 'second draft',
      path: 'other.txt',
      version: 'other-version',
    },
    status: 'saved',
  });
  await registry.flush(session.sourceKey);
  expect(registry.hasUnsavedEdits()).toBe(false);
  expect(store.getSnapshot()?.document).toBe(session.document);
});

test('the same working-tree file uses one writer across focused hunks and review sources', () => {
  expect(registry.start({ ...session, sourceKey: 'branch-working-tree' })).toBeNull();
  expect(registry.start({ ...session, item: { ...session.item, id: 'another-hunk' } })).toBeNull();
  expect(registry.getSnapshot().size).toBe(1);
  expect(startOtherFile()).not.toBeNull();
  expect(registry.getSnapshot().size).toBe(2);
});

test('changes compare to the edit baseline across auto-save and undoing back to the original', async () => {
  expect(store.getSnapshot()?.hasChanges).toBe(false);
  store.setDraft('typed');
  expect(store.getSnapshot()?.hasChanges).toBe(true);
  await waitForAutosave();
  expect(store.getSnapshot()?.dirty).toBe(false);
  expect(store.getSnapshot()?.hasChanges).toBe(true);
  store.setDraft('more typing');
  store.setDraft(originalContent);
  expect(store.getSnapshot()?.hasChanges).toBe(false);
  expect(store.getSnapshot()?.dirty).toBe(true);
  expect(await store.finish(true)).toBe(true);
  expect(window.codiff.saveRepositoryFile).toHaveBeenLastCalledWith(
    expect.objectContaining({ baseVersion: 'version-1', content: originalContent }),
  );
});
