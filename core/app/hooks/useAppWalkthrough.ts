import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { SidebarMode, WalkthroughError } from '../../lib/app-types.ts';
import {
  parseWalkthroughModel,
  resolveWalkthroughFiles,
} from '../../lib/narrative-walkthrough-schema.ts';
import { buildCommitModel, buildGenericCommitModel } from '../../lib/narrative-walkthrough.ts';
import type { ReloadMainMode } from '../../lib/reload-selection.ts';
import {
  createReviewCommandTarget,
  type ReviewCommandTarget,
} from '../../lib/review-command-target.ts';
import { getSourceRevisionKey } from '../../lib/source.ts';
import type {
  ChangedFile,
  CodiffPreferences,
  NarrativeWalkthroughResult,
  NarrativeWalkthroughRequestOptions,
  PersistedWalkthrough,
  RepositoryState,
  SharedWalkthroughSnapshot,
  WalkthroughCommitMessageRequest,
  WalkthroughCommitRequest,
  WalkthroughModel,
  WalkthroughProgressEvent,
} from '../../types.ts';
import type { WalkthroughReviewTarget } from '../components/walkthrough/NarrativeWalkthroughView.tsx';
import { useNarrativeNavigation } from '../components/walkthrough/useNarrativeNavigation.ts';
import { nextWalkthroughResponseLabelIndex } from '../components/walkthrough/WalkthroughProgress.tsx';
import type { WalkthroughFileError } from '../components/WalkthroughFileError.tsx';

type UseAppWalkthroughOptions = {
  initialMainMode?: ReloadMainMode;
  initialSidebarMode?: SidebarMode;
  initialWalkthroughFileError?: WalkthroughFileError | null;
  initialWalkthroughLoading?: boolean;
  initialWalkthroughResult?: NarrativeWalkthroughResult;
  preferencesRef: RefObject<CodiffPreferences>;
  state: RepositoryState | null;
  stateGenerationRef: RefObject<number>;
  stateRef: RefObject<RepositoryState | null>;
};

const emptyFiles: ReadonlyArray<ChangedFile> = [];
const emptyPendingAssessmentThreadIds: ReadonlySet<string> = new Set();

