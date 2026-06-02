import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { CommandBar } from './app/components/CommandBar.tsx';
import {
  CopyCommentsButton,
  CodexUnavailablePanel,
  DiffSearchPanel,
  FirstRunPanel,
  PullRequestReviewButtons,
  RepositoryChangeBanner,
  RepositoryLoadErrorPanel,
  ReviewSourceLoading,
} from './app/components/Panels.tsx';
import { ReviewCodeView } from './app/components/ReviewCodeView.tsx';
import { Sidebar } from './app/components/Sidebar.tsx';
import { createDefaultConfig } from './config/defaults.ts';
import { getShortcutLabel, matchesShortcut } from './config/keymap.ts';
import type { CodiffConfig } from './config/types.ts';
import {
  defaultCodexSkillStatus,
  defaultLaunchOptions,
  defaultTerminalHelperStatus,
  HISTORY_PAGE_SIZE,
} from './lib/app-constants.ts';
import {
  type CodeViewInstance,
  type DiffSearchResult,
  type RepositoryLoadError,
  type ReviewComment,
  type ReviewScrollBehavior,
  type ReviewScrollTarget,
  type SidebarMode,
  type SourceSession,
  type WalkthroughError,
} from './lib/app-types.ts';
import { DEFAULT_PADDING } from './lib/code-view-options.ts';
import { type Command, createCommandRegistry } from './lib/command-registry.ts';
import { getDiffSearchResult } from './lib/diff-search.ts';
import {
  fileHasVisibleDiff,
  getFirstVisibleSection,
  getItemId,
  isPatchOnlyDiffSection,
  shouldLoadDiffSectionContents,
} from './lib/diff.ts';
import { compactPath, fuzzyMatches, sortFiles } from './lib/files.ts';
import { isNativeInputTarget } from './lib/keyboard.ts';
import {
  consumeReloadSelection,
  getReloadDeltaPaths,
  getReloadSelectionPath,
  writeReloadSelection,
} from './lib/reload-selection.ts';
import {
  buildReviewCommentsMarkdown,
  getCommentKey,
  getReviewCommentRangeProps,
  getReviewCommentsFromState,
  getVisibleReviewComments,
} from './lib/review-comments.ts';
import {
  SIDEBAR_COLLAPSE_THRESHOLD,
  clampSidebarWidth,
  readSidebarCollapsed,
  readSidebarWidth,
  writeSidebarCollapsed,
  writeSidebarWidth,
} from './lib/sidebar-width.ts';
import { getRepositoryLoadError, getShortRef, getSourceKey, getSourceLabel } from './lib/source.ts';
import { readViewed, writeViewed } from './lib/viewed.ts';
import {
  emptyWalkthroughNotes,
  getWalkthroughNotes,
  orderFilesByWalkthrough,
} from './lib/walkthrough.ts';
import type {
  ChangedFile,
  CodexSkillStatus,
  CodiffLaunchOptions,
  CodiffPreferences,
  GitIdentity,
  HistoryEntry,
  PullRequestReviewEvent,
  RepositoryState,
  ReviewAssistantRequest,
  ReviewSource,
  TerminalHelperStatus,
  Walkthrough,
  DiffSection,
} from './types.ts';

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

