import type {
  CodiffLaunchOptions,
  RepositoryState,
  ResolvedReviewSource,
  ReviewSource,
} from '../types.ts';
import type { ReviewScrollTarget, SidebarMode } from './app-types.ts';
import {
  getReloadDeltaPaths,
  getReloadHistorySource,
  getReloadMainMode,
  getReloadSelectionPath,
  haveReloadedFilesChanged,
  type ReloadMainMode,
  type ReloadSelection,
} from './reload-selection.ts';
import {
  getHistorySource,
  getRefreshSource,
  getSourceKey,
  shouldStartInHistoryWhenEmpty,
} from './source.ts';

export type RepositoryReviewBootstrap = {
  forceInitialWalkthrough: boolean;
  historySource: ReviewSource | null;
  initialScrollTarget: ReviewScrollTarget | null;
  mainMode: ReloadMainMode;
  reloadDeltaPaths: ReadonlySet<string>;
  selectedPath: string | null;
  sidebarMode: SidebarMode;
  source: ResolvedReviewSource;
  state: RepositoryState;
};

export const resolveReloadSourceForLaunch = (
  reloadSelection: ReloadSelection | null,
  launchOptions: CodiffLaunchOptions,
): ReviewSource | undefined => {
  if (!reloadSelection) {
    return undefined;
  }
  if (!launchOptions.source) {
    return getRefreshSource(reloadSelection.source);
  }
  return getSourceKey(reloadSelection.source) === getSourceKey(launchOptions.source)
    ? getRefreshSource(reloadSelection.source)
    : undefined;
};

export const resolveRepositoryReviewBootstrap = ({
  launchOptions,
  reloadSelection,
  state,
}: {
  launchOptions: CodiffLaunchOptions;
  reloadSelection: ReloadSelection | null;
  state: RepositoryState;
}): RepositoryReviewBootstrap => {
  const restoredSelectedPath = getReloadSelectionPath(reloadSelection, state);
  const selectedPath = restoredSelectedPath ?? state.files[0]?.path ?? null;
  const requestedMainMode = getReloadMainMode(reloadSelection, state);
  const mainMode: ReloadMainMode =
    requestedMainMode === 'commit' && state.source.type === 'working-tree' && state.files.length > 0
      ? 'commit'
      : 'review';
  const walkthroughRequested = Boolean(launchOptions.walkthrough || launchOptions.walkthroughFile);
  const sidebarMode: SidebarMode = walkthroughRequested
    ? 'walkthrough'
    : shouldStartInHistoryWhenEmpty(state.source) && state.files.length === 0
      ? 'history'
      : 'tree';

  return {
    forceInitialWalkthrough:
      walkthroughRequested &&
      !launchOptions.walkthroughFile &&
      haveReloadedFilesChanged(reloadSelection, state),
    historySource:
      getReloadHistorySource(reloadSelection, state) ?? getHistorySource(state.source) ?? null,
    initialScrollTarget: restoredSelectedPath
      ? { behavior: 'instant', path: restoredSelectedPath, request: 1 }
      : null,
    mainMode,
    reloadDeltaPaths: getReloadDeltaPaths(reloadSelection, state),
    selectedPath,
    sidebarMode,
    source: state.source,
    state,
  };
};
