import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/ArrowSquareOut';
import { ClockCounterClockwiseIcon as ClockCounterClockwise } from '@phosphor-icons/react/ClockCounterClockwise';
import { PathIcon as Path } from '@phosphor-icons/react/Path';
import { TreeStructureIcon as TreeStructure } from '@phosphor-icons/react/TreeStructure';
import type { FileDiffLoadedFiles } from '@pierre/diffs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CommandBar } from './app/components/CommandBar.tsx';
import { KeyboardShortcutsHelp } from './app/components/KeyboardShortcutsHelp.tsx';
import { OpenReviewSourceDialog } from './app/components/OpenReviewSourceDialog.tsx';
import { OpenReviewSourceMenu } from './app/components/OpenReviewSourceMenu.tsx';
import {
  AgentUnavailablePanel,
  CopyCommentsButton,
  DiffSearchPanel,
  FirstRunPanel,
  isPullRequestReviewActionDisabled,
  PullRequestReviewButtons,
  RepositoryChangeBanner,
  RepositoryLoadErrorPanel,
  ReviewSourceLoading,
  UpdatePill,
  WalkthroughOutdatedBanner,
} from './app/components/Panels.tsx';
import { PlanEditorView } from './app/components/PlanEditorView.tsx';
import { ReviewCodeView, type ReviewDiffBlock } from './app/components/ReviewCodeView.tsx';
import { ReviewTopBar, type ReviewModeItem } from './app/components/ReviewTopBar.tsx';
import { Sidebar } from './app/components/Sidebar.tsx';
import { CommitView } from './app/components/walkthrough/CommitView.tsx';
import {
  NarrativeWalkthroughView,
  type WalkthroughBlockScrollTarget,
} from './app/components/walkthrough/NarrativeWalkthroughView.tsx';
import { WalkthroughDiffSurface } from './app/components/walkthrough/WalkthroughDiffSurface.tsx';
import { WalkthroughProgress } from './app/components/walkthrough/WalkthroughProgress.tsx';
import { useAppCommands } from './app/hooks/useAppCommands.ts';
import { useAppKeyboardShortcuts } from './app/hooks/useAppKeyboardShortcuts.ts';
import { useAppReviewComments } from './app/hooks/useAppReviewComments.ts';
import { useAppWalkthrough } from './app/hooks/useAppWalkthrough.ts';
import { useDiffSearch } from './app/hooks/useDiffSearch.ts';
import {
  getCodeFontLineHeight,
  normalizeCodeFontSizePreference,
  useDocumentAppearance,
} from './app/hooks/useDocumentAppearance.ts';
import { useResizableSidebar } from './app/hooks/useResizableSidebar.ts';
import { useReviewFileState } from './app/hooks/useReviewState.ts';
import { createDefaultConfig } from './config/defaults.ts';
import { getShortcutLabel } from './config/keymap.ts';
import type { CodiffConfig } from './config/types.ts';
import {
  defaultAgentSkillStatus,
  defaultLaunchOptions,
  defaultTerminalHelperStatus,
  getAgentLabel,
  HISTORY_PAGE_SIZE,
} from './lib/app-constants.ts';
import {
  type CodeViewInstance,
  type RepositoryLoadError,
  type ReviewIdentity,
  type ReviewScrollBehavior,
  type ReviewScrollTarget,
  type SourceSession,
  type WalkthroughNote,
} from './lib/app-types.ts';
import {
  isPatchOnlyDiffSection,
  shouldLoadDiffSectionContents,
  shouldPreloadSectionContentsForSearch,
} from './lib/diff.ts';
import { sortFiles, splitRepositoryPath } from './lib/files.ts';
import {
  consumeReloadSelection,
  getChangedPaths,
  getReloadDeltaPaths,
  getReloadHistorySource,
  getReloadMainMode,
  getReloadSelectionPath,
  haveChangedFiles,
  haveReloadedFilesChanged,
  writeReloadSelection,
} from './lib/reload-selection.ts';
import { resolveReviewCommandTarget } from './lib/review-command-target.ts';
import {
  buildReviewCommentsMarkdown,
  getReviewCommentsFromState,
  getVisibleReviewComments,
} from './lib/review-comments.ts';
import { getSelectedPathFromScroll } from './lib/review-scroll.ts';
import {
  SIDEBAR_COLLAPSE_THRESHOLD,
  readSidebarWidth,
  writeSidebarWidth,
} from './lib/sidebar-width.ts';
import {
  getEmptySourceDetail,
  getEmptySourceTitle,
  getHistorySource,
  getRefreshSource,
  getRepositoryLoadError,
  getSourceKey,
  getSourceLabel,
  shouldStartInHistoryWhenEmpty,
  supportsDiffSearchContentPreload,
  supportsLazyDiffContent,
  usesViewedFileState,
} from './lib/source.ts';
import { readViewed, writeViewed } from './lib/viewed.ts';
import type {
  ChangedFile,
  AgentSkillStatus,
  CodiffLaunchOptions,
  CodiffMarkdownDocument,
  CodiffPreferences,
  CodiffUpdateStatus,
  GitIdentity,
  HistoryEntry,
  OpenReviewSourceKind,
  RepositoryState,
  ReviewSource,
  TerminalHelperStatus,
  DiffSection,
} from './types.ts';

const emptyWalkthroughNotes = new Map<string, WalkthroughNote>();
const disableCodeViewWorkerPool = process.env.NODE_ENV === 'test';

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

const defaultPreferences = getPreferencesFromConfig(createDefaultConfig());

const getCollapsedViewedPaths = (
  files: ReadonlyArray<ChangedFile>,
  viewedFiles: Readonly<Record<string, string>>,
) =>
  new Set(
    files.filter((file) => viewedFiles[file.path] === file.fingerprint).map((file) => file.path),
  );

const getReloadSourceForLaunch = (
  reloadSelection: ReturnType<typeof consumeReloadSelection>,
  launchOptions: CodiffLaunchOptions,
) => {
  if (!reloadSelection) {
    return undefined;
  }

  if (!launchOptions.source) {
    return reloadSelection.source;
  }

  return getSourceKey(reloadSelection.source) === getSourceKey(launchOptions.source)
    ? reloadSelection.source
    : undefined;
};

