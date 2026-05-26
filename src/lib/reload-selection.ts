import type { RepositoryState } from '../types.ts';
import { getSourceKey } from './source.ts';

const reloadSelectionStorageKey = 'codiff.reloadSelection.v1';

type ReloadSelection = {
  root: string;
  selectedPath: string;
  sourceKey: string;
};

const getStorage = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

const isReloadSelection = (value: unknown): value is ReloadSelection =>
  typeof value === 'object' &&
  value != null &&
  'root' in value &&
  typeof value.root === 'string' &&
  'selectedPath' in value &&
  typeof value.selectedPath === 'string' &&
  'sourceKey' in value &&
  typeof value.sourceKey === 'string';

export const consumeReloadSelection = (): ReloadSelection | null => {
  const storage = getStorage();
  if (!storage) {
    return null;
  }

  let raw: string | null;
  try {
    raw = storage.getItem(reloadSelectionStorageKey);
    storage.removeItem(reloadSelectionStorageKey);
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isReloadSelection(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const getReloadSelectionPath = (
  selection: ReloadSelection | null,
  state: RepositoryState,
): string | null => {
  if (
    !selection ||
    selection.root !== state.root ||
    selection.sourceKey !== getSourceKey(state.source)
  ) {
    return null;
  }

  return state.files.some((file) => file.path === selection.selectedPath)
    ? selection.selectedPath
    : null;
};

export const writeReloadSelection = (
  state: RepositoryState | null,
  selectedPath: string | null,
) => {
  const storage = getStorage();
  if (!storage || !state || !selectedPath) {
    return;
  }

  try {
    storage.setItem(
      reloadSelectionStorageKey,
      JSON.stringify({
        root: state.root,
        selectedPath,
        sourceKey: getSourceKey(state.source),
      } satisfies ReloadSelection),
    );
  } catch {
    return;
  }
};
