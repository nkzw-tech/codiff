import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { SidebarMode, WalkthroughError } from '../../lib/app-types.ts';
import { buildCommitModel, buildGenericCommitModel } from '../../lib/narrative-walkthrough.ts';
import {
  createReviewCommandTarget,
  type ReviewCommandTarget,
} from '../../lib/review-command-target.ts';
import { getSourceKey } from '../../lib/source.ts';
import type {
  ChangedFile,
  CodiffPreferences,
  NarrativeWalkthrough,
  NarrativeWalkthroughRequestOptions,
  RepositoryState,
  SharedWalkthroughSnapshot,
  WalkthroughCommitMessageRequest,
  WalkthroughCommitRequest,
  WalkthroughProgressEvent,
} from '../../types.ts';
import type { WalkthroughReviewTarget } from '../components/walkthrough/NarrativeWalkthroughView.tsx';
import { useNarrativeNavigation } from '../components/walkthrough/useNarrativeNavigation.ts';
import { nextWalkthroughResponseLabelIndex } from '../components/walkthrough/WalkthroughProgress.tsx';
import type { WalkthroughFileError } from '../components/WalkthroughFileError.tsx';

type MainMode = 'commit' | 'review';

type UseAppWalkthroughOptions = {
  codiffVersion: string;
  preferencesRef: RefObject<CodiffPreferences>;
  state: RepositoryState | null;
  stateGenerationRef: RefObject<number>;
  stateRef: RefObject<RepositoryState | null>;
};

const emptyFiles: ReadonlyArray<ChangedFile> = [];

