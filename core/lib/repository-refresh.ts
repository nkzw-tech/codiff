import type { RepositoryState, ReviewSource } from '../types.ts';
import type { ReloadMainMode } from './reload-selection.ts';
import { getHistorySource } from './source.ts';

type RefreshFile = RepositoryState['files'][number];

const getSectionCodeIdentity = (section: RefreshFile['sections'][number]) => {
  if (section.patch) {
    return `patch\0${section.patch}`;
  }

  if (section.summary?.fingerprint) {
    return `blob\0${section.summary.fingerprint}`;
  }

  if (section.oldFile || section.newFile) {
    return `contents\0${section.oldFile?.contents ?? ''}\0${section.newFile?.contents ?? ''}`;
  }

  return 'unavailable';
};

const getFileCodeIdentity = (file: RefreshFile) =>
  [
    file.path,
    file.oldPath ?? '',
    file.status,
    ...file.sections.map(getSectionCodeIdentity).toSorted(),
  ].join('\0');

const getFilesByPath = (files: RepositoryState['files']) =>
  new Map(files.map((file) => [file.path, getFileCodeIdentity(file)]));

const getReviewedCodeChangedPaths = (
  previousFiles: RepositoryState['files'],
  nextFiles: RepositoryState['files'],
) => {
  const previousByPath = getFilesByPath(previousFiles);
  const changedPaths = new Set<string>();
  for (const file of nextFiles) {
    if (previousByPath.get(file.path) !== getFileCodeIdentity(file)) {
      changedPaths.add(file.path);
    }
  }
  return changedPaths;
};

export const hasReviewedCodeChanged = (
  previousFiles: RepositoryState['files'],
  nextFiles: RepositoryState['files'],
) => {
  if (previousFiles.length !== nextFiles.length) {
    return true;
  }

  const previousIdentities = previousFiles.map(getFileCodeIdentity).toSorted();
  const nextIdentities = nextFiles.map(getFileCodeIdentity).toSorted();
  return previousIdentities.some((identity, index) => identity !== nextIdentities[index]);
};

export type RepositoryRefreshReconciliation = {
  changedPaths: ReadonlySet<string>;
  collapsed: Set<string>;
  historySource: ReviewSource | null;
  mainMode: ReloadMainMode;
  selectedPath: string | null;
  walkthroughNeedsRefresh: boolean;
};

export const reconcileRepositoryRefresh = ({
  collapsed,
  historySource,
  mainMode,
  nextState,
  previousState,
  selectedPath,
}: {
  collapsed: ReadonlySet<string>;
  historySource: ReviewSource | null;
  mainMode: ReloadMainMode;
  nextState: RepositoryState;
  previousState: RepositoryState;
  selectedPath: string | null;
}): RepositoryRefreshReconciliation => {
  const changedPaths = getReviewedCodeChangedPaths(previousState.files, nextState.files);
  const nextCollapsed = new Set(collapsed);
  for (const path of changedPaths) {
    nextCollapsed.delete(path);
  }

  return {
    changedPaths,
    collapsed: nextCollapsed,
    historySource: getHistorySource(nextState.source) ?? historySource,
    mainMode:
      mainMode === 'commit' &&
      (nextState.source.type !== 'working-tree' || nextState.files.length === 0)
        ? 'review'
        : mainMode,
    selectedPath:
      selectedPath != null && nextState.files.some((file) => file.path === selectedPath)
        ? selectedPath
        : (nextState.files[0]?.path ?? null),
    walkthroughNeedsRefresh: hasReviewedCodeChanged(previousState.files, nextState.files),
  };
};
