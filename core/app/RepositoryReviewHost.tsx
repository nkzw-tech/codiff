import type { FileDiffLoadedFiles } from '@pierre/diffs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodiffConfig } from '../config/types.ts';
import { HISTORY_PAGE_SIZE } from '../lib/app-constants.ts';
import {
  type RepositoryLoadError,
  type ReviewComment,
  type ReviewIdentity,
  type SourceSession,
} from '../lib/app-types.ts';
import { isPatchOnlyDiffSection, shouldLoadDiffSectionContents } from '../lib/diff.ts';
import { sortFiles } from '../lib/files.ts';
import {
  getChangedPaths,
  haveChangedFiles,
  writeReloadSelection,
} from '../lib/reload-selection.ts';
import { reconcileRepositoryRefresh } from '../lib/repository-refresh.ts';
import type { RepositoryReviewBootstrap } from '../lib/repository-review-bootstrap.ts';
import { resolveReviewCommandTarget } from '../lib/review-command-target.ts';
import { getReviewCommentsFromState, mergeReviewComments } from '../lib/review-comments.ts';
import { getFileReviewIdentity } from '../lib/review-identity.ts';
import {
  getHistorySource,
  getRefreshSource,
  getRepositoryLoadError,
  getSourceKey,
  getSourceLabel,
  getSourceRevisionKey,
  supportsLazyDiffContent,
  usesViewedFileState,
} from '../lib/source.ts';
import { readViewed, writeViewed } from '../lib/viewed.ts';
import {
  buildSharedReviewSnapshot,
  ReviewSurface,
  type ProviderReviewOutcome,
  type ReviewMode,
  type ReviewSurfaceCapabilities,
  type ReviewSurfaceCommandBridge,
  type ReviewWalkthroughStatus,
} from '../ReviewSurface.tsx';
import type {
  ChangedFile,
  CodiffLaunchOptions,
  CodiffPreferences,
  CodiffUpdateStatus,
  GitIdentity,
  HistoryEntry,
  NarrativeWalkthrough,
  NarrativeWalkthroughResult,
  OpenReviewSourceKind,
  RepositoryState,
  ReviewSource,
  DiffImageContentRequest,
  DiffImageContentResult,
  DiffSection,
  DiffSectionContentRequest,
} from '../types.ts';
import { OpenReviewSourceDialog } from './components/OpenReviewSourceDialog.tsx';
import { OpenReviewSourceMenu } from './components/OpenReviewSourceMenu.tsx';
import {
  RepositoryChangeBanner,
  RepositoryLoadErrorPanel,
  RepositoryRefreshBanner,
  type RepositoryRefreshStatus,
  ReviewCommentsLoadBanner,
  ReviewSourceLoading,
  UpdatePill,
  WalkthroughOutdatedBanner,
} from './components/Panels.tsx';
import { WalkthroughProgress } from './components/walkthrough/WalkthroughProgress.tsx';
import type { WalkthroughFileError } from './components/WalkthroughFileError.tsx';
import { useAppCommands } from './hooks/useAppCommands.ts';
import { useAppReviewComments } from './hooks/useAppReviewComments.ts';
import { useAppWalkthrough } from './hooks/useAppWalkthrough.ts';
import { useDocumentAppearance } from './hooks/useDocumentAppearance.ts';
import { useReviewFileState } from './hooks/useReviewState.ts';

const portableSurfaceCommandIds = new Set([
  'diff-search',
  'file-filter',
  'sidebar-history',
  'sidebar-tree',
  'sidebar-walkthrough',
  'toggle-sidebar',
  'toggle-word-wrap',
]);
const defaultReviewCommentsPrefix = '# Address these Review Comments';

type ReviewAuthoringMode = 'local-notes' | 'provider-comments' | 'read-only';

const getProviderMutationDestination = (
  source: RepositoryState['source'],
): 'github' | 'gitlab' | null =>
  source.type === 'pull-request' && (source.provider === 'github' || source.provider === 'gitlab')
    ? source.provider
    : null;

const getReviewAuthoringMode = (source: RepositoryState['source']): ReviewAuthoringMode =>
  getProviderMutationDestination(source)
    ? 'provider-comments'
    : source.type === 'pull-request'
      ? 'read-only'
      : 'local-notes';

const getPendingCommentsLabel = (mode: ReviewAuthoringMode) =>
  mode === 'provider-comments' ? 'Copy Pending Review Comments' : 'Copy Review Notes';

const getPendingCommentsPrefix = (mode: ReviewAuthoringMode, configuredPrefix: string) =>
  configuredPrefix === defaultReviewCommentsPrefix
    ? mode === 'provider-comments'
      ? '# Address these Pending Review Comments'
      : '# Address these Review Notes'
    : configuredPrefix;

const toPullRequestReviewEvent = (
  outcome: ProviderReviewOutcome,
): 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES' => {
  switch (outcome) {
    case 'approve':
      return 'APPROVE';
    case 'comment':
      return 'COMMENT';
    case 'request-changes':
      return 'REQUEST_CHANGES';
  }
};

const createPlaceholderWalkthrough = (
  state: RepositoryState,
  title: string,
  agent: NarrativeWalkthrough['agent'],
): NarrativeWalkthrough => ({
  agent,
  chapters: [],
  focus: 'Generate a walkthrough to review this change in narrative order.',
  generatedAt: new Date(state.generatedAt).toISOString(),
  kind: 'narrative',
  repo: { branch: state.branch, root: state.root },
  source: state.source,
  support: [],
  title,
  version: 4,
});

const getFailedSectionLoadState = (section: DiffSection): DiffSection =>
  isPatchOnlyDiffSection(section)
    ? {
        ...section,
        summary: {
          canLoad: false,
          reason: 'Codiff could not load full file context.',
        },
      }
    : {
        ...section,
        loadState: 'error',
        summary: {
          canLoad: false,
          reason: 'Codiff could not load this file.',
        },
      };

const getPreferencesFromConfig = ({ settings }: CodiffConfig): CodiffPreferences => ({
  ...settings,
});

const getCollapsedViewedPaths = (
  files: ReadonlyArray<ChangedFile>,
  viewedFiles: Readonly<Record<string, string>>,
) =>
  new Set(
    files.filter((file) => viewedFiles[file.path] === file.fingerprint).map((file) => file.path),
  );

const mergeStateReviewComments = (
  state: RepositoryState,
  currentComments: ReadonlyArray<ReviewComment>,
) =>
  mergeReviewComments(
    getReviewCommentsFromState(state),
    currentComments.filter((comment) => !comment.isReadOnly),
  );

export type RepositoryReviewHostProps = {
  bootstrap: RepositoryReviewBootstrap;
  config: CodiffConfig;
  disableCodeViewWorkerPool?: boolean;
  gitIdentity: GitIdentity | null;
  gitIdentityReady: boolean;
  initialHistory?: ReadonlyArray<HistoryEntry>;
  initialHistoryLoading?: boolean;
  initialWalkthroughFileError?: WalkthroughFileError | null;
  initialWalkthroughLoading?: boolean;
  initialWalkthroughResult?: NarrativeWalkthroughResult;
  launchOptions: CodiffLaunchOptions;
  walkthroughSharingEnabled?: boolean;
};

