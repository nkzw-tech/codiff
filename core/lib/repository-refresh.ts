import type { RepositoryState, ReviewSource } from '../types.ts';
import type { ReloadMainMode } from './reload-selection.ts';
import { getChangedPaths, haveChangedFiles } from './reload-selection.ts';
import { getHistorySource } from './source.ts';

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
  const changedPaths = getChangedPaths(previousState.files, nextState.files);
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
    walkthroughNeedsRefresh: haveChangedFiles(previousState.files, nextState.files),
  };
};
