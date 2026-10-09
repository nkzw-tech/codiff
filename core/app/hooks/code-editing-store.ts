import type { CodeViewDiffItem, CodeViewItem, FileDiffMetadata } from '@pierre/diffs';
import type { CodeViewItemMetadata, ReviewAnnotationMetadata } from '../../lib/app-types.ts';
import type { RepositoryFileDocument } from '../../types.ts';

export const CODE_AUTOSAVE_DELAY = 300;

export type EditSession = {
  dirty: boolean;
  document: RepositoryFileDocument;
  finishing?: 'done' | 'revert';
  hasChanges: boolean;
  item: CodeViewDiffItem<ReviewAnnotationMetadata>;
  metadata: CodeViewItemMetadata;
  originalContent: string;
  originalDiff: FileDiffMetadata;
  saveError?: string;
  saving?: boolean;
  sourceKey: string;
};

// Each file owns its save queue, independently of mounted review surfaces.
const createFileEditingStore = (onChange: () => void) => {
  const sessionRef = { current: null as EditSession | null };
  const draftRef = { current: '' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingWrite: Promise<boolean> | null = null;
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const setSession = (session: EditSession | null) => {
    sessionRef.current = session
      ? {
          ...session,
          dirty: draftRef.current !== session.document.content,
          hasChanges:
            session.finishing === 'revert'
              ? session.hasChanges
              : draftRef.current !== session.originalContent,
        }
      : null;
    if (!session) {
      clearTimer();
    }
    onChange();
  };
  const scheduleSave = () => {
    clearTimer();
    timer = setTimeout(() => void flush(), CODE_AUTOSAVE_DELAY);
  };
  const flush = (): Promise<boolean> => {
    clearTimer();
    if (pendingWrite) {
      return pendingWrite.then((saved) => (saved ? flush() : false));
    }
    const current = sessionRef.current;
    if (!current || draftRef.current === current.document.content) {
      return Promise.resolve(true);
    }
    const content = draftRef.current;
    setSession({ ...current, saveError: undefined, saving: true });
    pendingWrite = Promise.resolve()
      .then(() =>
        window.codiff.saveRepositoryFile({
          ...current.document,
          baseVersion: current.document.version,
          content,
        }),
      )
      .then((result) => {
        if (result.status === 'conflict') {
          throw new Error(
            'The file changed on disk. Your edits are kept; copy them before refreshing.',
          );
        }
        const latest = sessionRef.current;
        if (latest) {
          setSession({ ...latest, document: result.document, saving: false });
        }
        return true;
      })
      .catch((error: unknown) => {
        const latest = sessionRef.current;
        if (latest) {
          setSession({
            ...latest,
            saveError: error instanceof Error ? error.message : String(error),
            saving: false,
          });
        }
        return false;
      })
      .finally(() => {
        pendingWrite = null;
        const latest = sessionRef.current;
        if (
          latest &&
          !latest.finishing &&
          !latest.saveError &&
          draftRef.current !== latest.document.content
        ) {
          scheduleSave();
        }
      });
    return pendingWrite;
  };
  const finish = async (revert: boolean, beforeClose?: () => void) => {
    const current = sessionRef.current;
    if (!current || current.finishing) {
      return false;
    }
    clearTimer();
    setSession({ ...current, finishing: revert ? 'revert' : 'done' });
    let previousDraft: string | undefined;
    try {
      if (pendingWrite && !(await pendingWrite)) {
        return false;
      }
      if (revert) {
        previousDraft = draftRef.current;
        draftRef.current = current.originalContent;
      }
      do {
        if (!(await flush())) {
          if (previousDraft !== undefined) {
            draftRef.current = previousDraft;
          }
          return false;
        }
      } while (!revert && draftRef.current !== sessionRef.current?.document.content);
      beforeClose?.();
      setSession(null);
      return true;
    } catch (error) {
      if (previousDraft !== undefined) {
        draftRef.current = previousDraft;
      }
      throw error;
    } finally {
      const latest = sessionRef.current;
      if (latest) {
        setSession({ ...latest, finishing: undefined });
      }
    }
  };
  return {
    draftRef,
    finish,
    flush,
    getSnapshot: () => sessionRef.current,
    setDraft: (content: string) => {
      const current = sessionRef.current;
      if (!current || current.finishing === 'revert' || content === draftRef.current) {
        return;
      }
      const wasDirty = draftRef.current !== current.document.content;
      draftRef.current = content;
      const isDirty = content !== current.document.content;
      if (isDirty && !current.finishing && !current.saveError) {
        scheduleSave();
      } else {
        clearTimer();
      }
      if (wasDirty !== isDirty || current.hasChanges !== (content !== current.originalContent)) {
        setSession({ ...current });
      }
    },
    setSession,
  };
};

export type CodeEditingSession = ReturnType<typeof createFileEditingStore>;

export const getCodeEditKey = (sourceKey: string, itemId: string) =>
  JSON.stringify([sourceKey, itemId]);

export const createCodeEditingStore = () => {
  const entries = new Map<string, CodeEditingSession>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyMap<string, EditSession> = new Map();
  const hasFile = (path: string) =>
    [...snapshot.values()].some((session) => session.document.path === path);
  return {
    clear: () => {
      for (const entry of entries.values()) {
        entry.setSession(null);
      }
    },
    flush: (sourceKey: string) =>
      Promise.all(
        [...entries.values()]
          .filter((entry) => entry.getSnapshot()?.sourceKey === sourceKey)
          .map((entry) => entry.flush()),
      ),
    get: (sourceKey: string, itemId: string) => entries.get(getCodeEditKey(sourceKey, itemId)),
    getForItem: (item: CodeViewItem<ReviewAnnotationMetadata>) =>
      item.type === 'diff'
        ? [...entries.values()].find((entry) => {
            const session = entry.getSnapshot();
            return session?.item.id === item.id && session.item.fileDiff === item.fileDiff;
          })
        : undefined,
    getSnapshot: () => snapshot,
    hasFile,
    hasUnsavedEdits: () =>
      [...entries.values()].some((entry) => {
        const session = entry.getSnapshot();
        return session && (session.saving || entry.draftRef.current !== session.document.content);
      }),
    start: (session: EditSession) => {
      // Focused hunks and review sources can show the same working-tree file.
      // Share one disk writer per file; different files edit independently.
      if (hasFile(session.document.path)) {
        return null;
      }
      const key = getCodeEditKey(session.sourceKey, session.item.id);
      const entry = createFileEditingStore(() => {
        const next = new Map(snapshot);
        const current = entry.getSnapshot();
        if (current) {
          next.set(key, current);
        } else {
          next.delete(key);
          entries.delete(key);
        }
        snapshot = next;
        for (const listener of listeners) {
          listener();
        }
      });
      entries.set(key, entry);
      entry.draftRef.current = session.document.content;
      entry.setSession(session);
      return entry;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export type CodeEditingStore = ReturnType<typeof createCodeEditingStore>;
