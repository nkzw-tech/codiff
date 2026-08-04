import { Select } from '@base-ui/react/select';
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
import { CommitRefTooltip, ReviewCommitRef } from './app/components/CommitRefTooltip.tsx';
import { CommitScopePanel } from './app/components/CommitScopePanel.tsx';
import { ReviewFileTree } from './app/components/FileTree.tsx';
import { KeyboardShortcutsHelp } from './app/components/KeyboardShortcutsHelp.tsx';
import {
  MergeRequestCommentsView,
  SidebarCommentSection,
  SidebarGeneralCommentList,
  SidebarInlineReviewCommentList,
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
  ReviewCommentCreation,
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
  parseWalkthroughModel,
  resolveWalkthroughFiles,
} from './lib/narrative-walkthrough-schema.ts';
import {
  resolveProviderCommentTarget,
  resolveShareCommentTarget,
} from './lib/review-comment-target.ts';
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
import {
  evolutionUnitCommit,
  evolutionUnitRebaseOverlaps,
  suggestReviewComparison,
  versionOptionHeadSha,
  versionOptionLabelText,
} from './lib/review-history.ts';
import { getSelectedPathFromScroll } from './lib/review-scroll.ts';
import {
  SIDEBAR_COLLAPSE_THRESHOLD,
  SIDEBAR_DEFAULT_WIDTH,
  readSidebarWidth,
  writeSidebarWidth,
} from './lib/sidebar-width.ts';
import { buildSourceDescriptionModel } from './lib/source-description.ts';
import {
  getEmptySourceDetail,
  getEmptySourceTitle,
  getSourceLabel,
  getSourceKey,
  getSourceRevisionKey,
  supportsDiffSearchContentPreload,
} from './lib/source.ts';
import {
  assessmentComponentByThreadId,
  currentThreadStateById,
} from './lib/walkthrough-assessment-display.ts';
import type {
  ChangedFile,
  DiffComparisonBaseMovement,
  DiffComparisonView,
  DiffImageContentRequest,
  DiffImageContentResult,
  DiffSection,
  EvolutionUnitId,
  GitSha,
  GitIdentity,
  HistoryEntry,
  PersistedWalkthrough,
  PullRequestMergeOptions,
  PullRequestGeneralComment,
  PullRequestGeneralCommentThread,
  PullRequestExistingReviewComment,
  PullRequestReviewEvent,
  ProviderCommentSubmission,
  ResolvedReviewSource,
  ReviewCommenting,
  ReviewContextResolver,
  ReviewCommitEvolution,
  ReviewCommitListEntry,
  ReviewEvolutionUnit,
  ReviewSource,
  ReviewVersionEvolutionProgress,
  ReviewVersionId,
  ReviewVersionOption,
  RepositoryState,
  ShareCommentSubmission,
  SharedWalkthroughSnapshot,
  SharedWalkthroughReviewScope,
  SubmittedReviewComment,
  SubmitPullRequestReviewResult,
  TargetComparisonReviewStructure,
  VersionComparisonReviewStructure,
  WalkthroughCommitMessageResult,
  WalkthroughCommitResult,
  WalkthroughGenerationProgress,
} from './types.ts';

export { ReadOnlyGeneralCommentCard } from './app/components/merge-request/GeneralComments.tsx';
export type { ReviewCommenting } from './types.ts';

const emptyChangedFiles: ReadonlyArray<ChangedFile> = [];
const emptyReviewComments: ReadonlyArray<RenderedSubmittedReviewComment> = [];
const emptyReviewDrafts: ReadonlyArray<ReviewDraft> = [];
const emptyGeneralCommentThreads: ReadonlyArray<PullRequestGeneralCommentThread> = [];
const emptyReviewVersions: ReadonlyArray<ReviewVersionOption> = [];
const emptyPaths = new Set<string>();
const emptyWalkthroughNotes = new Map();
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

export type ReviewWalkthroughStatus = 'failed' | 'generating' | 'idle' | 'ready';
export type WalkthroughReviewStructure =
  | TargetComparisonReviewStructure
  | VersionComparisonReviewStructure;
export type ReviewMode = 'comments' | 'history' | 'tree' | 'walkthrough';
export type ReviewSurfaceCommandBridge = {
  copyPendingComments: () => string;
  copyPendingCommentsLabel: string;
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
export type SubmitProviderReviewResult = SubmitPullRequestReviewResult;

export type SubmitProviderReviewRequest = {
  comments: ReadonlyArray<ProviderCommentSubmission>;
  outcome: ProviderReviewOutcome;
  summary?: string;
};

export type ProviderReviewSessionCapabilities = {
  drafts: ControlledReviewDrafts<ProviderCommentDraft>;
  submit: (request: SubmitProviderReviewRequest) => Promise<SubmitProviderReviewResult>;
};

type ReviewCommentDraftForDestination<Destination extends CommentDestination> =
  Destination extends 'share' ? ShareCommentDraft : ProviderCommentDraft;

type ReviewCommentSubmission<Destination extends CommentDestination> = Destination extends 'share'
  ? ShareCommentSubmission
  : ProviderCommentSubmission;

type CommonReviewCommentCapabilities<Destination extends CommentDestination> = {
  anchorPolicy: Destination extends 'share' ? 'share-snapshot' : 'provider-target';
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
  onLoadSectionContents?: (file: ChangedFile, section: DiffSection) => Promise<FileDiffLoadedFiles>;
  onRefreshMarkdown?: (file: ChangedFile, section: DiffSection) => Promise<boolean>;
  renderUnavailableContent?: (file: ChangedFile, section: DiffSection) => ReactNode;
  resolveReviewContext?: ReviewContextResolver;
};

export type ReviewDesktopCapabilities = {
  beforeContent?: ReactNode;
  collapsed?: ReadonlySet<string>;
  commands?: ReadonlyArray<Command>;
  commit?: ComponentProps<typeof CommitView> & {
    onToggle: () => void;
    open: boolean;
  };
  commitScope?: {
    commits: ReadonlyArray<ReviewCommitListEntry>;
    onLoadRangeDiff: (
      fromSha: GitSha,
      toSha: GitSha,
    ) => Promise<ReadonlyArray<ChangedFile>> | ReadonlyArray<ChangedFile>;
    targetBaseCommit?: ReviewCommitListEntry | null;
  };
  disableCodeViewWorkerPool?: boolean;
  isSwitchingSource?: boolean;
  isWindowFullscreen?: boolean;
  onActiveWalkthroughReviewTargetChange?: (target: WalkthroughReviewTarget | null) => void;
  onCollapsedChange?: (collapsed: Set<string>) => void;
  onOpenFile?: (file: ChangedFile) => void;
  onOpenSelectedFile?: () => void;
  onViewedChange?: (viewed: Record<string, string>) => void;
  reloadDeltaPaths?: ReadonlySet<string>;
  sidebarFooter?: ReactNode;
  sourceMenu?: ReactNode;
  versionComparison?: {
    commitEvolution?: ReviewCommitEvolution | null;
    commitEvolutionError?: string | null;
    commitEvolutionLoading?: boolean;
    commitEvolutionProgress?: ReviewVersionEvolutionProgress | null;
    enabled?: boolean;
    error?: string | null;
    fromVersionId?: ReviewVersionId | null;
    historyLoading?: boolean;
    loading?: boolean;
    onExit?: () => void;
    onLoadUnitDiff?: (
      unitId: EvolutionUnitId,
    ) => Promise<ReadonlyArray<ChangedFile>> | ReadonlyArray<ChangedFile>;
    onOpen?: () => void;
    onRangeChange?: (fromVersionId: ReviewVersionId, toVersionId: ReviewVersionId) => void;
    result?: DiffComparisonView | null;
    toVersionId?: ReviewVersionId | null;
    versions?: ReadonlyArray<ReviewVersionOption>;
  };
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
  generationReady?: boolean;
  onGenerate?: (options?: {
    force?: boolean;
    regenerateUnitId?: EvolutionUnitId;
    reviewStructure?: WalkthroughReviewStructure;
  }) => Promise<void> | void;
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
  reviewScope,
  reviewStructure,
  state,
  title,
  walkthrough,
}: {
  preferences: SharedWalkthroughSnapshot['preferences'];
  reviewScope?: SharedWalkthroughReviewScope;
  reviewStructure?: TargetComparisonReviewStructure;
  state: RepositoryState;
  title: string;
  walkthrough: PersistedWalkthrough;
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
  reviewScope: reviewScope ?? {
    kind: 'merge-request',
    structure:
      reviewStructure === 'commit-by-commit' || reviewStructure === 'net-change'
        ? reviewStructure
        : 'net-change',
  },
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

type VersionEvolutionUnit = Exclude<ReviewEvolutionUnit, { kind: 'commit' }>;

const shortVersionAge = (value: string) => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return '—';
  }
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / (60 * 1000)));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 14) {
    return `${days}d`;
  }
  if (days < 60) {
    return `${Math.floor(days / 7)}w`;
  }
  if (days < 365) {
    return `${Math.floor(days / 30)}mo`;
  }
  return `${Math.floor(days / 365)}y`;
};

