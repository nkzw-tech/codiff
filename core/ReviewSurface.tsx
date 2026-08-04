import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/ArrowSquareOut';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/ChatCircle';
import { ClockCounterClockwiseIcon as ClockCounterClockwise } from '@phosphor-icons/react/ClockCounterClockwise';
import { PathIcon as Path } from '@phosphor-icons/react/Path';
import { TreeStructureIcon as TreeStructure } from '@phosphor-icons/react/TreeStructure';
import type { FileDiffLoadedFiles } from '@pierre/diffs';
import { Trash2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { Button } from './app/components/Button.tsx';
import { CommandBar } from './app/components/CommandBar.tsx';
import { ReviewFileTree } from './app/components/FileTree.tsx';
import { KeyboardShortcutsHelp } from './app/components/KeyboardShortcutsHelp.tsx';
import {
  MergeRequestCommentsView,
  SidebarGeneralCommentList,
} from './app/components/merge-request/GeneralComments.tsx';
import {
  AgentUnavailablePanel,
  isTerminalPullRequestMergeState,
  CopyCommentsButton,
  DiffSearchPanel,
  isPullRequestReviewActionDisabled,
  PullRequestMergeControls,
  PullRequestMergeStatusBadge,
  PullRequestReviewButtons,
} from './app/components/Panels.tsx';
import {
  PullRequestSourceDescription,
  ReviewCodeView,
  type ReviewDiffBlock,
} from './app/components/ReviewCodeView.tsx';
import type { ReviewModeItem } from './app/components/ReviewModeControl.tsx';
import { ReviewTopBar } from './app/components/ReviewTopBar.tsx';
import { DiffLineCountBadge, HistorySidebar } from './app/components/Sidebar.tsx';
import {
  CommitView,
  type CommitHandler,
  type CommitMessageHandler,
  type CommitOutputSubscriber,
} from './app/components/walkthrough/CommitView.tsx';
import { NarrativeSidebar } from './app/components/walkthrough/NarrativeSidebar.tsx';
import {
  NarrativeWalkthroughView,
  type WalkthroughBlockScrollTarget,
  type WalkthroughReviewTarget,
} from './app/components/walkthrough/NarrativeWalkthroughView.tsx';
import { useNarrativeNavigation } from './app/components/walkthrough/useNarrativeNavigation.ts';
import { WalkthroughDiffSurface } from './app/components/walkthrough/WalkthroughDiffSurface.tsx';
import { WalkthroughProgress } from './app/components/walkthrough/WalkthroughProgress.tsx';
import { useAppKeyboardShortcuts } from './app/hooks/useAppKeyboardShortcuts.ts';
import { useDiffSearch } from './app/hooks/useDiffSearch.ts';
import {
  getCodeFontLineHeight,
  normalizeCodeFontSizePreference,
  useDocumentAppearance,
} from './app/hooks/useDocumentAppearance.ts';
import { useResizableSidebar } from './app/hooks/useResizableSidebar.ts';
import { useReviewCommentDrafts } from './app/hooks/useReviewCommentDrafts.ts';
import { useReviewFileState } from './app/hooks/useReviewState.ts';
import { createDefaultConfig } from './config/defaults.ts';
import { getShortcutLabel } from './config/keymap.ts';
import type { CodiffDiffStyle, CodiffKeymap } from './config/types.ts';
import { getAgentLabel } from './lib/app-constants.ts';
import type {
  CodeViewInstance,
  LocalReviewNote,
  ProviderCommentDraft,
  RenderedSubmittedReviewComment,
  ReviewComment,
  ReviewDraft,
  ReviewScrollTarget,
  ShareCommentDraft,
  WalkthroughError,
} from './lib/app-types.ts';
import type { Command } from './lib/command-registry.ts';
import {
  getDiffLineCount,
  getTotalDiffLineCount,
  isMarkdownFilePath,
  shouldPreloadSectionContentsForSearch,
} from './lib/diff.ts';
import { abbreviateHomePath, sortFiles } from './lib/files.ts';
import { isNativeInputTarget } from './lib/keyboard.ts';
import { isGeneratedWalkthroughFile } from './lib/narrative-walkthrough-diff.js';
import {
  buildReviewCommentsMarkdown,
  getPendingPullRequestReviewComments,
  getReviewCommentsFromState,
  isLocalReviewNote,
  isProviderCommentDraft,
  isReviewDraft,
  isShareCommentDraft,
  isSubmittedReviewComment,
  mergeReviewComments,
  toProviderCommentSubmission,
  toRenderedSubmittedReviewComment,
  toShareCommentSubmission,
} from './lib/review-comments.ts';
import { getSelectedPathFromScroll } from './lib/review-scroll.ts';
import {
  SIDEBAR_COLLAPSE_THRESHOLD,
  SIDEBAR_DEFAULT_WIDTH,
  readSidebarWidth,
  writeSidebarWidth,
} from './lib/sidebar-width.ts';
import {
  getEmptySourceDetail,
  getEmptySourceTitle,
  getSourceLabel,
  getSourceKey,
  supportsDiffSearchContentPreload,
} from './lib/source.ts';
import type {
  ChangedFile,
  DefinitionCandidate,
  DefinitionSearchRequest,
  DefinitionSearchResult,
  DiffImageContentRequest,
  DiffImageContentResult,
  DiffSection,
  GitIdentity,
  HistoryEntry,
  NarrativeWalkthrough,
  PullRequestMergeOptions,
  PullRequestGeneralComment,
  PullRequestGeneralCommentThread,
  PullRequestExistingReviewComment,
  PullRequestReviewEvent,
  ProviderCommentSubmission,
  ResolvedReviewSource,
  ReviewCommenting,
  ReviewSource,
  RepositoryState,
  ShareCommentSubmission,
  SharedWalkthroughSnapshot,
  SubmittedReviewComment,
  WalkthroughCommitMessageResult,
  WalkthroughCommitResult,
  WalkthroughGenerationProgress,
} from './types.ts';

export { ReadOnlyGeneralCommentCard } from './app/components/merge-request/GeneralComments.tsx';
export type { ReviewCommenting } from './types.ts';

const emptyReviewComments: ReadonlyArray<RenderedSubmittedReviewComment> = [];
const emptyReviewDrafts: ReadonlyArray<ReviewDraft> = [];
const emptyGeneralCommentThreads: ReadonlyArray<PullRequestGeneralCommentThread> = [];
const emptyPaths = new Set<string>();
const emptyWalkthroughNotes = new Map();
const reviewSurfacePreferencesKey = 'codiff:web-review-surface-preferences:v1';
const mobileSidebarMediaQuery = '(max-width: 720px)';
const getLocationHashTarget = () => {
  const hash = window.location.hash.slice(1);
  if (!hash) {
    return null;
  }
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
};
const commentMatchesHashTarget = (
  comment: { id: string; threadId?: string; url?: string },
  target: string,
) =>
  comment.id === target ||
  comment.threadId === target ||
  comment.url?.slice(comment.url.lastIndexOf('#') + 1) === target;
const agentUnavailableCodes = new Set<NonNullable<WalkthroughError['code']>>([
  'CODEX_NOT_FOUND',
  'CLAUDE_NOT_FOUND',
  'OPENCODE_NOT_FOUND',
  'PI_NOT_FOUND',
]);
const readSharedSidebarWidth = () =>
  typeof localStorage === 'undefined' ? SIDEBAR_DEFAULT_WIDTH : readSidebarWidth();

const writeSharedSidebarWidth = (width: number) => {
  if (typeof localStorage !== 'undefined') {
    writeSidebarWidth(width);
  }
};

const readStoredSidebarCollapsed = (): boolean | null => {
  if (typeof localStorage === 'undefined') {
    return null;
  }
  try {
    const stored = JSON.parse(localStorage.getItem(reviewSurfacePreferencesKey) ?? '{}') as unknown;
    if (
      stored &&
      typeof stored === 'object' &&
      'sidebarCollapsed' in stored &&
      typeof stored.sidebarCollapsed === 'boolean'
    ) {
      return stored.sidebarCollapsed;
    }
  } catch {
    // Ignore unavailable or invalid browser storage and use the viewport default.
  }
  return null;
};

const writeStoredSidebarCollapsed = (sidebarCollapsed: boolean) => {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(reviewSurfacePreferencesKey, JSON.stringify({ sidebarCollapsed }));
  } catch {
    // Ignore unavailable or full browser storage; the preference remains in memory.
  }
};

const shouldCollapseSidebarInitially = () =>
  readStoredSidebarCollapsed() ??
  (typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(mobileSidebarMediaQuery).matches);

export type ReviewWalkthroughStatus = 'failed' | 'generating' | 'idle' | 'ready';
export type ReviewMode = 'comments' | 'history' | 'tree' | 'walkthrough';
export type ReviewSurfaceCommandBridge = {
  copyPendingComments: () => string;
  getPersistenceState: () => { mode: ReviewMode; selectedPath: string | null };
  openDiffSearch: () => void;
};

export type ControlledReviewValue<Value> = Readonly<{
  onChange: (value: Value) => void;
  value: Value;
}>;

export type ControlledReviewDrafts<Draft extends ReviewDraft = ReviewDraft> = Readonly<{
  onChange: Dispatch<SetStateAction<ReadonlyArray<Draft>>>;
  value: ReadonlyArray<Draft>;
}>;

type ReviewDraftCapabilities<Draft extends ReviewDraft> = {
  canCreateInline?: boolean;
  drafts?: ControlledReviewDrafts<Draft>;
  onAsk?: (comment: Draft) => void;
};

export type LocalReviewNoteCapabilities = ReviewDraftCapabilities<LocalReviewNote>;

export type CommentDestination = 'provider' | 'share';
export type CommentAnchorPolicy = 'provider-target' | 'share-snapshot';
export type ProviderReviewOutcome = 'approve' | 'comment' | 'request-changes';

export type SubmitProviderReviewRequest = {
  comments: ReadonlyArray<ProviderCommentSubmission>;
  outcome: ProviderReviewOutcome;
  summary?: string;
};

