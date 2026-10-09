import {
  cloneFileDiffMetadata,
  getFiletypeFromFileName,
  getHighlighterOptions,
  hydratePartialDiff,
  preloadHighlighter,
  type CodeViewDiffItem,
  type CodeViewItem,
  type FileDiffLoadedFiles,
  type FileDiffMetadata,
} from '@pierre/diffs';
import type {
  EditorChangeEvent,
  EditorFactory,
  EditorOptions,
  EditorType,
} from '@pierre/diffs/edit';
import type { CodeViewHandle, CodeViewItemEditCompleteHandler } from '@pierre/diffs/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import { defaultKeymap } from '../../config/defaults.ts';
import { matchesShortcut } from '../../config/keymap.ts';
import type { CodiffKeymap } from '../../config/types.ts';
import type { CodeViewItemMetadata, ReviewAnnotationMetadata } from '../../lib/app-types.ts';
import { DEFAULT_PADDING, workerHighlighterOptions } from '../../lib/code-view-options.ts';
import { loadSectionContents } from '../../lib/diff.ts';
import { getItemVersion } from '../../lib/item-version.ts';
import { isNativeInputTarget } from '../../lib/keyboard.ts';
import type { ChangedFile, DiffSection } from '../../types.ts';
import {
  createCodeEditingStore,
  getCodeEditKey,
  type CodeEditingStore,
  type EditSession,
} from './code-editing-store.ts';

export { createCodeEditingStore, type CodeEditingStore } from './code-editing-store.ts';

let editorModule: typeof import('@pierre/diffs/edit') | null = null;
let editorModulePromise: Promise<typeof import('@pierre/diffs/edit')> | null = null;
const loadEditor = () =>
  (editorModulePromise ??= import('@pierre/diffs/edit')
    .then((module) => {
      editorModule = module;
      return module;
    })
    .catch((error) => {
      editorModulePromise = null;
      throw error;
    }));

// Worker highlighting does not load the main-thread engine used by the editor.
const prepareEditor = (fileDiff: FileDiffMetadata) => {
  const lang = fileDiff.lang ?? getFiletypeFromFileName(fileDiff.name);
  return Promise.all([
    loadEditor(),
    preloadHighlighter(getHighlighterOptions(lang, workerHighlighterOptions)),
  ]);
};

export const createCodeEditor: EditorFactory<ReviewAnnotationMetadata, undefined> = (
  type,
  options,
  key,
) => {
  if (!editorModule) {
    throw new Error('The code editor has not loaded.');
  }
  return new editorModule.Editor(type, options, key);
};