export default function App() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [activeDiffSearchMatchIndex, setActiveDiffSearchMatchIndex] = useState(0);
  const [diffSearchFocusRequest, setDiffSearchFocusRequest] = useState(0);
  const [diffSearchQuery, setDiffSearchQuery] = useState('');
  const [diffSearchVisible, setDiffSearchVisible] = useState(false);
  const [loadError, setLoadError] = useState<RepositoryLoadError | null>(null);
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  const [focusCommentRequest, setFocusCommentRequest] = useState(0);
  const [gitIdentity, setGitIdentity] = useState<GitIdentity | null>(null);
  const [historyEntries, setHistoryEntries] = useState<ReadonlyArray<HistoryEntry>>([]);
  const [historyHasMore, setHistoryHasMore] = useState(true);
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE_SIZE);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySource, setHistorySource] = useState<ReviewSource | null>(null);
  const [itemVersionByPath, setItemVersionByPath] = useState<Record<string, number>>({});
  const [localChangesDetected, setLocalChangesDetected] = useState(false);
  const [launchOptions, setLaunchOptions] = useState<CodiffLaunchOptions>(defaultLaunchOptions);
  const [codiffConfig, setCodiffConfig] = useState<CodiffConfig>(createDefaultConfig);
  const [codexSkillInstalling, setCodexSkillInstalling] = useState(false);
  const [codexSkillStatus, setCodexSkillStatus] =
    useState<CodexSkillStatus>(defaultCodexSkillStatus);
  const [preferences, setPreferences] = useState<CodiffPreferences>(defaultPreferences);
  const [reviewComments, setReviewComments] = useState<ReadonlyArray<ReviewComment>>([]);
  const [reloadDeltaPaths, setReloadDeltaPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [pullRequestReviewSubmitting, setPullRequestReviewSubmitting] =
    useState<PullRequestReviewEvent | null>(null);
  const [scrollTarget, setScrollTarget] = useState<ReviewScrollTarget | null>(null);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  const [pendingSource, setPendingSource] = useState<ReviewSource | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loadingSectionIds, setLoadingSectionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => readSidebarCollapsed());
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('tree');
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readSidebarWidth());
  const [state, setState] = useState<RepositoryState | null>(null);
  const [terminalHelperInstalling, setTerminalHelperInstalling] = useState(false);
  const [terminalHelperStatus, setTerminalHelperStatus] = useState<TerminalHelperStatus>(
    defaultTerminalHelperStatus,
  );
  const [viewed, setViewed] = useState<Record<string, string>>({});
  const [walkthrough, setWalkthrough] = useState<Walkthrough | null>(null);
  const [walkthroughError, setWalkthroughError] = useState<WalkthroughError | null>(null);
  const [walkthroughLoading, setWalkthroughLoading] = useState(false);
  const [walkthroughUnread, setWalkthroughUnread] = useState(false);
  const historyRequestRef = useRef(0);
  const loadingSectionKeysRef = useRef<Set<string>>(new Set());
  const programmaticScrollPathRef = useRef<string | null>(null);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const sourceSessionsRef = useRef<Map<string, SourceSession>>(new Map());
  const stateRef = useRef<RepositoryState | null>(null);
  const collapsedRef = useRef<Set<string>>(new Set());
  const preferencesRef = useRef<CodiffPreferences>(defaultPreferences);
  const reviewCommentsRef = useRef<ReadonlyArray<ReviewComment>>([]);
  const selectedPathRef = useRef<string | null>(null);
  const sidebarModeRef = useRef<SidebarMode>('tree');
  const sourceRequestRef = useRef(0);
  const viewedRef = useRef<Record<string, string>>({});
  const walkthroughRef = useRef<Walkthrough | null>(null);
  const walkthroughErrorRef = useRef<WalkthroughError | null>(null);
  const [commandBarVisible, setCommandBarVisible] = useState(false);
  const [commandBarCommands, setCommandBarCommands] = useState<ReadonlyArray<Command>>([]);
  const commandRegistryRef = useRef(createCommandRegistry());

  const bumpItemVersion = useCallback((path: string) => {
    setItemVersionByPath((current) => ({
      ...current,
      [path]: (current[path] ?? 0) + 1,
    }));
  }, []);

  const loadDiffSection = useCallback(
    (file: ChangedFile, section: DiffSection, repositoryState = stateRef.current) => {
      const currentState = repositoryState;
      if (
        !currentState ||
        (currentState.source.type !== 'working-tree' && currentState.source.type !== 'commit') ||
        !shouldLoadDiffSectionContents(section)
      ) {
        return;
      }

      const sourceKey = getSourceKey(currentState.source);
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
          source: currentState.source,
        })
        .then((loadedSection) => {
          setState((current) => {
            if (
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
      reviewComments: reviewCommentsRef.current,
      selectedPath: selectedPathRef.current,
      viewed: viewedRef.current,
      walkthrough: walkthroughRef.current,
      walkthroughError: walkthroughErrorRef.current,
    });
  }, []);

  useEffect(() => {
    let canceled = false;

    const load = async () => {
      const reloadSelection = consumeReloadSelection();
      const nextLaunchOptions = await window.codiff.getLaunchOptions();
      if (canceled) {
        return;
      }
      setLaunchOptions(nextLaunchOptions);

      const nextCodexSkillStatus = await window.codiff
        .getCodexSkillStatus()
        .catch(() => defaultCodexSkillStatus);
      if (canceled) {
        return;
      }
      setCodexSkillStatus(nextCodexSkillStatus);

      const nextTerminalHelperStatus = await window.codiff
        .getTerminalHelperStatus()
        .catch(() => defaultTerminalHelperStatus);
      if (canceled) {
        return;
      }
      setTerminalHelperStatus(nextTerminalHelperStatus);

      const nextState = await window.codiff.getRepositoryState(reloadSelection?.source);

      if (canceled) {
        return;
      }

      const orderedState = {
        ...nextState,
        files: sortFiles(nextState.files),
      };
      const history = await window.codiff.getRepositoryHistory(
        HISTORY_PAGE_SIZE,
        orderedState.source.type === 'pull-request' || orderedState.source.type === 'branch'
          ? orderedState.source
          : undefined,
      );

      if (canceled) {
        return;
      }

      const shouldLoadWalkthrough = nextLaunchOptions.walkthrough && orderedState.files.length > 0;
      const shouldStartInHistory =
        (orderedState.source.type === 'working-tree' || orderedState.source.type === 'branch') &&
        orderedState.files.length === 0;

      setLaunchOptions({
        ...nextLaunchOptions,
        walkthrough: shouldLoadWalkthrough,
      });
      setSidebarMode(
        shouldLoadWalkthrough ? 'walkthrough' : shouldStartInHistory ? 'history' : 'tree',
      );
      setWalkthroughLoading(shouldLoadWalkthrough);

      const walkthroughResult = shouldLoadWalkthrough
        ? await window.codiff.getWalkthrough(orderedState.source)
        : null;

      if (canceled) {
        return;
      }

      const nextWalkthrough =
        walkthroughResult?.status === 'ready' ? walkthroughResult.walkthrough : null;

      if (walkthroughResult?.status === 'unavailable') {
        setWalkthroughError(walkthroughResult);
      } else {
        setWalkthroughError(null);
      }

      setWalkthrough(nextWalkthrough);
      setWalkthroughLoading(false);

      const nextViewed =
        orderedState.source.type === 'working-tree' ? readViewed(orderedState.root) : {};
      const initialFiles = nextLaunchOptions.walkthrough
        ? orderFilesByWalkthrough(orderedState.files, nextWalkthrough)
        : orderedState.files;
      const reloadSelectedPath = getReloadSelectionPath(reloadSelection, orderedState);
      const nextReloadDeltaPaths = getReloadDeltaPaths(reloadSelection, orderedState);

      setHistoryEntries(history.entries);
      setHistoryHasMore(history.entries.length >= HISTORY_PAGE_SIZE);
      setHistoryLimit(HISTORY_PAGE_SIZE);
      setHistorySource(
        orderedState.source.type === 'pull-request' || orderedState.source.type === 'branch'
          ? orderedState.source
          : null,
      );
      setState(orderedState);
      setLoadError(null);
      setCollapsed(
        new Set(
          orderedState.files
            .filter((file) => nextViewed[file.path] === file.fingerprint)
            .map((file) => file.path),
        ),
      );
      setItemVersionByPath({});
      setFocusCommentId(null);
      setFocusCommentRequest(0);
      setReloadDeltaPaths(nextReloadDeltaPaths);
      setReviewComments(getReviewCommentsFromState(orderedState));
      setViewed(nextViewed);
      const nextSelectedPath = reloadSelectedPath ?? initialFiles[0]?.path ?? null;
      setSelectedPath(nextSelectedPath);
      if (reloadSelectedPath) {
        scrollPathIntoReview(reloadSelectedPath, 'instant');
      }
    };

    load().catch((error: unknown) => {
      if (canceled) {
        return;
      }

      setLoadError(getRepositoryLoadError(error));
      setWalkthroughLoading(false);
    });

    return () => {
      canceled = true;
    };
  }, [scrollPathIntoReview]);

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
    if (
      !state ||
      (state.source.type !== 'working-tree' && state.source.type !== 'commit') ||
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
    if (!state || state.source.type !== 'working-tree' || !diffSearchQuery.trim()) {
      return;
    }

    const searchableFiles = sortFiles(state.files).filter(
      (file) =>
        fuzzyMatches(file.path, fileSearchQuery) &&
        fileHasVisibleDiff(file, preferences.showWhitespace),
    );
    const requests = searchableFiles.flatMap((file) =>
      file.sections.filter(shouldLoadDiffSectionContents).map((section) => ({
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
          source: state.source,
        });

        if (!canceled) {
          setState((current) => {
            if (
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
  }, [bumpItemVersion, diffSearchQuery, fileSearchQuery, preferences.showWhitespace, state]);

  useEffect(() => {
    let canceled = false;

    window.codiff.getConfig().then((nextConfig) => {
      if (!canceled) {
        setCodiffConfig(nextConfig);
        setPreferences(getPreferencesFromConfig(nextConfig));
      }
    });

    const removeConfigListener = window.codiff.onConfigChanged((nextConfig) => {
      setCodiffConfig(nextConfig);
      setPreferences(getPreferencesFromConfig(nextConfig));
    });

    return () => {
      canceled = true;
      removeConfigListener();
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (preferences.theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', preferences.theme);
    }
  }, [preferences.theme]);

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
    sidebarModeRef.current = sidebarMode;
  }, [sidebarMode]);

  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  useEffect(() => {
    reviewCommentsRef.current = reviewComments;
  }, [reviewComments]);

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
      );
    });
    return removeListener;
  }, []);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    viewedRef.current = viewed;
  }, [viewed]);

  useEffect(() => {
    walkthroughRef.current = walkthrough;
  }, [walkthrough]);

  useEffect(() => {
    walkthroughErrorRef.current = walkthroughError;
  }, [walkthroughError]);

  const showWhitespace = preferences.showWhitespace;
  const showOutdated = preferences.showOutdated;
  const diffStyle = preferences.diffStyle;
  const wordWrap = preferences.wordWrap;
  const visibleReviewComments = useMemo(
    () => getVisibleReviewComments(reviewComments, showOutdated),
    [reviewComments, showOutdated],
  );
  const walkthroughNotes = useMemo(() => getWalkthroughNotes(walkthrough), [walkthrough]);
  const orderedFiles = useMemo(
    () =>
      state
        ? sidebarMode === 'walkthrough'
          ? orderFilesByWalkthrough(sortFiles(state.files), walkthrough)
          : sortFiles(state.files)
        : [],
    [sidebarMode, state, walkthrough],
  );
  const fileFilteredFiles = useMemo(
    () =>
      state
        ? orderedFiles.filter(
            (file) =>
              fuzzyMatches(file.path, fileSearchQuery) && fileHasVisibleDiff(file, showWhitespace),
          )
        : [],
    [fileSearchQuery, orderedFiles, showWhitespace, state],
  );

  const diffSearchResults = useMemo(
    () =>
      diffSearchQuery.trim()
        ? fileFilteredFiles
            .map((file) => getDiffSearchResult(file, showWhitespace, diffSearchQuery))
            .filter((result): result is DiffSearchResult => result != null)
        : [],
    [diffSearchQuery, fileFilteredFiles, showWhitespace],
  );

  const diffSearchMatches = useMemo(
    () => diffSearchResults.flatMap((result) => result.matches),
    [diffSearchResults],
  );

  const diffSearchMatchPathSet = useMemo(
    () => new Set(diffSearchResults.map((result) => result.file.path)),
    [diffSearchResults],
  );

  const visibleFiles = useMemo(
    () =>
      diffSearchQuery.trim()
        ? fileFilteredFiles.filter((file) => diffSearchMatchPathSet.has(file.path))
        : fileFilteredFiles,
    [diffSearchMatchPathSet, diffSearchQuery, fileFilteredFiles],
  );

  const effectiveActiveDiffSearchMatchIndex =
    diffSearchMatches.length === 0
      ? 0
      : Math.min(activeDiffSearchMatchIndex, diffSearchMatches.length - 1);
  const activeDiffSearchMatch = diffSearchMatches[effectiveActiveDiffSearchMatchIndex] ?? null;

  const openDiffSearch = useCallback(() => {
    setDiffSearchVisible(true);
    setDiffSearchFocusRequest((current) => current + 1);
  }, []);

  const closeDiffSearch = useCallback(() => {
    setDiffSearchVisible(false);
    setDiffSearchQuery('');
    setActiveDiffSearchMatchIndex(0);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      writeSidebarCollapsed(next);
      return next;
    });
  }, []);

  const expandSidebar = useCallback(() => {
    setSidebarCollapsed(false);
    writeSidebarCollapsed(false);
  }, []);

  const openFile = useCallback((file: ChangedFile) => {
    // Deleted files are still shown in diffs, but there is no current file to open.
    if (file.status === 'deleted') {
      return;
    }

    void window.codiff.openFile(file.path).catch(() => {});
  }, []);

  const openSelectedFile = useCallback(() => {
    const currentState = stateRef.current;
    const path = selectedPathRef.current;
    const file = currentState?.files.find((candidate) => candidate.path === path);

    if (file) {
      openFile(file);
    }
  }, [openFile]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (matchesShortcut(event, codiffConfig.keymap, 'commandBar')) {
        event.preventDefault();
        setCommandBarVisible((current) => !current);
        return;
      }
      if (matchesShortcut(event, codiffConfig.keymap, 'toggleSidebar')) {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (matchesShortcut(event, codiffConfig.keymap, 'diffSearch')) {
        event.preventDefault();
        openDiffSearch();
        return;
      }
      if (
        !isNativeInputTarget(event.target) &&
        matchesShortcut(event, codiffConfig.keymap, 'openFile')
      ) {
        event.preventDefault();
        openSelectedFile();
        return;
      }
      if (matchesShortcut(event, codiffConfig.keymap, 'fileFilter')) {
        if (sidebarCollapsed) {
          event.preventDefault();
          event.stopImmediatePropagation();
          expandSidebar();
          requestAnimationFrame(() => {
            const input = document.querySelector<HTMLInputElement>('.sidebar-search');
            input?.focus();
            input?.select();
          });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    codiffConfig.keymap,
    expandSidebar,
    openDiffSearch,
    openSelectedFile,
    sidebarCollapsed,
    toggleSidebar,
  ]);

  useEffect(() => window.codiff.onFindInDiffs(openDiffSearch), [openDiffSearch]);

  const updateDiffSearchQuery = useCallback((query: string) => {
    setDiffSearchQuery(query);
    setDiffSearchVisible(true);
    setActiveDiffSearchMatchIndex(0);
  }, []);

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

  const moveDiffSearchMatch = useCallback(
    (direction: 1 | -1) => {
      setDiffSearchVisible(true);
      setActiveDiffSearchMatchIndex((current) => {
        const matchCount = diffSearchMatches.length;
        if (matchCount === 0) {
          return 0;
        }

        return (current + direction + matchCount) % matchCount;
      });
    },
    [diffSearchMatches.length],
  );

  const selectPath = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  const activatePath = useCallback(
    (path: string) => {
      setSelectedPath(path);
      scrollPathIntoReview(path, 'smooth');
    },
    [scrollPathIntoReview],
  );

  const reloadWindow = useCallback(() => {
    window.location.reload();
  }, []);

  useEffect(() => {
    const writeCurrentReloadSelection = () => {
      writeReloadSelection(stateRef.current, selectedPathRef.current);
    };

    window.addEventListener('beforeunload', writeCurrentReloadSelection);
    return () => window.removeEventListener('beforeunload', writeCurrentReloadSelection);
  }, []);

  const selectSource = useCallback(
    (source: ReviewSource) => {
      const currentState = stateRef.current;
      const sourceKey = getSourceKey(source);
      const currentDisplayKey = getSourceKey(pendingSource ?? currentState?.source ?? source);
      if (currentDisplayKey === sourceKey) {
        return;
      }

      saveCurrentSourceSession();
      const request = sourceRequestRef.current + 1;
      sourceRequestRef.current = request;
      setPendingSource(source);
      setLoadError(null);
      setFocusCommentId(null);
      setFocusCommentRequest(0);
      setReloadDeltaPaths(new Set());
      setDiffSearchQuery('');
      setActiveDiffSearchMatchIndex(0);
      setScrollTarget(null);

      window.codiff
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
            (orderedState.source.type === 'working-tree' ? readViewed(orderedState.root) : {});
          const nextSelectedPath =
            session?.selectedPath &&
            orderedState.files.some((file) => file.path === session.selectedPath)
              ? session.selectedPath
              : (orderedState.files[0]?.path ?? null);
          const nextCollapsed =
            session?.collapsed ??
            new Set(
              orderedState.files
                .filter((file) => nextViewed[file.path] === file.fingerprint)
                .map((file) => file.path),
            );

          setState(orderedState);
          if (
            orderedState.source.type === 'pull-request' ||
            orderedState.source.type === 'branch'
          ) {
            setHistorySource(orderedState.source);
          }
          setCollapsed(new Set(nextCollapsed));
          setItemVersionByPath({});
          setReviewComments(session?.reviewComments ?? getReviewCommentsFromState(orderedState));
          setReloadDeltaPaths(new Set());
          setViewed(nextViewed);
          setSelectedPath(nextSelectedPath);
          setWalkthrough(session?.walkthrough ?? null);
          setWalkthroughError(session?.walkthroughError ?? null);
          setWalkthroughLoading(false);
          setWalkthroughUnread(false);
          setLocalChangesDetected(false);
          setPendingSource(null);
        })
        .catch((error: unknown) => {
          if (sourceRequestRef.current === request) {
            setLoadError(getRepositoryLoadError(error));
            setWalkthroughLoading(false);
            setPendingSource(null);
          }
        });
    },
    [pendingSource, saveCurrentSourceSession],
  );

  const resizeSidebar = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();

    const handle = event.currentTarget;
    const shell = handle.parentElement;
    if (!shell) {
      return;
    }

    const shellLeft = shell.getBoundingClientRect().left;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    let collapsed = false;

    const cleanup = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener('pointermove', handleMove);
      handle.removeEventListener('pointerup', handleEnd);
      handle.removeEventListener('pointercancel', handleEnd);
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
    };

    const handleMove = (moveEvent: PointerEvent) => {
      const rawWidth = moveEvent.clientX - shellLeft;
      if (rawWidth < SIDEBAR_COLLAPSE_THRESHOLD) {
        // Collapse immediately mid-drag — no resistance, no snap on release
        collapsed = true;
        setSidebarCollapsed(true);
        writeSidebarCollapsed(true);
        cleanup();
        return;
      }
      setSidebarWidth(clampSidebarWidth(rawWidth));
    };

    const handleEnd = () => {
      cleanup();
      if (!collapsed) {
        setSidebarWidth((width) => {
          writeSidebarWidth(width);
          return width;
        });
      }
    };

    handle.addEventListener('pointermove', handleMove);
    handle.addEventListener('pointerup', handleEnd);
    handle.addEventListener('pointercancel', handleEnd);
  }, []);

  const changeSidebarMode = useCallback(
    (mode: SidebarMode) => {
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
      if (walkthrough || walkthroughError || walkthroughLoading || !state) {
        return;
      }
      if (state.files.length === 0) {
        setWalkthrough(null);
        setWalkthroughError(null);
        setWalkthroughLoading(false);
        return;
      }

      const sourceKey = getSourceKey(state.source);
      setWalkthroughLoading(true);
      setWalkthroughError(null);
      window.codiff
        .getWalkthrough(state.source)
        .then((result) => {
          if (getSourceKey(stateRef.current?.source ?? state.source) !== sourceKey) {
            return;
          }

          if (result.status === 'ready') {
            setWalkthrough(result.walkthrough);
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
          if (getSourceKey(stateRef.current?.source ?? state.source) !== sourceKey) {
            return;
          }

          setWalkthroughError({
            reason: error instanceof Error ? error.message : String(error),
            status: 'unavailable',
          });
        })
        .finally(() => {
          if (getSourceKey(stateRef.current?.source ?? state.source) === sourceKey) {
            setWalkthroughLoading(false);
          }
        });
    },
    [state, walkthrough, walkthroughError, walkthroughLoading],
  );

  useEffect(() => {
    const registry = commandRegistryRef.current;
    const unregisterFns = [
      registry.register({
        execute: () => {
          expandSidebar();
          requestAnimationFrame(() => {
            const input = document.querySelector<HTMLInputElement>('.sidebar-search');
            input?.focus();
            input?.select();
          });
        },
        id: 'file-filter',
        keymapAction: 'fileFilter',
        title: 'Focus File Filter',
      }),
      registry.register({
        execute: openDiffSearch,
        id: 'diff-search',
        keymapAction: 'diffSearch',
        title: 'Find in Diffs',
      }),
      registry.register({
        execute: () => changeSidebarMode('tree'),
        id: 'sidebar-tree',
        title: 'Show File Tree',
      }),
      registry.register({
        execute: () => changeSidebarMode('history'),
        id: 'sidebar-history',
        title: 'Show History',
      }),
      registry.register({
        execute: () => changeSidebarMode('walkthrough'),
        id: 'sidebar-walkthrough',
        title: 'Show Walkthrough',
      }),
      registry.register({
        execute: () => {
          const currentState = stateRef.current;
          if (!currentState) {
            return;
          }

          const markdown = buildReviewCommentsMarkdown(
            currentState.files,
            reviewCommentsRef.current,
            preferencesRef.current.showWhitespace,
          );
          if (markdown) {
            void navigator.clipboard.writeText(markdown);
          }
        },
        id: 'copy-comments',
        title: 'Copy Review Comments',
      }),
      registry.register({
        execute: () => {
          const currentState = stateRef.current;
          if (!currentState) {
            return;
          }

          const markdown = buildReviewCommentsMarkdown(
            currentState.files,
            reviewCommentsRef.current,
            preferencesRef.current.showWhitespace,
          );
          if (markdown) {
            void navigator.clipboard.writeText(markdown).then(() => {
              window.close();
            });
          } else {
            window.close();
          }
        },
        id: 'copy-comments-and-close',
        title: 'Copy Review Comments and Close',
      }),
      registry.register({
        description: () => selectedPathRef.current,
        execute: () => {
          const currentState = stateRef.current;
          const path = selectedPathRef.current;
          if (!currentState || !path) {
            return;
          }

          const file = currentState.files.find((f) => f.path === path);
          if (!file) {
            return;
          }

          const isViewed = viewedRef.current[file.path] === file.fingerprint;
          setViewed((current) => {
            if (isViewed) {
              const next = { ...current };
              delete next[file.path];
              if (currentState.source.type === 'working-tree') {
                writeViewed(currentState.root, next);
              }
              return next;
            }

            const next = {
              ...current,
              [file.path]: file.fingerprint,
            };
            if (currentState.source.type === 'working-tree') {
              writeViewed(currentState.root, next);
            }
            return next;
          });

          setCollapsed((current) => {
            const next = new Set(current);
            if (isViewed) {
              next.delete(file.path);
            } else {
              next.add(file.path);
            }
            return next;
          });
          bumpItemVersion(file.path);
        },
        id: 'toggle-viewed',
        title: 'Toggle Viewed',
      }),
      registry.register({
        description: () => selectedPathRef.current,
        execute: openSelectedFile,
        id: 'open-file',
        keymapAction: 'openFile',
        title: 'Open File in Editor',
      }),
      registry.register({
        execute: toggleSidebar,
        id: 'toggle-sidebar',
        keymapAction: 'toggleSidebar',
        title: 'Toggle Sidebar',
      }),
      registry.register({
        execute: () => {
          void window.codiff.setShowOutdated(!preferencesRef.current.showOutdated).catch(() => {});
        },
        id: 'toggle-outdated-comments',
        title: 'Toggle Outdated Comments',
      }),
      registry.register({
        description: () =>
          preferencesRef.current.diffStyle === 'split' ? 'Switch to Unified' : 'Switch to Split',
        execute: () => {
          const nextDiffStyle = preferencesRef.current.diffStyle === 'split' ? 'unified' : 'split';
          void window.codiff.setDiffStyle(nextDiffStyle).catch(() => {});
        },
        id: 'toggle-diff-layout',
        title: 'Toggle Diff Layout',
      }),
      registry.register({
        description: () =>
          preferencesRef.current.wordWrap ? 'Disable Word Wrap' : 'Enable Word Wrap',
        execute: () => {
          void window.codiff.setWordWrap(!preferencesRef.current.wordWrap).catch(() => {});
        },
        id: 'toggle-word-wrap',
        title: 'Toggle Word Wrap',
      }),
      registry.register({
        execute: reloadWindow,
        id: 'reload',
        title: 'Reload Window',
      }),
    ];
    setCommandBarCommands(registry.commands);

    return () => {
      for (const unregister of unregisterFns) {
        unregister();
      }
    };
  }, [
    bumpItemVersion,
    changeSidebarMode,
    expandSidebar,
    openDiffSearch,
    openSelectedFile,
    reloadWindow,
    toggleSidebar,
  ]);

  const toggleCollapsed = useCallback(
    (file: ChangedFile, isCollapsed: boolean) => {
      setCollapsed((current) => {
        const next = new Set(current);
        if (isCollapsed) {
          next.delete(file.path);
        } else {
          next.add(file.path);
        }
        return next;
      });
      bumpItemVersion(file.path);
    },
    [bumpItemVersion],
  );

  const updateSelectedPathFromScroll = useCallback(
    (viewer: CodeViewInstance) => {
      if (!visibleFiles.length) {
        return;
      }

      const scrollTop = viewer.getScrollTop();
      const activationTop = scrollTop + DEFAULT_PADDING;
      let nextPath = visibleFiles[0]?.path ?? null;
      let nextDistance = Number.NEGATIVE_INFINITY;

      for (const file of visibleFiles) {
        const section = getFirstVisibleSection(file, showWhitespace);
        const itemId = section ? getItemId(section) : null;
        const itemTop = itemId ? viewer.getTopForItem(itemId) : undefined;
        if (itemTop == null) {
          continue;
        }

        const distance = itemTop - activationTop;
        if (distance <= 0 && distance > nextDistance) {
          nextDistance = distance;
          nextPath = file.path;
        }
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

      if (nextPath) {
        setSelectedPath((current) => (current === nextPath ? current : nextPath));
      }
    },
    [showWhitespace, visibleFiles],
  );

  const toggleViewed = useCallback(
    (file: ChangedFile, isViewed: boolean) => {
      if (!state) {
        return;
      }

      setViewed((current) => {
        if (isViewed) {
          const next = { ...current };
          delete next[file.path];
          if (state.source.type === 'working-tree') {
            writeViewed(state.root, next);
          }
          return next;
        }

        const next = {
          ...current,
          [file.path]: file.fingerprint,
        };
        if (state.source.type === 'working-tree') {
          writeViewed(state.root, next);
        }
        return next;
      });

      setCollapsed((current) => {
        if (isViewed) {
          const next = new Set(current);
          next.delete(file.path);
          return next;
        }

        const next = new Set(current);
        next.add(file.path);
        return next;
      });
      bumpItemVersion(file.path);
    },
    [bumpItemVersion, state],
  );

  const createComment = useCallback((comment: Omit<ReviewComment, 'body' | 'id'>) => {
    const emptyExistingComment = reviewCommentsRef.current.find(
      (candidate) =>
        candidate.body.length === 0 && getCommentKey(candidate) === getCommentKey(comment),
    );
    if (emptyExistingComment) {
      setFocusCommentId(emptyExistingComment.id);
      setFocusCommentRequest((current) => current + 1);
      return;
    }

    const emptyDraft = reviewCommentsRef.current.find(
      (candidate) => !candidate.isReadOnly && candidate.body.length === 0,
    );
    if (emptyDraft) {
      const id = crypto.randomUUID();
      setFocusCommentId(id);
      setFocusCommentRequest((current) => current + 1);
      setReviewComments((current) =>
        current.map((candidate) =>
          candidate.id === emptyDraft.id
            ? {
                ...comment,
                body: '',
                id,
              }
            : candidate,
        ),
      );
      return;
    }

    const id = crypto.randomUUID();
    setFocusCommentId(id);
    setFocusCommentRequest((current) => current + 1);

    setReviewComments((current) => [
      ...current,
      {
        ...comment,
        body: '',
        id,
      },
    ]);
  }, []);

  const updateComment = useCallback((commentId: string, body: string) => {
    setReviewComments((current) =>
      current.map((comment) =>
        comment.id === commentId && !comment.isReadOnly ? { ...comment, body } : comment,
      ),
    );
  }, []);

  const deleteComment = useCallback((commentId: string) => {
    setFocusCommentId((current) => (current === commentId ? null : current));
    setReviewComments((current) => current.filter((comment) => comment.id !== commentId));
  }, []);

  const updateCodexReply = useCallback(
    (commentId: string, filePath: string, codexReply: NonNullable<ReviewComment['codexReply']>) => {
      setReviewComments((current) =>
        current.map((comment) =>
          comment.id === commentId
            ? {
                ...comment,
                codexReply,
              }
            : comment,
        ),
      );
      bumpItemVersion(filePath);
    },
    [bumpItemVersion],
  );

  const updateGitHubSubmit = useCallback(
    (commentId: string, githubSubmit: ReviewComment['githubSubmit']) => {
      setReviewComments((current) =>
        current.map((comment) =>
          comment.id === commentId
            ? {
                ...comment,
                githubSubmit,
              }
            : comment,
        ),
      );
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (comment) {
        bumpItemVersion(comment.filePath);
      }
    },
    [bumpItemVersion],
  );

  const askCodex = useCallback(
    (commentId: string) => {
      const currentState = stateRef.current;
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (
        !currentState ||
        !comment ||
        comment.body.trim().length === 0 ||
        comment.codexReply?.status === 'loading'
      ) {
        return;
      }

      const note = walkthroughNotes.get(comment.filePath);
      const request: ReviewAssistantRequest = {
        comment: {
          body: comment.body,
          filePath: comment.filePath,
          lineNumber: comment.lineNumber,
          sectionId: comment.sectionId,
          side: comment.side,
          ...getReviewCommentRangeProps(comment),
        },
        source: currentState.source,
        walkthroughNote: note
          ? {
              action: note.action,
              context: note.context,
              groupReason: note.groupReason,
              groupTitle: note.groupTitle,
              impact: note.impact,
              reason: note.reason,
            }
          : undefined,
      };

      updateCodexReply(comment.id, comment.filePath, { status: 'loading' });
      void window.codiff
        .askReviewAssistant(request)
        .then((result) => {
          updateCodexReply(
            comment.id,
            comment.filePath,
            result.status === 'ready'
              ? {
                  body: result.reply,
                  status: 'ready',
                }
              : {
                  error: result.reason,
                  status: 'error',
                },
          );
        })
        .catch((error: unknown) => {
          updateCodexReply(comment.id, comment.filePath, {
            error: error instanceof Error ? error.message : String(error),
            status: 'error',
          });
        });
    },
    [updateCodexReply, walkthroughNotes],
  );

  const submitPullRequestComment = useCallback(
    (commentId: string) => {
      const currentState = stateRef.current;
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (
        currentState?.source.type !== 'pull-request' ||
        !comment ||
        comment.body.trim().length === 0 ||
        comment.githubSubmit?.status === 'submitting'
      ) {
        return;
      }

      updateGitHubSubmit(comment.id, { status: 'submitting' });
      void window.codiff
        .submitPullRequestComment({
          comment: {
            body: comment.body,
            filePath: comment.filePath,
            lineNumber: comment.lineNumber,
            side: comment.side,
            ...getReviewCommentRangeProps(comment),
          },
          source: currentState.source,
        })
        .then((submittedComment) => {
          setFocusCommentId((current) => (current === comment.id ? null : current));
          setReviewComments((current) =>
            current.map((candidate) =>
              candidate.id === comment.id
                ? {
                    author: submittedComment.author,
                    body: submittedComment.body,
                    filePath: submittedComment.filePath,
                    id: submittedComment.id,
                    isReadOnly: true,
                    lineNumber: submittedComment.lineNumber,
                    sectionId: comment.sectionId,
                    side: submittedComment.side,
                    ...getReviewCommentRangeProps(submittedComment),
                    submittedAt: submittedComment.submittedAt,
                    url: submittedComment.url,
                  }
                : candidate,
            ),
          );
          bumpItemVersion(comment.filePath);
        })
        .catch((error: unknown) => {
          updateGitHubSubmit(comment.id, {
            error: error instanceof Error ? error.message : String(error),
            status: 'error',
          });
        });
    },
    [bumpItemVersion, updateGitHubSubmit],
  );

  const submitPullRequestReview = useCallback(
    (event: PullRequestReviewEvent) => {
      const currentState = stateRef.current;
      if (currentState?.source.type !== 'pull-request' || pullRequestReviewSubmitting) {
        return;
      }

      const pendingComments = reviewCommentsRef.current.filter(
        (comment) => !comment.isReadOnly && comment.body.trim(),
      );
      const pendingCommentIds = new Set(pendingComments.map((comment) => comment.id));
      setPullRequestReviewSubmitting(event);
      void window.codiff
        .submitPullRequestReview({
          comments: pendingComments.map((comment) => ({
            body: comment.body,
            filePath: comment.filePath,
            lineNumber: comment.lineNumber,
            side: comment.side,
            ...getReviewCommentRangeProps(comment),
          })),
          event,
          source: currentState.source,
        })
        .then(() => {
          setReviewComments((current) =>
            current.filter((comment) => !pendingCommentIds.has(comment.id)),
          );
        })
        .catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          setPullRequestReviewSubmitting(null);
        });
    },
    [pullRequestReviewSubmitting],
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

  const installCodexSkill = useCallback(() => {
    setCodexSkillInstalling(true);
    window.codiff
      .installCodexSkill()
      .then((status) => setCodexSkillStatus(status))
      .catch(() => {
        setCodexSkillStatus(defaultCodexSkillStatus);
      })
      .finally(() => {
        setCodexSkillInstalling(false);
      });
  }, []);

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
              codexSkillInstalled={codexSkillStatus.installed}
              codexSkillInstalling={codexSkillInstalling}
              installing={terminalHelperInstalling}
              onInstallCodexSkill={installCodexSkill}
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
      <main className={`loading italic${launchOptions.walkthrough ? ' codex' : ' pulse'}`}>
        {launchOptions.walkthrough ? 'Generating walkthrough…' : 'Thinking…'}
      </main>
    );
  }

  const selectedOrSearchPath = activeDiffSearchMatch?.filePath ?? selectedPath;
  const visibleSelectedPath =
    selectedOrSearchPath && visibleFiles.some((file) => file.path === selectedOrSearchPath)
      ? selectedOrSearchPath
      : (visibleFiles[0]?.path ?? null);
  const hasDiffSearchQuery = diffSearchQuery.trim().length > 0;
  const isPullRequest = state.source.type === 'pull-request';
  const isSwitchingSource = pendingSource != null;
  const showCodexUnavailablePanel =
    sidebarMode === 'walkthrough' &&
    !walkthrough &&
    !walkthroughLoading &&
    walkthroughError?.code === 'CODEX_NOT_FOUND';

  const sidebarLabel = `${compactPath(state.root)}${state.branch ? ` (${state.branch})` : ''}`;
  const sidebarSourceLabel =
    state.source.type !== 'working-tree' ? ` · ${getSourceLabel(state.source)}` : '';

  return (
    <div
      className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
      style={
        sidebarCollapsed
          ? undefined
          : { gridTemplateColumns: `${sidebarWidth}px 6px minmax(0, 1fr)` }
      }
    >
      <div aria-hidden className="window-drag-region" />
      {sidebarCollapsed ? (
        <div className="collapsed-sidebar-bar">
          <button
            className="sidebar-toggle-button"
            onClick={expandSidebar}
            title={`Expand sidebar (${getShortcutLabel(codiffConfig.keymap, 'toggleSidebar')})`}
            type="button"
          >
            <svg
              aria-hidden
              fill="none"
              height="16"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
              width="16"
            >
              <rect height="18" rx="2" ry="2" width="18" x="3" y="3" />
              <line x1="9" x2="9" y1="3" y2="21" />
            </svg>
          </button>
          <div className="collapsed-sidebar-label" title={state.root}>
            {sidebarLabel}
            {sidebarSourceLabel}
          </div>
        </div>
      ) : null}
      <RepositoryChangeBanner
        onReload={reloadWindow}
        visible={localChangesDetected && (pendingSource ?? state.source).type === 'working-tree'}
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
        onClose={() => setCommandBarVisible(false)}
        visible={commandBarVisible}
      />
      {!isSwitchingSource ? (
        <div className="review-action-bar">
          <CopyCommentsButton
            comments={reviewComments}
            files={orderedFiles}
            showWhitespace={showWhitespace}
          />
          {isPullRequest ? (
            <PullRequestReviewButtons
              disabled={pullRequestReviewSubmitting != null}
              onSubmitReview={submitPullRequestReview}
              submittingEvent={pullRequestReviewSubmitting}
            />
          ) : null}
        </div>
      ) : null}
      <aside className="squircle sidebar">
        <div className="sidebar-header">
          <div className="sidebar-path-row">
            <button
              className="sidebar-toggle-button"
              onClick={toggleSidebar}
              title={`Collapse sidebar (${getShortcutLabel(codiffConfig.keymap, 'toggleSidebar')})`}
              type="button"
            >
              <svg
                aria-hidden
                fill="none"
                height="16"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
                width="16"
              >
                <rect height="18" rx="2" ry="2" width="18" x="3" y="3" />
                <line x1="9" x2="9" y1="3" y2="21" />
              </svg>
            </button>
            <div className="sidebar-path" title={state.root}>
              {sidebarLabel}
              {sidebarSourceLabel}
            </div>
          </div>
        </div>
        <Sidebar
          branchSource={historySource?.type === 'branch' ? historySource : null}
          currentSource={pendingSource ?? state.source}
          files={visibleFiles}
          historyEntries={historyEntries}
          historyHasMore={historyHasMore}
          historyLoading={historyLoading}
          keymap={codiffConfig.keymap}
          mode={sidebarMode}
          onActivatePath={activatePath}
          onLoadMoreHistory={loadMoreHistory}
          onModeChange={changeSidebarMode}
          onSearchQueryChange={
            sidebarMode === 'history' ? setHistorySearchQuery : setFileSearchQuery
          }
          onSelectPath={selectPath}
          onSelectSource={selectSource}
          pullRequestSource={historySource?.type === 'pull-request' ? historySource : null}
          reloadDeltaPaths={reloadDeltaPaths}
          searchQuery={sidebarMode === 'history' ? historySearchQuery : fileSearchQuery}
          selectedPath={visibleSelectedPath}
          showWhitespace={showWhitespace}
          walkthroughAvailable={walkthrough != null}
          walkthroughError={walkthroughError}
          walkthroughLoading={walkthroughLoading}
          walkthroughNotes={walkthroughNotes}
          walkthroughSummary={walkthrough?.summary ?? null}
          walkthroughUnread={walkthroughUnread}
        />
      </aside>
      <div aria-hidden className="sidebar-resizer" onPointerDown={resizeSidebar} />
      <main className="review">
        {isSwitchingSource ? (
          <ReviewSourceLoading />
        ) : showCodexUnavailablePanel ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <CodexUnavailablePanel onShowFiles={() => setSidebarMode('tree')} />
            </div>
          </div>
        ) : state.files.length === 0 ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>
                {state.source.type === 'commit'
                  ? 'No changes in commit'
                  : state.source.type === 'branch'
                    ? 'Branch history'
                    : 'No local changes'}
              </strong>
              {state.source.type === 'commit' ? (
                <span>{getShortRef(state.source.ref)}</span>
              ) : state.source.type === 'branch' ? (
                <span>{state.source.ref}</span>
              ) : (
                <code className="walkthrough-inline-code" title={state.root}>
                  {compactPath(state.root)}
                </code>
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
            activeSearchMatch={activeDiffSearchMatch}
            collapsed={collapsed}
            comments={visibleReviewComments}
            commitMetadata={state.source.type === 'commit' ? (state.commitMetadata ?? null) : null}
            diffStyle={diffStyle}
            files={visibleFiles}
            focusCommentId={focusCommentId}
            focusCommentRequest={focusCommentRequest}
            forceExpandedPaths={diffSearchMatchPathSet}
            gitIdentity={gitIdentity}
            isPullRequest={isPullRequest}
            itemVersionByPath={itemVersionByPath}
            keymap={codiffConfig.keymap}
            loadingSectionIds={loadingSectionIds}
            onAskCodex={askCodex}
            onCreateComment={createComment}
            onDeleteComment={deleteComment}
            onLoadSection={loadDiffSection}
            onOpenFile={openFile}
            onSelectPathFromScroll={updateSelectedPathFromScroll}
            onSubmitComment={submitPullRequestComment}
            onToggleCollapsed={toggleCollapsed}
            onToggleViewed={toggleViewed}
            onUpdateComment={updateComment}
            scrollTarget={scrollTarget}
            searchQuery={diffSearchQuery}
            selectedPath={visibleSelectedPath}
            showWhitespace={showWhitespace}
            source={state.source}
            viewed={viewed}
            walkthroughNotes={
              sidebarMode === 'walkthrough' ? walkthroughNotes : emptyWalkthroughNotes
            }
            wordWrap={wordWrap}
          />
        )}
      </main>
    </div>
  );
}