export function useAppWalkthrough({
  codiffVersion,
  preferencesRef,
  state,
  stateGenerationRef,
  stateRef,
}: UseAppWalkthroughOptions) {
  const [mainMode, setMainMode] = useState<MainMode>('review');
  const [narrativeWalkthrough, setNarrativeWalkthrough] = useState<NarrativeWalkthrough | null>(
    null,
  );
  const [shareWalkthroughEnabled, setShareWalkthroughEnabled] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('tree');
  const [walkthroughError, setWalkthroughError] = useState<WalkthroughError | null>(null);
  const [walkthroughFileError, setWalkthroughFileError] = useState<WalkthroughFileError | null>(
    null,
  );
  const [walkthroughLoading, setWalkthroughLoading] = useState(false);
  const [walkthroughOutdatedPaths, setWalkthroughOutdatedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [walkthroughProgress, setWalkthroughProgress] = useState<{
    phase: WalkthroughProgressEvent['phase'] | null;
    responseLabelIndex: number;
    stageRevision: number;
  }>({ phase: null, responseLabelIndex: -1, stageRevision: 0 });
  const [walkthroughSharing, setWalkthroughSharing] = useState(false);
  const [walkthroughUnread, setWalkthroughUnread] = useState(false);
  const activeReviewCommandTargetRef = useRef<ReviewCommandTarget | null>(null);
  const mainModeRef = useRef<MainMode>('review');
  const narrativeWalkthroughRef = useRef<NarrativeWalkthrough | null>(null);
  const sidebarModeRef = useRef<SidebarMode>('tree');
  const walkthroughErrorRef = useRef<WalkthroughError | null>(null);
  const walkthroughOutdatedPathsRef = useRef<ReadonlySet<string>>(new Set());
  const walkthroughRequestRef = useRef(0);
  const navigationResetKey = state ? `${state.root}:${getSourceKey(state.source)}` : '';
  const narrativeNavigation = useNarrativeNavigation(
    narrativeWalkthrough,
    state?.files ?? emptyFiles,
    navigationResetKey,
  );

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
    walkthroughOutdatedPathsRef.current = walkthroughOutdatedPaths;
  }, [walkthroughOutdatedPaths]);

  useEffect(() => {
    walkthroughErrorRef.current = walkthroughError;
  }, [walkthroughError]);

  useEffect(() => {
    activeReviewCommandTargetRef.current = null;
  }, [navigationResetKey]);

  useEffect(
    () =>
      window.codiff.onWalkthroughProgress((progress) => {
        setWalkthroughProgress((current) =>
          current.phase === progress.phase
            ? current
            : {
                phase: progress.phase,
                responseLabelIndex: current.responseLabelIndex,
                stageRevision: current.stageRevision + 1,
              },
        );
      }),
    [],
  );

  const startWalkthroughLoading = useCallback(() => {
    setWalkthroughProgress((current) => ({
      phase: null,
      responseLabelIndex: nextWalkthroughResponseLabelIndex(current.responseLabelIndex),
      stageRevision: current.stageRevision + 1,
    }));
    setWalkthroughLoading(true);
  }, []);

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

  const loadNarrativeWalkthrough = useCallback(
    (source: RepositoryState['source'], options?: NarrativeWalkthroughRequestOptions) => {
      const request = walkthroughRequestRef.current + 1;
      walkthroughRequestRef.current = request;
      const sourceKey = getSourceKey(source);
      const stateGeneration = stateGenerationRef.current;
      const isCurrentState = () =>
        walkthroughRequestRef.current === request &&
        stateGenerationRef.current === stateGeneration &&
        getSourceKey(stateRef.current?.source ?? source) === sourceKey;
      startWalkthroughLoading();
      setWalkthroughError(null);
      window.codiff
        .getNarrativeWalkthrough(source, options)
        .then((result) => {
          if (!isCurrentState()) {
            return;
          }

          if (result.status === 'ready') {
            setNarrativeWalkthrough(result.walkthrough);
            setWalkthroughOutdatedPaths(new Set());
            if (sidebarModeRef.current === 'walkthrough') {
              setSidebarMode('walkthrough');
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
          if (walkthroughRequestRef.current === request) {
            setWalkthroughLoading(false);
          }
        });
    },
    [startWalkthroughLoading, stateGenerationRef, stateRef],
  );

  const regenerateWalkthrough = useCallback(() => {
    const currentState = stateRef.current;
    if (!currentState || currentState.files.length === 0 || walkthroughLoading) {
      return;
    }
    loadNarrativeWalkthrough(currentState.source, {
      force: true,
      previousWalkthrough: narrativeWalkthroughRef.current ?? undefined,
    });
  }, [loadNarrativeWalkthrough, stateRef, walkthroughLoading]);

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
        setNarrativeWalkthrough(null);
        setWalkthroughError(null);
        setWalkthroughLoading(false);
        return;
      }

      loadNarrativeWalkthrough(state.source);
    },
    [loadNarrativeWalkthrough, narrativeWalkthrough, state, walkthroughError, walkthroughLoading],
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
    const currentWalkthrough = narrativeWalkthroughRef.current;
    if (!shareWalkthroughEnabled || !currentState || !currentWalkthrough || walkthroughSharing) {
      return;
    }

    const snapshot: SharedWalkthroughSnapshot = {
      branch: currentState.branch,
      codeQualityFindings: currentState.codeQualityFindings,
      codiffVersion,
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
  }, [codiffVersion, preferencesRef, shareWalkthroughEnabled, stateRef, walkthroughSharing]);

  const plainCommitModel = useMemo(
    () =>
      narrativeNavigation.walkthroughView
        ? buildCommitModel(narrativeNavigation.walkthroughView, state?.files ?? emptyFiles)
        : buildGenericCommitModel(state?.files ?? emptyFiles),
    [narrativeNavigation.walkthroughView, state?.files],
  );
  const showPlainCommitView =
    mainMode === 'commit' && state?.source.type === 'working-tree' && state.files.length > 0;

  return {
    activeReviewCommandTargetRef,
    changeSidebarMode,
    closeCommitView,
    commitWalkthrough,
    enabledShareWalkthrough: shareWalkthroughEnabled ? shareWalkthrough : undefined,
    mainModeRef,
    narrativeNavigation,
    narrativeWalkthrough,
    narrativeWalkthroughRef,
    openCommitView,
    plainCommitModel,
    regenerateWalkthrough,
    setMainMode,
    setNarrativeWalkthrough,
    setShareWalkthroughEnabled,
    setSidebarMode,
    setWalkthroughError,
    setWalkthroughFileError,
    setWalkthroughLoading,
    setWalkthroughOutdatedPaths,
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
    walkthroughOutdatedPaths,
    walkthroughOutdatedPathsRef,
    walkthroughProgress,
    walkthroughSharing,
    walkthroughUnread,
  };
}