export function RepositoryReviewHost({
  bootstrap,
  config,
  disableCodeViewWorkerPool = false,
  gitIdentity,
  gitIdentityReady,
  initialHistory = [],
  initialHistoryLoading = false,
  initialWalkthroughFileError,
  initialWalkthroughLoading = false,
  initialWalkthroughResult,
  launchOptions,
  walkthroughSharingEnabled = false,
}: RepositoryReviewHostProps) {
  const {
    historySource: initialHistorySource,
    initialScrollTarget,
    mainMode: initialMainMode,
    reloadDeltaPaths: initialReloadDeltaPaths,
    selectedPath: initialSelectedPath,
    sidebarMode: startupMode,
    state: initialState,
  } = bootstrap;
  const [loadError, setLoadError] = useState<RepositoryLoadError | null>(null);
  const [historyEntries, setHistoryEntries] = useState<ReadonlyArray<HistoryEntry>>(initialHistory);
  const [historyHasMore, setHistoryHasMore] = useState(initialHistory.length >= HISTORY_PAGE_SIZE);
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE_SIZE);
  const [historyLoading, setHistoryLoading] = useState(initialHistoryLoading);
  const [initialHistoryComplete, setInitialHistoryComplete] = useState(!initialHistoryLoading);
  const [historySource, setHistorySource] = useState<ReviewSource | null>(() =>
    initialHistorySource === undefined
      ? (getHistorySource(initialState.source) ?? null)
      : initialHistorySource,
  );
  const [localChangesDetected, setLocalChangesDetected] = useState(false);
  const [repositoryRefreshStatus, setRepositoryRefreshStatus] =
    useState<RepositoryRefreshStatus | null>(null);
  const [walkthroughStale, setWalkthroughStale] = useState(false);
  const [openReviewSourceKind, setOpenReviewSourceKind] = useState<OpenReviewSourceKind | null>(
    null,
  );
  const preferences = useMemo(() => getPreferencesFromConfig(config), [config]);
  const [reloadDeltaPaths, setReloadDeltaPaths] = useState<ReadonlySet<string>>(
    () => initialReloadDeltaPaths,
  );
  const [surfaceInitialScrollTarget, setSurfaceInitialScrollTarget] = useState(initialScrollTarget);
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(false);
  const [pendingSource, setPendingSource] = useState<ReviewSource | null>(null);
  const [loadingSectionIds, setLoadingSectionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [, setSidebarCollapsed] = useState<boolean>(false);
  const [state, setState] = useState<RepositoryState | null>(() => ({
    ...initialState,
    files: sortFiles(initialState.files),
  }));
  const [updateStatus, setUpdateStatus] = useState<CodiffUpdateStatus | null>(null);
  const historyRequestRef = useRef(0);
  const historySourceRef = useRef<ReviewSource | null>(null);
  const diffContentRequestCounterRef = useRef(0);
  const diffContentRequestIdsRef = useRef<Set<string>>(new Set());
  const loadingSectionKeysRef = useRef<Set<string>>(new Set());
  const reviewCommentsRequestRef = useRef(0);
  const repositoryRefreshRequestRef = useRef(0);
  const reviewCommentsInFlightRef = useRef<{
    generation: number;
    request: number;
    requestId: string;
    sourceKey: string;
  } | null>(null);
  const surfaceCommandBridgeRef = useRef<ReviewSurfaceCommandBridge | null>(null);
  const sourceSessionsRef = useRef<Map<string, SourceSession>>(new Map());
  const stateRef = useRef<RepositoryState | null>(state);
  const firstUsableMilestoneReportedRef = useRef(false);
  const deferredMilestoneReportedRef = useRef(false);
  const walkthroughFileFallbackAppliedRef = useRef(false);
  const initialViewed = usesViewedFileState(initialState.source)
    ? readViewed(initialState.root)
    : {};
  const initialCollapsed = getCollapsedViewedPaths(initialState.files, initialViewed);
  const collapsedRef = useRef<Set<string>>(initialCollapsed);
  const expandedGeneratedRef = useRef<Set<string>>(new Set());
  const preferencesRef = useRef<CodiffPreferences>(preferences);
  const previousShowWhitespaceRef = useRef(config.settings.showWhitespace);
  const selectedPathRef = useRef<string | null>(null);
  const sourceRequestRef = useRef(0);
  const stateGenerationRef = useRef(0);
  const markdownRefreshQueueRef = useRef<Promise<void>>(Promise.resolve());
  const viewedRef = useRef<Record<string, string>>(initialViewed);
  const persistViewed = useCallback((nextViewed: Record<string, string>) => {
    const currentState = stateRef.current;
    if (currentState && usesViewedFileState(currentState.source)) {
      writeViewed(currentState.root, nextViewed);
    }
  }, []);
  const {
    bumpItemVersion,
    collapsed,
    expandedGenerated,
    itemVersionByKey,
    selectedPath,
    setCollapsed,
    setExpandedGenerated,
    setItemVersionByKey,
    setSelectedPath,
    setViewed,
    toggleViewed: toggleReviewViewed,
    viewed,
  } = useReviewFileState({
    initialCollapsed,
    initialSelectedPath,
    initialViewed,
    onViewedChange: persistViewed,
  });
  const toggleViewed = useCallback(
    (file: ChangedFile, isViewed: boolean, reviewIdentity?: ReviewIdentity) => {
      if (!stateRef.current) {
        return;
      }
      if (reviewIdentity) {
        toggleReviewViewed(file, isViewed, reviewIdentity);
      } else {
        toggleReviewViewed(file, isViewed);
      }
    },
    [toggleReviewViewed],
  );

  useEffect(() => {
    if (!state || firstUsableMilestoneReportedRef.current) {
      return;
    }
    firstUsableMilestoneReportedRef.current = true;
    window.codiff.reportInitialLoadMilestone?.('first-usable-review-rendered');
  }, [state]);

  const { askCodex, resetCommentFocus, reviewComments, reviewCommentsRef, setReviewComments } =
    useAppReviewComments({
      initialReviewComments: getReviewCommentsFromState(initialState),
      onCommentFileChange: bumpItemVersion,
      stateRef,
    });

  const hydrateReviewComments = useCallback(
    (requestedState: RepositoryState | null = stateRef.current) => {
      if (
        requestedState?.source.type !== 'pull-request' ||
        requestedState.reviewCommentsLoadState === 'loaded'
      ) {
        return;
      }

      const sourceKey = `${requestedState.root}:${getSourceRevisionKey(requestedState.source)}`;
      const generation = stateGenerationRef.current;
      const inFlight = reviewCommentsInFlightRef.current;
      if (inFlight?.sourceKey === sourceKey && inFlight.generation === generation) {
        return;
      }

      if (inFlight) {
        window.codiff.cancelDiffContentRequest(inFlight.requestId);
        diffContentRequestIdsRef.current.delete(inFlight.requestId);
      }
      const request = reviewCommentsRequestRef.current + 1;
      const requestId = `review-comments:${request}`;
      reviewCommentsRequestRef.current = request;
      diffContentRequestIdsRef.current.add(requestId);
      reviewCommentsInFlightRef.current = { generation, request, requestId, sourceKey };
      const isCurrentState = () => {
        const current = stateRef.current;
        return (
          reviewCommentsRequestRef.current === request &&
          stateGenerationRef.current === generation &&
          current != null &&
          `${current.root}:${getSourceRevisionKey(current.source)}` === sourceKey
        );
      };

      if (requestedState.reviewCommentsLoadState === 'failed') {
        const retryingState = {
          ...requestedState,
          reviewCommentsError: undefined,
          reviewCommentsLoadState: 'not-loaded' as const,
        };
        stateRef.current = retryingState;
        setState(retryingState);
      }

      void window.codiff
        .getReviewComments(requestedState.source, requestId)
        .then((loadedComments) => {
          if (!isCurrentState()) {
            return;
          }
          const current = stateRef.current;
          if (!current) {
            return;
          }
          const hydratedState = {
            ...current,
            reviewComments: loadedComments,
            reviewCommentsError: undefined,
            reviewCommentsLoadState: 'loaded' as const,
          };
          stateRef.current = hydratedState;
          setState(hydratedState);
          setReviewComments((comments) => mergeStateReviewComments(hydratedState, comments));
        })
        .catch((error: unknown) => {
          if (!isCurrentState()) {
            return;
          }
          const current = stateRef.current;
          if (!current) {
            return;
          }
          const failedState = {
            ...current,
            reviewCommentsError: error instanceof Error ? error.message : String(error),
            reviewCommentsLoadState: 'failed' as const,
          };
          stateRef.current = failedState;
          setState(failedState);
        })
        .finally(() => {
          diffContentRequestIdsRef.current.delete(requestId);
          if (reviewCommentsInFlightRef.current?.request === request) {
            reviewCommentsInFlightRef.current = null;
          }
        });
    },
    [setReviewComments],
  );
  const {
    activeReviewCommandTargetRef,
    cancelWalkthroughRequest,
    changeSidebarMode,
    closeCommitView,
    commitWalkthrough,
    enabledShareWalkthrough,
    loadNarrativeWalkthrough,
    mainModeRef,
    narrativeNavigation,
    narrativeWalkthrough,
    narrativeWalkthroughRef,
    openCommitView,
    plainCommitModel,
    refreshWalkthroughForState,
    setMainMode,
    setNarrativeWalkthrough,
    setShareWalkthroughEnabled,
    setSidebarMode,
    setWalkthroughError,
    setWalkthroughFileError,
    setWalkthroughLoading,
    setWalkthroughUnread,
    showPlainCommitView,
    sidebarMode,
    sidebarModeRef,
    subscribeToCommitOutput,
    updateActiveWalkthroughReviewTarget,
    updateWalkthroughCommitMessage,
    walkthroughError,
    walkthroughErrorRef,
    walkthroughFileError,
    walkthroughLoading,
    walkthroughProgress,
    walkthroughUnread,
  } = useAppWalkthrough({
    initialMainMode,
    initialSidebarMode: startupMode,
    initialWalkthroughFileError,
    initialWalkthroughLoading,
    initialWalkthroughResult,
    preferencesRef,
    state,
    stateGenerationRef,
    stateRef,
  });

  useEffect(() => {
    if (
      walkthroughFileFallbackAppliedRef.current ||
      !initialWalkthroughFileError ||
      initialWalkthroughResult?.status !== 'unavailable' ||
      !state ||
      getSourceRevisionKey(state.source) !== getSourceRevisionKey(bootstrap.source)
    ) {
      return;
    }
    walkthroughFileFallbackAppliedRef.current = true;
    changeSidebarMode('history');
  }, [
    bootstrap.source,
    changeSidebarMode,
    initialWalkthroughFileError,
    initialWalkthroughResult,
    state,
  ]);

  useEffect(() => {
    if (
      !state ||
      state.source.type !== 'pull-request' ||
      state.reviewCommentsLoadState !== 'not-loaded'
    ) {
      return;
    }
    hydrateReviewComments(state);
  }, [hydrateReviewComments, state]);

  useEffect(() => {
    const reviewCommentsComplete =
      !state ||
      state.source.type !== 'pull-request' ||
      state.reviewCommentsLoadState !== 'not-loaded';
    if (
      !firstUsableMilestoneReportedRef.current ||
      !initialHistoryComplete ||
      !gitIdentityReady ||
      !reviewCommentsComplete ||
      walkthroughLoading ||
      deferredMilestoneReportedRef.current
    ) {
      return;
    }
    deferredMilestoneReportedRef.current = true;
    window.codiff.reportInitialLoadMilestone?.('deferred-review-data-complete');
  }, [
    gitIdentityReady,
    initialHistoryComplete,
    state,
    walkthroughLoading,
  ]);
  const [commentsMode, setCommentsMode] = useState(false);
  const activeSurfaceMode: ReviewMode = commentsMode ? 'comments' : sidebarMode;
  const changeSurfaceMode = useCallback(
    (mode: ReviewMode) => {
      if (mode === 'comments') {
        setMainMode('review');
        setCommentsMode(true);
        return;
      }
      setCommentsMode(false);
      if (mode === 'walkthrough' && walkthroughStale) {
        setMainMode('review');
        setSidebarMode('walkthrough');
        setWalkthroughUnread(false);
        return;
      }
      changeSidebarMode(mode);
    },
    [changeSidebarMode, setMainMode, setSidebarMode, setWalkthroughUnread, walkthroughStale],
  );

  const cancelDiffContentRequests = useCallback(() => {
    for (const requestId of diffContentRequestIdsRef.current) {
      window.codiff.cancelDiffContentRequest(requestId);
    }
    diffContentRequestIdsRef.current.clear();
  }, []);
  useEffect(() => cancelDiffContentRequests, [cancelDiffContentRequests]);

  const requestDiffSectionContent = useCallback((request: DiffSectionContentRequest) => {
    const requestId = `section:${diffContentRequestCounterRef.current + 1}`;
    diffContentRequestCounterRef.current += 1;
    diffContentRequestIdsRef.current.add(requestId);
    return window.codiff
      .getDiffSectionContent({ ...request, requestId })
      .finally(() => diffContentRequestIdsRef.current.delete(requestId));
  }, []);

  const requestDiffImageContent = useCallback(
    (request: DiffImageContentRequest): Promise<DiffImageContentResult> => {
      const requestId = `image:${diffContentRequestCounterRef.current + 1}`;
      diffContentRequestCounterRef.current += 1;
      diffContentRequestIdsRef.current.add(requestId);
      return window.codiff
        .getDiffImageContent({ ...request, requestId })
        .finally(() => diffContentRequestIdsRef.current.delete(requestId));
    },
    [],
  );

  const loadDiffSection = useCallback(
    (file: ChangedFile, section: DiffSection, repositoryState = stateRef.current) => {
      const currentState = repositoryState;
      if (
        !currentState ||
        !supportsLazyDiffContent(currentState.source) ||
        !shouldLoadDiffSectionContents(section)
      ) {
        return;
      }

      const sourceKey = getSourceRevisionKey(currentState.source);
      const stateGeneration = stateGenerationRef.current;
      const reviewKey = getFileReviewIdentity(file).key;
      const key = `${currentState.root}:${sourceKey}:${section.id}`;
      if (loadingSectionKeysRef.current.has(key)) {
        return;
      }

      loadingSectionKeysRef.current.add(key);
      setLoadingSectionIds((current) => new Set(current).add(section.id));

      return requestDiffSectionContent({
        force: true,
        kind: section.kind,
        path: file.path,
        showWhitespace: preferencesRef.current.showWhitespace,
        source: currentState.source,
      })
        .then((loadedSection) => {
          if (
            stateGenerationRef.current !== stateGeneration ||
            stateRef.current?.root !== currentState.root ||
            getSourceRevisionKey(stateRef.current.source) !== sourceKey
          ) {
            return;
          }
          setState((current) => {
            if (
              stateGenerationRef.current !== stateGeneration ||
              !current ||
              current.root !== currentState.root ||
              getSourceRevisionKey(current.source) !== sourceKey
            ) {
              return current;
            }

            return {
              ...current,
              files: current.files.map((candidate) =>
                candidate.path === file.path
                  ? {
                      ...candidate,
                      sections: candidate.sections.map((candidateSection) =>
                        candidateSection.id === section.id ? loadedSection : candidateSection,
                      ),
                    }
                  : candidate,
              ),
            };
          });
          bumpItemVersion(reviewKey);
        })
        .catch(() => {
          if (
            stateGenerationRef.current !== stateGeneration ||
            stateRef.current?.root !== currentState.root ||
            getSourceRevisionKey(stateRef.current.source) !== sourceKey
          ) {
            return;
          }
          setState((current) => {
            if (
              stateGenerationRef.current !== stateGeneration ||
              !current ||
              current.root !== currentState.root ||
              getSourceRevisionKey(current.source) !== sourceKey
            ) {
              return current;
            }

            return {
              ...current,
              files: current.files.map((candidate) =>
                candidate.path === file.path
                  ? {
                      ...candidate,
                      sections: candidate.sections.map((candidateSection) =>
                        candidateSection.id === section.id
                          ? getFailedSectionLoadState(candidateSection)
                          : candidateSection,
                      ),
                    }
                  : candidate,
              ),
            };
          });
          bumpItemVersion(reviewKey);
        })
        .finally(() => {
          loadingSectionKeysRef.current.delete(key);
          setLoadingSectionIds((current) => {
            const next = new Set(current);
            next.delete(section.id);
            return next;
          });
        });
    },
    [bumpItemVersion, requestDiffSectionContent],
  );

  // Fetches full file contents for a patch-only section so the CodeView
  // `loadDiffFiles` option can hydrate the rendered diff in place. Unlike
  // `loadDiffSection`, this must not touch React state: replacing the section
  // would reset the hydrated diff object's identity.
  const loadDiffSectionContents = useCallback(
    async (file: ChangedFile, section: DiffSection): Promise<FileDiffLoadedFiles> => {
      const currentState = stateRef.current;
      if (!currentState || !supportsLazyDiffContent(currentState.source)) {
        throw new Error(`Cannot load diff contents for '${file.path}'.`);
      }

      const loadedSection = await requestDiffSectionContent({
        force: true,
        kind: section.kind,
        path: file.path,
        showWhitespace: preferencesRef.current.showWhitespace,
        source: currentState.source,
      });
      if (!loadedSection.newFile) {
        throw new Error(`No file contents available for '${file.path}'.`);
      }

      return {
        newFile: loadedSection.newFile,
        oldFile: loadedSection.oldFile ?? null,
      };
    },
    [requestDiffSectionContent],
  );

  const refreshMarkdownFile = useCallback(
    (file: ChangedFile, _section: DiffSection) => {
      const refresh = async () => {
        const currentState = stateRef.current;
        if (
          !currentState ||
          (currentState.source.type !== 'working-tree' &&
            currentState.source.type !== 'branch-working-tree')
        ) {
          return true;
        }
        const sourceRequest = sourceRequestRef.current;
        const stateGeneration = stateGenerationRef.current;
        const sourceKey = getSourceRevisionKey(currentState.source);

        try {
          const nextState = await window.codiff.getRepositoryState(
            getRefreshSource(currentState.source),
          );
          const orderedState = {
            ...nextState,
            files: sortFiles(nextState.files),
          };
          if (
            sourceRequestRef.current !== sourceRequest ||
            stateGenerationRef.current !== stateGeneration ||
            stateRef.current?.root !== currentState.root ||
            getSourceRevisionKey(stateRef.current.source) !== sourceKey
          ) {
            return false;
          }

          const changedPaths = getChangedPaths(currentState.files, orderedState.files);
          const walkthroughNeedsRefresh = haveChangedFiles(currentState.files, orderedState.files);
          stateGenerationRef.current += 1;
          stateRef.current = orderedState;
          setState(orderedState);
          setLocalChangesDetected(false);
          setReviewComments((comments) => mergeStateReviewComments(orderedState, comments));
          if (walkthroughNeedsRefresh) {
            refreshWalkthroughForState(orderedState);
          }
          setCollapsed((current) => {
            const next = new Set(current);
            for (const path of changedPaths) {
              next.delete(path);
            }
            return next;
          });
          setSelectedPath((current) =>
            current && orderedState.files.some((candidate) => candidate.path === current)
              ? current
              : (orderedState.files[0]?.path ?? null),
          );
          if (changedPaths.size === 0) {
            bumpItemVersion(file.path);
          } else {
            for (const path of changedPaths) {
              bumpItemVersion(path);
            }
          }
          return true;
        } catch {
          setLocalChangesDetected(true);
          return false;
        }
      };

      const result = markdownRefreshQueueRef.current.then(refresh, refresh);
      markdownRefreshQueueRef.current = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    [bumpItemVersion, refreshWalkthroughForState, setCollapsed, setReviewComments, setSelectedPath],
  );

  const saveCurrentSourceSession = useCallback(() => {
    const currentState = stateRef.current;
    if (!currentState) {
      return;
    }

    sourceSessionsRef.current.set(getSourceRevisionKey(currentState.source), {
      collapsed: new Set(collapsedRef.current),
      expandedGenerated: new Set(expandedGeneratedRef.current),
      narrativeWalkthrough: narrativeWalkthroughRef.current,
      reviewComments: reviewCommentsRef.current,
      selectedPath: selectedPathRef.current,
      viewed: viewedRef.current,
      walkthroughError: walkthroughErrorRef.current,
      walkthroughFiles: currentState.files.map(({ fingerprint, path, status }) => ({
        fingerprint,
        path,
        status,
      })),
    });
  }, [narrativeWalkthroughRef, reviewCommentsRef, walkthroughErrorRef]);

  useEffect(
    () =>
      window.codiff.onRepositoryChanged(() => {
        setLocalChangesDetected(true);
      }),
    [],
  );

  useEffect(() => {
    void window.codiff.isWindowFullScreen().then(setIsWindowFullscreen, () => {});
    return window.codiff.onWindowFullScreenChanged(setIsWindowFullscreen);
  }, []);

  useEffect(() => {
    setShareWalkthroughEnabled(walkthroughSharingEnabled);
  }, [setShareWalkthroughEnabled, walkthroughSharingEnabled]);

  useEffect(() => {
    if (
      !state ||
      state.source.type === 'pull-request' ||
      !supportsLazyDiffContent(state.source) ||
      !selectedPath
    ) {
      return;
    }

    const selectedFile = state.files.find((file) => file.path === selectedPath);
    if (!selectedFile) {
      return;
    }

    const loadableSections = selectedFile.sections.filter(shouldLoadDiffSectionContents);

    if (!loadableSections.length) {
      return;
    }

    for (const section of loadableSections) {
      loadDiffSection(selectedFile, section, state);
    }
  }, [loadDiffSection, selectedPath, state]);

  useEffect(() => {
    const previousShowWhitespace = previousShowWhitespaceRef.current;
    const nextPreferences = preferences;
    previousShowWhitespaceRef.current = nextPreferences.showWhitespace;

    if (previousShowWhitespace === nextPreferences.showWhitespace) {
      return;
    }

    const currentState = stateRef.current;
    if (!currentState) {
      return;
    }

    const request = sourceRequestRef.current + 1;
    sourceRequestRef.current = request;
    stateGenerationRef.current += 1;
    loadingSectionKeysRef.current.clear();
    setLoadingSectionIds(new Set());

    window.codiff
      .getRepositoryState(getRefreshSource(currentState.source))
      .then((nextState) => {
        if (sourceRequestRef.current !== request) {
          return;
        }

        const orderedState = {
          ...nextState,
          files: sortFiles(nextState.files),
        };
        const nextSelectedPath =
          selectedPathRef.current &&
          orderedState.files.some((file) => file.path === selectedPathRef.current)
            ? selectedPathRef.current
            : (orderedState.files[0]?.path ?? null);
        const nextViewed = usesViewedFileState(orderedState.source)
          ? readViewed(orderedState.root)
          : {};
        const walkthroughNeedsRefresh = haveChangedFiles(currentState.files, orderedState.files);

        stateRef.current = orderedState;
        setState(orderedState);
        if (walkthroughNeedsRefresh) {
          refreshWalkthroughForState(orderedState);
        }
        setSelectedPath(nextSelectedPath);
        setReloadDeltaPaths(new Set());
        setItemVersionByKey({});
        setReviewComments((comments) => mergeStateReviewComments(orderedState, comments));
        setViewed(nextViewed);
        setCollapsed(getCollapsedViewedPaths(orderedState.files, nextViewed));
        setExpandedGenerated(new Set());
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (sourceRequestRef.current !== request) {
          return;
        }
        setLoadError(getRepositoryLoadError(error));
      });
  }, [
    preferences,
    setCollapsed,
    setExpandedGenerated,
    setItemVersionByKey,
    refreshWalkthroughForState,
    setReviewComments,
    setSelectedPath,
    setViewed,
  ]);

  useDocumentAppearance({
    cleanupCodeFontProperties: true,
    clearEmptyCodeFontFamily: true,
    codeFontFamily: preferences.codeFontFamily,
    codeFontSize: preferences.codeFontSize,
    theme: preferences.theme,
  });

  useEffect(() => {
    let canceled = false;
    window.codiff
      .getUpdateStatus()
      .then((status) => {
        if (!canceled) {
          setUpdateStatus(status);
        }
      })
      .catch(() => {});

    const unsubscribe = window.codiff.onUpdateStatusChanged(setUpdateStatus);
    return () => {
      canceled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    historySourceRef.current = historySource;
  }, [historySource]);

  useEffect(() => {
    if (!initialHistoryLoading) {
      return;
    }
    const request = historyRequestRef.current + 1;
    historyRequestRef.current = request;
    const requestedSource = historySource;
    const requestedSourceKey = requestedSource ? getSourceRevisionKey(requestedSource) : '';
    const stateGeneration = stateGenerationRef.current;
    queueMicrotask(() => {
      if (historyRequestRef.current !== request) {
        return;
      }
      setHistoryLoading(true);
      void window.codiff
        .getRepositoryHistory(HISTORY_PAGE_SIZE, requestedSource ?? undefined)
        .then((nextHistory) => {
          const currentSource = historySourceRef.current;
          const currentSourceKey = currentSource ? getSourceRevisionKey(currentSource) : '';
          if (
            historyRequestRef.current !== request ||
            stateGenerationRef.current !== stateGeneration ||
            currentSourceKey !== requestedSourceKey
          ) {
            return;
          }
          setHistoryEntries(nextHistory.entries);
          setHistoryHasMore(nextHistory.entries.length >= HISTORY_PAGE_SIZE);
        })
        .catch(() => {
          if (historyRequestRef.current === request) {
            setHistoryHasMore(false);
          }
        })
        .finally(() => {
          if (historyRequestRef.current === request) {
            setHistoryLoading(false);
            setInitialHistoryComplete(true);
          }
        });
    });
  }, [historySource, initialHistoryLoading]);

  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  useEffect(() => {
    expandedGeneratedRef.current = expandedGenerated;
  }, [expandedGenerated]);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    const removeListener = window.codiff.onCopyPendingCommentsRequest(() => {
      return surfaceCommandBridgeRef.current?.copyPendingComments() ?? '';
    });
    return removeListener;
  }, [reviewCommentsRef]);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    viewedRef.current = viewed;
  }, [viewed]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => !current);
  }, []);

  const toggleWordWrap = useCallback(() => {
    void window.codiff.setWordWrap(!preferencesRef.current.wordWrap).catch(() => {});
  }, []);

  const expandSidebar = useCallback(() => {
    setSidebarCollapsed(false);
  }, []);

  const focusFileFilter = useCallback(() => {
    expandSidebar();
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('.sidebar-search');
      input?.focus();
      input?.select();
    });
  }, [expandSidebar]);

  const openFile = useCallback((file: ChangedFile) => {
    // Deleted files are still shown in diffs, but there is no current file to open.
    if (file.status === 'deleted') {
      return;
    }

    void window.codiff.openFile(file.path).catch(() => {});
  }, []);

  const getReviewCommandTarget = useCallback(() => {
    const currentState = stateRef.current;
    if (!currentState) {
      return null;
    }

    return resolveReviewCommandTarget({
      activeTarget: activeReviewCommandTargetRef.current,
      files: currentState.files,
      selectedPath: selectedPathRef.current,
      source: currentState.source,
      useActiveTarget:
        mainModeRef.current === 'review' &&
        sidebarModeRef.current === 'walkthrough' &&
        narrativeWalkthroughRef.current != null,
    });
  }, [activeReviewCommandTargetRef, mainModeRef, narrativeWalkthroughRef, sidebarModeRef]);

  const openSelectedFile = useCallback(() => {
    const target = getReviewCommandTarget();

    if (target) {
      openFile(target.file);
    }
  }, [getReviewCommandTarget, openFile]);

  const openSurfaceDiffSearch = useCallback(() => {
    surfaceCommandBridgeRef.current?.openDiffSearch();
  }, []);
  const copyPendingComments = useCallback(
    () => surfaceCommandBridgeRef.current?.copyPendingComments() ?? '',
    [],
  );
  useEffect(() => window.codiff.onFindInDiffs(openSurfaceDiffSearch), [openSurfaceDiffSearch]);
  const updateSurfaceCommandBridge = useCallback((bridge: ReviewSurfaceCommandBridge | null) => {
    surfaceCommandBridgeRef.current = bridge;
  }, []);

  const loadMoreHistory = useCallback(() => {
    if (historyLoading || !historyHasMore) {
      return;
    }

    const nextLimit = historyLimit + HISTORY_PAGE_SIZE;
    const request = historyRequestRef.current + 1;
    historyRequestRef.current = request;
    const requestedSourceKey = historySource ? getSourceRevisionKey(historySource) : '';
    const stateGeneration = stateGenerationRef.current;
    setHistoryLoading(true);
    window.codiff
      .getRepositoryHistory(nextLimit, historySource ?? undefined)
      .then((history) => {
        const currentSource = historySourceRef.current;
        const currentSourceKey = currentSource ? getSourceRevisionKey(currentSource) : '';
        if (
          historyRequestRef.current !== request ||
          stateGenerationRef.current !== stateGeneration ||
          currentSourceKey !== requestedSourceKey
        ) {
          return;
        }

        setHistoryEntries(history.entries);
        setHistoryLimit(nextLimit);
        setHistoryHasMore(history.entries.length >= nextLimit);
      })
      .catch(() => {
        if (historyRequestRef.current === request) {
          setHistoryHasMore(false);
        }
      })
      .finally(() => {
        if (historyRequestRef.current === request) {
          setHistoryLoading(false);
        }
      });
  }, [historyHasMore, historyLimit, historyLoading, historySource]);

  // Refresh the repository state in place after the working tree changed.
  // Unlike a window reload, this keeps all review UI state (selection, scroll,
  // search, walkthrough navigation, commit drafts, pending comments) and only
  // re-renders files whose reviewed code actually changed.
  useEffect(() => {
    if (repositoryRefreshStatus?.phase !== 'complete' || walkthroughStale) {
      return;
    }
    const timeout = window.setTimeout(() => setRepositoryRefreshStatus(null), 2500);
    return () => window.clearTimeout(timeout);
  }, [repositoryRefreshStatus, walkthroughStale]);

  const refreshRepository = useCallback(() => {
    const previousState = stateRef.current;
    if (!previousState || pendingSource) {
      return;
    }

    setRepositoryRefreshStatus({ phase: 'refreshing' });
    const request = repositoryRefreshRequestRef.current + 1;
    repositoryRefreshRequestRef.current = request;
    const sourceRequest = sourceRequestRef.current;
    reviewCommentsRequestRef.current += 1;
    reviewCommentsInFlightRef.current = null;
    const historyRequest = historyRequestRef.current + 1;
    historyRequestRef.current = historyRequest;
    const refreshSource = getRefreshSource(previousState.source);
    const refreshHistorySource = historySourceRef.current
      ? getRefreshSource(historySourceRef.current)
      : undefined;
    const pendingReviewComments = reviewComments.filter((comment) => !comment.isReadOnly);

    Promise.all([
      window.codiff.getRepositoryState(refreshSource),
      window.codiff.getRepositoryHistory(historyLimit, refreshHistorySource),
    ])
      .then(([nextState, history]) => {
        if (
          repositoryRefreshRequestRef.current !== request ||
          sourceRequestRef.current !== sourceRequest ||
          historyRequestRef.current !== historyRequest
        ) {
          return;
        }

        const requestedState = {
          ...nextState,
          files: sortFiles(nextState.files),
        };
        const reconciliation = reconcileRepositoryRefresh({
          collapsed: collapsedRef.current,
          historySource: historySourceRef.current,
          mainMode: mainModeRef.current,
          nextState: requestedState,
          previousState,
          selectedPath: selectedPathRef.current,
        });
        const reviewedCodeChanged = reconciliation.walkthroughNeedsRefresh;
        const orderedState = reviewedCodeChanged
          ? requestedState
          : { ...requestedState, files: previousState.files };

        if (reviewedCodeChanged) {
          cancelDiffContentRequests();
          stateGenerationRef.current += 1;
          if (
            sidebarModeRef.current === 'walkthrough' ||
            narrativeWalkthrough != null ||
            walkthroughLoading
          ) {
            setWalkthroughStale(true);
          }
        }
        stateRef.current = orderedState;
        setState(orderedState);
        setReloadDeltaPaths(reconciliation.changedPaths);
        for (const path of reconciliation.changedPaths) {
          bumpItemVersion(path);
        }
        setCollapsed(reconciliation.collapsed);
        setHistoryEntries(history.entries);
        setHistoryHasMore(history.entries.length >= historyLimit);
        setHistoryLoading(false);
        setInitialHistoryComplete(true);
        setHistorySource(reconciliation.historySource);
        setReviewComments(
          mergeReviewComments(getReviewCommentsFromState(orderedState), pendingReviewComments),
        );
        setSelectedPath(reconciliation.selectedPath);
        if (reconciliation.mainMode !== mainModeRef.current) {
          setMainMode(reconciliation.mainMode);
        }
        setLocalChangesDetected(false);
        setRepositoryRefreshStatus({ phase: 'complete', updated: reviewedCodeChanged });
      })
      .catch((error: unknown) => {
        if (
          repositoryRefreshRequestRef.current === request &&
          sourceRequestRef.current === sourceRequest &&
          historyRequestRef.current === historyRequest
        ) {
          setHistoryLoading(false);
          setInitialHistoryComplete(true);
          setRepositoryRefreshStatus({
            phase: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        // Keep the current state; the banner stays up as a retry affordance.
      });
  }, [
    bumpItemVersion,
    cancelDiffContentRequests,
    historyLimit,
    mainModeRef,
    narrativeWalkthrough,
    pendingSource,
    reviewComments,
    setCollapsed,
    setMainMode,
    setReviewComments,
    setSelectedPath,
    sidebarModeRef,
    walkthroughLoading,
  ]);

  // ⌘R / the View menu's "Refresh Changes" item route here from the main
  // process instead of reloading the window.
  useEffect(() => window.codiff.onRefreshRequest(refreshRepository), [refreshRepository]);

  useEffect(() => {
    const writeCurrentReloadSelection = () => {
      const persistenceState = surfaceCommandBridgeRef.current?.getPersistenceState();
      writeReloadSelection(
        stateRef.current,
        persistenceState?.selectedPath ?? selectedPathRef.current,
        historySourceRef.current,
        mainModeRef.current,
      );
    };

    window.addEventListener('beforeunload', writeCurrentReloadSelection);
    return () => window.removeEventListener('beforeunload', writeCurrentReloadSelection);
  }, [mainModeRef]);

  const selectSource = useCallback(
    (source: ReviewSource, options: { throwOnError?: boolean } = {}) => {
      const currentState = stateRef.current;
      const sourceKey = getSourceKey(source);
      const currentDisplayKey = getSourceKey(pendingSource ?? currentState?.source ?? source);
      if (currentDisplayKey === sourceKey) {
        return Promise.resolve();
      }

      saveCurrentSourceSession();
      cancelDiffContentRequests();
      cancelWalkthroughRequest();
      repositoryRefreshRequestRef.current += 1;
      const request = sourceRequestRef.current + 1;
      sourceRequestRef.current = request;
      reviewCommentsRequestRef.current += 1;
      reviewCommentsInFlightRef.current = null;
      historyRequestRef.current += 1;
      setHistoryLoading(false);
      setInitialHistoryComplete(true);
      setPendingSource(source);
      setRepositoryRefreshStatus(null);
      setWalkthroughStale(false);
      setSurfaceInitialScrollTarget(null);
      setLoadError(null);
      resetCommentFocus();
      setReloadDeltaPaths(new Set());
      setMainMode('review');
      setWalkthroughUnread(false);

      return window.codiff
        .getRepositoryState(source)
        .then((nextState) => {
          if (sourceRequestRef.current !== request) {
            return;
          }

          const orderedState = {
            ...nextState,
            files: sortFiles(nextState.files),
          };
          const session = sourceSessionsRef.current.get(getSourceRevisionKey(orderedState.source));
          const nextViewed =
            session?.viewed ??
            (usesViewedFileState(orderedState.source) ? readViewed(orderedState.root) : {});
          const nextSelectedPath =
            session?.selectedPath &&
            orderedState.files.some((file) => file.path === session.selectedPath)
              ? session.selectedPath
              : (orderedState.files[0]?.path ?? null);
          const nextCollapsed =
            session?.collapsed ?? getCollapsedViewedPaths(orderedState.files, nextViewed);
          const nextExpandedGenerated = session?.expandedGenerated ?? new Set<string>();
          const sessionWalkthroughIsCurrent =
            session?.narrativeWalkthrough != null &&
            !haveChangedFiles(session.walkthroughFiles, orderedState.files);
          const nextNarrativeWalkthrough = sessionWalkthroughIsCurrent
            ? (session?.narrativeWalkthrough ?? null)
            : null;

          stateGenerationRef.current += 1;
          stateRef.current = orderedState;
          setState(orderedState);
          setHistorySource(getHistorySource(orderedState.source) ?? historySource);
          setCollapsed(new Set(nextCollapsed));
          setExpandedGenerated(new Set(nextExpandedGenerated));
          setItemVersionByKey({});
          setReviewComments(session?.reviewComments ?? getReviewCommentsFromState(orderedState));
          setReloadDeltaPaths(new Set());
          setViewed(nextViewed);
          setSelectedPath(nextSelectedPath);
          setNarrativeWalkthrough(nextNarrativeWalkthrough);
          setWalkthroughError(
            sessionWalkthroughIsCurrent ? (session.walkthroughError ?? null) : null,
          );
          setWalkthroughLoading(false);
          setWalkthroughUnread(false);
          setLocalChangesDetected(false);
          setPendingSource(null);
          if (!sessionWalkthroughIsCurrent) {
            refreshWalkthroughForState(orderedState, session?.narrativeWalkthrough ?? null);
          }
        })
        .catch((error: unknown) => {
          if (sourceRequestRef.current === request) {
            setLoadError(getRepositoryLoadError(error));
            setWalkthroughLoading(false);
            setPendingSource(null);
          }
          if (options.throwOnError) {
            throw error;
          }
        });
    },
    [
      cancelDiffContentRequests,
      cancelWalkthroughRequest,
      historySource,
      pendingSource,
      refreshWalkthroughForState,
      resetCommentFocus,
      saveCurrentSourceSession,
      setCollapsed,
      setExpandedGenerated,
      setItemVersionByKey,
      setMainMode,
      setNarrativeWalkthrough,
      setReviewComments,
      setSelectedPath,
      setViewed,
      setWalkthroughError,
      setWalkthroughLoading,
      setWalkthroughUnread,
    ],
  );

  const openReviewSource = useCallback(
    async (kind: OpenReviewSourceKind, value: string) => {
      if (kind === 'pull-request') {
        const url = await window.codiff.resolvePullRequestUrl(value);
        await selectSource({ type: 'pull-request', url }, { throwOnError: true });
        return;
      }

      await selectSource(
        kind === 'branch'
          ? { ref: value, type: 'branch-working-tree' }
          : { ref: value, type: 'commit' },
        { throwOnError: true },
      );
    },
    [selectSource],
  );

  const showOpenReviewSourceDialog = useCallback((kind: OpenReviewSourceKind) => {
    setOpenReviewSourceKind(kind);
  }, []);

  const openRepositoryFolder = useCallback(() => {
    void window.codiff.openRepositoryFolder().catch(() => {});
  }, []);

  useEffect(
    () => window.codiff.onOpenReviewSource(showOpenReviewSourceDialog),
    [showOpenReviewSourceDialog],
  );

  const commandBarCommands = useAppCommands({
    changeSidebarMode: changeSurfaceMode,
    copyPendingCommentsLabel: state
      ? getPendingCommentsLabel(getReviewAuthoringMode(state.source))
      : 'Copy Review Notes',
    focusFileFilter,
    getReviewCommandTarget,
    onCopyPendingComments: copyPendingComments,
    onOpenDiffSearch: openSurfaceDiffSearch,
    onOpenReviewSource: showOpenReviewSourceDialog,
    onOpenSelectedFile: openSelectedFile,
    onRefreshRepository: refreshRepository,
    onToggleSidebar: toggleSidebar,
    onToggleViewed: toggleViewed,
    onToggleWordWrap: toggleWordWrap,
    preferencesRef,
    viewedRef,
  });
  const desktopCommands = useMemo(
    () => commandBarCommands.filter((command) => !portableSurfaceCommandIds.has(command.id)),
    [commandBarCommands],
  );

  if (loadError) {
    return (
      <main className="empty-state">
        <div className="empty-panel squircle">
          <RepositoryLoadErrorPanel error={loadError} />
        </div>
      </main>
    );
  }

  if (!state) {
    return null;
  }

  const source = state.source;
  const title =
    source.type === 'pull-request'
      ? source.title?.trim() || getSourceLabel(source)
      : source.type === 'commit'
        ? state.commitMetadata?.subject?.trim() || getSourceLabel(source)
        : getSourceLabel(source);
  const walkthroughStatus: ReviewWalkthroughStatus = walkthroughLoading
    ? 'generating'
    : narrativeWalkthrough
      ? 'ready'
      : walkthroughError
        ? 'failed'
        : 'idle';
  const walkthroughAgent = launchOptions.agentBackend ?? config.settings.agentBackend;
  const snapshot = buildSharedReviewSnapshot({
    preferences,
    state,
    title,
    walkthrough:
      narrativeWalkthrough ?? createPlaceholderWalkthrough(state, title, walkthroughAgent),
  });
  const branchSource =
    historySource?.type === 'branch-diff'
      ? historySource
      : historySource?.type === 'branch-working-tree' &&
          historySource.baseSha &&
          historySource.headSha
        ? {
            baseSha: historySource.baseSha,
            headSha: historySource.headSha,
            ref: historySource.ref,
            type: 'branch-diff' as const,
          }
        : null;
  const isLocalCommitSource = source.type === 'working-tree';
  const providerSource =
    source.type === 'pull-request' && getProviderMutationDestination(source) ? source : null;
  const reviewAuthoringMode = getReviewAuthoringMode(source);
  const annotationCapabilities: ReviewSurfaceCapabilities = providerSource
    ? {
        comments: {
          authoring: {
            canCreateInline: true,
            onAsk: askCodex,
          },
          destination: 'provider',
          inline: {
            onSubmit: (comment) =>
              window.codiff.submitPullRequestComment({ comment, source: providerSource }),
          },
          reviewSession: {
            drafts: {
              onChange: setReviewComments,
              value: reviewComments,
            },
            submit: ({ comments, outcome, summary }) =>
              window.codiff.submitPullRequestReview({
                ...(summary ? { body: summary } : {}),
                comments,
                event: toPullRequestReviewEvent(outcome),
                source: providerSource,
              }),
          },
        },
      }
    : source.type === 'pull-request'
      ? {}
      : {
          localReviewNotes: {
            canCreateInline: true,
            drafts: {
              onChange: setReviewComments,
              value: reviewComments,
            },
            onAsk: askCodex,
          },
        };

  return (
    <ReviewSurface
      activeMode={{
        onChange: changeSurfaceMode,
        value: activeSurfaceMode,
      }}
      capabilities={{
        ...annotationCapabilities,
        content: {
          initialScrollTarget: surfaceInitialScrollTarget,
          itemVersionByKey,
          loadingSectionIds,
          onLoadImageContent: requestDiffImageContent,
          onLoadSection: loadDiffSection,
          onRefreshMarkdown: refreshMarkdownFile,
          resolveSectionContents: loadDiffSectionContents,
        },
        desktop: {
          beforeContent: (
            <>
              <RepositoryChangeBanner
                onRefresh={refreshRepository}
                visible={
                  repositoryRefreshStatus == null &&
                  localChangesDetected &&
                  ((pendingSource ?? source).type === 'working-tree' ||
                    (pendingSource ?? source).type === 'branch-working-tree')
                }
              />
              <RepositoryRefreshBanner
                onRestartWalkthrough={() => {
                  const currentState = stateRef.current;
                  if (!currentState) {
                    return;
                  }
                  setWalkthroughStale(false);
                  void loadNarrativeWalkthrough(currentState.source, {
                    force: true,
                    previousWalkthrough: narrativeWalkthroughRef.current ?? undefined,
                  });
                }}
                onRetry={refreshRepository}
                status={repositoryRefreshStatus}
                walkthroughStale={walkthroughStale}
              />
              <ReviewCommentsLoadBanner
                onRetry={() => hydrateReviewComments(stateRef.current)}
                reason={
                  state.reviewCommentsLoadState === 'failed'
                    ? state.reviewCommentsError || 'Could not load review comments.'
                    : null
                }
              />
              <WalkthroughOutdatedBanner
                onDismiss={() => setWalkthroughFileError(null)}
                reason={walkthroughFileError?.reason ?? null}
              />
              {pendingSource ? <ReviewSourceLoading /> : null}
              {openReviewSourceKind ? (
                <OpenReviewSourceDialog
                  kind={openReviewSourceKind}
                  onClose={() => setOpenReviewSourceKind(null)}
                  onOpen={(value) => openReviewSource(openReviewSourceKind, value)}
                />
              ) : null}
            </>
          ),
          collapsed,
          commands: desktopCommands,
          ...(isLocalCommitSource && state.files.length > 0
            ? {
                commit: {
                  branch: state.branch,
                  draft: narrativeNavigation,
                  model: plainCommitModel,
                  onCommit: commitWalkthrough,
                  onCommitOutput: subscribeToCommitOutput,
                  onToggle: showPlainCommitView ? closeCommitView : openCommitView,
                  onUpdateMessage: updateWalkthroughCommitMessage,
                  open: showPlainCommitView,
                },
              }
            : {}),
          disableCodeViewWorkerPool,
          isSwitchingSource: pendingSource != null,
          isWindowFullscreen,
          onActiveWalkthroughReviewTargetChange: updateActiveWalkthroughReviewTarget,
          onCollapsedChange: setCollapsed,
          onFindDefinitions: window.codiff.findDefinitions,
          onOpenDefinition: (candidate) => {
            void window.codiff.openFile(candidate.path, candidate.lineNumber).catch(() => {});
          },
          onOpenFile: openFile,
          onOpenSelectedFile: openSelectedFile,
          onViewedChange: setViewed,
          reloadDeltaPaths,
          sidebarFooter: updateStatus ? (
            <UpdatePill
              onApply={() => {
                window.codiff.applyUpdate().then(setUpdateStatus, () => {});
              }}
              onDismiss={() => {
                window.codiff.dismissUpdate().then(setUpdateStatus, () => {});
              }}
              status={updateStatus}
            />
          ) : null,
          sourceMenu: (
            <OpenReviewSourceMenu
              onOpen={showOpenReviewSourceDialog}
              onOpenFolder={openRepositoryFolder}
            />
          ),
          viewed,
        },
        history: {
          branchSource,
          currentSource: pendingSource ?? source,
          entries: historyEntries,
          hasMore: historyHasMore,
          loading: historyLoading,
          onLoadMore: loadMoreHistory,
          onSelectSource: selectSource,
          pullRequestSource: historySource?.type === 'pull-request' ? historySource : null,
        },
        preferences: {
          diffLayout: {
            onChange: (value) => {
              void window.codiff.setDiffStyle(value).catch(() => {});
            },
            value: preferences.diffStyle,
          },
          outdatedVisibility: {
            onChange: (value) => {
              void window.codiff.setShowOutdated(value).catch(() => {});
            },
            value: preferences.showOutdated,
          },
          pendingCommentPrefix: {
            onChange: () => {},
            value: getPendingCommentsPrefix(reviewAuthoringMode, preferences.reviewCommentsPrefix),
          },
          selectedPath: {
            onChange: setSelectedPath,
            value: selectedPath,
          },
          wordWrap: {
            onChange: (value) => {
              void window.codiff.setWordWrap(value).catch(() => {});
            },
            value: preferences.wordWrap,
          },
        },
        walkthrough: {
          ...(isLocalCommitSource
            ? {
                commit: commitWalkthrough,
                commitOutput: subscribeToCommitOutput,
                updateCommitMessage: updateWalkthroughCommitMessage,
              }
            : {}),
          error: walkthroughError,
          generationProgress: walkthroughProgress.generation,
          onGenerate: () => loadNarrativeWalkthrough(source),
          onShare: enabledShareWalkthrough,
          progress: (
            <WalkthroughProgress
              phase={walkthroughProgress.phase}
              responseLabelIndex={walkthroughProgress.responseLabelIndex}
              stageRevision={walkthroughProgress.stageRevision}
            />
          ),
          status: walkthroughStatus,
          unread: walkthroughUnread,
        },
      }}
      externalUrl={source.type === 'pull-request' ? source.url : undefined}
      gitIdentity={gitIdentity}
      key={getSourceRevisionKey(source)}
      keymap={config.keymap}
      onCommandBridgeChange={updateSurfaceCommandBridge}
      providerLabel={
        source.type === 'pull-request' && source.provider === 'gitlab' ? 'GitLab' : 'GitHub'
      }
      sidebarPosition={config.settings.sidebarPosition}
      snapshot={snapshot}
      title={title}
    />
  );
}
