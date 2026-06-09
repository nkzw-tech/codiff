import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { CommandBar } from './app/components/CommandBar.tsx';
import { KeyboardShortcutsHelp } from './app/components/KeyboardShortcutsHelp.tsx';
import {
  AgentUnavailablePanel,
  CopyCommentsButton,
  DiffSearchPanel,
  FirstRunPanel,
  PullRequestReviewButtons,
  RepositoryChangeBanner,
  RepositoryLoadErrorPanel,
  ReviewSourceLoading,
  WalkthroughOutdatedBanner,
} from './app/components/Panels.tsx';
import { ReviewCodeView, type ReviewDiffBlock } from './app/components/ReviewCodeView.tsx';
import { Sidebar } from './app/components/Sidebar.tsx';
import { CommitView } from './app/components/walkthrough/CommitView.tsx';
import {
  NarrativeWalkthroughView,
  type WalkthroughBlockScrollTarget,
  type WalkthroughReviewTarget,
} from './app/components/walkthrough/NarrativeWalkthroughView.tsx';
import { useNarrativeNavigation } from './app/components/walkthrough/useNarrativeNavigation.ts';
import type { WalkthroughFileError } from './app/components/WalkthroughFileError.tsx';
import { createDefaultConfig } from './config/defaults.ts';
import { getShortcutLabel, matchesShortcut } from './config/keymap.ts';
import type { CodiffConfig } from './config/types.ts';
import {
  defaultAgentSkillStatus,
  defaultLaunchOptions,
  defaultTerminalHelperStatus,
  getAgentLabel,
  getAgentModelShortName,
  HISTORY_PAGE_SIZE,
} from './lib/app-constants.ts';
import {
  type CodeViewInstance,
  type DiffSearchResult,
  type RepositoryLoadError,
  type ReviewComment,
  type ReviewIdentity,
  type ReviewScrollBehavior,
  type ReviewScrollTarget,
  type SidebarMode,
  type SourceSession,
  type WalkthroughNote,
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
import { buildCommitModel, buildGenericCommitModel } from './lib/narrative-walkthrough.ts';
import {
  consumeReloadSelection,
  getReloadDeltaPaths,
  getReloadHistorySource,
  getReloadSelectionPath,
  writeReloadSelection,
} from './lib/reload-selection.ts';
import {
  createReviewCommandTarget,
  resolveReviewCommandTarget,
  type ReviewCommandTarget,
} from './lib/review-command-target.ts';
import {
  buildReviewCommentsMarkdown,
  getCommentKey,
  getReviewCommentRangeProps,
  getReviewCommentsFromState,
  getVisibleReviewComments,
} from './lib/review-comments.ts';
import {
  getFileReviewIdentity,
  isReviewIdentityViewed,
  updateReviewIdentityCollapsed,
  updateReviewIdentityViewed,
} from './lib/review-identity.ts';
import {
  SIDEBAR_COLLAPSE_THRESHOLD,
  clampSidebarWidth,
  readSidebarCollapsed,
  readSidebarWidth,
  writeSidebarCollapsed,
  writeSidebarWidth,
} from './lib/sidebar-width.ts';
import {
  getEmptySourceDetail,
  getEmptySourceTitle,
  getHistorySource,
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
  CodiffPreferences,
  GitIdentity,
  HistoryEntry,
  PullRequestReviewEvent,
  RepositoryState,
  ReviewAssistantRequest,
  ReviewSource,
  TerminalHelperStatus,
  NarrativeWalkthrough,
  WalkthroughCommitMessageRequest,
  WalkthroughCommitRequest,
  DiffSection,
} from './types.ts';

const emptyWalkthroughNotes = new Map<string, WalkthroughNote>();
const emptyFiles: ReadonlyArray<ChangedFile> = [];
const walkthroughCodeViewBottomInset = 96;
type MainMode = 'review' | 'commit';
const CODE_FONT_SIZE_DEFAULT = 13;
const CODE_FONT_SIZE_MAX = 32;
const CODE_FONT_SIZE_MIN = 10;

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

const normalizeCodeFontSizePreference = (size: number) =>
  Number.isFinite(size)
    ? Math.min(CODE_FONT_SIZE_MAX, Math.max(CODE_FONT_SIZE_MIN, Math.round(size)))
    : CODE_FONT_SIZE_DEFAULT;

const getCodeFontLineHeight = (size: number) => Math.round((size * 20) / 13);

const ignoreWalkthroughPathScroll = () => {};

const defaultPreferences = getPreferencesFromConfig(createDefaultConfig());

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
  const [itemVersionByKey, setItemVersionByKey] = useState<Record<string, number>>({});
  const [localChangesDetected, setLocalChangesDetected] = useState(false);
  const [launchOptions, setLaunchOptions] = useState<CodiffLaunchOptions>(defaultLaunchOptions);
  const [codiffConfig, setCodiffConfig] = useState<CodiffConfig>(createDefaultConfig);
  const [agentSkillInstalling, setAgentSkillInstalling] = useState(false);
  const [agentSkillStatus, setAgentSkillStatus] =
    useState<AgentSkillStatus>(defaultAgentSkillStatus);
  const [preferences, setPreferences] = useState<CodiffPreferences>(defaultPreferences);
  const [reviewComments, setReviewComments] = useState<ReadonlyArray<ReviewComment>>([]);
  const [reloadDeltaPaths, setReloadDeltaPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [pullRequestReviewSubmitting, setPullRequestReviewSubmitting] =
    useState<PullRequestReviewEvent | null>(null);
  const [scrollTarget, setScrollTarget] = useState<ReviewScrollTarget | null>(null);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  const [isWindowFullScreen, setIsWindowFullScreen] = useState(false);
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
  const [narrativeWalkthrough, setNarrativeWalkthrough] = useState<NarrativeWalkthrough | null>(
    null,
  );
  const [walkthroughError, setWalkthroughError] = useState<WalkthroughError | null>(null);
  const [walkthroughFileError, setWalkthroughFileError] = useState<WalkthroughFileError | null>(
    null,
  );
  const [walkthroughLoading, setWalkthroughLoading] = useState(false);
  const [walkthroughUnread, setWalkthroughUnread] = useState(false);
  const [mainMode, setMainMode] = useState<MainMode>('review');
  const historyRequestRef = useRef(0);
  const historySourceRef = useRef<ReviewSource | null>(null);
  const loadingSectionKeysRef = useRef<Set<string>>(new Set());
  const programmaticScrollPathRef = useRef<string | null>(null);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const sourceSessionsRef = useRef<Map<string, SourceSession>>(new Map());
  const stateRef = useRef<RepositoryState | null>(null);
  const activeReviewCommandTargetRef = useRef<ReviewCommandTarget | null>(null);
  const collapsedRef = useRef<Set<string>>(new Set());
  const preferencesRef = useRef<CodiffPreferences>(defaultPreferences);
  const reviewCommentsRef = useRef<ReadonlyArray<ReviewComment>>([]);
  const selectedPathRef = useRef<string | null>(null);
  const sidebarModeRef = useRef<SidebarMode>('tree');
  const mainModeRef = useRef<MainMode>('review');
  const sourceRequestRef = useRef(0);
  const viewedRef = useRef<Record<string, string>>({});
  const narrativeWalkthroughRef = useRef<NarrativeWalkthrough | null>(null);
  const navigationResetKey = state ? `${state.root}:${getSourceKey(state.source)}` : '';
  const narrativeNavigation = useNarrativeNavigation(
    narrativeWalkthrough,
    state?.files ?? emptyFiles,
    navigationResetKey,
  );
  const walkthroughErrorRef = useRef<WalkthroughError | null>(null);
  const [commandBarVisible, setCommandBarVisible] = useState(false);
  const [commandBarCommands, setCommandBarCommands] = useState<ReadonlyArray<Command>>([]);
  const [shortcutsHelpVisible, setShortcutsHelpVisible] = useState(false);
  const [hunkNavigation, setHunkNavigation] = useState<{
    direction: 1 | -1;
    request: number;
  } | null>(null);
  const commandRegistryRef = useRef(createCommandRegistry());

  const navigateHunks = useCallback((direction: 1 | -1) => {
    setHunkNavigation((current) => ({
      direction,
      request: (current?.request ?? 0) + 1,
    }));
  }, []);

  const bumpItemVersion = useCallback((key: string) => {
    setItemVersionByKey((current) => ({
      ...current,
      [key]: (current[key] ?? 0) + 1,
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

  const setFileViewedState = useCallback(
    (repositoryState: RepositoryState, file: ChangedFile, nextViewed: boolean) => {
      setViewed((current) => {
        if (!nextViewed) {
          const next = { ...current };
          delete next[file.path];
          if (repositoryState.source.type === 'working-tree') {
            writeViewed(repositoryState.root, next);
          }
          return next;
        }

        const next = {
          ...current,
          [file.path]: file.fingerprint,
        };
        if (repositoryState.source.type === 'working-tree') {
          writeViewed(repositoryState.root, next);
        }
        return next;
      });

      setCollapsed((current) => {
        const next = new Set(current);
        if (nextViewed) {
          next.add(file.path);
        } else {
          next.delete(file.path);
        }
        return next;
      });
      bumpItemVersion(file.path);
    },
    [bumpItemVersion],
  );

  const saveCurrentSourceSession = useCallback(() => {
    const currentState = stateRef.current;
    if (!currentState) {
      return;
    }

    sourceSessionsRef.current.set(getSourceKey(currentState.source), {
      collapsed: new Set(collapsedRef.current),
      narrativeWalkthrough: narrativeWalkthroughRef.current,
      reviewComments: reviewCommentsRef.current,
      selectedPath: selectedPathRef.current,
      viewed: viewedRef.current,
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
      const nextHistorySource =
        getReloadHistorySource(reloadSelection, orderedState) ??
        getHistorySource(orderedState.source);
      const history = await window.codiff.getRepositoryHistory(
        HISTORY_PAGE_SIZE,
        nextHistorySource,
      );

      if (canceled) {
        return;
      }

      const filesPresent = orderedState.files.length > 0;
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
      setWalkthroughLoading(shouldLoadNarrative);

      // Always consult the main process for a pre-authored walkthrough file, even
      // when the diff is empty, so it can diagnose *why* (e.g. the changes were
      // committed) rather than us guessing in the renderer.
      const shouldFetchNarrative = shouldLoadNarrative || walkthroughFilePath != null;
      const narrativeResult = shouldFetchNarrative
        ? await window.codiff.getNarrativeWalkthrough(orderedState.source)
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
      const reloadSelectedPath = getReloadSelectionPath(reloadSelection, orderedState);
      const nextReloadDeltaPaths = getReloadDeltaPaths(reloadSelection, orderedState);

      setHistoryEntries(history.entries);
      setHistoryHasMore(history.entries.length >= HISTORY_PAGE_SIZE);
      setHistoryLimit(HISTORY_PAGE_SIZE);
      setHistorySource(nextHistorySource ?? null);
      setState(orderedState);
      setLoadError(null);
      setCollapsed(
        new Set(
          orderedState.files
            .filter((file) => nextViewed[file.path] === file.fingerprint)
            .map((file) => file.path),
        ),
      );
      setItemVersionByKey({});
      setFocusCommentId(null);
      setFocusCommentRequest(0);
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

  useEffect(() => {
    const root = document.documentElement;
    const codeFontFamily = preferences.codeFontFamily.trim();
    const codeFontSize = normalizeCodeFontSizePreference(preferences.codeFontSize);

    if (codeFontFamily) {
      root.style.setProperty('--font-diff-mono', `${JSON.stringify(codeFontFamily)}, monospace`);
    } else {
      root.style.removeProperty('--font-diff-mono');
    }

    root.style.setProperty('--font-diff-size', `${codeFontSize}px`);
    root.style.setProperty('--font-diff-line-height', `${getCodeFontLineHeight(codeFontSize)}px`);

    return () => {
      root.style.removeProperty('--font-diff-mono');
      root.style.removeProperty('--font-diff-size');
      root.style.removeProperty('--font-diff-line-height');
    };
  }, [preferences.codeFontFamily, preferences.codeFontSize]);

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
    void window.codiff.isWindowFullScreen().then(setIsWindowFullScreen, () => {});
    return window.codiff.onWindowFullScreenChanged(setIsWindowFullScreen);
  }, []);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    mainModeRef.current = mainMode;
  }, [mainMode]);

  useEffect(() => {
    activeReviewCommandTargetRef.current = null;
  }, [navigationResetKey]);

  useEffect(() => {
    viewedRef.current = viewed;
  }, [viewed]);

  useEffect(() => {
    narrativeWalkthroughRef.current = narrativeWalkthrough;
  }, [narrativeWalkthrough]);

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
  const orderedFiles = useMemo(() => (state ? sortFiles(state.files) : []), [state]);
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

  const toggleWordWrap = useCallback(() => {
    void window.codiff.setWordWrap(!preferencesRef.current.wordWrap).catch(() => {});
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
  }, []);

  const openSelectedFile = useCallback(() => {
    const target = getReviewCommandTarget();

    if (target) {
      openFile(target.file);
    }
  }, [getReviewCommandTarget, openFile]);

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
      if (
        !isNativeInputTarget(event.target) &&
        matchesShortcut(event, codiffConfig.keymap, 'toggleWordWrap')
      ) {
        event.preventDefault();
        toggleWordWrap();
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
      if (!isNativeInputTarget(event.target)) {
        if (
          sidebarModeRef.current === 'walkthrough' &&
          narrativeWalkthroughRef.current &&
          (matchesShortcut(event, codiffConfig.keymap, 'nextHunk') ||
            matchesShortcut(event, codiffConfig.keymap, 'prevHunk'))
        ) {
          return;
        }
        if (matchesShortcut(event, codiffConfig.keymap, 'nextHunk')) {
          event.preventDefault();
          navigateHunks(1);
          return;
        }
        if (matchesShortcut(event, codiffConfig.keymap, 'prevHunk')) {
          event.preventDefault();
          navigateHunks(-1);
          return;
        }
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
    navigateHunks,
    openDiffSearch,
    openSelectedFile,
    sidebarCollapsed,
    toggleSidebar,
    toggleWordWrap,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isNativeInputTarget(event.target)) {
        return;
      }
      if (matchesShortcut(event, codiffConfig.keymap, 'shortcutsHelp')) {
        event.preventDefault();
        setShortcutsHelpVisible(true);
      }
    };

    // The overlay is held open while Shift+? is pressed, so dismiss it the
    // moment either key is released (or the window loses focus mid-hold).
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === '?' || event.key === '/' || event.key === 'Shift') {
        setShortcutsHelpVisible(false);
      }
    };

    const handleBlur = () => setShortcutsHelpVisible(false);

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [codiffConfig.keymap]);

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
    setMainMode('review');
    setSelectedPath(path);
  }, []);

  const activatePath = useCallback(
    (path: string) => {
      setMainMode('review');
      setSelectedPath(path);
      scrollPathIntoReview(path, 'smooth');
    },
    [scrollPathIntoReview],
  );

  const reloadWindow = useCallback(() => {
    window.location.reload();
  }, []);

  // Commit the files a reviewer chose from the walkthrough's staging set. The
  // working-tree watcher surfaces a "reload to see changes" banner afterwards.
  const commitWalkthrough = useCallback(
    (request: WalkthroughCommitRequest) =>
      window.codiff.createWalkthroughCommit({
        ...request,
        source: stateRef.current?.source ?? request.source,
      }),
    [],
  );

  // Ask the connected agent to rewrite the commit message for the reviewer's
  // current file selection (used when files are dropped from the staging set).
  const updateWalkthroughCommitMessage = useCallback(
    (request: WalkthroughCommitMessageRequest) =>
      window.codiff.updateWalkthroughCommitMessage({
        ...request,
        source: stateRef.current?.source ?? request.source,
      }),
    [],
  );

  useEffect(() => {
    const writeCurrentReloadSelection = () => {
      writeReloadSelection(stateRef.current, selectedPathRef.current, historySourceRef.current);
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
      setMainMode('review');

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
            (usesViewedFileState(orderedState.source) ? readViewed(orderedState.root) : {});
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
          setHistorySource(getHistorySource(orderedState.source) ?? historySource);
          setCollapsed(new Set(nextCollapsed));
          setItemVersionByKey({});
          setReviewComments(session?.reviewComments ?? getReviewCommentsFromState(orderedState));
          setReloadDeltaPaths(new Set());
          setViewed(nextViewed);
          setSelectedPath(nextSelectedPath);
          setNarrativeWalkthrough(session?.narrativeWalkthrough ?? null);
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
    [historySource, pendingSource, saveCurrentSourceSession],
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

      const sourceKey = getSourceKey(state.source);
      setWalkthroughLoading(true);
      setWalkthroughError(null);
      window.codiff
        .getNarrativeWalkthrough(state.source)
        .then((result) => {
          if (getSourceKey(stateRef.current?.source ?? state.source) !== sourceKey) {
            return;
          }

          if (result.status === 'ready') {
            setNarrativeWalkthrough(result.walkthrough);
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
    [narrativeWalkthrough, state, walkthroughError, walkthroughLoading],
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
  }, [narrativeNavigation]);

  const closeCommitView = useCallback(() => {
    setSidebarMode('tree');
    setMainMode('review');
  }, []);

  const toggleViewed = useCallback(
    (
      file: ChangedFile,
      isViewed: boolean,
      reviewIdentity: ReviewIdentity = getFileReviewIdentity(file),
    ) => {
      const currentState = stateRef.current;
      if (!currentState) {
        return;
      }

      setViewed((current) => {
        const next = updateReviewIdentityViewed(current, reviewIdentity, isViewed);
        if (currentState.source.type === 'working-tree') {
          writeViewed(currentState.root, next);
        }
        return next;
      });

      setCollapsed((current) => updateReviewIdentityCollapsed(current, reviewIdentity, isViewed));
      bumpItemVersion(reviewIdentity.key);
    },
    [bumpItemVersion],
  );

  const updateActiveWalkthroughReviewTarget = useCallback(
    (target: WalkthroughReviewTarget | null) => {
      const currentState = stateRef.current;
      activeReviewCommandTargetRef.current =
        target && currentState
          ? createReviewCommandTarget(currentState.source, target.file, target.reviewIdentity)
          : null;
    },
    [],
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
        description: () => getReviewCommandTarget()?.file.path ?? null,
        execute: () => {
          const target = getReviewCommandTarget();
          if (!target) {
            return;
          }

          const isViewed = isReviewIdentityViewed(viewedRef.current, target.reviewIdentity);
          toggleViewed(target.file, isViewed, target.reviewIdentity);
        },
        id: 'toggle-viewed',
        title: 'Toggle Viewed',
      }),
      registry.register({
        description: () => getReviewCommandTarget()?.file.path ?? null,
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
        execute: toggleWordWrap,
        id: 'toggle-word-wrap',
        keymapAction: 'toggleWordWrap',
        title: 'Toggle Word Wrap',
      }),
      registry.register({
        execute: () => {
          void window.codiff.increaseCodeFontSize().catch(() => {});
        },
        id: 'increase-code-font-size',
        title: 'Increase Code Font Size',
      }),
      registry.register({
        execute: () => {
          void window.codiff.decreaseCodeFontSize().catch(() => {});
        },
        id: 'decrease-code-font-size',
        title: 'Decrease Code Font Size',
      }),
      registry.register({
        execute: () => {
          void window.codiff.resetCodeFontSize().catch(() => {});
        },
        id: 'reset-code-font-size',
        title: 'Reset Code Font Size',
      }),
      registry.register({
        execute: () => {
          void window.codiff.openConfigFile().catch(() => {});
        },
        id: 'open-config-file',
        title: 'Open Config File',
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
    changeSidebarMode,
    expandSidebar,
    getReviewCommandTarget,
    openDiffSearch,
    openSelectedFile,
    reloadWindow,
    setFileViewedState,
    toggleSidebar,
    toggleViewed,
    toggleWordWrap,
  ]);

  const toggleCollapsed = useCallback(
    (file: ChangedFile, isCollapsed: boolean, reviewKey = file.path) => {
      setCollapsed((current) => {
        const next = new Set(current);
        if (isCollapsed) {
          next.delete(reviewKey);
        } else {
          next.add(reviewKey);
        }
        return next;
      });
      bumpItemVersion(reviewKey);
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

  const createComment = useCallback(
    (comment: Omit<ReviewComment, 'body' | 'id'>) => {
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
        bumpItemVersion(emptyDraft.filePath);
        bumpItemVersion(comment.filePath);
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
      bumpItemVersion(comment.filePath);
    },
    [bumpItemVersion],
  );

  const updateComment = useCallback((commentId: string, body: string) => {
    const applyCommentBody = (current: ReadonlyArray<ReviewComment>) => {
      let changed = false;
      const next = current.map((comment) => {
        if (comment.id !== commentId || comment.isReadOnly || comment.body === body) {
          return comment;
        }
        changed = true;
        return { ...comment, body };
      });
      return changed ? next : current;
    };

    reviewCommentsRef.current = applyCommentBody(reviewCommentsRef.current);
    setReviewComments(applyCommentBody);
  }, []);

  const deleteComment = useCallback(
    (commentId: string) => {
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      setFocusCommentId((current) => (current === commentId ? null : current));
      setReviewComments((current) => current.filter((candidate) => candidate.id !== commentId));
      if (comment) {
        bumpItemVersion(comment.filePath);
      }
    },
    [bumpItemVersion],
  );

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
    [updateCodexReply],
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
  const agentModelLabel = getAgentModelShortName(
    activeAgentBackend,
    activeAgentBackend === 'codex'
      ? codiffConfig.settings.openAIModel
      : activeAgentBackend === 'claude'
        ? codiffConfig.settings.claudeModel
        : codiffConfig.settings.piModel,
  );
  const agentLabelWithModel = agentModelLabel ? `${agentLabel} (${agentModelLabel})` : agentLabel;
  const agentSkillLabel = `${agentLabel} Skill`;

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
  const showAgentUnavailablePanel =
    sidebarMode === 'walkthrough' &&
    !narrativeWalkthrough &&
    !walkthroughLoading &&
    (walkthroughError?.code === 'CODEX_NOT_FOUND' || walkthroughError?.code === 'CLAUDE_NOT_FOUND');

  const sidebarLabel = `${compactPath(state.root)}${state.branch ? ` (${state.branch})` : ''}`;
  const sidebarSourceLabel =
    state.source.type !== 'working-tree' ? ` · ${getSourceLabel(state.source)}` : '';
  const emptySourceDetail = getEmptySourceDetail(state.source, state.root);

  const showNarrativeWalkthrough = narrativeWalkthrough != null && sidebarMode === 'walkthrough';
  const plainCommitModel = narrativeNavigation.walkthroughView
    ? buildCommitModel(narrativeNavigation.walkthroughView, state.files)
    : buildGenericCommitModel(state.files);
  const showPlainCommitView =
    mainMode === 'commit' && state.source.type === 'working-tree' && state.files.length > 0;
  const diffLineHeight = getCodeFontLineHeight(
    normalizeCodeFontSizePreference(preferences.codeFontSize),
  );
  // Props shared by the full review and the per-stop scoped diffs, so the two
  // render paths can't drift apart.
  const commonReviewProps = {
    activeSearchMatch: activeDiffSearchMatch,
    agentId: activeAgentBackend,
    agentLabel: agentLabelWithModel,
    collapsed,
    comments: visibleReviewComments,
    commitMetadata: state.source.type === 'commit' ? (state.commitMetadata ?? null) : null,
    diffLineHeight,
    diffStyle,
    focusCommentId,
    focusCommentRequest,
    gitIdentity,
    hunkNavigation,
    isPullRequest,
    itemVersionByKey,
    keymap: codiffConfig.keymap,
    loadingSectionIds,
    onAskCodex: askCodex,
    onCreateComment: createComment,
    onDeleteComment: deleteComment,
    onLoadSection: loadDiffSection,
    onOpenFile: openFile,
    onSelectPathFromScroll: updateSelectedPathFromScroll,
    onSubmitComment: submitPullRequestComment,
    onToggleCollapsed: toggleCollapsed,
    onToggleViewed: toggleViewed,
    onUpdateComment: updateComment,
    searchQuery: diffSearchQuery,
    showWhitespace,
    source: state.source,
    viewed,
    wordWrap,
  };
  const renderWalkthroughDiffBlocks = (
    blocks: ReadonlyArray<ReviewDiffBlock>,
    blockScrollTarget: WalkthroughBlockScrollTarget | null,
    onActiveBlockChange: (blockId: string) => void,
  ) => {
    return (
      <div className="wt-stop wt-diff-surface">
        <ReviewCodeView
          {...commonReviewProps}
          blocks={blocks}
          bottomInset={walkthroughCodeViewBottomInset}
          commitMetadata={null}
          files={[]}
          forceExpandedPaths={diffSearchMatchPathSet}
          onActiveBlockChange={onActiveBlockChange}
          onSelectPathFromScroll={ignoreWalkthroughPathScroll}
          scrollTarget={blockScrollTarget}
          selectedPath={null}
          walkthroughNotes={emptyWalkthroughNotes}
        />
      </div>
    );
  };

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
        onClose={() => setCommandBarVisible(false)}
        visible={commandBarVisible}
      />
      <KeyboardShortcutsHelp keymap={codiffConfig.keymap} visible={shortcutsHelpVisible} />
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
          branchSource={historySource?.type === 'branch-diff' ? historySource : null}
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
          onModeChange={changeSidebarMode}
          onSearchQueryChange={
            sidebarMode === 'history' ? setHistorySearchQuery : setFileSearchQuery
          }
          onSelectPath={selectPath}
          onSelectSource={selectSource}
          onToggleCommitView={showPlainCommitView ? closeCommitView : openCommitView}
          pullRequestSource={historySource?.type === 'pull-request' ? historySource : null}
          reloadDeltaPaths={reloadDeltaPaths}
          searchQuery={sidebarMode === 'history' ? historySearchQuery : fileSearchQuery}
          selectedPath={visibleSelectedPath}
          showWhitespace={showWhitespace}
          viewed={viewed}
          walkthroughError={walkthroughError}
          walkthroughLoading={walkthroughLoading}
          walkthroughUnread={walkthroughUnread}
        />
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
            onUpdateMessage={updateWalkthroughCommitMessage}
          />
        ) : showNarrativeWalkthrough && narrativeWalkthrough ? (
          <NarrativeWalkthroughView
            files={state.files}
            navigation={narrativeNavigation}
            onActiveReviewTargetChange={updateActiveWalkthroughReviewTarget}
            onCommit={commitWalkthrough}
            onUpdateCommitMessage={updateWalkthroughCommitMessage}
            renderDiffBlocks={renderWalkthroughDiffBlocks}
            showWhitespace={showWhitespace}
            walkthrough={narrativeWalkthrough}
          />
        ) : showAgentUnavailablePanel ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <AgentUnavailablePanel
                agentLabel={agentLabelWithModel}
                onShowFiles={() => setSidebarMode('tree')}
                reason={walkthroughError?.reason}
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