export function useAppWalkthrough({
  initialMainMode = 'review',
  initialSidebarMode = 'tree',
  initialWalkthroughFileError = null,
  initialWalkthroughLoading = false,
  initialWalkthroughResult,
  preferencesRef,
  state,
  stateGenerationRef,
  stateRef,
}: UseAppWalkthroughOptions) {
  const [mainMode, setMainMode] = useState<ReloadMainMode>(initialMainMode);
  const initialPersistedWalkthrough =
    initialWalkthroughResult?.status === 'ready' ? initialWalkthroughResult.walkthrough : null;
  const [narrativeWalkthrough, setNarrativeWalkthrough] = useState<WalkthroughModel | null>(() =>
    initialPersistedWalkthrough ? parseWalkthroughModel(initialPersistedWalkthrough) : null,
  );
  const [persistedNarrativeWalkthrough, setPersistedNarrativeWalkthroughState] =
    useState<PersistedWalkthrough | null>(initialPersistedWalkthrough);
  const [shareWalkthroughEnabled, setShareWalkthroughEnabled] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(initialSidebarMode);
  const [walkthroughError, setWalkthroughError] = useState<WalkthroughError | null>(() =>
    initialWalkthroughResult?.status === 'unavailable' ? initialWalkthroughResult : null,
  );
  const [walkthroughFileError, setWalkthroughFileError] = useState<WalkthroughFileError | null>(
    initialWalkthroughFileError,
  );
  const [walkthroughLoading, setWalkthroughLoadingState] = useState(initialWalkthroughLoading);
  const [walkthroughProgress, setWalkthroughProgress] = useState<{
    generation: NonNullable<WalkthroughProgressEvent['generation']> | null;
    phase: NonNullable<WalkthroughProgressEvent['phase']> | null;
    responseLabelIndex: number;
    stageRevision: number;
  }>({ generation: null, phase: null, responseLabelIndex: -1, stageRevision: 0 });
  const [walkthroughSharing, setWalkthroughSharing] = useState(false);
  const [walkthroughUnread, setWalkthroughUnread] = useState(false);
  const [pendingAssessmentThreadIds, setPendingAssessmentThreadIds] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        initialWalkthroughResult?.status === 'ready'
          ? (initialWalkthroughResult.pendingAssessmentThreadIds ?? [])
          : [],
      ),
  );
  const activeReviewCommandTargetRef = useRef<ReviewCommandTarget | null>(null);
  const activeWalkthroughCacheKeyRef = useRef<string | null>(
    initialWalkthroughResult?.status === 'ready'
      ? (initialWalkthroughResult.cacheKey ?? null)
      : null,
  );
  const mainModeRef = useRef<ReloadMainMode>(initialMainMode);
  const narrativeWalkthroughRef = useRef<WalkthroughModel | null>(narrativeWalkthrough);
  const persistedNarrativeWalkthroughRef = useRef<PersistedWalkthrough | null>(
    initialPersistedWalkthrough,
  );
  const sidebarModeRef = useRef<SidebarMode>(initialSidebarMode);
  const walkthroughErrorRef = useRef<WalkthroughError | null>(walkthroughError);
  const walkthroughLoadingRef = useRef(initialWalkthroughLoading);
  const walkthroughProgressEnabledRef = useRef(true);
  const walkthroughRequestRef = useRef(0);
  const initialSourceKeyRef = useRef(state ? getSourceRevisionKey(state.source) : null);
  const initialStateGenerationRef = useRef(0);
  const navigationResetKey = state ? `${state.root}:${getSourceRevisionKey(state.source)}` : '';
  const narrativeWalkthroughFiles = resolveWalkthroughFiles(
    narrativeWalkthrough,
    state?.files ?? emptyFiles,
  );
  const narrativeNavigation = useNarrativeNavigation(
    narrativeWalkthrough,
    narrativeWalkthroughFiles,
    navigationResetKey,
  );
  const setWalkthroughLoading = useCallback((loading: boolean) => {
    walkthroughLoadingRef.current = loading;
    setWalkthroughLoadingState(loading);
  }, []);

  useEffect(() => {
    mainModeRef.current = mainMode;
  }, [mainMode]);

  useEffect(() => {
    sidebarModeRef.current = sidebarMode;
  }, [sidebarMode]);

  useEffect(() => {
    narrativeWalkthroughRef.current = narrativeWalkthrough;
  }, [narrativeWalkthrough]);

  useEffect(() => {
    walkthroughErrorRef.current = walkthroughError;
  }, [walkthroughError]);

  useEffect(() => {
    const currentSource = stateRef.current?.source ?? state?.source;
    if (
      !initialWalkthroughResult ||
      !initialSourceKeyRef.current ||
      !currentSource ||
      stateGenerationRef.current !== initialStateGenerationRef.current ||
      getSourceRevisionKey(currentSource) !== initialSourceKeyRef.current
    ) {
      return;
    }
    const sourceKey = initialSourceKeyRef.current;
    queueMicrotask(() => {
      const latestSource = stateRef.current?.source;
      if (
        stateGenerationRef.current !== initialStateGenerationRef.current ||
        !latestSource ||
        getSourceRevisionKey(latestSource) !== sourceKey
      ) {
        return;
      }
      setWalkthroughLoading(false);
      if (initialWalkthroughResult.status === 'ready') {
        activeWalkthroughCacheKeyRef.current = initialWalkthroughResult.cacheKey ?? null;
        setPendingAssessmentThreadIds(
          new Set(initialWalkthroughResult.pendingAssessmentThreadIds ?? []),
        );
        persistedNarrativeWalkthroughRef.current = initialWalkthroughResult.walkthrough;
        setPersistedNarrativeWalkthroughState(initialWalkthroughResult.walkthrough);
        setNarrativeWalkthrough(parseWalkthroughModel(initialWalkthroughResult.walkthrough));
        setWalkthroughError(null);
      } else {
        setWalkthroughError(initialWalkthroughResult);
      }
      setWalkthroughFileError(initialWalkthroughFileError);
    });
  }, [
    initialWalkthroughFileError,
    initialWalkthroughResult,
    setWalkthroughLoading,
    state?.source,
    stateGenerationRef,
    stateRef,
  ]);

  useEffect(() => {
    activeReviewCommandTargetRef.current = null;
    activeWalkthroughCacheKeyRef.current = null;
    queueMicrotask(() => setPendingAssessmentThreadIds(emptyPendingAssessmentThreadIds));
  }, [navigationResetKey]);

  useEffect(
    () =>
      window.codiff.onWalkthroughProgress((progress) => {
        if (!walkthroughProgressEnabledRef.current) {
          return;
        }
        setWalkthroughProgress((current) => {
          const phase = progress.phase ?? current.phase;
          return {
            generation: progress.generation ?? current.generation,
            phase,
            responseLabelIndex: current.responseLabelIndex,
            stageRevision:
              current.phase === phase ? current.stageRevision : current.stageRevision + 1,
          };
        });
      }),
    [],
  );

  useEffect(() => {
    const subscribe = window.codiff.onNarrativeWalkthroughUpdated;
    if (!subscribe) {
      return;
    }
    return subscribe(({ cacheKey, pendingAssessmentThreadIds: pendingIds, walkthrough }) => {
      if (activeWalkthroughCacheKeyRef.current !== cacheKey) {
        return;
      }
      persistedNarrativeWalkthroughRef.current = walkthrough;
      setPersistedNarrativeWalkthroughState(walkthrough);
      setNarrativeWalkthrough(parseWalkthroughModel(walkthrough));
      setPendingAssessmentThreadIds(new Set(pendingIds));
    });
  }, []);

  const startWalkthroughLoading = useCallback(() => {
    walkthroughProgressEnabledRef.current = true;
    activeWalkthroughCacheKeyRef.current = null;
    setPendingAssessmentThreadIds(emptyPendingAssessmentThreadIds);
    setWalkthroughProgress((current) => ({
      generation: null,
      phase: null,
      responseLabelIndex: nextWalkthroughResponseLabelIndex(current.responseLabelIndex),
      stageRevision: current.stageRevision + 1,
    }));
    walkthroughLoadingRef.current = true;
    setWalkthroughLoadingState(true);
  }, []);

  const cancelWalkthroughRequest = useCallback(() => {
    walkthroughRequestRef.current += 1;
    walkthroughProgressEnabledRef.current = false;
    const cancelMainProcess = walkthroughLoadingRef.current;
    setWalkthroughLoading(false);
    if (cancelMainProcess) {
      void window.codiff.cancelNarrativeWalkthrough().catch(() => {});
    }
  }, [setWalkthroughLoading]);

  const commitWalkthrough = useCallback(
    (request: WalkthroughCommitRequest) =>
      window.codiff.createWalkthroughCommit({
        ...request,
        source: stateRef.current?.source ?? request.source,
      }),
    [stateRef],
  );

  const subscribeToCommitOutput = useCallback(
    (callback: (chunk: string) => void) => window.codiff.onWalkthroughCommitOutput(callback),
    [],
  );

  const updateWalkthroughCommitMessage = useCallback(
    (request: WalkthroughCommitMessageRequest) =>
      window.codiff.updateWalkthroughCommitMessage({
        ...request,
        source: stateRef.current?.source ?? request.source,
      }),
    [stateRef],
  );

  const applyNarrativeWalkthroughResult = useCallback(
    (result: Extract<NarrativeWalkthroughResult, { status: 'ready' }>) => {
      activeWalkthroughCacheKeyRef.current = result.cacheKey ?? null;
      setPendingAssessmentThreadIds(new Set(result.pendingAssessmentThreadIds ?? []));
      persistedNarrativeWalkthroughRef.current = result.walkthrough;
      setPersistedNarrativeWalkthroughState(result.walkthrough);
      setNarrativeWalkthrough(parseWalkthroughModel(result.walkthrough));
    },
    [],
  );

  const loadNarrativeWalkthrough = useCallback(
    (source: RepositoryState['source'], options?: NarrativeWalkthroughRequestOptions) => {
      const request = walkthroughRequestRef.current + 1;
      walkthroughRequestRef.current = request;
      const sourceKey = getSourceRevisionKey(source);
      const stateGeneration = stateGenerationRef.current;
      const isCurrentState = () =>
        walkthroughRequestRef.current === request &&
        stateGenerationRef.current === stateGeneration &&
        getSourceRevisionKey(stateRef.current?.source ?? source) === sourceKey;
      startWalkthroughLoading();
      setWalkthroughError(null);
      activeWalkthroughCacheKeyRef.current = null;
      setPendingAssessmentThreadIds(emptyPendingAssessmentThreadIds);
      return window.codiff
        .getNarrativeWalkthrough(source, options)
        .then((result) => {
          if (!isCurrentState()) {
            return;
          }

          if (result.status === 'ready') {
            applyNarrativeWalkthroughResult(result);
            if (sidebarModeRef.current === 'walkthrough') {
              setWalkthroughUnread(false);
            } else {
              setWalkthroughUnread(true);
            }
          } else {
            setWalkthroughError(result);
          }
        })
        .catch((error: unknown) => {
          if (!isCurrentState()) {
            return;
          }

          setWalkthroughError({
            reason: error instanceof Error ? error.message : String(error),
            status: 'unavailable',
          });
        })
        .finally(() => {
          if (isCurrentState()) {
            setWalkthroughLoading(false);
          }
        });
    },
    [
      applyNarrativeWalkthroughResult,
      setWalkthroughLoading,
      startWalkthroughLoading,
      stateGenerationRef,
      stateRef,
    ],
  );

  const refreshWalkthroughForState = useCallback(
    (
      nextState: RepositoryState,
      previousWalkthrough: PersistedWalkthrough | null = persistedNarrativeWalkthroughRef.current,
    ) => {
      if (
        sidebarModeRef.current !== 'walkthrough' &&
        previousWalkthrough == null &&
        !walkthroughLoadingRef.current
      ) {
        return;
      }

      walkthroughRequestRef.current += 1;
      persistedNarrativeWalkthroughRef.current = null;
      setPersistedNarrativeWalkthroughState(null);
      activeWalkthroughCacheKeyRef.current = null;
      setPendingAssessmentThreadIds(emptyPendingAssessmentThreadIds);
      setNarrativeWalkthrough(null);
      setWalkthroughError(null);
      setWalkthroughLoading(false);
      if (nextState.files.length === 0) {
        return;
      }

      loadNarrativeWalkthrough(nextState.source, {
        force: true,
        previousWalkthrough: previousWalkthrough ?? undefined,
      });
    },
    [loadNarrativeWalkthrough, setWalkthroughLoading],
  );

  const changeSidebarMode = useCallback(
    (mode: SidebarMode) => {
      setMainMode('review');
      if (mode === 'tree') {
        setSidebarMode('tree');
        return;
      }

      if (mode === 'history') {
        setSidebarMode('history');
        return;
      }

      setSidebarMode('walkthrough');
      setWalkthroughUnread(false);
      if (narrativeWalkthrough || walkthroughError || walkthroughLoading || !state) {
        return;
      }
      if (state.files.length === 0) {
        persistedNarrativeWalkthroughRef.current = null;
        setPersistedNarrativeWalkthroughState(null);
        setNarrativeWalkthrough(null);
        setWalkthroughError(null);
        setWalkthroughLoading(false);
        return;
      }

      loadNarrativeWalkthrough(state.source);
    },
    [
      loadNarrativeWalkthrough,
      narrativeWalkthrough,
      setWalkthroughLoading,
      state,
      walkthroughError,
      walkthroughLoading,
    ],
  );

  const openCommitView = useCallback(() => {
    const currentState = stateRef.current;
    if (
      !currentState ||
      currentState.source.type !== 'working-tree' ||
      currentState.files.length === 0
    ) {
      return;
    }
    if (narrativeWalkthroughRef.current) {
      narrativeNavigation.enterCommit();
    }
    setSidebarMode('tree');
    setMainMode('commit');
  }, [narrativeNavigation, stateRef]);

  const closeCommitView = useCallback(() => {
    setSidebarMode('tree');
    setMainMode('review');
  }, []);

  const updateActiveWalkthroughReviewTarget = useCallback(
    (target: WalkthroughReviewTarget | null) => {
      const currentState = stateRef.current;
      activeReviewCommandTargetRef.current =
        target && currentState
          ? createReviewCommandTarget(currentState.source, target.file, target.reviewIdentity)
          : null;
    },
    [stateRef],
  );

  const shareWalkthrough = useCallback(() => {
    const currentState = stateRef.current;
    const currentWalkthrough = persistedNarrativeWalkthroughRef.current;
    if (!shareWalkthroughEnabled || !currentState || !currentWalkthrough || walkthroughSharing) {
      return;
    }

    const snapshot: SharedWalkthroughSnapshot = {
      branch: currentState.branch,
      codeQualityFindings: currentState.codeQualityFindings,
      codiffVersion: 'dev',
      exportedAt: new Date().toISOString(),
      files: currentState.files,
      kind: 'codiff-walkthrough-share',
      preferences: {
        codeFontFamily: preferencesRef.current.codeFontFamily,
        codeFontSize: preferencesRef.current.codeFontSize,
        diffStyle: preferencesRef.current.diffStyle,
        showWhitespace: preferencesRef.current.showWhitespace,
        theme: preferencesRef.current.theme,
        wordWrap: preferencesRef.current.wordWrap,
      },
      repository: {
        root: currentState.root,
        source: currentState.source,
        title:
          currentState.source.type === 'commit' ? currentState.commitMetadata?.subject : undefined,
      },
      reviewComments: currentState.reviewComments,
      version: 1,
      walkthrough: currentWalkthrough,
    };

    setWalkthroughSharing(true);
    void window.codiff
      .shareWalkthrough(snapshot)
      .then((result) => {
        if (result.status === 'failed') {
          window.alert(result.reason);
        }
      })
      .catch((error: unknown) => {
        window.alert(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setWalkthroughSharing(false);
      });
  }, [preferencesRef, shareWalkthroughEnabled, stateRef, walkthroughSharing]);

  const plainCommitModel = useMemo(
    () =>
      narrativeNavigation.walkthroughView
        ? buildCommitModel(narrativeNavigation.walkthroughView, state?.files ?? emptyFiles)
        : buildGenericCommitModel(state?.files ?? emptyFiles),
    [narrativeNavigation.walkthroughView, state?.files],
  );
  const showPlainCommitView =
    mainMode === 'commit' && state?.source.type === 'working-tree' && state.files.length > 0;
  const setPersistedNarrativeWalkthrough = useCallback(
    (walkthrough: PersistedWalkthrough | null) => {
      if (!walkthrough) {
        activeWalkthroughCacheKeyRef.current = null;
        setPendingAssessmentThreadIds(emptyPendingAssessmentThreadIds);
      }
      persistedNarrativeWalkthroughRef.current = walkthrough;
      setPersistedNarrativeWalkthroughState(walkthrough);
      setNarrativeWalkthrough(walkthrough ? parseWalkthroughModel(walkthrough) : null);
    },
    [],
  );

  return {
    activeReviewCommandTargetRef,
    applyNarrativeWalkthroughResult,
    cancelWalkthroughRequest,
    changeSidebarMode,
    closeCommitView,
    commitWalkthrough,
    enabledShareWalkthrough: shareWalkthroughEnabled ? shareWalkthrough : undefined,
    loadNarrativeWalkthrough,
    mainModeRef,
    narrativeNavigation,
    narrativeWalkthrough,
    narrativeWalkthroughFiles,
    narrativeWalkthroughRef,
    openCommitView,
    pendingAssessmentThreadIds,
    persistedNarrativeWalkthrough,
    persistedNarrativeWalkthroughRef,
    plainCommitModel,
    refreshWalkthroughForState,
    setMainMode,
    setNarrativeWalkthrough: setPersistedNarrativeWalkthrough,
    setShareWalkthroughEnabled,
    setSidebarMode,
    setWalkthroughError,
    setWalkthroughFileError,
    setWalkthroughLoading,
    setWalkthroughUnread,
    showNarrativeWalkthrough: narrativeWalkthrough != null && sidebarMode === 'walkthrough',
    showPlainCommitView,
    sidebarMode,
    sidebarModeRef,
    startWalkthroughLoading,
    subscribeToCommitOutput,
    updateActiveWalkthroughReviewTarget,
    updateWalkthroughCommitMessage,
    walkthroughError,
    walkthroughErrorRef,
    walkthroughFileError,
    walkthroughLoading,
    walkthroughProgress,
    walkthroughSharing,
    walkthroughUnread,
  };
}