export type ProviderReviewSessionCapabilities = {
  drafts: ControlledReviewDrafts<ProviderCommentDraft>;
  submit: (request: SubmitProviderReviewRequest) => Promise<void>;
};

type ReviewCommentDraftForDestination<Destination extends CommentDestination> =
  Destination extends 'share' ? ShareCommentDraft : ProviderCommentDraft;

type ReviewCommentSubmission<Destination extends CommentDestination> = Destination extends 'share'
  ? ShareCommentSubmission
  : ProviderCommentSubmission;

type CommonReviewCommentCapabilities<Destination extends CommentDestination> = {
  authoring: ReviewDraftCapabilities<ReviewCommentDraftForDestination<Destination>>;
  destination: Destination;
  general?: {
    onCreate?: (body: string) => Promise<void>;
    onDelete?: (commentId: string) => Promise<void>;
    onReply?: (threadId: string, body: string) => Promise<void>;
    onResolve?: (threadId: string, resolved: boolean) => Promise<void>;
    onUpdate?: (commentId: string, body: string) => Promise<void>;
  };
  inline: {
    onDelete?: (commentId: string) => Promise<void>;
    onResolve?: (threadId: string, resolved: boolean) => Promise<void>;
    onSubmit?: (comment: ReviewCommentSubmission<Destination>) => Promise<SubmittedReviewComment>;
    onUpdate?: (commentId: string, body: string) => Promise<void>;
  };
  onSignIn?: () => Promise<void> | void;
};

export type ShareReviewCommentCapabilities = CommonReviewCommentCapabilities<'share'>;

export type ProviderReviewCommentCapabilities = CommonReviewCommentCapabilities<'provider'> & {
  reviewSession?: ProviderReviewSessionCapabilities;
};

export type ReviewCommentCapabilities =
  | ProviderReviewCommentCapabilities
  | ShareReviewCommentCapabilities;

export type ReviewContentCapabilities = {
  forceExpandedPaths?: ReadonlySet<string>;
  initialScrollTarget?: ReviewScrollTarget | null;
  itemVersionByKey?: Readonly<Record<string, number>>;
  loadingSectionIds?: ReadonlySet<string>;
  onLoadImageContent?: (request: DiffImageContentRequest) => Promise<DiffImageContentResult>;
  onLoadSection?: (file: ChangedFile, section: DiffSection) => Promise<void> | void;
  onRefreshMarkdown?: (file: ChangedFile, section: DiffSection) => Promise<boolean>;
  resolveSectionContents?: (
    file: ChangedFile,
    section: DiffSection,
  ) => Promise<FileDiffLoadedFiles>;
};

export type ReviewDesktopCapabilities = {
  beforeContent?: ReactNode;
  collapsed?: ReadonlySet<string>;
  commands?: ReadonlyArray<Command>;
  commit?: ComponentProps<typeof CommitView> & {
    onToggle: () => void;
    open: boolean;
  };
  disableCodeViewWorkerPool?: boolean;
  isSwitchingSource?: boolean;
  isWindowFullscreen?: boolean;
  onActiveWalkthroughReviewTargetChange?: (target: WalkthroughReviewTarget | null) => void;
  onCollapsedChange?: (collapsed: Set<string>) => void;
  onFindDefinitions?: (request: DefinitionSearchRequest) => Promise<DefinitionSearchResult>;
  onOpenDefinition?: (candidate: DefinitionCandidate) => void;
  onOpenFile?: (file: ChangedFile) => void;
  onOpenSelectedFile?: () => void;
  onViewedChange?: (viewed: Record<string, string>) => void;
  reloadDeltaPaths?: ReadonlySet<string>;
  sidebarFooter?: ReactNode;
  sourceMenu?: ReactNode;
  viewed?: Readonly<Record<string, string>>;
};

export type ReviewHistoryModel = {
  branchSource?: Extract<ReviewSource, { type: 'branch-diff' }> | null;
  currentSource: ResolvedReviewSource | ReviewSource;
  entries: ReadonlyArray<HistoryEntry>;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onSelectSource: (source: ReviewSource) => void;
  pullRequestSource?: Extract<ReviewSource, { type: 'pull-request' }> | null;
};

export type ControlledReviewPreferences = {
  diffLayout?: ControlledReviewValue<CodiffDiffStyle>;
  outdatedVisibility?: ControlledReviewValue<boolean>;
  pendingCommentPrefix?: ControlledReviewValue<string>;
  selectedPath?: ControlledReviewValue<string | null>;
  wordWrap?: ControlledReviewValue<boolean>;
};

export type ReviewSourceNavigation = {
  onCancelAutoMerge?: () => Promise<void> | void;
  onClosePullRequest?: () => Promise<void> | void;
  onMarkPullRequestReady?: () => Promise<void> | void;
  onMergePullRequest?: (
    options: PullRequestMergeOptions & { autoMerge: boolean },
  ) => Promise<void> | void;
  onUpdateDescription?: (body: string) => Promise<void> | void;
  onUpdateTitle?: (title: string) => Promise<void> | void;
  onUploadDescriptionAsset?: (file: File) => Promise<string> | string;
};

export type ReviewWalkthroughCapabilities = {
  commit?: CommitHandler;
  commitOutput?: CommitOutputSubscriber;
  error?: Pick<WalkthroughError, 'code' | 'reason'> | null;
  generationProgress?: WalkthroughGenerationProgress | null;
  onGenerate?: () => Promise<void> | void;
  onShare?: () => Promise<void> | void;
  progress?: ReactNode;
  status?: ReviewWalkthroughStatus;
  unread?: boolean;
  updateCommitMessage?: CommitMessageHandler;
};

type ReviewAnnotationCapabilities =
  | {
      comments?: never;
      localReviewNotes: LocalReviewNoteCapabilities;
    }
  | {
      comments: ReviewCommentCapabilities;
      localReviewNotes?: never;
    }
  | {
      comments?: never;
      localReviewNotes?: never;
    };

export type ReviewSurfaceCapabilities = ReviewAnnotationCapabilities & {
  content?: ReviewContentCapabilities;
  desktop?: ReviewDesktopCapabilities;
  history?: ReviewHistoryModel;
  preferences?: ControlledReviewPreferences;
  sourceNavigation?: ReviewSourceNavigation;
  walkthrough?: ReviewWalkthroughCapabilities;
};

export const buildSharedReviewSnapshot = ({
  preferences,
  state,
  title,
  walkthrough,
}: {
  preferences: SharedWalkthroughSnapshot['preferences'];
  state: RepositoryState;
  title: string;
  walkthrough: NarrativeWalkthrough;
}): SharedWalkthroughSnapshot => ({
  branch: state.branch,
  codeQualityFindings: state.codeQualityFindings,
  codiffVersion: 'desktop',
  commitMetadata: state.commitMetadata,
  exportedAt: new Date(state.generatedAt).toISOString(),
  files: state.files,
  kind: 'codiff-walkthrough-share',
  preferences,
  repository: {
    generalComments: state.generalComments,
    root: state.root,
    source: state.source,
    title,
  },
  reviewComments: state.reviewComments,
  version: 1,
  walkthrough,
});

const getSnapshotReviewComments = (
  snapshot: SharedWalkthroughSnapshot,
  destination: CommentDestination,
): ReadonlyArray<RenderedSubmittedReviewComment> => {
  if (!snapshot.reviewComments?.length) {
    return emptyReviewComments;
  }

  return getReviewCommentsFromState(
    {
      branch: snapshot.branch,
      files: snapshot.files,
      generatedAt: Date.parse(snapshot.exportedAt) || Date.now(),
      launchPath: snapshot.repository.root,
      reviewComments: snapshot.reviewComments as ReadonlyArray<PullRequestExistingReviewComment>,
      root: snapshot.repository.root,
      source: snapshot.repository.source,
    } satisfies RepositoryState,
    destination,
  );
};

const noop = () => {};

const toProviderReviewOutcome = (event: PullRequestReviewEvent): ProviderReviewOutcome => {
  switch (event) {
    case 'APPROVE':
      return 'approve';
    case 'COMMENT':
      return 'comment';
    case 'REQUEST_CHANGES':
      return 'request-changes';
  }
};

const disabledCommit = async (): Promise<WalkthroughCommitResult> => ({
  reason: 'Shared walkthroughs are read-only.',
  status: 'failed',
});

const disabledCommitMessage = async (): Promise<WalkthroughCommitMessageResult> => ({
  reason: 'Shared walkthroughs are read-only.',
  status: 'unavailable',
});

type ReviewSurfaceBaseProps = {
  capabilities?: ReviewSurfaceCapabilities;
  externalUrl?: string;
  gitIdentity?: GitIdentity | null;
  keymap?: CodiffKeymap;
  onCommandBridgeChange?: (bridge: ReviewSurfaceCommandBridge | null) => void;
  onDeleteShare?: () => Promise<void> | void;
  providerLabel?: string;
  repositoryUrl?: string;
  settingsBar?: ReactNode;
  sidebarPosition?: 'left' | 'right';
  signInLabel?: string;
  snapshot: SharedWalkthroughSnapshot;
  sourceDescriptionFooterAside?: ReactNode;
  title?: string;
};

type ControlledReviewSurfaceProps = ReviewSurfaceBaseProps & {
  activeMode: ControlledReviewValue<ReviewMode>;
  initialMode?: never;
};

type UncontrolledReviewSurfaceProps = ReviewSurfaceBaseProps & {
  activeMode?: never;
  initialMode?: ReviewMode;
};

export type ReviewSurfaceProps = ControlledReviewSurfaceProps | UncontrolledReviewSurfaceProps;