export const formatVersionElapsedDuration = (from: string, to: string) => {
  const fromTimestamp = Date.parse(from);
  const toTimestamp = Date.parse(to);
  if (
    !Number.isFinite(fromTimestamp) ||
    !Number.isFinite(toTimestamp) ||
    toTimestamp < fromTimestamp
  ) {
    return '—';
  }
  const minutes = Math.floor((toTimestamp - fromTimestamp) / (60 * 1000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 14) {
    return `${days}d`;
  }
  if (days < 60) {
    return `${Math.floor(days / 7)}w`;
  }
  if (days < 365) {
    return `${Math.floor(days / 30)}mo`;
  }
  return `${Math.floor(days / 365)}y`;
};

const formatSignedBaseInterval = (delta: number | null) => {
  if (delta == null) {
    return null;
  }
  const duration = formatVersionElapsedDuration(
    new Date(0).toISOString(),
    new Date(Math.abs(delta)).toISOString(),
  );
  return `new base is ${duration} ${delta >= 0 ? 'newer' : 'older'}`;
};

const formatBaseMovementRelationship = (
  relationship: DiffComparisonBaseMovement['relationship'],
) => {
  switch (relationship) {
    case 'forward':
      return 'fast-forward';
    case 'backward':
      return 'rewound';
    case 'divergent':
      return 'divergent histories';
    default:
      return 'relationship unknown';
  }
};

const formatBaseMovementCommitCount = (
  movement: Pick<DiffComparisonBaseMovement, 'commits' | 'commitsBetween' | 'truncated'>,
) => {
  const listed = movement.commits?.length ?? 0;
  const count = movement.commitsBetween ?? (listed > 0 ? listed : null);
  if (count == null) {
    return 'Commit count unavailable';
  }
  const approximate = movement.truncated || (movement.commitsBetween == null && listed > 0);
  return `${approximate ? '≈' : ''}${count} commit${count === 1 ? '' : 's'}`;
};

const VersionPicker = ({
  endpoint,
  label,
  onChange,
  otherId,
  value,
  versions,
}: {
  endpoint: 'from' | 'to';
  label: string;
  onChange: (id: ReviewVersionId) => void;
  otherId: ReviewVersionId | null;
  value: ReviewVersionId;
  versions: ReadonlyArray<ReviewVersionOption>;
}) => {
  const selected = versions.find((version) => version.versionId === value);
  return (
    <Select.Root
      modal={false}
      onValueChange={(nextValue) => {
        const nextVersion = versions.find((version) => version.versionId === nextValue);
        if (nextVersion) {
          onChange(nextVersion.versionId);
        }
      }}
      value={value}
    >
      <div className="version-picker">
        <span className="version-picker-label">{label}</span>
        <Select.Trigger aria-label={`${label} version`} className="version-picker-trigger">
          <Select.Value>
            {() => <span>{selected ? versionOptionLabelText(selected) : 'Version'}</span>}
          </Select.Value>
          <Select.Icon aria-hidden>⌄</Select.Icon>
        </Select.Trigger>
      </div>
      <Select.Portal>
        <Select.Positioner
          align="start"
          className="version-picker-positioner"
          side="bottom"
          sideOffset={4}
        >
          <Select.Popup aria-label={`${label} version options`} className="version-picker-popover">
            <Select.List>
              {versions.map((version, optionIndex) => {
                const otherIndex = versions.findIndex(
                  (candidate) => candidate.versionId === otherId,
                );
                const disabled =
                  Boolean(version.unavailableReason) ||
                  (otherIndex >= 0 &&
                    (endpoint === 'from' ? optionIndex >= otherIndex : optionIndex <= otherIndex));
                const stat = version.diffStat;
                const headSha = versionOptionHeadSha(version);
                const age = version.number === 0 ? null : shortVersionAge(version.createdAt);
                const elapsed =
                  version.previousCreatedAt && version.previousNumber != null
                    ? formatVersionElapsedDuration(version.previousCreatedAt, version.createdAt)
                    : null;
                const timing = [
                  age ? `${age} old` : null,
                  elapsed ? `${elapsed} since v${version.previousNumber}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <Select.Item
                    className="version-picker-option"
                    disabled={disabled}
                    key={version.versionId}
                    label={`${versionOptionLabelText(version)} ${headSha}`}
                    title={
                      version.unavailableReason ?? new Date(version.createdAt).toLocaleString()
                    }
                    value={version.versionId}
                  >
                    <span>{versionOptionLabelText(version)}</span>
                    <span className="version-picker-head">{version.isHead ? 'HEAD' : ''}</span>
                    {version.number === 0 ? (
                      <code>base</code>
                    ) : (
                      <CommitRefTooltip
                        commit={{
                          additions: stat?.additions,
                          authoredAt: version.createdAt,
                          deletions: stat?.deletions,
                          sha: headSha,
                          shortSha: headSha.slice(0, 7),
                          subject: `${versionOptionLabelText(version)} head`,
                          webUrl: version.range.head.label.url,
                        }}
                        linkTrigger={false}
                      />
                    )}
                    <span className="version-picker-additions">
                      {version.number === 0 ? '' : `+${stat?.additions ?? '…'}`}
                    </span>
                    <span className="version-picker-deletions">
                      {version.number === 0 ? '' : `−${stat?.deletions ?? '…'}`}
                    </span>
                    <span>
                      {version.number === 0
                        ? ''
                        : `${stat?.filesChanged ?? '…'} ${stat?.filesChanged === 1 ? 'file' : 'files'}`}
                    </span>
                    <span className="version-picker-timing">
                      {version.number === 0 ? 'MR base' : timing || '—'}
                    </span>
                    {version.activity?.reasons.length ? (
                      <span
                        className="version-review-activity-pill"
                        title={version.activity.reasons
                          .map(
                            (reason) =>
                              `${reason.kind} · ${new Date(reason.occurredAt).toLocaleString()}`,
                          )
                          .join('\n')}
                      >
                        Review activity
                      </span>
                    ) : null}
                  </Select.Item>
                );
              })}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
};

function VersionComparisonEndpoint({ version }: { version?: ReviewVersionOption | null }) {
  if (!version) {
    return <span>Version</span>;
  }
  const label = versionOptionLabelText(version);
  const headSha = versionOptionHeadSha(version);
  return (
    <span className="version-comparison-endpoint">
      <span>{label}</span>
      <CommitRefTooltip
        commit={{
          additions: version.diffStat?.additions,
          authoredAt: version.createdAt,
          deletions: version.diffStat?.deletions,
          sha: headSha,
          shortSha: headSha.slice(0, 7),
          subject: `${label} head`,
          webUrl: version.range.head.label.url,
        }}
        linkTrigger={false}
      />
    </span>
  );
}

type ReviewSurfaceBaseProps = {
  capabilities?: ReviewSurfaceCapabilities;
  externalUrl?: string;
  gitIdentity?: GitIdentity | null;
  keymap?: CodiffKeymap;
  onCommandBridgeChange?: (bridge: ReviewSurfaceCommandBridge | null) => void;
  onDeleteShare?: () => Promise<void> | void;
  pendingAssessmentThreadIds?: ReadonlySet<string>;
  providerLabel?: string;
  repositoryUrl?: string;
  settingsBar?: ReactNode;
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
  pendingAssessmentThreadIds,
  providerLabel = 'provider',
  repositoryUrl,
  settingsBar,
  signInLabel = 'Sign in to comment',
  snapshot,
  sourceDescriptionFooterAside,
  title,
}: ReviewSurfaceProps) {
  const content = capabilities?.content;
  const desktop = capabilities?.desktop;
  const history = capabilities?.history;
  const versionComparison = desktop?.versionComparison;
  const versionCommitEvolution = versionComparison?.commitEvolution ?? null;
  const versionCommitEvolutionError = versionComparison?.commitEvolutionError ?? null;
  const versionCommitEvolutionLoading = versionComparison?.commitEvolutionLoading ?? false;
  const versionCommitEvolutionProgress = versionComparison?.commitEvolutionProgress ?? null;
  const versionCompare = versionComparison?.result ?? null;
  const versionCompareEnabled = versionComparison?.enabled ?? false;
  const versionCompareError = versionComparison?.error ?? null;
  const versionCompareFromVersionId = versionComparison?.fromVersionId ?? null;
  const versionCompareLoading = versionComparison?.loading ?? false;
  const versionCompareToVersionId = versionComparison?.toVersionId ?? null;
  const versionHistoryLoading = versionComparison?.historyLoading ?? false;
  const versions = versionComparison?.versions ?? emptyReviewVersions;
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
  const sharedWalkthrough = useMemo(() => {
    const model = parseWalkthroughModel(snapshot.walkthrough);
    return walkthrough?.commit
      ? model
      : {
          ...model,
          commit: undefined,
        };
  }, [snapshot.walkthrough, walkthrough?.commit]);
  const walkthroughFiles = resolveWalkthroughFiles(sharedWalkthrough, snapshot.files);
  const navigation = useNarrativeNavigation(
    sharedWalkthrough,
    walkthroughFiles,
    `${snapshot.repository.root}:${getSourceKey(snapshot.repository.source)}`,
  );
  const defaultKeymap = useMemo(() => createDefaultConfig().keymap, []);
  const keymap = keymapProp ?? defaultKeymap;
  const onVersionCompareRangeChange = versionComparison?.onRangeChange;
  const [uncontrolledWordWrap, setUncontrolledWordWrap] = useState(snapshot.preferences.wordWrap);
  const wordWrap = controlledPreferences?.wordWrap?.value ?? uncontrolledWordWrap;
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  const [uncontrolledSidebarMode, setUncontrolledSidebarMode] = useState<ReviewMode>(
    () => initialMode ?? (desktop ? 'tree' : 'walkthrough'),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarMode = activeMode?.value ?? uncontrolledSidebarMode;
  const [selectedTreeCommitRange, setSelectedTreeCommitRange] = useState<{
    fromSha: GitSha;
    toSha: GitSha;
  } | null>(null);
  const [treeCommitFiles, setTreeCommitFiles] = useState<ReadonlyArray<ChangedFile> | null>(null);
  const [treeCommitDiffError, setTreeCommitDiffError] = useState<string | null>(null);
  const [treeCommitDiffLoading, setTreeCommitDiffLoading] = useState(false);
  const treeCommitLoadRequestRef = useRef(0);
  const [versionSectionExpanded, setVersionSectionExpanded] = useState(true);
  const [selectedVersionWalkthroughStructure, setSelectedVersionWalkthroughStructure] =
    useState<VersionComparisonReviewStructure>('complete-comparison');
  const [selectedTargetWalkthroughStructure, setSelectedTargetWalkthroughStructure] =
    useState<TargetComparisonReviewStructure>(() =>
      snapshot.reviewScope?.kind === 'merge-request'
        ? snapshot.reviewScope.structure
        : 'net-change',
    );
  const [selectedVersionUnitIds, setSelectedVersionUnitIds] = useState<
    ReadonlySet<EvolutionUnitId>
  >(() => new Set());
  const [versionUnitFiles, setVersionUnitFiles] = useState<
    Readonly<Record<EvolutionUnitId, ReadonlyArray<ChangedFile>>>
  >({});
  const [versionUnitLoadingIds, setVersionUnitLoadingIds] = useState<ReadonlySet<EvolutionUnitId>>(
    () => new Set(),
  );
  const [versionUnitErrors, setVersionUnitErrors] = useState<
    Readonly<Record<EvolutionUnitId, string>>
  >({});
  const versionUnitScopeRef = useRef(0);
  const versionCompareActive =
    versionCompareEnabled ||
    versionCompare != null ||
    versionCompareLoading ||
    Boolean(versionCompareError);
  const selectedVersionUnits = useMemo(
    () =>
      (versionCommitEvolution?.units ?? []).filter(
        (unit): unit is VersionEvolutionUnit =>
          unit.kind !== 'commit' && selectedVersionUnitIds.has(unit.unitId),
      ),
    [selectedVersionUnitIds, versionCommitEvolution],
  );
  const selectedVersionUnit = selectedVersionUnits[0] ?? null;
  const selectedVersionUnitFiles = useMemo(
    () =>
      selectedVersionUnit
        ? (versionUnitFiles[selectedVersionUnit.unitId] ?? emptyChangedFiles)
        : [],
    [selectedVersionUnit, versionUnitFiles],
  );
  const versionUnitLoading = selectedVersionUnits.some((unit) =>
    versionUnitLoadingIds.has(unit.unitId),
  );
  const versionUnitError = selectedVersionUnits
    .map((unit) => versionUnitErrors[unit.unitId])
    .find((error): error is string => Boolean(error));
  useEffect(() => {
    const reviewScope = snapshot.reviewScope;
    if (reviewScope?.kind !== 'version-comparison') {
      return;
    }
    const structure =
      reviewScope.structure ??
      versionCommitEvolution?.recommendation.suggestedStructure ??
      'complete-comparison';
    let canceled = false;
    queueMicrotask(() => {
      if (!canceled) {
        setSelectedVersionWalkthroughStructure(structure);
      }
    });
    return () => {
      canceled = true;
    };
  }, [
    snapshot.reviewScope,
    versionCommitEvolution?.recommendation.suggestedStructure,
    versionCompareFromVersionId,
    versionCompareToVersionId,
  ]);
  useEffect(() => {
    const reviewScope = snapshot.reviewScope;
    if (reviewScope?.kind !== 'merge-request') {
      return;
    }
    let canceled = false;
    queueMicrotask(() => {
      if (!canceled) {
        setSelectedTargetWalkthroughStructure(reviewScope.structure);
      }
    });
    return () => {
      canceled = true;
    };
  }, [snapshot.reviewScope]);
  const versionWalkthrough = snapshot.reviewScope?.kind === 'version-comparison';
  const walkthroughReviewStructure: WalkthroughReviewStructure = versionWalkthrough
    ? selectedVersionWalkthroughStructure
    : selectedTargetWalkthroughStructure;
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
  const selectPath = useCallback(
    (path: string | null) => {
      setUncontrolledSelectedPath(path);
      controlledPreferences?.selectedPath?.onChange(path);
    },
    [controlledPreferences?.selectedPath, setUncontrolledSelectedPath],
  );
  const commitScope = desktop?.commitScope;
  const commits = commitScope?.commits ?? [];
  const targetBaseCommit = commitScope?.targetBaseCommit ?? null;
  useEffect(() => {
    versionUnitScopeRef.current += 1;
    let canceled = false;
    queueMicrotask(() => {
      if (!canceled) {
        setSelectedVersionUnitIds(new Set());
        setVersionUnitFiles({});
        setVersionUnitLoadingIds(new Set());
        setVersionUnitErrors({});
        selectPath(versionCompare?.files[0]?.path ?? snapshot.files[0]?.path ?? null);
      }
    });
    return () => {
      canceled = true;
    };
  }, [
    selectPath,
    snapshot.files,
    versionCompare?.files,
    versionCompare?.from.versionId,
    versionCompare?.to.versionId,
  ]);

  const loadVersionUnit = useCallback(
    (unit: VersionEvolutionUnit) => {
      if (
        versionUnitFiles[unit.unitId] ||
        versionUnitLoadingIds.has(unit.unitId) ||
        !versionComparison?.onLoadUnitDiff
      ) {
        return;
      }
      const scope = versionUnitScopeRef.current;
      setVersionUnitLoadingIds((current) => new Set([...current, unit.unitId]));
      setVersionUnitErrors((current) => {
        const { [unit.unitId]: _error, ...rest } = current;
        return rest;
      });
      void Promise.resolve(versionComparison.onLoadUnitDiff(unit.unitId))
        .then((files) => {
          if (versionUnitScopeRef.current !== scope) {
            return;
          }
          setVersionUnitFiles((current) => ({
            ...current,
            [unit.unitId]: files,
          }));
          selectPath(files[0]?.path ?? null);
        })
        .catch((error: unknown) => {
          if (versionUnitScopeRef.current !== scope) {
            return;
          }
          setVersionUnitErrors((current) => ({
            ...current,
            [unit.unitId]: error instanceof Error ? error.message : String(error),
          }));
        })
        .finally(() => {
          if (versionUnitScopeRef.current !== scope) {
            return;
          }
          setVersionUnitLoadingIds((current) => {
            const next = new Set(current);
            next.delete(unit.unitId);
            return next;
          });
        });
    },
    [selectPath, versionComparison, versionUnitFiles, versionUnitLoadingIds],
  );

  const selectOnlyVersionUnit = useCallback(
    (unit: VersionEvolutionUnit) => {
      setSelectedVersionUnitIds(new Set([unit.unitId]));
      selectPath(null);
      loadVersionUnit(unit);
    },
    [loadVersionUnit, selectPath],
  );

  const clearVersionUnits = useCallback(() => {
    setSelectedVersionUnitIds(new Set());
    selectPath(versionCompare?.files[0]?.path ?? null);
  }, [selectPath, versionCompare?.files]);

  const clearTreeCommitRange = useCallback(() => {
    treeCommitLoadRequestRef.current += 1;
    setSelectedTreeCommitRange(null);
    setTreeCommitFiles(null);
    setTreeCommitDiffError(null);
    setTreeCommitDiffLoading(false);
    selectPath((versionCompare?.files ?? snapshot.files)[0]?.path ?? null);
  }, [selectPath, snapshot.files, versionCompare?.files]);
  const sourceRevisionKey = getSourceRevisionKey(snapshot.repository.source);
  const previousSourceRevisionKeyRef = useRef(sourceRevisionKey);
  useEffect(() => {
    if (previousSourceRevisionKeyRef.current === sourceRevisionKey) {
      return;
    }
    previousSourceRevisionKeyRef.current = sourceRevisionKey;
    clearTreeCommitRange();
  }, [clearTreeCommitRange, sourceRevisionKey]);
  useEffect(() => {
    if (
      sidebarMode !== 'tree' ||
      selectedTreeCommitRange == null ||
      !commitScope?.onLoadRangeDiff
    ) {
      return;
    }
    const { fromSha, toSha } = selectedTreeCommitRange;
    const requestId = treeCommitLoadRequestRef.current + 1;
    treeCommitLoadRequestRef.current = requestId;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || treeCommitLoadRequestRef.current !== requestId) {
        return;
      }
      setTreeCommitDiffLoading(true);
      setTreeCommitDiffError(null);
      setTreeCommitFiles(null);
    });
    void Promise.resolve(commitScope.onLoadRangeDiff(fromSha, toSha))
      .then((files) => {
        if (cancelled || treeCommitLoadRequestRef.current !== requestId) {
          return;
        }
        setTreeCommitFiles(files);
        const nextPath = files[0]?.path ?? null;
        setUncontrolledSelectedPath(nextPath);
        controlledPreferences?.selectedPath?.onChange(nextPath);
      })
      .catch((error: unknown) => {
        if (!cancelled && treeCommitLoadRequestRef.current === requestId) {
          setTreeCommitDiffError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled && treeCommitLoadRequestRef.current === requestId) {
          setTreeCommitDiffLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    commitScope,
    controlledPreferences?.selectedPath,
    selectedTreeCommitRange,
    setUncontrolledSelectedPath,
    sidebarMode,
  ]);
  const { resizeSidebar, sidebarWidth } = useResizableSidebar({
    collapseThreshold: SIDEBAR_COLLAPSE_THRESHOLD,
    onCollapse: () => setSidebarCollapsed(true),
    onWidthCommit: writeSharedSidebarWidth,
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
  const renderableReviewComments = useMemo(
    () =>
      reviewComments.filter(
        (comment) => isReviewDraft(comment) || comment.resolvedSectionId != null,
      ),
    [reviewComments],
  );
  const assessmentComponents = useMemo(
    () => assessmentComponentByThreadId(sharedWalkthrough),
    [sharedWalkthrough],
  );
  const liveReviewState = useMemo(
    () => ({
      currentThreadStateById: currentThreadStateById(visibleSnapshotReviewComments),
      pendingAssessmentThreadIds,
    }),
    [pendingAssessmentThreadIds, visibleSnapshotReviewComments],
  );
  const {
    activeReviewCommentDraftRef,
    activeReviewCommentDraftState,
    clearCommentFocus,
    createComment: createDraftComment,
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
  const createComment = useCallback(
    (comment: ReviewCommentCreation) => {
      if (localReviewNotes) {
        createDraftComment(comment);
        return;
      }
      if (!comments) {
        return;
      }
      const file = snapshot.files.find((candidate) => candidate.path === comment.filePath);
      const section = file?.sections.find((candidate) => candidate.id === comment.sectionId);
      if (!file || !section) {
        return;
      }
      const targetInput = {
        anchor: comment.anchor,
        file,
        lineNumber: comment.lineNumber,
        section,
        showWhitespace: snapshot.preferences.showWhitespace,
        side: comment.side,
        startLineNumber: comment.startLineNumber,
        startSide: comment.startSide,
      };
      const target =
        comments.destination === 'share'
          ? resolveShareCommentTarget({ ...targetInput, displayedFiles: snapshot.files })
          : resolveProviderCommentTarget({ ...targetInput, canonicalFiles: snapshot.files });
      if (target.status !== 'enabled') {
        return;
      }
      createDraftComment({
        ...comment,
        ...(target.position ? { position: target.position } : {}),
      });
    },
    [
      comments,
      createDraftComment,
      localReviewNotes,
      snapshot.files,
      snapshot.preferences.showWhitespace,
    ],
  );
  const generalCommentThreads = snapshot.repository.generalComments ?? emptyGeneralCommentThreads;
  const generalComments = useMemo(
    () =>
      (snapshot.repository.generalComments ?? emptyGeneralCommentThreads).flatMap(
        (thread) => thread.comments,
      ),
    [snapshot.repository.generalComments],
  );
  const generalCommentCount = generalComments.length;
  const inlineReviewCommentCount = visibleSnapshotReviewComments.length;
  const reviewCommentCount = generalCommentCount + inlineReviewCommentCount;
  const showCommentsTab = comments != null || reviewCommentCount > 0;
  const [generalCommentDraft, setGeneralCommentDraft] = useState('');
  const [generalCommentEditDraft, setGeneralCommentEditDraft] = useState('');
  const [editingGeneralCommentId, setEditingGeneralCommentId] = useState<string | null>(null);
  const [generalCommentEditError, setGeneralCommentEditError] = useState<string | null>(null);
  const [generalCommentEditSubmitting, setGeneralCommentEditSubmitting] = useState(false);
  const [generalCommentError, setGeneralCommentError] = useState<string | null>(null);
  const [focusedGeneralCommentId, setFocusedGeneralCommentId] = useState<string | null>(null);
  const [focusedInlineSidebarCommentId, setFocusedInlineSidebarCommentId] = useState<string | null>(
    null,
  );
  const [focusedReviewCommentPath, setFocusedReviewCommentPath] = useState<string | null>(null);
  const [generalCommentScrollRequest, setGeneralCommentScrollRequest] = useState(0);
  const [generalCommentSubmitting, setGeneralCommentSubmitting] = useState(false);
  const [pullRequestReviewSubmitting, setPullRequestReviewSubmitting] =
    useState<PullRequestReviewEvent | null>(null);
  const [pullRequestCloseSubmitting, setPullRequestCloseSubmitting] = useState(false);
  const [pullRequestMergeSubmitting, setPullRequestMergeSubmitting] = useState(false);
  const [walkthroughRequestPending, setWalkthroughRequestPending] = useState(false);
  const walkthroughRequestPendingRef = useRef(false);
  const walkthroughGenerationOptionsRef = useRef<{
    force?: boolean;
    regenerateUnitId?: EvolutionUnitId;
    reviewStructure?: WalkthroughReviewStructure;
  } | null>(null);
  const [walkthroughRequestId, setWalkthroughRequestId] = useState(0);
  const walkthroughRef = useRef(walkthrough);

  const reviewFiles = useMemo(
    () =>
      versionCompare
        ? selectedVersionUnitIds.size > 0
          ? selectedVersionUnitFiles
          : versionCompare.files
        : versionCompareActive
          ? []
          : sidebarMode === 'tree' && selectedTreeCommitRange != null
            ? (treeCommitFiles ?? [])
            : snapshot.files,
    [
      selectedTreeCommitRange,
      selectedVersionUnitFiles,
      selectedVersionUnitIds.size,
      sidebarMode,
      snapshot.files,
      treeCommitFiles,
      versionCompare,
      versionCompareActive,
    ],
  );
  const orderedFiles = useMemo(() => sortFiles(reviewFiles), [reviewFiles]);
  const {
    activeMatch: activeDiffSearchMatch,
    activeMatchIndex: activeDiffSearchMatchIndex,
    closeSearch: closeDiffSearch,
    fileFilteredFiles,
    filters: diffSearchFilters,
    focusRequest: diffSearchFocusRequest,
    matches: diffSearchMatches,
    matchPathSet: diffSearchMatchPathSet,
    moveMatch: moveDiffSearchMatch,
    openSearch: openDiffSearch,
    query: diffSearchQuery,
    updateFilters: updateDiffSearchFilters,
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
    () =>
      new Set([
        ...diffSearchMatchPathSet,
        ...(content?.forceExpandedPaths ?? emptyPaths),
        ...(focusedReviewCommentPath ? [focusedReviewCommentPath] : []),
      ]),
    [content?.forceExpandedPaths, diffSearchMatchPathSet, focusedReviewCommentPath],
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
      if (mode !== 'tree') {
        clearTreeCommitRange();
      }
      if (activeMode) {
        activeMode.onChange(mode);
      } else {
        setUncontrolledSidebarMode(mode);
      }
    },
    [activeMode, clearTreeCommitRange],
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
      setFocusedReviewCommentPath(null);
      setFocusedGeneralCommentId(commentId);
      setGeneralCommentScrollRequest((current) => current + 1);
    },
    [changeSidebarMode],
  );
  const activateReviewComment = useCallback(
    (commentId: string) => {
      const comment = visibleSnapshotReviewComments.find((candidate) => candidate.id === commentId);
      if (!comment?.resolvedSectionId) {
        changeSidebarMode('comments');
        setFocusedReviewCommentPath(null);
        setFocusedInlineSidebarCommentId(commentId);
        return;
      }
      setFocusedInlineSidebarCommentId(null);
      setFocusedReviewCommentPath(comment.filePath);
      setUncontrolledSelectedPath(comment.filePath);
      controlledPreferences?.selectedPath?.onChange(comment.filePath);
      setTreeScrollTarget((current) => ({
        behavior: 'smooth',
        path: comment.filePath,
        request: (current?.request ?? 0) + 1,
      }));
      changeSidebarMode('tree');
      focusComment(commentId);
    },
    [
      changeSidebarMode,
      controlledPreferences?.selectedPath,
      focusComment,
      setUncontrolledSelectedPath,
      visibleSnapshotReviewComments,
    ],
  );
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
      setEditedReviewCommentBodies((current) => ({
        ...current,
        [commentId]: body,
      }));
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
        comment.remoteSubmit?.status === 'submitting' ||
        comment.remoteSubmit?.status === 'outcome-unknown'
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
      let formattedComments;
      try {
        formattedComments = pendingComments.map((comment) => toProviderCommentSubmission(comment));
      } catch (error) {
        return Promise.reject(error);
      }
      setPullRequestReviewSubmitting(event);
      return Promise.resolve()
        .then(() =>
          reviewSession.submit({
            comments: formattedComments,
            outcome: toProviderReviewOutcome(event),
            ...(body?.trim() ? { summary: body } : {}),
          }),
        )
        .then((result) => {
          const submittedDraftIds = new Set(result.submittedDraftIds);
          const outcomeUnknownDraftIds = new Set(
            result.status === 'failed' ? (result.outcomeUnknownDraftIds ?? []) : [],
          );
          if (
            activeReviewCommentDraftRef.current &&
            submittedDraftIds.has(activeReviewCommentDraftRef.current.id)
          ) {
            updateActiveReviewCommentDraft(null);
          }
          setLocalReviewComments((current) =>
            current
              .filter((comment) => !submittedDraftIds.has(comment.id))
              .map((comment) =>
                outcomeUnknownDraftIds.has(comment.id) && isProviderCommentDraft(comment)
                  ? {
                      ...comment,
                      remoteSubmit: {
                        error: 'Provider outcome is unknown. Refresh and inspect before retrying.',
                        status: 'outcome-unknown' as const,
                      },
                    }
                  : comment,
              ),
          );
          if (result.status === 'failed') {
            throw new Error(result.reason);
          }
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
    const options = walkthroughGenerationOptionsRef.current;
    walkthroughGenerationOptionsRef.current = null;
    void Promise.resolve(walkthroughRef.current?.onGenerate?.(options ?? undefined))
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

  const startWalkthroughGeneration = useCallback(
    (options?: {
      force?: boolean;
      regenerateUnitId?: EvolutionUnitId;
      reviewStructure?: WalkthroughReviewStructure;
    }) => {
      if (
        !walkthrough?.onGenerate ||
        walkthrough.status === 'generating' ||
        walkthroughRequestPendingRef.current
      ) {
        return;
      }

      walkthroughGenerationOptionsRef.current = options ?? null;
      walkthroughRequestPendingRef.current = true;
      setWalkthroughRequestPending(true);
      setWalkthroughRequestId((current) => current + 1);
    },
    [walkthrough],
  );
  useEffect(() => {
    if (
      sidebarMode === 'walkthrough' &&
      walkthrough?.status === 'idle' &&
      walkthrough.generationReady !== false
    ) {
      startWalkthroughGeneration({ reviewStructure: walkthroughReviewStructure });
    }
  }, [
    sidebarMode,
    startWalkthroughGeneration,
    walkthrough?.generationReady,
    walkthrough?.status,
    walkthroughReviewStructure,
  ]);
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
  const activateTreePath = useCallback(
    (path: string) => {
      setFocusedReviewCommentPath(null);
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
    setSidebarCollapsed(false);
    changeSidebarMode('tree');
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('.review-surface .sidebar-search');
      input?.focus();
      input?.select();
    });
  }, [changeSidebarMode]);
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
    onToggleSidebar: () => setSidebarCollapsed((current) => !current),
    onToggleWordWrap: toggleWordWrap,
    shouldDeferHunkNavigation: () => sidebarMode === 'walkthrough',
    sidebarCollapsed,
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
        {
          execute: () => changeSidebarMode('tree'),
          id: 'sidebar-tree',
          title: 'Show File Tree',
        },
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
          execute: () => setSidebarCollapsed((current) => !current),
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
      copyPendingCommentsLabel,
      getPersistenceState: () => ({
        mode: sidebarMode,
        selectedPath: visibleSelectedPath,
      }),
      openDiffSearch,
    }),
    [
      copyPendingCommentsLabel,
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
  const source = snapshot.repository.source;
  const sourceDescriptionModel = useMemo(
    () =>
      buildSourceDescriptionModel({
        commitMetadata: snapshot.commitMetadata ?? null,
        source,
      }),
    [snapshot.commitMetadata, source],
  );
  const [sourceDescriptionCollapsedByIdentity, setSourceDescriptionCollapsedByIdentity] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const sourceDescriptionCollapsed = sourceDescriptionModel
    ? (sourceDescriptionCollapsedByIdentity[sourceDescriptionModel.identity] ??
      sourceDescriptionModel.defaultCollapsed)
    : false;
  const changeSourceDescriptionCollapsed = useCallback(
    (collapsed: boolean) => {
      if (!sourceDescriptionModel) {
        return;
      }
      setSourceDescriptionCollapsedByIdentity((current) => ({
        ...current,
        [sourceDescriptionModel.identity]: collapsed,
      }));
    },
    [sourceDescriptionModel],
  );
  const commonReviewProps = {
    activeSearchMatch: activeDiffSearchMatch,
    agentId: sharedWalkthrough.agent,
    agentLabel: getAgentLabel(sharedWalkthrough.agent),
    assessmentComponents,
    codeQualityFindings: snapshot.codeQualityFindings,
    collapsed,
    comments: renderableReviewComments,
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
    liveReviewState,
    loadingSectionIds: content?.loadingSectionIds ?? new Set<string>(),
    onAskCodex:
      localReviewNotes?.onAsk || providerComments?.authoring.onAsk || shareComments?.authoring.onAsk
        ? askReviewAssistant
        : undefined,
    onCommentDraftChange: updateActiveReviewCommentDraft,
    onCreateComment: createComment,
    onDeleteComment: deleteComment,
    onLoadImageContent: content?.onLoadImageContent,
    onLoadSection: content?.onLoadSection,
    onOpenFile: desktop?.onOpenFile,
    onRefreshMarkdown: content?.onRefreshMarkdown,
    onResolveThread: resolveDiscussion ?? noop,
    onSaveCommentEdit: updateExistingReviewComment,
    onSelectPathFromScroll: noop,
    onSourceDescriptionCollapsedChange: changeSourceDescriptionCollapsed,
    onSubmitComment: submitComment,
    onToggleCollapsed: toggleCollapsed,
    onToggleViewed: toggleViewed,
    onUpdateComment: updateComment,
    onUpdateSourceDescription: sourceNavigation?.onUpdateDescription,
    onUpdateSourceTitle: sourceNavigation?.onUpdateTitle,
    onUploadSourceDescriptionAsset: sourceNavigation?.onUploadDescriptionAsset,
    resolveReviewContext: content?.resolveReviewContext,
    searchQuery: diffSearchQuery,
    showWhitespace: snapshot.preferences.showWhitespace,
    source: snapshot.repository.source,
    sourceDescriptionCollapsed,
    supportsReviewCommentActions: submitReviewComment != null,
    targetVersionId: versionCompareActive ? versionCompare?.to.versionId : undefined,
    theme: snapshot.preferences.theme,
    viewed,
    wordWrap,
  };
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
    (reviewSession || sourceNavigation?.onClosePullRequest) && source.type === 'pull-request' ? (
      <PullRequestReviewButtons
        disabled={pullRequestReviewSubmitting != null || pullRequestCloseSubmitting}
        hasPendingComments={
          getPendingPullRequestReviewComments(
            localReviewComments.filter(isProviderCommentDraft),
            activeReviewCommentDraftState,
          ).length > 0
        }
        onClosePullRequest={sourceNavigation?.onClosePullRequest ? closePullRequest : undefined}
        onSubmitReview={reviewSession ? submitReview : undefined}
        reviewStatus={source.reviewStatus}
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
  const sourceDescription =
    source.type === 'pull-request' ? (
      <PullRequestSourceDescription
        actions={sourceDescriptionActions}
        collapsed={sourceDescriptionCollapsed}
        footer={sourceDescriptionFooterMain}
        footerAside={sourceDescriptionFooterAside}
        keymap={keymap}
        onCollapsedChange={changeSourceDescriptionCollapsed}
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
        sourceDescriptionFooter={sourceDescriptionFooterMain}
        sourceDescriptionFooterAside={sourceDescriptionFooterAside}
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
  const targetComparisonRange = snapshot.files
    .flatMap((file) => file.sections)
    .find((section) => section.range)?.range;
  const targetBaseSha =
    targetComparisonRange && 'sha' in targetComparisonRange.base
      ? targetComparisonRange.base.sha
      : null;
  const targetHeadSha =
    targetComparisonRange && 'sha' in targetComparisonRange.head
      ? targetComparisonRange.head.sha
      : snapshot.repository.source.type === 'pull-request' && snapshot.repository.source.headSha
        ? (snapshot.repository.source.headSha as GitSha)
        : null;
  const targetBranch =
    snapshot.repository.source.type === 'pull-request'
      ? (snapshot.repository.source.targetBranch ?? 'target')
      : 'target';
  const targetBaseCommitSummary = targetBaseSha
    ? targetBaseCommit?.sha === targetBaseSha
      ? targetBaseCommit
      : {
          authoredAt: '',
          authorName: '',
          parentShas: [],
          sha: targetBaseSha,
          shortSha: targetBaseSha.slice(0, 8),
          subject: `${targetBranch} base`,
        }
    : null;
  const targetHeadCommitSummary = targetHeadSha
    ? (commits.find((commit) => commit.sha === targetHeadSha) ?? {
        authoredAt: '',
        authorName: '',
        parentShas: [],
        sha: targetHeadSha,
        shortSha: targetHeadSha.slice(0, 8),
        subject: 'Head',
      })
    : null;
  const versionCompareFrom =
    versions.find((version) => version.versionId === versionCompareFromVersionId) ??
    versionCompare?.from;
  const versionCompareTo =
    versions.find((version) => version.versionId === versionCompareToVersionId) ??
    versionCompare?.to;
  const defaultVersionPair = suggestReviewComparison(versions);
  const pickerFromVersionId =
    versionCompareFromVersionId ?? defaultVersionPair?.fromVersionId ?? null;
  const pickerToVersionId = versionCompareToVersionId ?? defaultVersionPair?.toVersionId ?? null;
  const pairSessionKey = `codiff:review-comparison:${getSourceKey(snapshot.repository.source)}`;
  const isValidVersionPair = useCallback(
    (
      fromVersionId: ReviewVersionId | null | undefined,
      toVersionId: ReviewVersionId | null | undefined,
    ) => {
      const fromIndex = versions.findIndex((version) => version.versionId === fromVersionId);
      const toIndex = versions.findIndex((version) => version.versionId === toVersionId);
      return fromIndex >= 0 && toIndex > fromIndex;
    },
    [versions],
  );
  useEffect(() => {
    if (
      !versionCompareActive ||
      versionHistoryLoading ||
      !onVersionCompareRangeChange ||
      isValidVersionPair(versionCompareFromVersionId, versionCompareToVersionId)
    ) {
      return;
    }

    let restored: {
      fromVersionId?: ReviewVersionId;
      toVersionId?: ReviewVersionId;
    } | null = null;
    try {
      restored = JSON.parse(sessionStorage.getItem(pairSessionKey) ?? 'null');
    } catch {
      restored = null;
    }
    if (isValidVersionPair(restored?.fromVersionId, restored?.toVersionId)) {
      onVersionCompareRangeChange(restored!.fromVersionId!, restored!.toVersionId!);
      return;
    }
    const suggested = suggestReviewComparison(versions);
    if (suggested && isValidVersionPair(suggested.fromVersionId, suggested.toVersionId)) {
      onVersionCompareRangeChange(suggested.fromVersionId, suggested.toVersionId);
    }
  }, [
    onVersionCompareRangeChange,
    isValidVersionPair,
    pairSessionKey,
    versionCompareActive,
    versionCompareFromVersionId,
    versionCompareToVersionId,
    versionHistoryLoading,
    versions,
  ]);
  const selectVersionPair = (fromVersionId: ReviewVersionId, toVersionId: ReviewVersionId) => {
    if (!isValidVersionPair(fromVersionId, toVersionId)) {
      return;
    }
    try {
      sessionStorage.setItem(pairSessionKey, JSON.stringify({ fromVersionId, toVersionId }));
    } catch {
      // Session restoration is optional in restricted shared/browser contexts.
    }
    onVersionCompareRangeChange?.(fromVersionId, toVersionId);
  };
  const renderTargetComparisonEndpoints = () => (
    <>
      <span className="version-comparison-endpoint">
        <span>From · {targetBranch}</span>
        {targetBaseCommitSummary ? (
          <ReviewCommitRef commit={targetBaseCommitSummary} linkTrigger={false} />
        ) : null}
      </span>
      {' → '}
      <span className="version-comparison-endpoint">
        <span>To · Head</span>
        {targetHeadCommitSummary ? (
          <ReviewCommitRef commit={targetHeadCommitSummary} linkTrigger={false} />
        ) : null}
      </span>
    </>
  );
  const selectedEvolutionKind = selectedVersionUnit?.kind;
  const diffScopeSummary = versionCompareActive ? (
    versionCompareFrom && versionCompareTo ? (
      <>
        <VersionComparisonEndpoint version={versionCompareFrom} />
        {' → '}
        <VersionComparisonEndpoint version={versionCompareTo} />
        {selectedEvolutionKind ? (
          <span className={`comparison-kind-pill ${selectedEvolutionKind}`}>
            {selectedEvolutionKind.replaceAll('-', ' ')}
          </span>
        ) : null}
      </>
    ) : (
      <span>Choose versions</span>
    )
  ) : (
    <>
      {renderTargetComparisonEndpoints()}
      <span className="comparison-range-pill">
        {selectedTreeCommitRange
          ? `${selectedTreeCommitRange.fromSha.slice(0, 7)} → ${selectedTreeCommitRange.toSha.slice(0, 7)}`
          : 'All commit changes'}
      </span>
    </>
  );
  const selectVersionComparisonScope = () => {
    if (versionCompareActive) {
      return;
    }
    clearTreeCommitRange();
    setVersionSectionExpanded(true);
    versionComparison?.onOpen?.();
  };
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
  const requestWalkthrough = (options?: {
    force?: boolean;
    regenerateUnitId?: EvolutionUnitId;
    reviewStructure?: WalkthroughReviewStructure;
  }) => {
    startWalkthroughGeneration(options);
  };
  const alternateReviewStructure: WalkthroughReviewStructure = versionWalkthrough
    ? walkthroughReviewStructure === 'commit-evolution'
      ? 'complete-comparison'
      : 'commit-evolution'
    : walkthroughReviewStructure === 'commit-by-commit'
      ? 'net-change'
      : 'commit-by-commit';
  const walkthroughGenerationReady = walkthrough?.generationReady !== false;
  const walkthroughStructureControls = walkthrough?.onGenerate ? (
    <div className="history-section walkthrough-structure-controls">
      <span>
        {walkthroughReviewStructure === 'commit-by-commit'
          ? 'Structured by commits'
          : walkthroughReviewStructure === 'net-change'
            ? 'Net-change walkthrough'
            : walkthroughReviewStructure === 'commit-evolution'
              ? 'Commit Evolution'
              : 'Complete Comparison'}
      </span>
      <button
        disabled={
          !walkthroughGenerationReady ||
          walkthroughStatus === 'generating' ||
          walkthroughRequestPending
        }
        onClick={() => {
          if (
            alternateReviewStructure === 'commit-evolution' ||
            alternateReviewStructure === 'complete-comparison'
          ) {
            setSelectedVersionWalkthroughStructure(alternateReviewStructure);
          } else {
            setSelectedTargetWalkthroughStructure(alternateReviewStructure);
          }
          requestWalkthrough({
            force: true,
            reviewStructure: alternateReviewStructure,
          });
        }}
        type="button"
      >
        {alternateReviewStructure === 'commit-by-commit'
          ? 'Use commit-by-commit'
          : alternateReviewStructure === 'net-change'
            ? 'Use net change'
            : alternateReviewStructure === 'commit-evolution'
              ? 'Use Commit Evolution'
              : 'Use Complete Comparison'}
      </button>
      {!walkthroughGenerationReady ? <small>Loading commit structure…</small> : null}
    </div>
  ) : null;
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
            ariaLabel: reviewCommentCount > 0 ? `Comments (${reviewCommentCount})` : 'Comments',
            icon: <ChatCircle aria-hidden size={14} weight="bold" />,
            indicator:
              reviewCommentCount > 0 ? (
                <span aria-hidden className="review-mode-count">
                  {reviewCommentCount}
                </span>
              ) : undefined,
            label: 'Comments',
            title:
              reviewCommentCount > 0
                ? `${reviewCommentCount} ${reviewCommentCount === 1 ? 'comment' : 'comments'}`
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
        }${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
        data-theme={shellTheme}
        style={
          sidebarCollapsed
            ? undefined
            : { gridTemplateColumns: `${sidebarWidth}px 0 minmax(0, 1fr)` }
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
          onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
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
          sidebarCollapsed={sidebarCollapsed}
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
          filters={diffSearchFilters}
          focusRequest={diffSearchFocusRequest}
          keymap={keymap}
          matchCount={diffSearchMatches.length}
          onChange={updateDiffSearchQuery}
          onClose={closeDiffSearch}
          onFiltersChange={updateDiffSearchFilters}
          onNext={() => moveDiffSearchMatch(1)}
          onPrevious={() => moveDiffSearchMatch(-1)}
          query={diffSearchQuery}
          visible={diffSearchVisible}
        />
        <aside className="squircle sidebar">
          <div className="sidebar-search-row">
            <input
              aria-label={sidebarMode === 'history' ? 'Filter history' : 'Filter changed files'}
              className="sidebar-search"
              onChange={(event) =>
                sidebarMode === 'history'
                  ? setHistorySearchQuery(event.currentTarget.value)
                  : setFileSearchQuery(event.currentTarget.value)
              }
              placeholder={sidebarMode === 'history' ? 'Filter history' : 'Filter files'}
              spellCheck={false}
              type="search"
              value={sidebarMode === 'history' ? historySearchQuery : fileSearchQuery}
            />
          </div>
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
              searchQuery={historySearchQuery}
            />
          ) : null}
          {sidebarMode === 'tree' &&
          (versionComparison || commitScope) &&
          snapshot.repository.source.type === 'pull-request' ? (
            <section
              className={`history-section version-comparison-section${
                versionSectionExpanded ? '' : ' collapsed'
              }`}
            >
              <div className="version-comparison-header">
                <button
                  aria-controls="version-comparison-body"
                  aria-expanded={versionSectionExpanded}
                  className="version-comparison-toggle"
                  onClick={() => setVersionSectionExpanded((expanded) => !expanded)}
                  type="button"
                >
                  <span aria-hidden className="version-comparison-toggle-caret">
                    {versionSectionExpanded ? '▾' : '▸'}
                  </span>
                  <span className="version-comparison-toggle-copy">
                    <strong>Comparison</strong>
                    <span className="version-comparison-summary">{diffScopeSummary}</span>
                  </span>
                </button>
                {versionComparison ? (
                  <div aria-label="Comparison" className="diff-scope-control" role="radiogroup">
                    <button
                      aria-checked={!versionCompareActive}
                      className={!versionCompareActive ? 'selected' : ''}
                      onClick={() => versionComparison.onExit?.()}
                      role="radio"
                      type="button"
                    >
                      Compare to <code>{targetBranch}</code>
                    </button>
                    <button
                      aria-checked={versionCompareActive}
                      className={versionCompareActive ? 'selected' : ''}
                      disabled={!versionComparison.onOpen}
                      onClick={selectVersionComparisonScope}
                      role="radio"
                      type="button"
                    >
                      Compare versions
                    </button>
                  </div>
                ) : null}
              </div>
              {versionSectionExpanded && !versionCompareActive ? (
                <div className="version-comparison-body" id="version-comparison-body">
                  <div className="comparison-endpoint-row">{renderTargetComparisonEndpoints()}</div>
                  {commits.length > 0 ? (
                    <CommitScopePanel
                      commits={commits}
                      onClear={clearTreeCommitRange}
                      onSelectCommitRange={(range) => {
                        setSelectedTreeCommitRange(range);
                        setTreeCommitFiles(null);
                        setTreeCommitDiffError(null);
                      }}
                      selectedCommitRange={selectedTreeCommitRange}
                    />
                  ) : null}
                </div>
              ) : null}
              {versionSectionExpanded && versionCompareActive ? (
                <div className="version-comparison-body" id="version-comparison-body">
                  {versionHistoryLoading ? (
                    <div aria-live="polite" className="version-comparison-status" role="status">
                      <span aria-hidden className="version-comparison-spinner" />
                      Loading version history…
                    </div>
                  ) : versions.length >= 2 &&
                    pickerFromVersionId &&
                    pickerToVersionId &&
                    onVersionCompareRangeChange ? (
                    <div className="version-picker-pair">
                      <VersionPicker
                        endpoint="from"
                        label="From"
                        onChange={(fromVersionId) =>
                          selectVersionPair(fromVersionId, pickerToVersionId)
                        }
                        otherId={versionCompareToVersionId}
                        value={pickerFromVersionId}
                        versions={versions}
                      />
                      <VersionPicker
                        endpoint="to"
                        label="To"
                        onChange={(toVersionId) =>
                          selectVersionPair(pickerFromVersionId, toVersionId)
                        }
                        otherId={versionCompareFromVersionId}
                        value={pickerToVersionId}
                        versions={versions}
                      />
                    </div>
                  ) : null}
                  {versionCompare?.analysis.baseMovement?.changed ? (
                    <div className="version-base-movement" role="status">
                      <div>
                        <strong>Base changed</strong>{' '}
                        <CommitRefTooltip
                          commit={{
                            authoredAt: versionCompare.analysis.baseMovement.from.committedAt,
                            sha: versionCompare.analysis.baseMovement.from.sha,
                            shortSha: versionCompare.analysis.baseMovement.from.shortSha,
                            subject: 'From target base',
                            webUrl: versionCompare.analysis.baseMovement.from.webUrl,
                          }}
                        />{' '}
                        →{' '}
                        <CommitRefTooltip
                          commit={{
                            authoredAt: versionCompare.analysis.baseMovement.to.committedAt,
                            sha: versionCompare.analysis.baseMovement.to.sha,
                            shortSha: versionCompare.analysis.baseMovement.to.shortSha,
                            subject: 'To target base',
                            webUrl: versionCompare.analysis.baseMovement.to.webUrl,
                          }}
                        />
                      </div>
                      {versionCompare.analysis.baseMovement.diffStat ? (
                        <div className="version-base-movement-stat">
                          {formatBaseMovementCommitCount(versionCompare.analysis.baseMovement)} ·{' '}
                          {versionCompare.analysis.baseMovement.diffStat.filesChanged} files ·{' '}
                          <span className="diffstat-additions">
                            +{versionCompare.analysis.baseMovement.diffStat.additions}
                          </span>{' '}
                          <span className="diffstat-deletions">
                            −{versionCompare.analysis.baseMovement.diffStat.deletions}
                          </span>{' '}
                          ·{' '}
                          {formatBaseMovementRelationship(
                            versionCompare.analysis.baseMovement.relationship,
                          )}
                          {formatSignedBaseInterval(
                            versionCompare.analysis.baseMovement.commitTimestampDeltaMs,
                          )
                            ? ` · ${formatSignedBaseInterval(
                                versionCompare.analysis.baseMovement.commitTimestampDeltaMs,
                              )}`
                            : ''}
                        </div>
                      ) : null}
                      {(versionCompare.analysis.baseMovement.commits?.length ?? 0) > 0 ? (
                        <details className="version-base-movement-commits">
                          <summary>
                            {versionCompare.analysis.baseMovement.relationship === 'backward'
                              ? 'Show previous base commits'
                              : 'Show new base commits'}{' '}
                            ({formatBaseMovementCommitCount(versionCompare.analysis.baseMovement)})
                          </summary>
                          <div className="version-commit-evolution-list version-base-movement-commit-list">
                            {(versionCompare.analysis.baseMovement.commits ?? []).map((commit) => (
                              <div
                                className="version-commit-unit version-base-movement-commit"
                                key={commit.sha}
                              >
                                <CommitRefTooltip commit={commit} />
                                <span>{commit.subject}</span>
                              </div>
                            ))}
                          </div>
                        </details>
                      ) : null}
                      {versionCompare.analysis.baseMovement.warning ? (
                        <small>{versionCompare.analysis.baseMovement.warning}</small>
                      ) : null}
                      <small>
                        Base branch changes are context only and excluded from this review.
                      </small>
                    </div>
                  ) : null}
                  {versionCompareLoading ? (
                    <div aria-live="polite" className="version-comparison-status" role="status">
                      <span aria-hidden className="version-comparison-spinner" />
                      Computing changes between versions…
                    </div>
                  ) : null}
                  {versionCompareError ? (
                    <div className="version-comparison-status error">{versionCompareError}</div>
                  ) : null}
                  <div className="version-commit-stack-header">
                    <strong>Commit stack</strong>
                    <button
                      disabled={selectedVersionUnitIds.size === 0}
                      onClick={clearVersionUnits}
                      type="button"
                    >
                      View all commit changes
                    </button>
                  </div>
                  {versionCommitEvolutionLoading ? (
                    <div aria-live="polite" className="version-comparison-status" role="status">
                      <span aria-hidden className="version-comparison-spinner" />
                      {versionCommitEvolutionProgress?.message ?? 'Analyzing commit evolution…'}
                    </div>
                  ) : null}
                  {versionCommitEvolutionError ? (
                    <details className="version-comparison-status error">
                      <summary>Commit evolution could not be analyzed</summary>
                      <small>{versionCommitEvolutionError}</small>
                    </details>
                  ) : null}
                  {versionCommitEvolution ? (
                    <div className="version-commit-evolution">
                      <div className="version-commit-evolution-list">
                        {versionCommitEvolution.warnings?.map((warning) => (
                          <div className="version-commit-warning" key={warning}>
                            {warning}
                          </div>
                        ))}
                        {versionCommitEvolution.units.map((unit) => {
                          if (unit.kind === 'commit') {
                            return null;
                          }
                          const commit = evolutionUnitCommit(unit);
                          if (!commit) {
                            return null;
                          }
                          const unchanged =
                            unit.kind === 'retained' ||
                            unit.kind === 'rewritten-same-patch' ||
                            unit.kind === 'absorbed-into-base';
                          const symbol =
                            unit.kind === 'introduced'
                              ? '+'
                              : unit.kind === 'removed'
                                ? '−'
                                : unit.kind === 'revised'
                                  ? '~'
                                  : unit.kind === 'absorbed-into-base'
                                    ? '↳'
                                    : unit.kind === 'ambiguous'
                                      ? '?'
                                      : '·';
                          const kindClass = unchanged ? 'unchanged' : unit.kind;
                          const overlaps = evolutionUnitRebaseOverlaps(unit);
                          return (
                            <div className="version-commit-unit-block" key={unit.unitId}>
                              <button
                                aria-pressed={selectedVersionUnitIds.has(unit.unitId)}
                                className={`version-commit-unit ${kindClass}`}
                                disabled={!unit.reviewable}
                                onClick={() => {
                                  if (unit.reviewable) {
                                    selectOnlyVersionUnit(unit);
                                  }
                                }}
                                type="button"
                              >
                                <span className={`version-commit-kind ${kindClass}`}>{symbol}</span>
                                <ReviewCommitRef
                                  commit={commit}
                                  focusable={false}
                                  linkTrigger={false}
                                />
                                <span>{commit.subject}</span>
                              </button>
                              {overlaps.length > 0 ? (
                                <div className="version-commit-rebase-overlaps">
                                  <span className="version-commit-rebase-overlaps-label">
                                    Rebase overlap
                                  </span>
                                  {overlaps.map((overlap) => (
                                    <div
                                      className="version-commit-unit version-base-movement-commit"
                                      key={`${unit.unitId}:${overlap.sha}`}
                                    >
                                      <CommitRefTooltip commit={overlap} />
                                      <span>{overlap.subject}</span>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                  {selectedVersionUnit ? (
                    <div className="version-unit-scope">
                      <span>Viewing one commit change</span>
                      <button onClick={clearVersionUnits} type="button">
                        View all commit changes
                      </button>
                    </div>
                  ) : null}
                  {versionCompare && !versionCompare.analysis.summary.empty ? (
                    <div className="version-walkthrough-structure">
                      <strong>Walkthrough structure</strong>
                      <label>
                        <input
                          checked={selectedVersionWalkthroughStructure === 'commit-evolution'}
                          disabled={
                            !versionCommitEvolution?.summary.completeCoverage ||
                            versionCommitEvolution.summary.reviewable === 0
                          }
                          name="version-walkthrough-structure"
                          onChange={() =>
                            setSelectedVersionWalkthroughStructure('commit-evolution')
                          }
                          type="radio"
                        />
                        Commit Evolution
                        {versionCommitEvolution?.recommendation.suggestedStructure ===
                        'commit-evolution'
                          ? ' — Recommended'
                          : ''}
                      </label>
                      <label>
                        <input
                          checked={selectedVersionWalkthroughStructure === 'complete-comparison'}
                          name="version-walkthrough-structure"
                          onChange={() =>
                            setSelectedVersionWalkthroughStructure('complete-comparison')
                          }
                          type="radio"
                        />
                        Complete Comparison
                        {versionCommitEvolution?.recommendation.suggestedStructure ===
                        'complete-comparison'
                          ? ' — Recommended'
                          : ''}
                      </label>
                      <small>
                        {versionCommitEvolution?.recommendation.rationale ??
                          'Complete Comparison is available while commit evolution loads.'}
                      </small>
                      <button
                        aria-label={`Generate ${selectedVersionWalkthroughStructure} walkthrough`}
                        disabled={walkthroughStatus === 'generating' || walkthroughRequestPending}
                        onClick={() => {
                          requestWalkthrough({
                            reviewStructure: selectedVersionWalkthroughStructure,
                          });
                          setVersionSectionExpanded(false);
                          changeSidebarMode('walkthrough');
                        }}
                        type="button"
                      >
                        Generate{' '}
                        {selectedVersionWalkthroughStructure === 'commit-evolution'
                          ? 'Commit Evolution'
                          : 'Complete Comparison'}
                      </button>
                    </div>
                  ) : null}
                  {versionCompare && versionCompare.analysis.summary.empty ? (
                    <div className="version-comparison-status">
                      {versionCommitEvolution?.summary.reviewable
                        ? 'The final patch is equivalent, but the commit stack changed.'
                        : 'These versions have no intentional review changes.'}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}
          {sidebarMode === 'tree' ? (
            versionCompareActive && selectedVersionUnit && versionUnitLoading ? (
              <div className="sidebar-scope-status">Loading selected commit changes…</div>
            ) : versionCompareActive && selectedVersionUnit && versionUnitError ? (
              <div className="sidebar-scope-status error">{versionUnitError}</div>
            ) : treeCommitDiffLoading && selectedTreeCommitRange != null ? (
              <div className="sidebar-scope-status">Loading selected commit changes…</div>
            ) : treeCommitDiffError ? (
              <div className="sidebar-scope-status error">{treeCommitDiffError}</div>
            ) : (
              <ReviewFileTree
                files={visibleFiles}
                onActivatePath={activateTreePath}
                reloadDeltaPaths={desktop?.reloadDeltaPaths}
                scrollSelectedPathIntoView={content?.initialScrollTarget != null}
                selectedPath={visibleSelectedPath}
                showWhitespace={snapshot.preferences.showWhitespace}
                viewed={viewed}
              />
            )
          ) : sidebarMode === 'comments' ? (
            <>
              <SidebarCommentSection count={generalComments.length} title="Overview comments">
                <SidebarGeneralCommentList
                  comments={generalComments}
                  focusedCommentId={focusedGeneralCommentId}
                  onActivateComment={activateGeneralComment}
                />
              </SidebarCommentSection>
              <SidebarCommentSection
                count={inlineReviewCommentCount}
                title="Inline review comments"
              >
                <SidebarInlineReviewCommentList
                  comments={visibleSnapshotReviewComments}
                  focusedCommentId={focusedInlineSidebarCommentId ?? focusCommentId}
                  onActivateComment={activateReviewComment}
                  permalinkLabel={
                    comments?.destination === 'share'
                      ? 'View on Codiff'
                      : `View on ${providerLabel}`
                  }
                />
              </SidebarCommentSection>
            </>
          ) : sidebarMode === 'history' ? null : (
            <>
              {walkthroughStructureControls}
              {walkthroughReady ? (
                <NarrativeSidebar
                  allowCommit={walkthrough?.commit != null}
                  files={visibleFiles}
                  navigation={navigation}
                  onRegenerateUnit={
                    walkthrough?.onGenerate
                      ? (unitId) => requestWalkthrough({ regenerateUnitId: unitId })
                      : undefined
                  }
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
                    {walkthroughStatusDescription ? (
                      <span>{walkthroughStatusDescription}</span>
                    ) : null}
                  </div>
                </div>
              )}
            </>
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
              commentPermalinkLabel={
                comments?.destination === 'share' ? 'View on Codiff' : `View on ${providerLabel}`
              }
              draft={generalCommentDraft}
              editDraft={generalCommentEditDraft}
              editError={generalCommentEditError}
              editingCommentId={editingGeneralCommentId}
              editSubmitting={generalCommentEditSubmitting}
              error={generalCommentError}
              focusedCommentId={focusedGeneralCommentId}
              focusedCommentRequest={generalCommentScrollRequest}
              gitIdentity={gitIdentity}
              inlineCommentCount={inlineReviewCommentCount}
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
          ) : sidebarMode === 'tree' && versionCompareLoading && !versionCompare ? (
            <div className="loading codex italic">Computing changes between versions…</div>
          ) : sidebarMode === 'tree' &&
            versionCompareActive &&
            selectedVersionUnit != null &&
            versionUnitLoading &&
            selectedVersionUnitFiles.length === 0 ? (
            <div className="loading codex italic">Loading selected commit changes…</div>
          ) : sidebarMode === 'tree' &&
            versionCompareActive &&
            selectedVersionUnit != null &&
            versionUnitError &&
            selectedVersionUnitFiles.length === 0 ? (
            <div className="empty-state">
              <div className="empty-panel squircle">
                <strong>Unable to load selected commit changes</strong>
                <p>{versionUnitError}</p>
              </div>
            </div>
          ) : sidebarMode === 'tree' && treeCommitDiffLoading && selectedTreeCommitRange != null ? (
            <div className="loading codex italic">Loading selected commit changes…</div>
          ) : sidebarMode === 'tree' && treeCommitDiffError ? (
            <div className="empty-state">
              <div className="empty-panel squircle">
                <strong>Unable to load selected commit changes</strong>
                <p>{treeCommitDiffError}</p>
              </div>
            </div>
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
                    {hasDiffSearchQuery
                      ? 'No matches in diffs'
                      : fileSearchQuery
                        ? 'No matching files'
                        : 'No files in this diff'}
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
                key={
                  versionCompareActive
                    ? `version:${selectedVersionUnit?.unitId ?? 'all'}`
                    : selectedTreeCommitRange
                      ? `commits:${selectedTreeCommitRange.fromSha}:${selectedTreeCommitRange.toSha}`
                      : 'commits:all'
                }
                onSelectPathFromScroll={updateSelectedPathFromScroll}
                scrollTarget={treeScrollTarget}
                selectedPath={visibleSelectedPath}
                sourceDescriptionActions={sourceDescriptionActions}
                sourceDescriptionFooter={sourceDescriptionFooterMain}
                sourceDescriptionFooterAside={sourceDescriptionFooterAside}
                walkthroughNotes={emptyWalkthroughNotes}
              />
            )
          ) : walkthroughReady ? (
            <NarrativeWalkthroughView
              allowCommit={walkthrough?.commit != null}
              files={walkthroughFiles}
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
                    agentLabel={getAgentLabel(sharedWalkthrough.agent)}
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
                      <button onClick={() => requestWalkthrough()} type="button">
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