export default function App() {
  const [loadError, setLoadError] = useState<RepositoryLoadError | null>(null);
  const [gitIdentity, setGitIdentity] = useState<GitIdentity | null>(null);
  const [historyEntries, setHistoryEntries] = useState<ReadonlyArray<HistoryEntry>>([]);
  const [historyHasMore, setHistoryHasMore] = useState(true);
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE_SIZE);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySource, setHistorySource] = useState<ReviewSource | null>(null);
  const [localChangesDetected, setLocalChangesDetected] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<CodiffUpdateStatus | null>(null);
  const [launchOptions, setLaunchOptions] = useState<CodiffLaunchOptions>(defaultLaunchOptions);
  const [codiffConfig, setCodiffConfig] = useState<CodiffConfig>(createDefaultConfig);
  const [agentSkillInstalling, setAgentSkillInstalling] = useState(false);
  const [agentSkillStatus, setAgentSkillStatus] =
    useState<AgentSkillStatus>(defaultAgentSkillStatus);
  const [preferences, setPreferences] = useState<CodiffPreferences>(defaultPreferences);
  const [reloadDeltaPaths, setReloadDeltaPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [scrollTarget, setScrollTarget] = useState<ReviewScrollTarget | null>(null);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  const [isWindowFullScreen, setIsWindowFullScreen] = useState(false);
  const [pendingSource, setPendingSource] = useState<ReviewSource | null>(null);
  const [planDocument, setPlanDocument] = useState<CodiffMarkdownDocument | null>(null);
  const [planLoadError, setPlanLoadError] = useState<string | null>(null);
  const [loadingSectionIds, setLoadingSectionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [openReviewSourceKind, setOpenReviewSourceKind] = useState<OpenReviewSourceKind | null>(
    null,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [state, setState] = useState<RepositoryState | null>(null);
  const [terminalHelperInstalling, setTerminalHelperInstalling] = useState(false);
  const [terminalHelperStatus, setTerminalHelperStatus] = useState<TerminalHelperStatus>(
    defaultTerminalHelperStatus,
  );
  const [sharePlanEnabled, setSharePlanEnabled] = useState(false);
  const historyRequestRef = useRef(0);
  const historySourceRef = useRef<ReviewSource | null>(null);
  const loadingSectionKeysRef = useRef<Set<string>>(new Set());
  const programmaticScrollPathRef = useRef<string | null>(null);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const sourceSessionsRef = useRef<Map<string, SourceSession>>(new Map());
  const stateRef = useRef<RepositoryState | null>(null);
  const collapsedRef = useRef<Set<string>>(new Set());
  const expandedGeneratedRef = useRef<Set<string>>(new Set());
  const preferencesRef = useRef<CodiffPreferences>(defaultPreferences);
  const selectedPathRef = useRef<string | null>(null);
  const sourceRequestRef = useRef(0);
  const stateGenerationRef = useRef(0);
  const markdownRefreshQueueRef = useRef<Promise<void>>(Promise.resolve());
  const viewedRef = useRef<Record<string, string>>({});
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
    toggleCollapsed,
    toggleViewed: toggleReviewViewed,
    viewed,
  } = useReviewFileState({ onViewedChange: persistViewed });
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
  const {
    askCodex,
    createComment,
    deleteComment,
    focusCommentId,
    focusCommentRequest,
    hasPendingReviewComments,
    pullRequestReviewSubmitting,
    resetCommentFocus,
    reviewComments,
    reviewCommentsRef,
    setReviewComments,
    submitPullRequestComment,
    submitPullRequestReview,
    updateActiveReviewCommentDraft,
    updateComment,
  } = useAppReviewComments({
    isReviewActionDisabled: isPullRequestReviewActionDisabled,
    onCommentFileChange: bumpItemVersion,
    stateRef,
  });
  const collapseSidebar = useCallback(() => {
    setSidebarCollapsed(true);
  }, []);
  const { resizeSidebar, sidebarWidth } = useResizableSidebar({
    collapseThreshold: SIDEBAR_COLLAPSE_THRESHOLD,
    onCollapse: collapseSidebar,
    onWidthCommit: writeSidebarWidth,
    readWidth: readSidebarWidth,
  });
  const {
    activeReviewCommandTargetRef,
    changeSidebarMode,
    closeCommitView,
    commitWalkthrough,
    enabledShareWalkthrough,
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
    showNarrativeWalkthrough,
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
  } = useAppWalkthrough({
    preferencesRef,
    state,
    stateGenerationRef,
    stateRef,
  });
  const [hunkNavigation, setHunkNavigation] = useState<{
    direction: 1 | -1;
    request: number;
  } | null>(null);
  const showWhitespace = preferences.showWhitespace;
  const orderedFiles = useMemo(() => (state ? sortFiles(state.files) : []), [state]);
  const {
    activeMatch: activeDiffSearchMatch,
    activeMatchIndex: effectiveActiveDiffSearchMatchIndex,
    closeSearch: closeDiffSearch,
    fileFilteredFiles,
    focusRequest: diffSearchFocusRequest,
    hasQuery: hasDiffSearchQuery,
    matches: diffSearchMatches,
    matchPathSet: diffSearchMatchPathSet,
    moveMatch: moveDiffSearchMatch,
    openSearch: openDiffSearch,
    query: diffSearchQuery,
    resetSearch: resetDiffSearch,
    updateQuery: updateDiffSearchQuery,
    visible: diffSearchVisible,
    visibleFiles,
  } = useDiffSearch({
    files: orderedFiles,
    fileSearchQuery,
    showWhitespace,
  });

  const navigateHunks = useCallback((direction: 1 | -1) => {
    setHunkNavigation((current) => ({
      direction,
      request: (current?.request ?? 0) + 1,
    }));
  }, []);

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

      const sourceKey = getSourceKey(currentState.source);
      const stateGeneration = stateGenerationRef.current;
      const key = `${currentState.root}:${sourceKey}:${section.id}`;
      if (loadingSectionKeysRef.current.has(key)) {
        return;
      }

      loadingSectionKeysRef.current.add(key);
      setLoadingSectionIds((current) => new Set(current).add(section.id));

      window.codiff
        .getDiffSectionContent({
          force: true,
          kind: section.kind,
          path: file.path,
          showWhitespace: preferencesRef.current.showWhitespace,
          source: currentState.source,
        })
        .then((loadedSection) => {
          setState((current) => {
            if (
              stateGenerationRef.current !== stateGeneration ||
              !current ||
              current.root !== currentState.root ||
              getSourceKey(current.source) !== sourceKey
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
          bumpItemVersion(file.path);
        })
        .catch(() => {
          setState((current) => {
            if (
              stateGenerationRef.current !== stateGeneration ||
              !current ||
              current.root !== currentState.root ||
              getSourceKey(current.source) !== sourceKey
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
          bumpItemVersion(file.path);
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
    [bumpItemVersion],
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

      const loadedSection = await window.codiff.getDiffSectionContent({
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
    [],
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
        const sourceKey = getSourceKey(currentState.source);

        try {
          const nextState = await window.codiff.getRepositoryState(currentState.source);
          const orderedState = {
            ...nextState,
            files: sortFiles(nextState.files),
          };
          if (
            sourceRequestRef.current !== sourceRequest ||
            stateGenerationRef.current !== stateGeneration ||
            stateRef.current?.root !== currentState.root ||
            getSourceKey(stateRef.current.source) !== sourceKey
          ) {
            return false;
          }

          const changedPaths = getChangedPaths(currentState.files, orderedState.files);
          const walkthroughNeedsRefresh = haveChangedFiles(currentState.files, orderedState.files);
          stateGenerationRef.current += 1;
          stateRef.current = orderedState;
          setState(orderedState);
          setLocalChangesDetected(false);
          setReviewComments(getReviewCommentsFromState(orderedState));
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

  const scrollPathIntoReview = useCallback((path: string, behavior: ReviewScrollBehavior) => {
    setScrollTarget((current) => ({
      behavior,
      path,
      request: (current?.request ?? 0) + 1,
    }));
    programmaticScrollPathRef.current = path;
    if (programmaticScrollTimerRef.current != null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }

    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollPathRef.current = null;
      programmaticScrollTimerRef.current = null;
    }, 1200);
  }, []);

  const saveCurrentSourceSession = useCallback(() => {
    const currentState = stateRef.current;
    if (!currentState) {
      return;
    }

    sourceSessionsRef.current.set(getSourceKey(currentState.source), {
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

  useEffect(() => {
    let canceled = false;
    let loadingPlan = false;

    const load = async () => {
      const reloadSelection = consumeReloadSelection();
      const nextLaunchOptions = await window.codiff.getLaunchOptions();
      if (canceled) {
        return;
      }
      setLaunchOptions(nextLaunchOptions);

      if (nextLaunchOptions.planFile) {
        loadingPlan = true;
        const nextPlanDocument = await window.codiff.getMarkdownDocument({
          kind: 'plan',
          path: nextLaunchOptions.planFile,
        });
        if (!canceled) {
          setPlanDocument(nextPlanDocument);
          setPlanLoadError(null);
        }
        return;
      }

      const nextAgentSkillStatus = await window.codiff
        .getAgentSkillStatus()
        .catch(() => defaultAgentSkillStatus);
      if (canceled) {
        return;
      }
      setAgentSkillStatus(nextAgentSkillStatus);

      const nextTerminalHelperStatus = await window.codiff
        .getTerminalHelperStatus()
        .catch(() => defaultTerminalHelperStatus);
      if (canceled) {
        return;
      }
      setTerminalHelperStatus(nextTerminalHelperStatus);

      const nextState = await window.codiff.getRepositoryState(
        getReloadSourceForLaunch(reloadSelection, nextLaunchOptions),
      );

      if (canceled) {
        return;
      }

      const orderedState = {
        ...nextState,
        files: sortFiles(nextState.files),
      };
      const nextHistorySource: ReviewSource | null =
        getReloadHistorySource(reloadSelection, orderedState) ??
        getHistorySource(orderedState.source) ??
        null;
      const history = await window.codiff.getRepositoryHistory(
        HISTORY_PAGE_SIZE,
        nextHistorySource ?? undefined,
      );

      if (canceled) {
        return;
      }

      const filesPresent = orderedState.files.length > 0;
      const reloadSelectedPath = getReloadSelectionPath(reloadSelection, orderedState);
      const nextReloadDeltaPaths = getReloadDeltaPaths(reloadSelection, orderedState);
      const reloadFilesChanged = haveReloadedFilesChanged(reloadSelection, orderedState);
      // A pre-authored `--walkthrough-file` is an explicit request to open in
      // walkthrough mode, even without the `-w` flag. Treat it like `walkthrough`
      // so the file is actually loaded instead of being silently ignored.
      const walkthroughFilePath = nextLaunchOptions.walkthroughFile ?? null;
      const shouldLoadNarrative =
        (nextLaunchOptions.walkthrough || walkthroughFilePath != null) && filesPresent;
      const shouldStartInHistory =
        shouldStartInHistoryWhenEmpty(orderedState.source) && orderedState.files.length === 0;

      setLaunchOptions(nextLaunchOptions);
      setSidebarMode(
        shouldLoadNarrative ? 'walkthrough' : shouldStartInHistory ? 'history' : 'tree',
      );
      if (shouldLoadNarrative) {
        startWalkthroughLoading();
      } else {
        setWalkthroughLoading(false);
      }

      // Always consult the main process for a pre-authored walkthrough file, even
      // when the diff is empty, so it can diagnose *why* (e.g. the changes were
      // committed) rather than us guessing in the renderer.
      const shouldFetchNarrative = shouldLoadNarrative || walkthroughFilePath != null;
      const narrativeResult = shouldFetchNarrative
        ? reloadFilesChanged && walkthroughFilePath == null
          ? await window.codiff.getNarrativeWalkthrough(orderedState.source, { force: true })
          : await window.codiff.getNarrativeWalkthrough(orderedState.source)
        : null;
      if (canceled) {
        return;
      }
      const loadedNarrative =
        narrativeResult?.status === 'ready' ? narrativeResult.walkthrough : null;
      setNarrativeWalkthrough(loadedNarrative);

      if (narrativeResult?.status === 'unavailable') {
        setWalkthroughError(narrativeResult);
      } else {
        setWalkthroughError(null);
      }

      // When a walkthrough file was explicitly passed but did not anchor, drop
      // the reviewer into the history view and float a dismissible banner
      // explaining that the diff has moved on, rather than blocking with a modal.
      if (walkthroughFilePath != null && loadedNarrative == null) {
        setSidebarMode('history');
        setWalkthroughFileError({
          path: walkthroughFilePath,
          reason:
            narrativeResult?.status === 'unavailable'
              ? narrativeResult.reason
              : !filesPresent
                ? 'No changed files were found for this diff, so the walkthrough file has nothing to anchor to.'
                : 'The walkthrough file could not be loaded.',
        });
      } else {
        setWalkthroughFileError(null);
      }

      setWalkthroughLoading(false);

      const nextViewed = usesViewedFileState(orderedState.source)
        ? readViewed(orderedState.root)
        : {};
      // Reopen the commit view after a reload, but only while it would still be
      // openable (same conditions as openCommitView); e.g. once the commit
      // lands the working tree may be empty and we fall back to the review.
      const restoreCommitView =
        getReloadMainMode(reloadSelection, orderedState) === 'commit' &&
        orderedState.source.type === 'working-tree' &&
        orderedState.files.length > 0;
      if (restoreCommitView) {
        setSidebarMode('tree');
        setMainMode('commit');
      }

      setHistoryEntries(history.entries);
      setHistoryHasMore(history.entries.length >= HISTORY_PAGE_SIZE);
      setHistoryLimit(HISTORY_PAGE_SIZE);
      setHistorySource(nextHistorySource ?? null);
      stateGenerationRef.current += 1;
      stateRef.current = orderedState;
      setState(orderedState);
      setLoadError(null);
      setCollapsed(getCollapsedViewedPaths(orderedState.files, nextViewed));
      setExpandedGenerated(new Set());
      setItemVersionByKey({});
      resetCommentFocus();
      setReloadDeltaPaths(nextReloadDeltaPaths);
      setReviewComments(getReviewCommentsFromState(orderedState));
      setViewed(nextViewed);
      const nextSelectedPath = reloadSelectedPath ?? orderedState.files[0]?.path ?? null;
      setSelectedPath(nextSelectedPath);
      if (reloadSelectedPath) {
        scrollPathIntoReview(reloadSelectedPath, 'instant');
      }
    };

    load().catch((error: unknown) => {
      if (canceled) {
        return;
      }

      if (loadingPlan) {
        setPlanLoadError(error instanceof Error ? error.message : String(error));
      } else {
        setLoadError(getRepositoryLoadError(error));
      }
      setWalkthroughLoading(false);
    });

    return () => {
      canceled = true;
    };
  }, [
    resetCommentFocus,
    scrollPathIntoReview,
    setCollapsed,
    setExpandedGenerated,
    setItemVersionByKey,
    setMainMode,
    setNarrativeWalkthrough,
    setReviewComments,
    setSelectedPath,
    setSidebarMode,
    setViewed,
    setWalkthroughError,
    setWalkthroughFileError,
    setWalkthroughLoading,
    startWalkthroughLoading,
  ]);

  useEffect(
    () =>
      window.codiff.onRepositoryChanged(() => {
        setLocalChangesDetected(true);
      }),
    [],
  );

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
    let canceled = false;

    window.codiff
      .getGitIdentity()
      .then((identity) => {
        if (!canceled) {
          setGitIdentity(identity);
        }
      })
      .catch(() => {
        if (!canceled) {
          setGitIdentity(null);
        }
      });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!state || !supportsLazyDiffContent(state.source) || !selectedPath) {
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
    if (!state || !supportsDiffSearchContentPreload(state.source) || !diffSearchQuery.trim()) {
      return;
    }

    const requests = fileFilteredFiles.flatMap((file) =>
      file.sections.filter(shouldPreloadSectionContentsForSearch).map((section) => ({
        file,
        section,
      })),
    );

    if (!requests.length) {
      return;
    }

    let canceled = false;
    let cursor = 0;
    const sourceKey = getSourceKey(state.source);
    const stateGeneration = stateGenerationRef.current;

    const loadNext = async (): Promise<void> => {
      if (canceled) {
        return;
      }

      const request = requests[cursor];
      cursor += 1;
      if (!request) {
        return;
      }

      const key = `${state.root}:${sourceKey}:${request.section.id}`;
      if (loadingSectionKeysRef.current.has(key)) {
        return loadNext();
      }

      loadingSectionKeysRef.current.add(key);

      try {
        const loadedSection = await window.codiff.getDiffSectionContent({
          force: true,
          kind: request.section.kind,
          path: request.file.path,
          showWhitespace: preferences.showWhitespace,
          source: state.source,
        });

        if (!canceled) {
          setState((current) => {
            if (
              stateGenerationRef.current !== stateGeneration ||
              !current ||
              current.root !== state.root ||
              getSourceKey(current.source) !== sourceKey
            ) {
              return current;
            }

            return {
              ...current,
              files: current.files.map((file) =>
                file.path === request.file.path
                  ? {
                      ...file,
                      sections: file.sections.map((candidate) =>
                        candidate.id === request.section.id ? loadedSection : candidate,
                      ),
                    }
                  : file,
              ),
            };
          });
          bumpItemVersion(request.file.path);
        }
      } catch {
        if (!canceled) {
          setState((current) => {
            if (
              stateGenerationRef.current !== stateGeneration ||
              !current ||
              current.root !== state.root ||
              getSourceKey(current.source) !== sourceKey
            ) {
              return current;
            }

            return {
              ...current,
              files: current.files.map((file) =>
                file.path === request.file.path
                  ? {
                      ...file,
                      sections: file.sections.map((candidate) =>
                        candidate.id === request.section.id
                          ? getFailedSectionLoadState(candidate)
                          : candidate,
                      ),
                    }
                  : file,
              ),
            };
          });
          bumpItemVersion(request.file.path);
        }
      } finally {
        loadingSectionKeysRef.current.delete(key);
      }

      return loadNext();
    };

    void Promise.all(Array.from({ length: Math.min(3, requests.length) }, () => loadNext()));

    return () => {
      canceled = true;
    };
  }, [bumpItemVersion, diffSearchQuery, fileFilteredFiles, preferences.showWhitespace, state]);

  useEffect(() => {
    let canceled = false;

    void window.codiff.getFeatureFlags().then(
      (flags) => {
        if (!canceled) {
          setSharePlanEnabled(flags.planSharing);
          setShareWalkthroughEnabled(flags.walkthroughSharing);
        }
      },
      () => {},
    );

    window.codiff.getConfig().then((nextConfig) => {
      if (!canceled) {
        const nextPreferences = getPreferencesFromConfig(nextConfig);
        preferencesRef.current = nextPreferences;
        setCodiffConfig(nextConfig);
        setPreferences(nextPreferences);
      }
    });

    const removeConfigListener = window.codiff.onConfigChanged((nextConfig) => {
      const previousShowWhitespace = preferencesRef.current.showWhitespace;
      const nextPreferences = getPreferencesFromConfig(nextConfig);
      preferencesRef.current = nextPreferences;
      setCodiffConfig(nextConfig);
      setPreferences(nextPreferences);

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
        .getRepositoryState(currentState.source)
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
          setReviewComments(getReviewCommentsFromState(orderedState));
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
    });

    return () => {
      canceled = true;
      removeConfigListener();
    };
  }, [
    setCollapsed,
    setExpandedGenerated,
    setItemVersionByKey,
    refreshWalkthroughForState,
    setReviewComments,
    setShareWalkthroughEnabled,
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

  useEffect(
    () => () => {
      if (programmaticScrollTimerRef.current != null) {
        window.clearTimeout(programmaticScrollTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    historySourceRef.current = historySource;
  }, [historySource]);

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
      const currentState = stateRef.current;
      if (!currentState) {
        return '';
      }

      return buildReviewCommentsMarkdown(
        currentState.files,
        reviewCommentsRef.current,
        preferencesRef.current.showWhitespace,
        preferencesRef.current.reviewCommentsPrefix,
      );
    });
    return removeListener;
  }, [reviewCommentsRef]);

  useEffect(() => {
    void window.codiff.isWindowFullScreen().then(setIsWindowFullScreen, () => {});
    return window.codiff.onWindowFullScreenChanged(setIsWindowFullScreen);
  }, []);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    viewedRef.current = viewed;
  }, [viewed]);

  const showOutdated = preferences.showOutdated;
  const diffStyle = preferences.diffStyle;
  const wordWrap = preferences.wordWrap;
  const visibleReviewComments = useMemo(
    () => getVisibleReviewComments(reviewComments, showOutdated),
    [reviewComments, showOutdated],
  );
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

  const shouldDeferHunkNavigation = useCallback(
    () => sidebarModeRef.current === 'walkthrough' && narrativeWalkthroughRef.current != null,
    [narrativeWalkthroughRef, sidebarModeRef],
  );
  const { closeCommandBar, commandBarVisible, shortcutsHelpVisible } = useAppKeyboardShortcuts({
    keymap: codiffConfig.keymap,
    navigateHunks,
    onFocusFileFilter: focusFileFilter,
    onOpenDiffSearch: openDiffSearch,
    onOpenSelectedFile: openSelectedFile,
    onToggleSidebar: toggleSidebar,
    onToggleWordWrap: toggleWordWrap,
    shouldDeferHunkNavigation,
    sidebarCollapsed,
  });

  useEffect(() => window.codiff.onFindInDiffs(openDiffSearch), [openDiffSearch]);

  const loadMoreHistory = useCallback(() => {
    if (historyLoading || !historyHasMore) {
      return;
    }

    const nextLimit = historyLimit + HISTORY_PAGE_SIZE;
    const request = historyRequestRef.current + 1;
    historyRequestRef.current = request;
    setHistoryLoading(true);
    window.codiff
      .getRepositoryHistory(nextLimit, historySource ?? undefined)
      .then((history) => {
        if (historyRequestRef.current !== request) {
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

  const activatePath = useCallback(
    (path: string) => {
      setMainMode('review');
      setSelectedPath(path);
      scrollPathIntoReview(path, 'smooth');
    },
    [scrollPathIntoReview, setMainMode, setSelectedPath],
  );

  // Refresh the repository state in place after the working tree changed.
  // Unlike a window reload, this keeps all review UI state (selection, scroll,
  // search, walkthrough navigation, commit drafts, pending comments) and only
  // re-renders the files whose fingerprints actually moved.
  const refreshRepository = useCallback(() => {
    const previousState = stateRef.current;
    if (!previousState || pendingSource) {
      return;
    }

    const request = sourceRequestRef.current + 1;
    sourceRequestRef.current = request;
    const refreshSource = getRefreshSource(previousState.source);
    const refreshHistorySource = historySourceRef.current
      ? getRefreshSource(historySourceRef.current)
      : undefined;

    Promise.all([
      window.codiff.getRepositoryState(refreshSource),
      window.codiff.getRepositoryHistory(historyLimit, refreshHistorySource),
    ])
      .then(([nextState, history]) => {
        if (sourceRequestRef.current !== request) {
          return;
        }

        const orderedState = {
          ...nextState,
          files: sortFiles(nextState.files),
        };
        const changedPaths = getChangedPaths(previousState.files, orderedState.files);
        const walkthroughNeedsRefresh = haveChangedFiles(previousState.files, orderedState.files);

        stateGenerationRef.current += 1;
        stateRef.current = orderedState;
        setState(orderedState);
        setReloadDeltaPaths(changedPaths);
        if (walkthroughNeedsRefresh) {
          refreshWalkthroughForState(orderedState);
        }
        for (const path of changedPaths) {
          bumpItemVersion(path);
        }
        setCollapsed((current) => {
          const next = new Set(current);
          for (const path of changedPaths) {
            next.delete(path);
          }
          return next;
        });
        setHistoryEntries(history.entries);
        setHistoryHasMore(history.entries.length >= historyLimit);
        setHistorySource(getHistorySource(orderedState.source) ?? historySourceRef.current);
        setSelectedPath((current) =>
          current != null && orderedState.files.some((file) => file.path === current)
            ? current
            : (orderedState.files[0]?.path ?? null),
        );
        if (
          mainModeRef.current === 'commit' &&
          (orderedState.source.type !== 'working-tree' || orderedState.files.length === 0)
        ) {
          setMainMode('review');
        }
        setLocalChangesDetected(false);
      })
      .catch(() => {
        // Keep the current state; the banner stays up as a retry affordance.
      });
  }, [
    bumpItemVersion,
    historyLimit,
    mainModeRef,
    pendingSource,
    refreshWalkthroughForState,
    setCollapsed,
    setMainMode,
    setSelectedPath,
  ]);

  // ⌘R / the View menu's "Refresh Changes" item route here from the main
  // process instead of reloading the window.
  useEffect(() => window.codiff.onRefreshRequest(refreshRepository), [refreshRepository]);

  useEffect(() => {
    const writeCurrentReloadSelection = () => {
      writeReloadSelection(
        stateRef.current,
        selectedPathRef.current,
        historySourceRef.current,
        mainModeRef.current,
      );
    };

    window.addEventListener('beforeunload', writeCurrentReloadSelection);
    return () => window.removeEventListener('beforeunload', writeCurrentReloadSelection);
  }, [mainModeRef]);

  const selectSource = useCallback(
    (
      source: ReviewSource,
      { throwOnError = false }: { throwOnError?: boolean } = {},
    ): Promise<void> => {
      const currentState = stateRef.current;
      const sourceKey = getSourceKey(source);
      const currentDisplayKey = getSourceKey(pendingSource ?? currentState?.source ?? source);
      if (currentDisplayKey === sourceKey) {
        return Promise.resolve();
      }

      saveCurrentSourceSession();
      const request = sourceRequestRef.current + 1;
      sourceRequestRef.current = request;
      setPendingSource(source);
      setLoadError(null);
      resetCommentFocus();
      setReloadDeltaPaths(new Set());
      resetDiffSearch();
      setScrollTarget(null);
      setMainMode('review');

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
          const session = sourceSessionsRef.current.get(getSourceKey(orderedState.source));
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
            if (!throwOnError) {
              setLoadError(getRepositoryLoadError(error));
            }
            setWalkthroughLoading(false);
            setPendingSource(null);
          }
          if (throwOnError) {
            throw error;
          }
        });
    },
    [
      historySource,
      pendingSource,
      refreshWalkthroughForState,
      resetCommentFocus,
      resetDiffSearch,
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
    changeSidebarMode,
    focusFileFilter,
    getReviewCommandTarget,
    onOpenDiffSearch: openDiffSearch,
    onOpenReviewSource: showOpenReviewSourceDialog,
    onOpenSelectedFile: openSelectedFile,
    onRefreshRepository: refreshRepository,
    onToggleSidebar: toggleSidebar,
    onToggleViewed: toggleViewed,
    onToggleWordWrap: toggleWordWrap,
    preferencesRef,
    reviewCommentsRef,
    stateRef,
    viewedRef,
  });

  const updateSelectedPathFromScroll = useCallback(
    (viewer: CodeViewInstance) => {
      const nextPath = getSelectedPathFromScroll(viewer, visibleFiles, showWhitespace);
      if (!nextPath) {
        return;
      }

      const programmaticScrollPath = programmaticScrollPathRef.current;
      if (programmaticScrollPath && nextPath !== programmaticScrollPath) {
        return;
      }

      if (programmaticScrollPath) {
        programmaticScrollPathRef.current = null;
        if (programmaticScrollTimerRef.current != null) {
          window.clearTimeout(programmaticScrollTimerRef.current);
          programmaticScrollTimerRef.current = null;
        }
      }

      setSelectedPath((current) => (current === nextPath ? current : nextPath));
    },
    [setSelectedPath, showWhitespace, visibleFiles],
  );

  const installTerminalHelper = useCallback(() => {
    setTerminalHelperInstalling(true);
    window.codiff
      .installTerminalHelper()
      .then((status) => setTerminalHelperStatus(status))
      .catch(() => {
        setTerminalHelperStatus(defaultTerminalHelperStatus);
      })
      .finally(() => {
        setTerminalHelperInstalling(false);
      });
  }, []);

  const installAgentSkill = useCallback(() => {
    setAgentSkillInstalling(true);
    window.codiff
      .installAgentSkill()
      .then((status) => setAgentSkillStatus(status))
      .catch(() => {
        setAgentSkillStatus(defaultAgentSkillStatus);
      })
      .finally(() => {
        setAgentSkillInstalling(false);
      });
  }, []);

  const activeAgentBackend = launchOptions.agentBackend ?? codiffConfig.settings.agentBackend;
  const agentLabel = getAgentLabel(activeAgentBackend);
  const agentSkillLabel = `${agentLabel} Skill`;

  if (launchOptions.planFile) {
    if (planLoadError) {
      return (
        <main className="empty-state">
          <div className="empty-panel squircle">
            <strong>Could not open plan</strong>
            <span>{planLoadError}</span>
          </div>
        </main>
      );
    }
    return planDocument ? (
      <PlanEditorView document={planDocument} shareEnabled={sharePlanEnabled} />
    ) : (
      <main className="loading">Loading…</main>
    );
  }

  if (loadError) {
    const showFirstRun =
      loadError.kind === 'not-a-repository' &&
      !launchOptions.repositoryPathProvided &&
      !terminalHelperStatus.installed;

    return (
      <main className="empty-state">
        <div className="empty-panel squircle">
          {showFirstRun ? (
            <FirstRunPanel
              agentSkillInstalled={agentSkillStatus.installed}
              agentSkillInstalling={agentSkillInstalling}
              agentSkillLabel={agentSkillLabel}
              installing={terminalHelperInstalling}
              onInstallAgentSkill={installAgentSkill}
              onInstallTerminalHelper={installTerminalHelper}
            />
          ) : (
            <RepositoryLoadErrorPanel error={loadError} />
          )}
        </div>
      </main>
    );
  }

  if (!state) {
    return (
      <main className={`loading${launchOptions.walkthrough ? ' codex' : ' pulse'}`}>
        {launchOptions.walkthrough ? (
          <WalkthroughProgress
            phase={walkthroughProgress.phase}
            responseLabelIndex={walkthroughProgress.responseLabelIndex}
            stageRevision={walkthroughProgress.stageRevision}
          />
        ) : (
          'Thinking…'
        )}
      </main>
    );
  }

  const selectedOrSearchPath = activeDiffSearchMatch?.filePath ?? selectedPath;
  const visibleSelectedPath =
    selectedOrSearchPath && visibleFiles.some((file) => file.path === selectedOrSearchPath)
      ? selectedOrSearchPath
      : (visibleFiles[0]?.path ?? null);
  const isPullRequest = state.source.type === 'pull-request';
  const isSwitchingSource = pendingSource != null;
  const showAgentUnavailablePanel =
    sidebarMode === 'walkthrough' &&
    !narrativeWalkthrough &&
    !walkthroughLoading &&
    (walkthroughError?.code === 'CODEX_NOT_FOUND' ||
      walkthroughError?.code === 'CLAUDE_NOT_FOUND' ||
      walkthroughError?.code === 'OPENCODE_NOT_FOUND' ||
      walkthroughError?.code === 'PI_NOT_FOUND');

  const repositoryPathParts = splitRepositoryPath(state.root);
  const sidebarSourceLabel =
    state.source.type !== 'working-tree' ? getSourceLabel(state.source) : null;
  const pullRequestUrl = state.source.type === 'pull-request' ? state.source.url : null;
  const emptySourceDetail = getEmptySourceDetail(state.source, state.root);

  const diffLineHeight = getCodeFontLineHeight(
    normalizeCodeFontSizePreference(preferences.codeFontSize),
  );
  const commitMetadata =
    state.source.type === 'commit' && state.commitMetadata
      ? (() => {
          const historyAvatarUrl = historyEntries.find(
            (entry) => entry.ref === state.commitMetadata?.ref,
          )?.gravatarUrl;
          return historyAvatarUrl
            ? {
                ...state.commitMetadata,
                author: {
                  ...state.commitMetadata.author,
                  gravatarUrl: historyAvatarUrl,
                },
              }
            : state.commitMetadata;
        })()
      : null;
  // Props shared by the full review and the per-stop scoped diffs, so the two
  // render paths can't drift apart.
  const commonReviewProps = {
    activeSearchMatch: activeDiffSearchMatch,
    agentId: activeAgentBackend,
    agentLabel,
    codeQualityFindings: state.codeQualityFindings,
    collapsed,
    comments: visibleReviewComments,
    commitMetadata,
    diffLineHeight,
    diffStyle,
    disableWorkerPool: disableCodeViewWorkerPool,
    expandedGenerated,
    focusCommentId,
    focusCommentRequest,
    gitIdentity,
    hunkNavigation,
    itemVersionByKey,
    keymap: codiffConfig.keymap,
    loadingSectionIds,
    onAskCodex: askCodex,
    onCommentDraftChange: updateActiveReviewCommentDraft,
    onCreateComment: createComment,
    onDeleteComment: deleteComment,
    onLoadImageContent: window.codiff.getDiffImageContent,
    onLoadSection: loadDiffSection,
    onLoadSectionContents: loadDiffSectionContents,
    onOpenFile: openFile,
    onRefreshMarkdown: refreshMarkdownFile,
    onSaveCommentEdit: updateComment,
    onSelectPathFromScroll: updateSelectedPathFromScroll,
    onSubmitComment: submitPullRequestComment,
    onToggleCollapsed: toggleCollapsed,
    onToggleViewed: toggleViewed,
    onUpdateComment: updateComment,
    searchQuery: diffSearchQuery,
    showWhitespace,
    source: state.source,
    sourceDescriptionActions: isPullRequest ? (
      <PullRequestReviewButtons
        disabled={pullRequestReviewSubmitting != null}
        hasPendingComments={hasPendingReviewComments}
        onSubmitReview={submitPullRequestReview}
        reviewStatus={state.source.type === 'pull-request' ? state.source.reviewStatus : undefined}
        showCommentReview={
          state.source.type === 'pull-request' &&
          (state.source.provider === 'github' || state.source.host === 'github.com')
        }
      />
    ) : undefined,
    supportsReviewCommentActions: isPullRequest,
    theme: preferences.theme,
    viewed,
    wordWrap,
  };
  const renderWalkthroughDiffBlocks = (
    blocks: ReadonlyArray<ReviewDiffBlock>,
    blockScrollTarget: WalkthroughBlockScrollTarget | null,
    onActiveBlockChange: (blockId: string) => void,
  ) => {
    return (
      <WalkthroughDiffSurface
        blocks={blocks}
        forceExpandedPaths={diffSearchMatchPathSet}
        onActiveBlockChange={onActiveBlockChange}
        reviewProps={commonReviewProps}
        scrollTarget={blockScrollTarget}
      />
    );
  };
  const reviewModes = [
    {
      icon: <Path aria-hidden size={14} weight="bold" />,
      indicator: walkthroughUnread ? <span aria-hidden className="review-mode-dot" /> : undefined,
      label: 'Walkthrough',
      value: 'walkthrough',
    },
    {
      icon: <TreeStructure aria-hidden size={14} weight="bold" />,
      label: 'Tree',
      value: 'tree',
    },
    {
      icon: <ClockCounterClockwise aria-hidden size={14} weight="bold" />,
      label: 'History',
      value: 'history',
    },
  ] satisfies ReadonlyArray<ReviewModeItem<typeof sidebarMode>>;

  return (
    <div
      className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}${
        isWindowFullScreen ? ' window-fullscreen' : ''
      }`}
      style={
        sidebarCollapsed ? undefined : { gridTemplateColumns: `${sidebarWidth}px 0 minmax(0, 1fr)` }
      }
    >
      <div aria-hidden className="window-drag-region" />
      <ReviewTopBar
        context={
          <>
            {state.branch ? (
              <span className="review-top-bar-branch" title={state.branch}>
                {state.branch}
              </span>
            ) : null}
            {sidebarSourceLabel ? (
              pullRequestUrl ? (
                <a
                  className="review-top-bar-source"
                  href={pullRequestUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <span>{sidebarSourceLabel}</span>
                  <ArrowSquareOut aria-hidden size={14} weight="bold" />
                </a>
              ) : (
                <span className="review-top-bar-source">{sidebarSourceLabel}</span>
              )
            ) : null}
          </>
        }
        mode={sidebarMode}
        modes={reviewModes}
        onModeChange={changeSidebarMode}
        onToggleSidebar={toggleSidebar}
        repository={
          <span className="review-top-bar-repository review-top-bar-repository-path">
            <span className="review-top-bar-repository-head">{repositoryPathParts.head}</span>
            <span className="review-top-bar-repository-tail">{repositoryPathParts.tail}</span>
          </span>
        }
        repositoryTooltip={state.root}
        sidebarCollapsed={sidebarCollapsed}
        sourceMenu={
          <OpenReviewSourceMenu
            onOpen={showOpenReviewSourceDialog}
            onOpenFolder={openRepositoryFolder}
          />
        }
        toggleTitle={`${sidebarCollapsed ? 'Expand' : 'Collapse'} sidebar (${getShortcutLabel(
          codiffConfig.keymap,
          'toggleSidebar',
        )})`}
      />
      <RepositoryChangeBanner
        onRefresh={refreshRepository}
        visible={
          localChangesDetected &&
          ((pendingSource ?? state.source).type === 'working-tree' ||
            (pendingSource ?? state.source).type === 'branch-working-tree')
        }
      />
      <WalkthroughOutdatedBanner
        onDismiss={() => setWalkthroughFileError(null)}
        reason={walkthroughFileError?.reason ?? null}
      />
      <DiffSearchPanel
        activeIndex={effectiveActiveDiffSearchMatchIndex}
        focusRequest={diffSearchFocusRequest}
        keymap={codiffConfig.keymap}
        matchCount={diffSearchMatches.length}
        onChange={updateDiffSearchQuery}
        onClose={closeDiffSearch}
        onNext={() => moveDiffSearchMatch(1)}
        onPrevious={() => moveDiffSearchMatch(-1)}
        query={diffSearchQuery}
        visible={diffSearchVisible}
      />
      <CommandBar
        commands={commandBarCommands}
        keymap={codiffConfig.keymap}
        onClose={closeCommandBar}
        visible={commandBarVisible}
      />
      {openReviewSourceKind ? (
        <OpenReviewSourceDialog
          kind={openReviewSourceKind}
          onClose={() => setOpenReviewSourceKind(null)}
          onOpen={(value) => openReviewSource(openReviewSourceKind, value)}
        />
      ) : null}
      <KeyboardShortcutsHelp keymap={codiffConfig.keymap} visible={shortcutsHelpVisible} />
      {!isSwitchingSource ? (
        <div className="review-action-bar">
          <CopyCommentsButton
            comments={reviewComments}
            files={orderedFiles}
            reviewCommentsPrefix={preferences.reviewCommentsPrefix}
            showWhitespace={showWhitespace}
          />
        </div>
      ) : null}
      <aside className="squircle sidebar">
        <Sidebar
          branchSource={
            historySource?.type === 'branch-diff'
              ? historySource
              : historySource?.type === 'branch-working-tree' &&
                  historySource.baseRef &&
                  historySource.headRef
                ? {
                    baseRef: historySource.baseRef,
                    headRef: historySource.headRef,
                    ref: historySource.ref,
                    type: 'branch-diff',
                  }
                : null
          }
          commitFiles={state.files}
          commitViewOpen={showPlainCommitView}
          currentSource={pendingSource ?? state.source}
          files={visibleFiles}
          historyEntries={historyEntries}
          historyHasMore={historyHasMore}
          historyLoading={historyLoading}
          keymap={codiffConfig.keymap}
          mode={sidebarMode}
          narrativeNavigation={narrativeNavigation}
          narrativeWalkthrough={narrativeWalkthrough}
          onActivatePath={activatePath}
          onLoadMoreHistory={loadMoreHistory}
          onSearchQueryChange={
            sidebarMode === 'history' ? setHistorySearchQuery : setFileSearchQuery
          }
          onSelectSource={selectSource}
          onShareWalkthrough={enabledShareWalkthrough}
          onToggleCommitView={showPlainCommitView ? closeCommitView : openCommitView}
          pullRequestSource={historySource?.type === 'pull-request' ? historySource : null}
          reloadDeltaPaths={reloadDeltaPaths}
          searchQuery={sidebarMode === 'history' ? historySearchQuery : fileSearchQuery}
          selectedPath={visibleSelectedPath}
          shareWalkthroughDisabled={walkthroughSharing}
          showWhitespace={showWhitespace}
          viewed={viewed}
          walkthroughError={walkthroughError}
          walkthroughLoading={walkthroughLoading}
          walkthroughProgress={walkthroughProgress}
        />
        {updateStatus ? (
          <UpdatePill
            onApply={() => {
              window.codiff.applyUpdate().then(setUpdateStatus, () => {});
            }}
            status={updateStatus}
          />
        ) : null}
      </aside>
      <div aria-hidden className="sidebar-resizer" onPointerDown={resizeSidebar} />
      <main className="review">
        {isSwitchingSource ? (
          <ReviewSourceLoading />
        ) : showPlainCommitView ? (
          <CommitView
            branch={state.branch}
            draft={narrativeNavigation}
            model={plainCommitModel}
            onCommit={commitWalkthrough}
            onCommitOutput={subscribeToCommitOutput}
            onUpdateMessage={updateWalkthroughCommitMessage}
          />
        ) : showNarrativeWalkthrough && narrativeWalkthrough ? (
          <NarrativeWalkthroughView
            files={state.files}
            navigation={narrativeNavigation}
            onActiveReviewTargetChange={updateActiveWalkthroughReviewTarget}
            onCommit={commitWalkthrough}
            onCommitOutput={subscribeToCommitOutput}
            onShareWalkthrough={enabledShareWalkthrough}
            onUpdateCommitMessage={updateWalkthroughCommitMessage}
            renderDiffBlocks={renderWalkthroughDiffBlocks}
            shareWalkthroughDisabled={walkthroughSharing}
            showWhitespace={showWhitespace}
            walkthrough={narrativeWalkthrough}
          />
        ) : showAgentUnavailablePanel ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <AgentUnavailablePanel
                agentLabel={agentLabel}
                onShowFiles={() => setSidebarMode('tree')}
                reason={walkthroughError?.reason}
                title={walkthroughError?.code === 'PI_NOT_FOUND' ? 'Pi CLI not found' : undefined}
              />
            </div>
          </div>
        ) : state.files.length === 0 ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>{getEmptySourceTitle(state.source)}</strong>
              {emptySourceDetail.kind === 'code' ? (
                <code className="walkthrough-inline-code" title={emptySourceDetail.title}>
                  {emptySourceDetail.text}
                </code>
              ) : (
                <span>{emptySourceDetail.text}</span>
              )}
            </div>
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>{hasDiffSearchQuery ? 'No matches in diffs' : 'No matching files'}</strong>
              <span>
                {diffSearchQuery ||
                  fileSearchQuery ||
                  (showWhitespace ? state.root : 'Whitespace-only changes hidden')}
              </span>
            </div>
          </div>
        ) : (
          <ReviewCodeView
            {...commonReviewProps}
            files={visibleFiles}
            forceExpandedPaths={diffSearchMatchPathSet}
            scrollTarget={scrollTarget}
            selectedPath={visibleSelectedPath}
            walkthroughNotes={emptyWalkthroughNotes}
          />
        )}
      </main>
    </div>
  );
}
