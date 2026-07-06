import type { GitFileStatus, RepositoryState, ReviewSource } from '../types.ts';
import { getSourceKey } from './source.ts';

const reloadSelectionStorageKey = 'codiff.reloadSelection.v3';

type ReloadSelectionFile = {
  fingerprint: string;
  path: string;
  status: GitFileStatus;
};

export type ReloadMainMode = 'commit' | 'review';

type ReloadSelection = {
  files: ReadonlyArray<ReloadSelectionFile>;
  historySource?: ReviewSource | null;
  mainMode?: ReloadMainMode;
  root: string;
  selectedPath: string | null;
  source: ReviewSource;
};

const getStorage = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value != null;

const isOptionalString = (value: unknown) => value == null || typeof value === 'string';

const isReviewSource = (value: unknown): value is ReviewSource => {
  if (!isObject(value) || typeof value.type !== 'string') {
    return false;
  }

  if (value.type === 'working-tree') {
    return true;
  }

  if (value.type === 'commit') {
    return typeof value.ref === 'string';
  }

  if (value.type === 'range') {
    return (
      typeof value.base === 'string' &&
      typeof value.head === 'string' &&
      typeof value.symmetric === 'boolean'
    );
  }

  if (value.type === 'branch') {
    return typeof value.ref === 'string';
  }

  if (value.type === 'branch-diff') {
    return (
      typeof value.ref === 'string' &&
      typeof value.baseRef === 'string' &&
      typeof value.headRef === 'string'
    );
  }

  return (
    value.type === 'pull-request' &&
    typeof value.url === 'string' &&
    (value.number == null || typeof value.number === 'number') &&
    isOptionalString(value.headSha) &&
    isOptionalString(value.owner) &&
    isOptionalString(value.repo) &&
    isOptionalString(value.title)
  );
};

const isGitFileStatus = (value: unknown): value is GitFileStatus =>
  value === 'added' ||
  value === 'deleted' ||
  value === 'modified' ||
  value === 'renamed' ||
  value === 'untracked';

const isReloadSelectionFile = (value: unknown): value is ReloadSelectionFile =>
  isObject(value) &&
  typeof value.fingerprint === 'string' &&
  typeof value.path === 'string' &&
  isGitFileStatus(value.status);

const isReloadSelection = (value: unknown): value is ReloadSelection =>
  isObject(value) &&
  Array.isArray(value.files) &&
  value.files.every(isReloadSelectionFile) &&
  (value.historySource == null || isReviewSource(value.historySource)) &&
  (value.mainMode == null || value.mainMode === 'commit' || value.mainMode === 'review') &&
  typeof value.root === 'string' &&
  (value.selectedPath == null || typeof value.selectedPath === 'string') &&
  isReviewSource(value.source);

const getMatchingSelection = (selection: ReloadSelection | null, state: RepositoryState) =>
  selection?.root === state.root && getSourceKey(selection.source) === getSourceKey(state.source)
    ? selection
    : null;

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
  const matchedSelection = getMatchingSelection(selection, state);
  if (!matchedSelection || !matchedSelection.selectedPath) {
    return null;
  }

  return state.files.some((file) => file.path === matchedSelection.selectedPath)
    ? matchedSelection.selectedPath
    : null;
};

export const getChangedPaths = (
  previousFiles: ReadonlyArray<ReloadSelectionFile>,
  nextFiles: ReadonlyArray<ReloadSelectionFile>,
): ReadonlySet<string> => {
  const previousByPath = new Map(previousFiles.map((file) => [file.path, file]));
  const changedPaths = new Set<string>();
  for (const file of nextFiles) {
    const previousFile = previousByPath.get(file.path);
    if (
      !previousFile ||
      previousFile.fingerprint !== file.fingerprint ||
      previousFile.status !== file.status
    ) {
      changedPaths.add(file.path);
    }
  }

  return changedPaths;
};

export const getReloadDeltaPaths = (
  selection: ReloadSelection | null,
  state: RepositoryState,
): ReadonlySet<string> => {
  const matchedSelection = getMatchingSelection(selection, state);
  if (!matchedSelection) {
    return new Set();
  }

  return getChangedPaths(matchedSelection.files, state.files);
};

export const getReloadHistorySource = (
  selection: ReloadSelection | null,
  state: RepositoryState,
): ReviewSource | null => getMatchingSelection(selection, state)?.historySource ?? null;

export const getReloadMainMode = (
  selection: ReloadSelection | null,
  state: RepositoryState,
): ReloadMainMode | null => getMatchingSelection(selection, state)?.mainMode ?? null;

export const writeReloadSelection = (
  state: RepositoryState | null,
  selectedPath: string | null,
  historySource: ReviewSource | null = null,
  mainMode: ReloadMainMode = 'review',
) => {
  const storage = getStorage();
  if (!storage || !state) {
    return;
  }

  try {
    storage.setItem(
      reloadSelectionStorageKey,
      JSON.stringify({
        files: state.files.map((file) => ({
          fingerprint: file.fingerprint,
          path: file.path,
          status: file.status,
        })),
        historySource,
        mainMode,
        root: state.root,
        selectedPath,
        source: state.source,
      } satisfies ReloadSelection),
    );
  } catch {
    return;
  }
};