export function useUnsavedCodeEditsGuard(store: CodeEditingStore) {
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (store.hasUnsavedEdits()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [store]);
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const getFirstVisibleChangedLine = (root: ShadowRoot, viewport: HTMLElement) => {
  const viewportRect = viewport.getBoundingClientRect();
  const header = root.querySelector<HTMLElement>('[data-diffs-header][data-sticky]');
  const top =
    Math.max(viewportRect.top, header?.getBoundingClientRect().bottom ?? viewportRect.top) +
    DEFAULT_PADDING;
  for (const row of root.querySelectorAll<HTMLElement>(
    '[data-content] > [data-line-type="change-addition"]',
  )) {
    const rect = row.getBoundingClientRect();
    if (rect.height > 0 && rect.top >= top && rect.top < viewportRect.bottom) {
      const line = Number(row.dataset.line);
      if (Number.isInteger(line) && line > 0) {
        return line;
      }
    }
  }
  return undefined;
};

export function useCodeEditing({
  codeViewRef,
  items,
  keymap = defaultKeymap,
  onLoadSectionContents,
  onRefresh,
  selectedItemId,
  sourceKey,
  store: sharedStore,
}: {
  codeViewRef: RefObject<CodeViewHandle<ReviewAnnotationMetadata, undefined> | null>;
  items: ReadonlyArray<CodeViewItem<ReviewAnnotationMetadata>>;
  keymap?: CodiffKeymap;
  onLoadSectionContents?: (file: ChangedFile, section: DiffSection) => Promise<FileDiffLoadedFiles>;
  onRefresh?: (file: ChangedFile, section: DiffSection) => Promise<boolean>;
  selectedItemId?: string;
  sourceKey: string;
  store?: CodeEditingStore;
}) {
  const [localStore] = useState(createCodeEditingStore);
  const store = sharedStore ?? localStore;
  const sessions = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useUnsavedCodeEditsGuard(store);
  const busyRef = useRef(new Set<string>());
  const [busyItemKeys, setBusyItemKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [completedItems, setCompletedItems] = useState<
    ReadonlyMap<
      string,
      { item: CodeViewDiffItem<ReviewAnnotationMetadata>; originalDiff: FileDiffMetadata }
    >
  >(() => new Map());
  const setBusy = useCallback((key: string, busy: boolean) => {
    if (busy) {
      busyRef.current.add(key);
    } else {
      busyRef.current.delete(key);
    }
    setBusyItemKeys(new Set(busyRef.current));
  }, []);
  const setError = useCallback((key: string, message?: string) => {
    setErrors((current) => {
      const next = new Map(current);
      if (message) {
        next.set(key, message);
      } else {
        next.delete(key);
      }
      return next;
    });
  }, []);
  const currentSessions = useMemo(
    () =>
      new Map(
        [...sessions.values()]
          .filter((session) => session.sourceKey === sourceKey)
          .map((session) => [session.item.id, session]),
      ),
    [sessions, sourceKey],
  );
  const editorOptions = useMemo<
    EditorOptions<EditorType, ReviewAnnotationMetadata, undefined>
  >(() => {
    const focusedEditors = new WeakSet();
    return {
      onAttach: (editor, fileInstance) => {
        if (!focusedEditors.has(editor)) {
          focusedEditors.add(editor);
          const viewer = codeViewRef.current?.getInstance();
          const root = viewer?.getRenderedItems().find(({ instance }) => instance === fileInstance)
            ?.element.shadowRoot;
          const viewport = viewer?.getContainerElement();
          // Prefer the change being reviewed. Keep the caret below the sticky
          // header and preserve the viewport when the changes are offscreen.
          editor.focus({
            character: 0,
            lineNumber:
              (root && viewport ? getFirstVisibleChangedLine(root, viewport) : undefined) ??
              'first-visible',
            offset: DEFAULT_PADDING,
            preventScroll: true,
          });
          const position = editor.getViewState().selections?.[0]?.start;
          const line = position && editor.getEditState()?.document.getLineText(position.line);
          const indentation = line?.match(/^\s*/)?.[0].length ?? 0;
          if (position && indentation > 0) {
            editor.focus({
              character: indentation,
              lineNumber: position.line + 1,
              preventScroll: true,
            });
          }
        }
      },
    };
  }, [codeViewRef]);

  const loadEditContents = useCallback(
    (item: CodeViewDiffItem<ReviewAnnotationMetadata>, metadata: CodeViewItemMetadata) => {
      if (!item.fileDiff.isPartial) {
        return Promise.resolve({
          newFile: { contents: item.fileDiff.additionLines.join(''), name: item.fileDiff.name },
          oldFile: null,
        });
      }
      return loadSectionContents(metadata.file, metadata.section, onLoadSectionContents!);
    },
    [onLoadSectionContents],
  );

  const prepareEdit = useCallback(
    async (item: CodeViewItem<ReviewAnnotationMetadata>, metadata: CodeViewItemMetadata) => {
      if (item.type === 'diff' && onLoadSectionContents) {
        const [, loaded] = await Promise.all([
          prepareEditor(item.fileDiff),
          loadEditContents(item, metadata),
        ]);
        const rendered = codeViewRef.current
          ?.getInstance()
          ?.getRenderedItems()
          .find(({ id }) => id === item.id);
        if (rendered?.type === 'diff') {
          // Warm an independent full diff. Hydrating the displayed partial diff
          // clears its highlighted markup while the full worker result loads.
          const fileDiff = item.fileDiff.isPartial
            ? hydratePartialDiff('clone', item.fileDiff, loaded)
            : item.fileDiff;
          await rendered.instance.primeHighlightCache(fileDiff);
        }
      }
    },
    [codeViewRef, loadEditContents, onLoadSectionContents],
  );

  const startEdit = useCallback(
    async (item: CodeViewItem<ReviewAnnotationMetadata>, metadata: CodeViewItemMetadata) => {
      const itemKey = getCodeEditKey(sourceKey, item.id);
      if (
        item.type !== 'diff' ||
        !onLoadSectionContents ||
        store.hasFile(metadata.file.path) ||
        busyRef.current.has(itemKey)
      ) {
        return;
      }
      setBusy(itemKey, true);
      setError(itemKey);
      try {
        const [, loaded, document] = await Promise.all([
          prepareEditor(item.fileDiff),
          loadEditContents(item, metadata),
          window.codiff.getRepositoryFile(metadata.file.path),
        ]);
        if (!loaded.newFile || loaded.newFile.contents !== document.content) {
          throw new Error('The file changed on disk. Refresh the diff before editing.');
        }
        const key = crypto.randomUUID();
        // Load the complete document without re-diffing it: recomputing the patch
        // changes its context lines and can reveal hunks outside a focused review.
        const fileDiff = item.fileDiff.isPartial
          ? hydratePartialDiff('clone', item.fileDiff, loaded)
          : cloneFileDiffMetadata(item.fileDiff);
        // Keep the prepared highlight cache for an unchanged document, including
        // the stable hydrated key used while warming a partial diff.
        // Pierre owns a separate edit-session diff and detaches cached markup.
        fileDiff.cacheKey ??= `code-edit:${key}`;
        const rendered = codeViewRef.current
          ?.getInstance()
          ?.getRenderedItems()
          .find(({ id }) => id === item.id);
        if (rendered?.type === 'diff') {
          // After a refresh the worker may still be highlighting the new diff.
          // Wait for it without letting editor attachment tokenize on the UI thread.
          await rendered.instance.primeHighlightCache(fileDiff);
        }
        const nextSession: EditSession = {
          dirty: false,
          document,
          hasChanges: false,
          item: {
            ...item,
            collapsed: false,
            edit: true,
            fileDiff,
            version: getItemVersion(`code-edit:${key}`),
          },
          metadata,
          originalContent: document.content,
          originalDiff: fileDiff,
          sourceKey,
        };
        if (store.start(nextSession)) {
          codeViewRef.current?.clearSelectedLines();
        }
      } catch (error) {
        setError(itemKey, errorMessage(error));
      } finally {
        setBusy(itemKey, false);
      }
    },
    [codeViewRef, loadEditContents, onLoadSectionContents, setBusy, setError, sourceKey, store],
  );

  const finishEdit = useCallback(
    async (itemId: string, revert: boolean) => {
      const itemKey = getCodeEditKey(sourceKey, itemId);
      const entry = store.get(sourceKey, itemId);
      const current = entry?.getSnapshot();
      if (!entry || !current || busyRef.current.has(itemKey)) {
        return;
      }
      setBusy(itemKey, true);
      setError(itemKey);
      const needsRefresh =
        current.hasChanges ||
        current.document.content !== current.originalContent ||
        current.saving;
      try {
        const finished = await entry.finish(revert, () => {
          const latest = entry.getSnapshot();
          const viewer = codeViewRef.current;
          const displayed = viewer?.getItem(itemId);
          if (latest && displayed?.type === 'diff' && displayed.fileDiff === latest.item.fileDiff) {
            // End Pierre's session while the store still owns it, so completion
            // can accept its diff before the repository metadata is refreshed.
            flushSync(() => {
              entry.setSession({
                ...latest,
                item: {
                  ...latest.item,
                  edit: false,
                  version: getItemVersion(`code-edit-complete:${crypto.randomUUID()}`),
                },
              });
            });
          }
        });
        if (
          finished &&
          needsRefresh &&
          onRefresh &&
          !(await onRefresh(current.metadata.file, current.metadata.section))
        ) {
          throw new Error('File saved. Refresh the review to update its repository status.');
        }
      } catch (error) {
        setError(itemKey, errorMessage(error));
      } finally {
        setBusy(itemKey, false);
      }
    },
    [codeViewRef, onRefresh, setBusy, setError, sourceKey, store],
  );

  const doneEdit = useCallback((itemId: string) => finishEdit(itemId, false), [finishEdit]);
  const revertEdit = useCallback((itemId: string) => finishEdit(itemId, true), [finishEdit]);

  const onItemEditChange = useCallback(
    (
      event: EditorChangeEvent<EditorType, ReviewAnnotationMetadata, undefined>,
      item: CodeViewItem<ReviewAnnotationMetadata>,
    ) => {
      store.getForItem(item)?.setDraft(event.file.contents);
    },
    [store],
  );

  const onItemEditComplete: CodeViewItemEditCompleteHandler<ReviewAnnotationMetadata, undefined> =
    useCallback(
      (_event, item, nextItem) => {
        // Completion can arrive after the selected source changed. Match the
        // document that owned the editor, rather than the newly selected source.
        const entry = store.getForItem(item);
        const current = entry?.getSnapshot();
        if (!entry || !current || nextItem.type !== 'diff') {
          return 'reject';
        }
        if (current.finishing && !current.item.edit) {
          nextItem.fileDiff.cacheKey = `code-edit:${crypto.randomUUID()}`;
          const original = items.find((candidate) => candidate.id === item.id);
          if (original?.type === 'diff') {
            const completed: CodeViewDiffItem<ReviewAnnotationMetadata> = {
              ...nextItem,
              fileDiff: current.finishing === 'revert' ? current.originalDiff : nextItem.fileDiff,
              type: 'diff',
            };
            setCompletedItems((previous) =>
              new Map(previous).set(getCodeEditKey(current.sourceKey, item.id), {
                item: completed,
                originalDiff: original.fileDiff,
              }),
            );
          }
          return current.finishing === 'revert' ? 'reject' : 'accept';
        }
        // Source/view switches end Pierre's session. Retain the completed draft
        // for returning to this review without parsing the document again.
        nextItem.fileDiff.cacheKey = `code-edit:${crypto.randomUUID()}`;
        entry.setSession({
          ...current,
          item: { ...nextItem, edit: true },
        });
        return 'accept';
      },
      [items, store],
    );

  const editedItems = useMemo(() => {
    if (currentSessions.size === 0 && completedItems.size === 0) {
      return items;
    }
    const found = new Set<string>();
    const next = items.map((item) => {
      const session = currentSessions.get(item.id);
      if (!session) {
        const completed = completedItems.get(getCodeEditKey(sourceKey, item.id));
        if (item.type === 'diff' && completed?.originalDiff === item.fileDiff) {
          return {
            ...item,
            fileDiff: completed.item.fileDiff,
            version: getItemVersion(
              `code-edit-completed:${completed.item.version}:${item.version}`,
            ),
          };
        }
        return item;
      }
      found.add(item.id);
      return { ...session.item, collapsed: item.collapsed };
    });
    // A background refresh or walkthrough change must not discard active drafts.
    for (const session of currentSessions.values()) {
      if (!found.has(session.item.id)) {
        next.push(session.item);
      }
    }
    return next;
  }, [completedItems, currentSessions, items, sourceKey]);

  useEffect(() => {
    if (currentSessions.size === 0) {
      return;
    }
    const keyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        !matchesShortcut(event, keymap, 'doneEditing')
      ) {
        return;
      }
      const path = event.composedPath();
      // A comment or another input owns its shortcuts. Pierre's editable code
      // lives inside a shadow root, so inspect the original event path as well.
      if (
        isNativeInputTarget(event.target) &&
        !path.some((node) => (node as Element).matches?.('[data-content][contenteditable="true"]'))
      ) {
        return;
      }
      const focusedItemId = codeViewRef.current
        ?.getInstance()
        ?.getRenderedItems()
        .find(({ element, id }) => currentSessions.has(id) && path.includes(element))?.id;
      const itemId =
        focusedItemId ??
        selectedItemId ??
        (currentSessions.size === 1 ? currentSessions.keys().next().value : undefined);
      if (itemId == null || !currentSessions.has(itemId)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void doneEdit(itemId);
    };
    window.addEventListener('keydown', keyDown, true);
    return () => window.removeEventListener('keydown', keyDown, true);
  }, [codeViewRef, currentSessions, doneEdit, keymap, selectedItemId]);

  return {
    canStartEdit: (itemId: string, path: string) =>
      !busyItemKeys.has(getCodeEditKey(sourceKey, itemId)) &&
      ![...sessions.values()].some((session) => session.document.path === path),
    doneEdit,
    editorOptions,
    getError: (itemId: string) =>
      currentSessions.get(itemId)?.saveError ?? errors.get(getCodeEditKey(sourceKey, itemId)),
    isBusy: (itemId: string) =>
      busyItemKeys.has(getCodeEditKey(sourceKey, itemId)) ||
      currentSessions.get(itemId)?.finishing != null,
    items: editedItems,
    onItemEditChange,
    onItemEditComplete,
    prepareEdit,
    revertEdit,
    sessions: currentSessions,
    startEdit,
  };
}