export function ReviewSurface({
  activeMode,
  capabilities,
  externalUrl,
  gitIdentity = null,
  initialMode,
  keymap: keymapProp,
  onCommandBridgeChange,
  onDeleteShare,
  providerLabel = 'provider',
  repositoryUrl,
  settingsBar,
  sidebarPosition = 'left',
  signInLabel = 'Sign in to comment',
  snapshot,
  sourceDescriptionFooterAside,
  title,
}: ReviewSurfaceProps) {
  const content = capabilities?.content;
  const desktop = capabilities?.desktop;
  const history = capabilities?.history;
  const localReviewNotes = capabilities?.localReviewNotes;
  const comments = capabilities?.comments;
  const providerComments = comments?.destination === 'provider' ? comments : undefined;
  const shareComments = comments?.destination === 'share' ? comments : undefined;
  const controlledPreferences = capabilities?.preferences;
  const sourceNavigation = capabilities?.sourceNavigation;
  const walkthrough = capabilities?.walkthrough;
  const reviewSession = providerComments?.reviewSession;
  const canComment =
    localReviewNotes?.canCreateInline ??
    comments?.authoring.canCreateInline ??
    comments?.inline.onSubmit != null;
  const reviewDrafts = localReviewNotes ?? comments?.authoring;
  const copyPendingCommentsLabel = localReviewNotes
    ? 'Copy Review Notes'
    : 'Copy Pending Review Comments';
  const pendingCommentPrefix =
    controlledPreferences?.pendingCommentPrefix?.value ??
    (localReviewNotes
      ? '# Address these Review Notes'
      : comments
        ? '# Address these Pending Review Comments'
        : undefined);
  const commenting = useMemo<ReviewCommenting | undefined>(
    () =>
      comments
        ? {
            canComment,
            onDeleteComment: comments.inline.onDelete,
            onDeleteGeneralComment: comments.general?.onDelete,
            onReplyGeneralComment: comments.general?.onReply,
            onResolveDiscussion: comments.general?.onResolve ?? comments.inline.onResolve,
            onSignIn: comments.onSignIn,
            onSubmitGeneralComment: comments.general?.onCreate,
            onUpdateComment: comments.inline.onUpdate,
            onUpdateGeneralComment: comments.general?.onUpdate,
          }
        : undefined,
    [canComment, comments],
  );
  const deleteShare = useCallback(async () => {
    if (
      !onDeleteShare ||
      !window.confirm('Delete this shared walkthrough? This cannot be undone.')
    ) {
      return;
    }
    try {
      await onDeleteShare();
    } catch (error: unknown) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }, [onDeleteShare]);
  const submitReviewComment = comments?.inline.onSubmit;
  const submitGeneralDiscussion = comments?.general?.onCreate;
  const updateReviewComment = comments?.inline.onUpdate;
  const updateGeneralDiscussion = comments?.general?.onUpdate;
  const resolveDiscussion = comments?.inline.onResolve;
  const sharedWalkthrough = useMemo(
    () =>
      walkthrough?.commit
        ? snapshot.walkthrough
        : {
            ...snapshot.walkthrough,
            commit: undefined,
          },
    [snapshot.walkthrough, walkthrough?.commit],
  );
  const navigation = useNarrativeNavigation(
    sharedWalkthrough,
    snapshot.files,
    `${snapshot.repository.root}:${getSourceKey(snapshot.repository.source)}`,
  );
  const defaultKeymap = useMemo(() => createDefaultConfig().keymap, []);
  const keymap = keymapProp ?? defaultKeymap;
  const [uncontrolledWordWrap, setUncontrolledWordWrap] = useState(snapshot.preferences.wordWrap);
  const wordWrap = controlledPreferences?.wordWrap?.value ?? uncontrolledWordWrap;
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [uncontrolledSidebarMode, setUncontrolledSidebarMode] = useState<ReviewMode>(
    () => initialMode ?? (desktop ? 'tree' : 'walkthrough'),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean | null>(null);
  const sidebarCollapsedRef = useRef<boolean | null>(null);
  const sidebarInteractedRef = useRef(false);
  const updateSidebarCollapsed = useCallback((value: boolean, persist: boolean) => {
    sidebarCollapsedRef.current = value;
    setSidebarCollapsed(value);
    if (persist) {
      writeStoredSidebarCollapsed(value);
    }
  }, []);
  const toggleSidebar = useCallback(() => {
    sidebarInteractedRef.current = true;
    updateSidebarCollapsed(
      !(sidebarCollapsedRef.current ?? shouldCollapseSidebarInitially()),
      true,
    );
  }, [updateSidebarCollapsed]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (!sidebarInteractedRef.current) {
        updateSidebarCollapsed(shouldCollapseSidebarInitially(), false);
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [updateSidebarCollapsed]);
  const sidebarMode = activeMode?.value ?? uncontrolledSidebarMode;
  const [treeScrollTarget, setTreeScrollTarget] = useState<ReviewScrollTarget | null>(
    () => content?.initialScrollTarget ?? null,
  );
  const {
    bumpItemVersion,
    collapsed,
    expandedGenerated,
    itemVersionByKey: uncontrolledItemVersionByKey,
    selectedPath: uncontrolledSelectedPath,
    setSelectedPath: setUncontrolledSelectedPath,
    toggleCollapsed,
    toggleViewed,
    viewed,
  } = useReviewFileState({
    collapsed: desktop?.collapsed,
    initialSelectedPath:
      controlledPreferences?.selectedPath?.value ?? snapshot.files[0]?.path ?? null,
    onCollapsedChange: desktop?.onCollapsedChange,
    onViewedChange: desktop?.onViewedChange,
    viewed: desktop?.viewed,
  });
  const itemVersionByKey = content?.itemVersionByKey ?? uncontrolledItemVersionByKey;
  const selectedPath = controlledPreferences?.selectedPath?.value ?? uncontrolledSelectedPath;
  const { resizeSidebar, sidebarWidth } = useResizableSidebar({
    collapseThreshold: SIDEBAR_COLLAPSE_THRESHOLD,
    onCollapse: () => {
      sidebarInteractedRef.current = true;
      updateSidebarCollapsed(true, true);
    },
    onWidthCommit: writeSharedSidebarWidth,
    position: sidebarPosition,
    readWidth: readSharedSidebarWidth,
  });
  const snapshotReviewComments = useMemo(
    () => getSnapshotReviewComments(snapshot, comments?.destination ?? 'provider'),
    [comments?.destination, snapshot],
  );
  const reviewCommentScopeKey = `${snapshot.repository.root}:${getSourceKey(snapshot.repository.source)}`;
  const showOutdated = controlledPreferences?.outdatedVisibility?.value ?? true;
  const [submittedReviewCommentState, setSubmittedReviewCommentState] = useState<{
    comments: ReadonlyArray<RenderedSubmittedReviewComment>;
    scopeKey: string;
  }>(() => ({ comments: [], scopeKey: reviewCommentScopeKey }));
  const submittedReviewComments = useMemo(
    () =>
      submittedReviewCommentState.scopeKey === reviewCommentScopeKey
        ? submittedReviewCommentState.comments
        : [],
    [reviewCommentScopeKey, submittedReviewCommentState],
  );
  const setSubmittedReviewComments = useCallback<
    Dispatch<SetStateAction<ReadonlyArray<RenderedSubmittedReviewComment>>>
  >(
    (update) => {
      setSubmittedReviewCommentState((current) => {
        const scopedCurrent = current.scopeKey === reviewCommentScopeKey ? current.comments : [];
        return {
          comments: typeof update === 'function' ? update(scopedCurrent) : update,
          scopeKey: reviewCommentScopeKey,
        };
      });
    },
    [reviewCommentScopeKey],
  );
  const [editedReviewCommentBodyState, setEditedReviewCommentBodyState] = useState<{
    bodies: Readonly<Record<string, string>>;
    scopeKey: string;
  }>(() => ({ bodies: {}, scopeKey: reviewCommentScopeKey }));
  const editedReviewCommentBodies = useMemo(
    () =>
      editedReviewCommentBodyState.scopeKey === reviewCommentScopeKey
        ? editedReviewCommentBodyState.bodies
        : {},
    [editedReviewCommentBodyState, reviewCommentScopeKey],
  );
  const setEditedReviewCommentBodies = useCallback<
    Dispatch<SetStateAction<Readonly<Record<string, string>>>>
  >(
    (update) => {
      setEditedReviewCommentBodyState((current) => {
        const scopedCurrent = current.scopeKey === reviewCommentScopeKey ? current.bodies : {};
        return {
          bodies: typeof update === 'function' ? update(scopedCurrent) : update,
          scopeKey: reviewCommentScopeKey,
        };
      });
    },
    [reviewCommentScopeKey],
  );
  const visibleSnapshotReviewComments = useMemo(() => {
    const snapshotIds = new Set(snapshotReviewComments.map((comment) => comment.id));
    return [
      ...snapshotReviewComments,
      ...submittedReviewComments.filter((comment) => !snapshotIds.has(comment.id)),
    ]
      .filter((comment) => showOutdated || !comment.isOutdated)
      .map((comment) => ({
        ...comment,
        ...(editedReviewCommentBodies[comment.id] != null &&
        editedReviewCommentBodies[comment.id] !== comment.body
          ? { body: editedReviewCommentBodies[comment.id] }
          : {}),
        canDelete: comment.canDelete === true && comments?.inline.onDelete != null,
        canEdit: comment.canEdit === true && comments?.inline.onUpdate != null,
        canReplyThread: comment.canReplyThread !== false && comments?.inline.onSubmit != null,
        canResolveThread: comment.canResolveThread === true && comments?.inline.onResolve != null,
      }));
  }, [
    comments,
    editedReviewCommentBodies,
    showOutdated,
    snapshotReviewComments,
    submittedReviewComments,
  ]);
  const [uncontrolledLocalReviewComments, setUncontrolledLocalReviewComments] =
    useState<ReadonlyArray<ReviewDraft>>(emptyReviewDrafts);
  const uncontrolledLocalReviewCommentsRef = useRef(uncontrolledLocalReviewComments);
  const providerControlledDrafts = reviewSession?.drafts ?? providerComments?.authoring.drafts;
  const localReviewComments: ReadonlyArray<ReviewDraft> =
    localReviewNotes?.drafts?.value ??
    shareComments?.authoring.drafts?.value ??
    providerControlledDrafts?.value ??
    uncontrolledLocalReviewComments;
  const setLocalReviewComments = useCallback<
    Dispatch<SetStateAction<ReadonlyArray<ReviewComment>>>
  >(
    (update) => {
      if (localReviewNotes?.drafts) {
        localReviewNotes.drafts.onChange((current) => {
          const next = typeof update === 'function' ? update(current) : update;
          return next.filter(isLocalReviewNote);
        });
        return;
      }
      if (shareComments?.authoring.drafts) {
        shareComments.authoring.drafts.onChange((current) => {
          const next = typeof update === 'function' ? update(current) : update;
          return next.filter(isShareCommentDraft);
        });
        return;
      }
      if (providerControlledDrafts) {
        providerControlledDrafts.onChange((current) => {
          const next = typeof update === 'function' ? update(current) : update;
          return next.filter(isProviderCommentDraft);
        });
        return;
      }
      const nextComments =
        typeof update === 'function' ? update(uncontrolledLocalReviewCommentsRef.current) : update;
      const nextDrafts = nextComments.filter(isReviewDraft);
      uncontrolledLocalReviewCommentsRef.current = nextDrafts;
      setUncontrolledLocalReviewComments(nextDrafts);
    },
    [localReviewNotes, providerControlledDrafts, shareComments],
  );
  const reviewComments = useMemo(
    () => mergeReviewComments(visibleSnapshotReviewComments, localReviewComments),
    [localReviewComments, visibleSnapshotReviewComments],
  );
  const {
    activeReviewCommentDraftRef,
    activeReviewCommentDraftState,
    clearCommentFocus,
    createComment,
    deleteComment: deleteLocalComment,
    focusComment,
    focusCommentId,
    focusCommentRequest,
    reviewCommentsRef,
    updateActiveReviewCommentDraft,
    updateComment,
  } = useReviewCommentDrafts({
    canCreateComment: canComment,
    comments: reviewComments,
    draftKind: localReviewNotes ? 'local-note' : shareComments ? 'share-draft' : 'provider-draft',
    onCommentFileChange: bumpItemVersion,
    setComments: setLocalReviewComments,
  });
  const generalCommentThreads = snapshot.repository.generalComments ?? emptyGeneralCommentThreads;
  const generalComments = useMemo(
    () =>
      (snapshot.repository.generalComments ?? emptyGeneralCommentThreads).flatMap(
        (thread) => thread.comments,
      ),
    [snapshot.repository.generalComments],
  );
  const generalCommentCount = generalComments.length;
  const showCommentsTab =
    comments != null || generalCommentCount > 0 || visibleSnapshotReviewComments.length > 0;
  const [generalCommentDraft, setGeneralCommentDraft] = useState('');
  const [generalCommentEditDraft, setGeneralCommentEditDraft] = useState('');
  const [editingGeneralCommentId, setEditingGeneralCommentId] = useState<string | null>(null);
  const [generalCommentEditError, setGeneralCommentEditError] = useState<string | null>(null);
  const [generalCommentEditSubmitting, setGeneralCommentEditSubmitting] = useState(false);
  const [generalCommentError, setGeneralCommentError] = useState<string | null>(null);
  const [focusedGeneralCommentId, setFocusedGeneralCommentId] = useState<string | null>(null);
  const handledHashTargetRef = useRef<string | null>(null);
  const [generalCommentScrollRequest, setGeneralCommentScrollRequest] = useState(0);
  const [generalCommentSubmitting, setGeneralCommentSubmitting] = useState(false);
  const [pullRequestReviewSubmitting, setPullRequestReviewSubmitting] =
    useState<PullRequestReviewEvent | null>(null);
  const [pullRequestCloseSubmitting, setPullRequestCloseSubmitting] = useState(false);
  const [pullRequestReadySubmitting, setPullRequestReadySubmitting] = useState(false);
  const [pullRequestMergeSubmitting, setPullRequestMergeSubmitting] = useState(false);
  const [walkthroughRequestPending, setWalkthroughRequestPending] = useState(false);
  const walkthroughRequestPendingRef = useRef(false);
  const [walkthroughRequestId, setWalkthroughRequestId] = useState(0);
  const walkthroughRef = useRef(walkthrough);

  const orderedFiles = useMemo(() => sortFiles(snapshot.files), [snapshot.files]);
  const {
    activeMatch: activeDiffSearchMatch,
    activeMatchIndex: activeDiffSearchMatchIndex,
    closeSearch: closeDiffSearch,
    fileFilteredFiles,
    focusRequest: diffSearchFocusRequest,
    matches: diffSearchMatches,
    matchPathSet: diffSearchMatchPathSet,
    moveMatch: moveDiffSearchMatch,
    openSearch: openDiffSearch,
    query: diffSearchQuery,
    updateQuery: updateDiffSearchQuery,
    visible: diffSearchVisible,
    visibleFiles,
  } = useDiffSearch({
    files: orderedFiles,
    fileSearchQuery,
    showWhitespace: snapshot.preferences.showWhitespace,
  });
  useEffect(() => {
    if (
      !content?.onLoadSection ||
      !supportsDiffSearchContentPreload(snapshot.repository.source) ||
      !diffSearchQuery.trim()
    ) {
      return;
    }

    const requests = fileFilteredFiles.flatMap((file) =>
      file.sections
        .filter(shouldPreloadSectionContentsForSearch)
        .map((section) => ({ file, section })),
    );
    if (requests.length === 0) {
      return;
    }

    let canceled = false;
    let cursor = 0;
    const loadNext = async () => {
      while (!canceled) {
        const request = requests[cursor];
        cursor += 1;
        if (!request) {
          return;
        }
        await content.onLoadSection!(request.file, request.section);
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, requests.length) }, () => loadNext()));
    return () => {
      canceled = true;
    };
  }, [content, diffSearchQuery, fileFilteredFiles, snapshot.repository.source]);
  const forceExpandedPaths = useMemo(
    () => new Set([...diffSearchMatchPathSet, ...(content?.forceExpandedPaths ?? emptyPaths)]),
    [content?.forceExpandedPaths, diffSearchMatchPathSet],
  );
  const totalLineCount = useMemo(
    () =>
      getTotalDiffLineCount(
        visibleFiles.map((file) => getDiffLineCount(file, snapshot.preferences.showWhitespace)),
      ),
    [snapshot.preferences.showWhitespace, visibleFiles],
  );
  const showTotalLineCount =
    sidebarMode !== 'comments' && sidebarMode !== 'history' && totalLineCount.countable;
  const visibleSelectedPath =
    selectedPath && visibleFiles.some((file) => file.path === selectedPath)
      ? selectedPath
      : (visibleFiles[0]?.path ?? null);
  const initialMarkdownPreviewSectionIds = useMemo(() => {
    const nonGeneratedFiles = snapshot.files.filter((file) => !isGeneratedWalkthroughFile(file));
    if (
      nonGeneratedFiles.length === 0 ||
      !nonGeneratedFiles.every((file) => isMarkdownFilePath(file.path))
    ) {
      return emptyPaths;
    }

    return new Set(
      snapshot.files
        .filter((file) => isMarkdownFilePath(file.path))
        .flatMap((file) => file.sections.map((section) => section.id)),
    );
  }, [snapshot.files]);

  useDocumentAppearance({
    codeFontFamily: snapshot.preferences.codeFontFamily,
    codeFontSize: snapshot.preferences.codeFontSize,
    theme: snapshot.preferences.theme,
  });

  const changeSidebarMode = useCallback(
    (mode: ReviewMode) => {
      if (activeMode) {
        activeMode.onChange(mode);
      } else {
        setUncontrolledSidebarMode(mode);
      }
    },
    [activeMode],
  );
  const askReviewAssistant = useCallback(
    (comment: ReviewComment) => {
      if (isLocalReviewNote(comment)) {
        localReviewNotes?.onAsk?.(comment);
      } else if (isProviderCommentDraft(comment)) {
        providerComments?.authoring.onAsk?.(comment);
      } else if (isShareCommentDraft(comment)) {
        shareComments?.authoring.onAsk?.(comment);
      }
    },
    [localReviewNotes, providerComments, shareComments],
  );

  const activateGeneralComment = useCallback(
    (commentId: string) => {
      changeSidebarMode('comments');
      setFocusedGeneralCommentId(commentId);
      setGeneralCommentScrollRequest((current) => current + 1);
    },
    [changeSidebarMode],
  );
  const activateReviewComment = useCallback(
    (comment: ReviewComment) => {
      changeSidebarMode('tree');
      setUncontrolledSelectedPath(comment.filePath);
      controlledPreferences?.selectedPath?.onChange(comment.filePath);
      focusComment(comment.id);
      setTreeScrollTarget((current) => ({
        behavior: 'smooth',
        commentId: comment.id,
        path: comment.filePath,
        request: (current?.request ?? 0) + 1,
      }));
    },
    [
      changeSidebarMode,
      controlledPreferences?.selectedPath,
      focusComment,
      setUncontrolledSelectedPath,
    ],
  );
  const activateHashTarget = useCallback(() => {
    const target = getLocationHashTarget();
    if (!target || handledHashTargetRef.current === target) {
      return;
    }

    const reviewComment = reviewComments.find((comment) =>
      commentMatchesHashTarget(comment, target),
    );
    if (reviewComment) {
      handledHashTargetRef.current = target;
      activateReviewComment(reviewComment);
      return;
    }

    for (const thread of generalCommentThreads) {
      const generalComment =
        thread.comments.find((comment) => commentMatchesHashTarget(comment, target)) ??
        (thread.id === target ? thread.comments[0] : undefined);
      if (generalComment) {
        handledHashTargetRef.current = target;
        activateGeneralComment(generalComment.id);
        return;
      }
    }
  }, [activateGeneralComment, activateReviewComment, generalCommentThreads, reviewComments]);
  useEffect(() => {
    const timeout = window.setTimeout(activateHashTarget, 0);
    return () => window.clearTimeout(timeout);
  }, [activateHashTarget]);
  useEffect(() => {
    const handleHashChange = () => {
      handledHashTargetRef.current = null;
      activateHashTarget();
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [activateHashTarget]);
  const navigateGeneralComment = useCallback(
    (direction: 1 | -1) => {
      if (generalComments.length === 0) {
        return;
      }

      const currentIndex = focusedGeneralCommentId
        ? generalComments.findIndex((comment) => comment.id === focusedGeneralCommentId)
        : -1;
      const nextIndex =
        currentIndex === -1
          ? direction > 0
            ? 0
            : generalComments.length - 1
          : Math.min(generalComments.length - 1, Math.max(0, currentIndex + direction));
      const nextComment = generalComments[nextIndex];

      if (nextComment) {
        activateGeneralComment(nextComment.id);
      }
    },
    [activateGeneralComment, focusedGeneralCommentId, generalComments],
  );
  const updateExistingReviewComment = useCallback(
    async (commentId: string, body: string) => {
      if (!updateReviewComment) {
        return;
      }
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      await updateReviewComment(commentId, body);
      setEditedReviewCommentBodies((current) => ({ ...current, [commentId]: body }));
      if (comment) {
        bumpItemVersion(comment.filePath);
      }
    },
    [bumpItemVersion, reviewCommentsRef, setEditedReviewCommentBodies, updateReviewComment],
  );
  const deleteComment = useCallback(
    (commentId: string) => {
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (
        comment &&
        isSubmittedReviewComment(comment) &&
        comment.canDelete &&
        comments?.inline.onDelete
      ) {
        updateActiveReviewCommentDraft(null);
        setSubmittedReviewComments((current) =>
          current.filter((candidate) => candidate.id !== commentId),
        );
        void comments.inline.onDelete(commentId).catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : String(error));
        });
        return;
      }
      deleteLocalComment(commentId);
    },
    [
      comments,
      deleteLocalComment,
      reviewCommentsRef,
      setSubmittedReviewComments,
      updateActiveReviewCommentDraft,
    ],
  );
  const submitComment = useCallback(
    (commentId: string) => {
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      const isPersistedDraft =
        comment != null && (isProviderCommentDraft(comment) || isShareCommentDraft(comment));
      if (
        !comments?.inline.onSubmit ||
        !comment ||
        !isPersistedDraft ||
        !comment.body.trim() ||
        comment.remoteSubmit?.status === 'submitting'
      ) {
        return;
      }

      updateActiveReviewCommentDraft(null);
      setLocalReviewComments((current) =>
        current.map((candidate) =>
          candidate.id === commentId &&
          (isProviderCommentDraft(candidate) || isShareCommentDraft(candidate))
            ? { ...candidate, remoteSubmit: { status: 'submitting' as const } }
            : candidate,
        ),
      );

      let submission: Promise<SubmittedReviewComment>;
      try {
        if (comments.destination === 'share' && isShareCommentDraft(comment)) {
          submission = comments.inline.onSubmit(toShareCommentSubmission(comment));
        } else if (comments.destination === 'provider' && isProviderCommentDraft(comment)) {
          submission = comments.inline.onSubmit(toProviderCommentSubmission(comment));
        } else {
          return;
        }
      } catch (error: unknown) {
        setLocalReviewComments((current) =>
          current.map((candidate) =>
            candidate.id === commentId &&
            (isProviderCommentDraft(candidate) || isShareCommentDraft(candidate))
              ? {
                  ...candidate,
                  remoteSubmit: {
                    error: error instanceof Error ? error.message : String(error),
                    status: 'error' as const,
                  },
                }
              : candidate,
          ),
        );
        return;
      }

      void submission
        .then((submittedComment) => {
          clearCommentFocus(commentId);
          const submitted = toRenderedSubmittedReviewComment(submittedComment, comment);
          setLocalReviewComments((current) =>
            current.filter((candidate) => candidate.id !== commentId),
          );
          setSubmittedReviewComments((current) => [
            ...current.filter((candidate) => candidate.id !== submitted.id),
            submitted,
          ]);
          bumpItemVersion(comment.filePath);
        })
        .catch((error: unknown) => {
          setLocalReviewComments((current) =>
            current.map((candidate) =>
              candidate.id === commentId &&
              (isProviderCommentDraft(candidate) || isShareCommentDraft(candidate))
                ? {
                    ...candidate,
                    remoteSubmit: {
                      error: error instanceof Error ? error.message : String(error),
                      status: 'error' as const,
                    },
                  }
                : candidate,
            ),
          );
          bumpItemVersion(comment.filePath);
        });
    },
    [
      bumpItemVersion,
      clearCommentFocus,
      comments,
      reviewCommentsRef,
      setLocalReviewComments,
      setSubmittedReviewComments,
      updateActiveReviewCommentDraft,
    ],
  );
  const submitReview = useCallback(
    (event: PullRequestReviewEvent, body?: string): Promise<void> | void => {
      const source = snapshot.repository.source;
      if (
        !reviewSession ||
        pullRequestReviewSubmitting ||
        (source.type === 'pull-request' &&
          isPullRequestReviewActionDisabled(source.reviewStatus, event))
      ) {
        return;
      }

      const pendingComments = getPendingPullRequestReviewComments(
        reviewCommentsRef.current.filter(isProviderCommentDraft),
        activeReviewCommentDraftRef.current,
      );
      if (event === 'COMMENT' && pendingComments.length === 0 && !body?.trim()) {
        return;
      }
      const pendingIds = new Set(pendingComments.map((comment) => comment.id));
      setPullRequestReviewSubmitting(event);
      const formattedComments = pendingComments.map((comment) =>
        toProviderCommentSubmission(comment),
      );
      const submission = reviewSession.submit({
        comments: formattedComments,
        outcome: toProviderReviewOutcome(event),
        ...(body?.trim() ? { summary: body } : {}),
      });
      return submission
        .then(() => {
          updateActiveReviewCommentDraft(null);
          setLocalReviewComments((current) =>
            current.filter((comment) => !pendingIds.has(comment.id)),
          );
        })
        .catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : String(error));
          throw error;
        })
        .finally(() => setPullRequestReviewSubmitting(null));
    },
    [
      reviewSession,
      pullRequestReviewSubmitting,
      snapshot.repository.source,
      activeReviewCommentDraftRef,
      reviewCommentsRef,
      setLocalReviewComments,
      updateActiveReviewCommentDraft,
    ],
  );
  const closePullRequest = useCallback(() => {
    const source = snapshot.repository.source;
    if (
      !sourceNavigation?.onClosePullRequest ||
      pullRequestCloseSubmitting ||
      source.type !== 'pull-request' ||
      source.reviewStatus?.close?.disabled === true ||
      !source.reviewStatus?.close
    ) {
      return;
    }

    setPullRequestCloseSubmitting(true);
    void Promise.resolve(sourceNavigation.onClosePullRequest())
      .catch((error: unknown) => {
        window.alert(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setPullRequestCloseSubmitting(false));
  }, [pullRequestCloseSubmitting, snapshot.repository.source, sourceNavigation]);
  const markPullRequestReady = useCallback(() => {
    const source = snapshot.repository.source;
    if (
      !sourceNavigation?.onMarkPullRequestReady ||
      pullRequestReadySubmitting ||
      source.type !== 'pull-request' ||
      source.reviewStatus?.markReady?.disabled === true ||
      !source.reviewStatus?.markReady
    ) {
      return;
    }

    setPullRequestReadySubmitting(true);
    return Promise.resolve(sourceNavigation.onMarkPullRequestReady())
      .catch((error: unknown) => {
        window.alert(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setPullRequestReadySubmitting(false));
  }, [pullRequestReadySubmitting, snapshot.repository.source, sourceNavigation]);
  const mergePullRequest = useCallback(
    (options: PullRequestMergeOptions & { autoMerge: boolean }) => {
      if (!sourceNavigation?.onMergePullRequest || pullRequestMergeSubmitting) {
        return;
      }

      setPullRequestMergeSubmitting(true);
      void Promise.resolve(sourceNavigation.onMergePullRequest(options))
        .catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setPullRequestMergeSubmitting(false));
    },
    [pullRequestMergeSubmitting, sourceNavigation],
  );
  const cancelAutoMerge = useCallback(() => {
    if (!sourceNavigation?.onCancelAutoMerge || pullRequestMergeSubmitting) {
      return;
    }

    setPullRequestMergeSubmitting(true);
    void Promise.resolve(sourceNavigation.onCancelAutoMerge())
      .catch((error: unknown) => {
        window.alert(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setPullRequestMergeSubmitting(false));
  }, [pullRequestMergeSubmitting, sourceNavigation]);
  useEffect(() => {
    walkthroughRef.current = walkthrough;
  }, [walkthrough]);

  useEffect(() => {
    if (!walkthroughRequestPending || walkthroughRequestId === 0) {
      return;
    }

    let cancelled = false;
    void Promise.resolve(walkthroughRef.current?.onGenerate?.())
      .catch(() => {})
      .finally(() => {
        if (cancelled) {
          return;
        }
        walkthroughRequestPendingRef.current = false;
        setWalkthroughRequestPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [walkthroughRequestId, walkthroughRequestPending]);

  const startWalkthroughGeneration = useCallback(() => {
    if (
      !walkthrough?.onGenerate ||
      walkthrough.status === 'generating' ||
      walkthroughRequestPendingRef.current
    ) {
      return;
    }

    walkthroughRequestPendingRef.current = true;
    setWalkthroughRequestPending(true);
    setWalkthroughRequestId((current) => current + 1);
  }, [walkthrough]);
  useEffect(() => {
    if (sidebarMode === 'walkthrough' && walkthrough?.status === 'idle') {
      startWalkthroughGeneration();
    }
  }, [sidebarMode, startWalkthroughGeneration, walkthrough?.status]);
  useEffect(() => {
    if (sidebarMode !== 'comments' || generalComments.length === 0) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isNativeInputTarget(event.target)
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key !== 'j' && key !== 'k') {
        return;
      }

      event.preventDefault();
      navigateGeneralComment(key === 'j' ? 1 : -1);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [generalComments.length, navigateGeneralComment, sidebarMode]);
  const submitGeneralComment = useCallback(() => {
    const body = generalCommentDraft.trim();
    if (!submitGeneralDiscussion || !body || generalCommentSubmitting) {
      return;
    }

    setGeneralCommentError(null);
    setGeneralCommentSubmitting(true);
    void Promise.resolve(submitGeneralDiscussion(body))
      .then(() => setGeneralCommentDraft(''))
      .catch((error: unknown) => {
        setGeneralCommentError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setGeneralCommentSubmitting(false));
  }, [generalCommentDraft, generalCommentSubmitting, submitGeneralDiscussion]);
  const startEditGeneralComment = useCallback((comment: PullRequestGeneralComment) => {
    if (!comment.canEdit) {
      return;
    }

    setEditingGeneralCommentId(comment.id);
    setGeneralCommentEditDraft(comment.body);
    setGeneralCommentEditError(null);
  }, []);
  const cancelEditGeneralComment = useCallback(() => {
    if (generalCommentEditSubmitting) {
      return;
    }

    setEditingGeneralCommentId(null);
    setGeneralCommentEditDraft('');
    setGeneralCommentEditError(null);
  }, [generalCommentEditSubmitting]);
  const saveGeneralCommentEdit = useCallback(() => {
    const commentId = editingGeneralCommentId;
    const body = generalCommentEditDraft.trim();
    if (!updateGeneralDiscussion || !commentId || !body || generalCommentEditSubmitting) {
      return;
    }

    setGeneralCommentEditError(null);
    setGeneralCommentEditSubmitting(true);
    void Promise.resolve(updateGeneralDiscussion(commentId, body))
      .then(() => {
        setEditingGeneralCommentId(null);
        setGeneralCommentEditDraft('');
      })
      .catch((error: unknown) => {
        setGeneralCommentEditError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setGeneralCommentEditSubmitting(false));
  }, [
    editingGeneralCommentId,
    generalCommentEditDraft,
    generalCommentEditSubmitting,
    updateGeneralDiscussion,
  ]);
  const selectPath = useCallback(
    (path: string | null) => {
      setUncontrolledSelectedPath(path);
      controlledPreferences?.selectedPath?.onChange(path);
    },
    [controlledPreferences?.selectedPath, setUncontrolledSelectedPath],
  );
  const activateTreePath = useCallback(
    (path: string) => {
      selectPath(path);
      setTreeScrollTarget((current) => ({
        behavior: 'smooth',
        path,
        request: (current?.request ?? 0) + 1,
      }));
    },
    [selectPath],
  );
  const updateSelectedPathFromScroll = useCallback(
    (viewer: CodeViewInstance) => {
      const nextPath = getSelectedPathFromScroll(
        viewer,
        visibleFiles,
        snapshot.preferences.showWhitespace,
      );

      if (nextPath && selectedPath !== nextPath) {
        selectPath(nextPath);
      }
    },
    [selectPath, selectedPath, snapshot.preferences.showWhitespace, visibleFiles],
  );

  const [hunkNavigation, setHunkNavigation] = useState<{
    direction: 1 | -1;
    request: number;
  } | null>(null);
  const navigateHunks = useCallback((direction: 1 | -1) => {
    setHunkNavigation((current) => ({
      direction,
      request: (current?.request ?? 0) + 1,
    }));
  }, []);
  const focusFileFilter = useCallback(() => {
    sidebarInteractedRef.current = true;
    updateSidebarCollapsed(false, true);
    changeSidebarMode('tree');
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('.review-surface .sidebar-search');
      input?.focus();
      input?.select();
    });
  }, [changeSidebarMode, updateSidebarCollapsed]);
  const toggleWordWrap = useCallback(() => {
    const nextWordWrap = !wordWrap;
    setUncontrolledWordWrap(nextWordWrap);
    controlledPreferences?.wordWrap?.onChange(nextWordWrap);
  }, [controlledPreferences?.wordWrap, wordWrap]);
  const { closeCommandBar, commandBarVisible, shortcutsHelpVisible } = useAppKeyboardShortcuts({
    keymap,
    navigateHunks,
    onFocusFileFilter: focusFileFilter,
    onOpenDiffSearch: openDiffSearch,
    onOpenSelectedFile: desktop?.onOpenSelectedFile,
    onToggleSidebar: toggleSidebar,
    onToggleWordWrap: toggleWordWrap,
    shouldDeferHunkNavigation: () => sidebarMode === 'walkthrough',
    sidebarCollapsed: sidebarCollapsed ?? false,
  });
  const commandBarCommands = useMemo(
    () =>
      [
        {
          execute: focusFileFilter,
          id: 'file-filter',
          keymapAction: 'fileFilter',
          title: 'Focus File Filter',
        },
        {
          execute: openDiffSearch,
          id: 'diff-search',
          keymapAction: 'diffSearch',
          title: 'Find in Diffs',
        },
        { execute: () => changeSidebarMode('tree'), id: 'sidebar-tree', title: 'Show File Tree' },
        {
          execute: () => changeSidebarMode('walkthrough'),
          id: 'sidebar-walkthrough',
          title: 'Show Walkthrough',
        },
        ...(showCommentsTab
          ? [
              {
                execute: () => changeSidebarMode('comments'),
                id: 'sidebar-comments',
                title: 'Show Comments',
              },
            ]
          : []),
        ...(history
          ? [
              {
                execute: () => changeSidebarMode('history'),
                id: 'sidebar-history',
                title: 'Show History',
              },
            ]
          : []),
        {
          execute: toggleSidebar,
          id: 'toggle-sidebar',
          keymapAction: 'toggleSidebar',
          title: 'Toggle Sidebar',
        },
        {
          execute: toggleWordWrap,
          id: 'toggle-word-wrap',
          keymapAction: 'toggleWordWrap',
          title: 'Toggle Word Wrap',
        },
        ...(desktop?.commands ?? []),
      ] satisfies ReadonlyArray<Command>,
    [
      changeSidebarMode,
      desktop?.commands,
      focusFileFilter,
      history,
      openDiffSearch,
      showCommentsTab,
      toggleSidebar,
      toggleWordWrap,
    ],
  );
  const commandBridge = useMemo<ReviewSurfaceCommandBridge>(
    () => ({
      copyPendingComments: () =>
        buildReviewCommentsMarkdown(
          snapshot.files,
          localReviewComments,
          snapshot.preferences.showWhitespace,
          pendingCommentPrefix,
        ),
      getPersistenceState: () => ({ mode: sidebarMode, selectedPath: visibleSelectedPath }),
      openDiffSearch,
    }),
    [
      localReviewComments,
      openDiffSearch,
      pendingCommentPrefix,
      sidebarMode,
      snapshot.files,
      snapshot.preferences.showWhitespace,
      visibleSelectedPath,
    ],
  );
  useEffect(() => {
    onCommandBridgeChange?.(commandBridge);
    return () => onCommandBridgeChange?.(null);
  }, [commandBridge, onCommandBridgeChange]);

  const diffLineHeight = getCodeFontLineHeight(
    normalizeCodeFontSizePreference(snapshot.preferences.codeFontSize),
  );
  const commonReviewProps = {
    activeSearchMatch: activeDiffSearchMatch,
    agentId: snapshot.walkthrough.agent,
    agentLabel: getAgentLabel(snapshot.walkthrough.agent),
    codeQualityFindings: snapshot.codeQualityFindings,
    collapsed,
    comments: reviewComments,
    commitMetadata: snapshot.commitMetadata ?? null,
    diffLineHeight,
    diffStyle: controlledPreferences?.diffLayout?.value ?? snapshot.preferences.diffStyle,
    disableWorkerPool: desktop?.disableCodeViewWorkerPool ?? true,
    expandedGenerated,
    focusCommentId,
    focusCommentRequest,
    gitIdentity,
    hunkNavigation,
    initialMarkdownPreviewSectionIds,
    isReadOnly: !canComment,
    itemVersionByKey,
    keymap,
    loadingSectionIds: content?.loadingSectionIds ?? new Set<string>(),
    onAskCodex:
      localReviewNotes?.onAsk || providerComments?.authoring.onAsk || shareComments?.authoring.onAsk
        ? askReviewAssistant
        : undefined,
    onCommentDraftChange: updateActiveReviewCommentDraft,
    onCreateComment: createComment,
    onDeleteComment: deleteComment,
    onFindDefinitions: desktop?.onFindDefinitions,
    onLoadImageContent: content?.onLoadImageContent,
    onLoadSection: content?.onLoadSection,
    onOpenDefinition: desktop?.onOpenDefinition,
    onOpenFile: desktop?.onOpenFile,
    onRefreshMarkdown: content?.onRefreshMarkdown,
    onResolveThread: resolveDiscussion ?? noop,
    onSaveCommentEdit: updateExistingReviewComment,
    onSelectPathFromScroll: noop,
    onSubmitComment: submitComment,
    onToggleCollapsed: toggleCollapsed,
    onToggleViewed: toggleViewed,
    onUpdateComment: updateComment,
    onUpdateSourceDescription: sourceNavigation?.onUpdateDescription,
    onUpdateSourceTitle: sourceNavigation?.onUpdateTitle,
    onUploadSourceDescriptionAsset: sourceNavigation?.onUploadDescriptionAsset,
    resolveSectionContents: content?.resolveSectionContents,
    searchQuery: diffSearchQuery,
    showWhitespace: snapshot.preferences.showWhitespace,
    source: snapshot.repository.source,
    supportsReviewCommentActions: submitReviewComment != null,
    theme: snapshot.preferences.theme,
    viewed,
    wordWrap,
  };
  const source = snapshot.repository.source;
  const showDesktopCommitButton =
    sidebarMode === 'tree' &&
    source.type === 'working-tree' &&
    snapshot.files.length > 0 &&
    desktop?.commit != null;
  const emptySourceDetail = getEmptySourceDetail(source, snapshot.repository.root);
  const hasDiffSearchQuery = diffSearchQuery.trim().length > 0;
  const sourceMergeState = source.type === 'pull-request' ? source.mergeState : undefined;
  const isTerminalMergeState = sourceMergeState
    ? isTerminalPullRequestMergeState(sourceMergeState)
    : false;
  const sourceMergeStatusBadge =
    sourceMergeState && isTerminalMergeState ? (
      <PullRequestMergeStatusBadge mergeState={sourceMergeState} />
    ) : null;
  const sourceDescriptionActions =
    (reviewSession ||
      sourceNavigation?.onClosePullRequest ||
      sourceNavigation?.onMarkPullRequestReady) &&
    source.type === 'pull-request' ? (
      <PullRequestReviewButtons
        disabled={
          pullRequestReviewSubmitting != null ||
          pullRequestCloseSubmitting ||
          pullRequestReadySubmitting
        }
        hasPendingComments={
          getPendingPullRequestReviewComments(
            localReviewComments.filter(isProviderCommentDraft),
            activeReviewCommentDraftState,
          ).length > 0
        }
        onClosePullRequest={sourceNavigation?.onClosePullRequest ? closePullRequest : undefined}
        onMarkPullRequestReady={
          sourceNavigation?.onMarkPullRequestReady ? markPullRequestReady : undefined
        }
        onSubmitReview={reviewSession ? submitReview : undefined}
        reviewStatus={source.reviewStatus}
        showCommentReview={source.provider === 'github' || source.host === 'github.com'}
      >
        {sourceMergeStatusBadge}
      </PullRequestReviewButtons>
    ) : sourceMergeStatusBadge ? (
      <div aria-label="Pull request status" className="source-description-review-actions">
        {sourceMergeStatusBadge}
      </div>
    ) : undefined;
  const sourceDescriptionFooterMain =
    (sourceNavigation?.onMergePullRequest || sourceNavigation?.onCancelAutoMerge) &&
    sourceMergeState &&
    !isTerminalMergeState ? (
      <PullRequestMergeControls
        disabled={pullRequestMergeSubmitting}
        isPending={pullRequestMergeSubmitting}
        mergeState={sourceMergeState}
        onCancelAutoMerge={sourceNavigation?.onCancelAutoMerge ? cancelAutoMerge : undefined}
        onMergePullRequest={sourceNavigation?.onMergePullRequest ? mergePullRequest : undefined}
      />
    ) : undefined;
  const sourceDescriptionFooter =
    sourceDescriptionFooterMain && sourceDescriptionFooterAside ? (
      <div className="codiff-source-description-footer-row">
        <div className="codiff-source-description-footer-main">{sourceDescriptionFooterMain}</div>
        <div className="codiff-source-description-footer-aside">{sourceDescriptionFooterAside}</div>
      </div>
    ) : (
      (sourceDescriptionFooterMain ?? sourceDescriptionFooterAside)
    );
  const sourceDescription =
    source.type === 'pull-request' ? (
      <PullRequestSourceDescription
        actions={sourceDescriptionActions}
        footer={sourceDescriptionFooter}
        keymap={keymap}
        onUpdateDescription={sourceNavigation?.onUpdateDescription}
        onUpdateTitle={sourceNavigation?.onUpdateTitle}
        onUploadDescriptionAsset={sourceNavigation?.onUploadDescriptionAsset}
        source={source}
      />
    ) : null;

  const renderWalkthroughDiffBlocks = (
    blocks: ReadonlyArray<ReviewDiffBlock>,
    blockScrollTarget: WalkthroughBlockScrollTarget | null,
    onActiveBlockChange: (blockId: string) => void,
  ) => {
    return (
      <WalkthroughDiffSurface
        allowViewedToggle
        blocks={blocks}
        forceExpandedPaths={forceExpandedPaths}
        onActiveBlockChange={onActiveBlockChange}
        reviewProps={commonReviewProps}
        scrollTarget={blockScrollTarget}
        sourceDescriptionActions={sourceDescriptionActions}
        sourceDescriptionFooter={sourceDescriptionFooter}
      />
    );
  };

  const sourceLabel =
    snapshot.repository.source.type === 'working-tree'
      ? null
      : getSourceLabel(snapshot.repository.source);
  const rootLabel = repositoryUrl
    ? snapshot.repository.root
    : abbreviateHomePath(snapshot.repository.root);
  const sourceExternalUrl =
    snapshot.repository.source.type === 'pull-request'
      ? (externalUrl ?? snapshot.repository.source.url)
      : null;
  const repositoryLinkUrl = repositoryUrl ?? sourceExternalUrl;
  const walkthroughStatus =
    walkthroughRequestPending && walkthrough?.status !== 'ready'
      ? 'generating'
      : walkthrough?.status;
  const [walkthroughProgressRevision, setWalkthroughProgressRevision] = useState(0);
  const previousWalkthroughStatusRef = useRef(walkthroughStatus);
  useEffect(() => {
    if (
      walkthroughStatus === 'generating' &&
      previousWalkthroughStatusRef.current !== 'generating'
    ) {
      setWalkthroughProgressRevision((current) => current + 1);
    }
    previousWalkthroughStatusRef.current = walkthroughStatus;
  }, [walkthroughStatus]);
  const walkthroughReady = !walkthrough || walkthroughStatus === 'ready';
  const walkthroughFailed = walkthroughStatus === 'failed';
  const walkthroughGenerationProgress = walkthrough?.generationProgress ?? null;
  const failedGenerationUnits =
    walkthroughGenerationProgress?.units?.filter((unit) => unit.status === 'failed') ?? [];
  const agentUnavailable =
    walkthroughFailed &&
    walkthrough?.error?.code != null &&
    agentUnavailableCodes.has(walkthrough.error.code);
  const walkthroughStatusTitle = walkthroughFailed
    ? 'Walkthrough unavailable'
    : 'Generating walkthrough…';
  const walkthroughStatusDescription = walkthroughFailed
    ? agentUnavailable
      ? (walkthrough?.error?.reason ?? 'Install the configured agent and try again.')
      : (walkthroughGenerationProgress?.summary ??
        walkthrough?.error?.reason ??
        'Fix the generation issue, then try again.')
    : (walkthroughGenerationProgress?.summary ?? null);
  const shellTheme =
    snapshot.preferences.theme === 'system' ? undefined : snapshot.preferences.theme;
  const requestWalkthrough = () => {
    startWalkthroughGeneration();
  };
  const reviewModes = [
    {
      icon: <Path aria-hidden size={14} weight="bold" />,
      indicator: walkthrough?.unread ? <span aria-hidden className="review-mode-dot" /> : undefined,
      label: 'Walkthrough',
      value: 'walkthrough',
    },
    {
      icon: <TreeStructure aria-hidden size={14} weight="bold" />,
      label: 'Tree',
      value: 'tree',
    },
    ...(history
      ? [
          {
            icon: <ClockCounterClockwise aria-hidden size={14} weight="bold" />,
            label: 'History',
            value: 'history' as const,
          },
        ]
      : []),
    ...(showCommentsTab
      ? [
          {
            ariaLabel: generalCommentCount > 0 ? `Comments (${generalCommentCount})` : 'Comments',
            icon: <ChatCircle aria-hidden size={14} weight="bold" />,
            indicator:
              generalCommentCount > 0 ? (
                <span aria-hidden className="review-mode-count">
                  {generalCommentCount}
                </span>
              ) : undefined,
            label: 'Comments',
            title:
              generalCommentCount > 0
                ? `${generalCommentCount} ${generalCommentCount === 1 ? 'comment' : 'comments'}`
                : 'Comments',
            value: 'comments' as const,
          },
        ]
      : []),
  ] satisfies ReadonlyArray<ReviewModeItem<ReviewMode>>;
  const topBarActions =
    onDeleteShare || settingsBar ? (
      <>
        {onDeleteShare ? (
          <Button
            action={deleteShare}
            aria-label="Delete shared walkthrough"
            pendingPlaceholder="…"
            size="icon"
            title="Delete shared walkthrough"
            type="button"
            variant="destructive"
          >
            <Trash2 aria-hidden size={16} />
          </Button>
        ) : null}
        {settingsBar ? <div className="review-top-bar-settings">{settingsBar}</div> : null}
      </>
    ) : undefined;

  return (
    <>
      <CommandBar
        commands={commandBarCommands}
        keymap={keymap}
        onClose={closeCommandBar}
        visible={commandBarVisible}
      />
      <div
        className={`app-shell share-shell review-surface${desktop ? ' merge-request-shell' : ''}${
          desktop?.isWindowFullscreen ? ' window-fullscreen' : ''
        }${
          sidebarCollapsed === null ? ' sidebar-auto' : sidebarCollapsed ? ' sidebar-collapsed' : ''
        }`}
        data-sidebar-position={sidebarPosition}
        data-theme={shellTheme}
        style={
          sidebarCollapsed !== false
            ? undefined
            : {
                gridTemplateColumns:
                  sidebarPosition === 'right'
                    ? `minmax(0, 1fr) 0 ${sidebarWidth}px`
                    : `${sidebarWidth}px 0 minmax(0, 1fr)`,
              }
        }
      >
        <ReviewTopBar
          actions={topBarActions}
          context={
            <>
              {snapshot.branch ? (
                <span className="review-top-bar-branch" title={snapshot.branch}>
                  {snapshot.branch}
                </span>
              ) : null}
              {sourceLabel ? (
                sourceExternalUrl ? (
                  <a
                    aria-label={`Open ${sourceLabel} in ${providerLabel}`}
                    className="review-top-bar-source"
                    href={sourceExternalUrl}
                    rel="noreferrer"
                    target="_blank"
                    title={`Open ${sourceLabel} in ${providerLabel}`}
                  >
                    <span>{sourceLabel}</span>
                    <ArrowSquareOut aria-hidden size={14} weight="bold" />
                  </a>
                ) : (
                  <span className="review-top-bar-source">{sourceLabel}</span>
                )
              ) : null}
            </>
          }
          mode={sidebarMode}
          modes={reviewModes}
          onModeChange={changeSidebarMode}
          onToggleSidebar={toggleSidebar}
          repository={
            repositoryLinkUrl ? (
              <a
                className="review-top-bar-repository"
                href={repositoryLinkUrl}
                rel="noreferrer"
                target={repositoryUrl ? undefined : '_blank'}
              >
                {rootLabel}
              </a>
            ) : (
              <span className="review-top-bar-repository">{rootLabel}</span>
            )
          }
          repositoryTooltip={snapshot.repository.root}
          sidebarCollapsed={sidebarCollapsed ?? false}
          sidebarPosition={sidebarPosition}
          sourceMenu={desktop?.sourceMenu}
          toggleTitle={`${sidebarCollapsed ? 'Expand' : 'Collapse'} sidebar (${getShortcutLabel(
            keymap,
            'toggleSidebar',
          )})`}
        />
        {desktop?.beforeContent}
        {reviewDrafts && !desktop?.isSwitchingSource ? (
          <div className="review-action-bar">
            <CopyCommentsButton
              actionLabel={copyPendingCommentsLabel}
              comments={localReviewComments}
              files={snapshot.files}
              reviewCommentsPrefix={pendingCommentPrefix ?? ''}
              showWhitespace={snapshot.preferences.showWhitespace}
            />
          </div>
        ) : null}
        <DiffSearchPanel
          activeIndex={activeDiffSearchMatchIndex}
          focusRequest={diffSearchFocusRequest}
          keymap={keymap}
          matchCount={diffSearchMatches.length}
          onChange={updateDiffSearchQuery}
          onClose={closeDiffSearch}
          onNext={() => moveDiffSearchMatch(1)}
          onPrevious={() => moveDiffSearchMatch(-1)}
          query={diffSearchQuery}
          visible={diffSearchVisible}
        />
        <aside className="squircle sidebar">
          {sidebarMode === 'tree' ? (
            <div className="sidebar-search-row">
              <input
                aria-label="Filter changed files"
                className="sidebar-search"
                onChange={(event) => setFileSearchQuery(event.currentTarget.value)}
                placeholder="Filter files"
                spellCheck={false}
                type="search"
                value={fileSearchQuery}
              />
            </div>
          ) : null}
          {sidebarMode === 'history' && history ? (
            <HistorySidebar
              branchSource={history.branchSource ?? null}
              currentSource={history.currentSource}
              entries={history.entries}
              hasMore={history.hasMore}
              loading={history.loading}
              onLoadMore={history.onLoadMore}
              onSelectSource={history.onSelectSource}
              pullRequestSource={history.pullRequestSource ?? null}
            />
          ) : sidebarMode === 'tree' ? (
            <ReviewFileTree
              files={visibleFiles}
              onActivatePath={activateTreePath}
              reloadDeltaPaths={desktop?.reloadDeltaPaths}
              scrollSelectedPathIntoView={content?.initialScrollTarget != null}
              selectedPath={visibleSelectedPath}
              showWhitespace={snapshot.preferences.showWhitespace}
              viewed={viewed}
            />
          ) : sidebarMode === 'comments' ? (
            <SidebarGeneralCommentList
              comments={generalComments}
              focusedCommentId={focusedGeneralCommentId}
              onActivateComment={activateGeneralComment}
            />
          ) : walkthroughReady ? (
            <NarrativeSidebar
              allowCommit={walkthrough?.commit != null}
              files={visibleFiles}
              navigation={navigation}
              onShareWalkthrough={walkthrough?.onShare}
              showWhitespace={snapshot.preferences.showWhitespace}
              walkthrough={sharedWalkthrough}
            />
          ) : (
            <div className="sidebar-walkthrough-status-shell">
              <div
                className={`sidebar-walkthrough-status${walkthroughFailed ? '' : ' codex'}`}
                title={walkthroughStatusDescription ?? undefined}
              >
                {walkthroughFailed && failedGenerationUnits.length === 0 ? (
                  <strong>{walkthroughStatusTitle}</strong>
                ) : !walkthroughFailed && walkthrough?.progress ? (
                  walkthrough.progress
                ) : (
                  <WalkthroughProgress
                    detail={walkthroughStatusDescription}
                    label={walkthroughStatusTitle}
                    phase={null}
                    progress={walkthroughGenerationProgress}
                    responseLabelIndex={0}
                    stageRevision={walkthroughProgressRevision}
                  />
                )}
                {walkthroughStatusDescription ? <span>{walkthroughStatusDescription}</span> : null}
              </div>
            </div>
          )}
          {showTotalLineCount || showDesktopCommitButton ? (
            <div className="sidebar-settings-bar">
              {showTotalLineCount ? (
                <DiffLineCountBadge
                  ariaLabelPrefix="Total change"
                  className="sidebar-total-line-count sidebar-settings-line-count"
                  lineCount={totalLineCount}
                />
              ) : null}
              {showDesktopCommitButton && desktop.commit ? (
                <Button
                  aria-label={desktop.commit.open ? 'Show file tree' : 'Open commit view'}
                  className="sidebar-commit-button"
                  onClick={desktop.commit.onToggle}
                  type="button"
                >
                  {desktop.commit.open ? 'Tree' : 'Commit'}
                </Button>
              ) : null}
            </div>
          ) : null}
          {desktop?.sidebarFooter}
        </aside>
        <div aria-hidden className="sidebar-resizer" onPointerDown={resizeSidebar} />
        <main className="review codiff-web-review">
          {desktop?.commit?.open ? (
            <CommitView
              branch={desktop.commit.branch}
              draft={desktop.commit.draft}
              model={desktop.commit.model}
              onCommit={desktop.commit.onCommit}
              onCommitOutput={desktop.commit.onCommitOutput}
              onUpdateMessage={desktop.commit.onUpdateMessage}
            />
          ) : sidebarMode === 'comments' ? (
            <MergeRequestCommentsView
              canComment={comments?.general?.onCreate != null}
              commenting={commenting}
              draft={generalCommentDraft}
              editDraft={generalCommentEditDraft}
              editError={generalCommentEditError}
              editingCommentId={editingGeneralCommentId}
              editSubmitting={generalCommentEditSubmitting}
              error={generalCommentError}
              focusedCommentId={focusedGeneralCommentId}
              focusedCommentRequest={generalCommentScrollRequest}
              gitIdentity={gitIdentity}
              keymap={keymap}
              onCancelEdit={cancelEditGeneralComment}
              onChangeDraft={setGeneralCommentDraft}
              onChangeEditDraft={setGeneralCommentEditDraft}
              onSaveEdit={saveGeneralCommentEdit}
              onStartEdit={startEditGeneralComment}
              onSubmit={submitGeneralComment}
              signInLabel={signInLabel}
              sourceDescription={sourceDescription}
              submitting={generalCommentSubmitting}
              threads={generalCommentThreads}
            />
          ) : sidebarMode === 'tree' || sidebarMode === 'history' ? (
            snapshot.files.length === 0 ? (
              <div className="empty-state">
                <div className="empty-panel squircle">
                  <strong>{getEmptySourceTitle(source)}</strong>
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
                  <strong>
                    {hasDiffSearchQuery ? 'No matches in diffs' : 'No matching files'}
                  </strong>
                  <span>
                    {diffSearchQuery ||
                      fileSearchQuery ||
                      (snapshot.preferences.showWhitespace
                        ? snapshot.repository.root
                        : 'Whitespace-only changes hidden')}
                  </span>
                </div>
              </div>
            ) : (
              <ReviewCodeView
                {...commonReviewProps}
                allowViewedToggle
                files={visibleFiles}
                forceExpandedPaths={forceExpandedPaths}
                onSelectPathFromScroll={updateSelectedPathFromScroll}
                scrollTarget={treeScrollTarget}
                selectedPath={visibleSelectedPath}
                sourceDescriptionActions={sourceDescriptionActions}
                sourceDescriptionFooter={sourceDescriptionFooter}
                walkthroughNotes={emptyWalkthroughNotes}
              />
            )
          ) : walkthroughReady ? (
            <NarrativeWalkthroughView
              allowCommit={walkthrough?.commit != null}
              files={snapshot.files}
              navigation={navigation}
              onActiveReviewTargetChange={desktop?.onActiveWalkthroughReviewTargetChange ?? noop}
              onCommit={walkthrough?.commit ?? disabledCommit}
              onCommitOutput={walkthrough?.commitOutput}
              onShareWalkthrough={walkthrough?.onShare}
              onUpdateCommitMessage={walkthrough?.updateCommitMessage ?? disabledCommitMessage}
              renderDiffBlocks={renderWalkthroughDiffBlocks}
              showWhitespace={snapshot.preferences.showWhitespace}
              walkthrough={sharedWalkthrough}
            />
          ) : walkthroughFailed ? (
            <div className="empty-state">
              <div className="empty-panel squircle">
                {agentUnavailable ? (
                  <AgentUnavailablePanel
                    agentLabel={getAgentLabel(snapshot.walkthrough.agent)}
                    onShowFiles={() => changeSidebarMode('tree')}
                    reason={walkthroughStatusDescription ?? undefined}
                  />
                ) : (
                  <>
                    <strong>{walkthroughStatusTitle}</strong>
                    <p>{walkthroughStatusDescription}</p>
                    {failedGenerationUnits.length > 0 ? (
                      <WalkthroughProgress
                        label="Failed walkthrough tasks"
                        phase={null}
                        progress={walkthroughGenerationProgress}
                        responseLabelIndex={0}
                        stageRevision={walkthroughProgressRevision}
                      />
                    ) : null}
                    <div className="empty-panel-actions">
                      <button onClick={requestWalkthrough} type="button">
                        {failedGenerationUnits.length > 0 ? 'Retry failed tasks' : 'Try again'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="loading codex">
              {walkthrough?.progress ?? (
                <WalkthroughProgress
                  detail={walkthroughStatusDescription}
                  label={walkthroughStatusTitle}
                  phase={null}
                  progress={walkthroughGenerationProgress}
                  responseLabelIndex={0}
                  stageRevision={walkthroughProgressRevision}
                />
              )}
            </div>
          )}
        </main>
      </div>
      <KeyboardShortcutsHelp keymap={keymap} visible={shortcutsHelpVisible} />
    </>
  );
}
