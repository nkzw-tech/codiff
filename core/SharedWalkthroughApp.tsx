import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/ArrowSquareOut';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/ChatCircle';
import { PathIcon as Path } from '@phosphor-icons/react/Path';
import { TreeStructureIcon as TreeStructure } from '@phosphor-icons/react/TreeStructure';
import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from './app/components/Button.tsx';
import { ReviewFileTree } from './app/components/FileTree.tsx';
import {
  MergeRequestCommentsView,
  SidebarGeneralCommentList,
  type ReviewCommenting,
} from './app/components/merge-request/GeneralComments.tsx';
import {
  isTerminalPullRequestMergeState,
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
import { DiffLineCountBadge } from './app/components/Sidebar.tsx';
import { NarrativeSidebar } from './app/components/walkthrough/NarrativeSidebar.tsx';
import {
  NarrativeWalkthroughView,
  type WalkthroughBlockScrollTarget,
} from './app/components/walkthrough/NarrativeWalkthroughView.tsx';
import { useNarrativeNavigation } from './app/components/walkthrough/useNarrativeNavigation.ts';
import { WalkthroughDiffSurface } from './app/components/walkthrough/WalkthroughDiffSurface.tsx';
import { WalkthroughProgress } from './app/components/walkthrough/WalkthroughProgress.tsx';
import {
  getCodeFontLineHeight,
  normalizeCodeFontSizePreference,
  useDocumentAppearance,
} from './app/hooks/useDocumentAppearance.ts';
import { useResizableSidebar } from './app/hooks/useResizableSidebar.ts';
import { useReviewCommentDrafts } from './app/hooks/useReviewCommentDrafts.ts';
import { useReviewFileState } from './app/hooks/useReviewState.ts';
import { createDefaultConfig } from './config/defaults.ts';
import { matchesShortcut } from './config/keymap.ts';
import { getAgentLabel } from './lib/app-constants.ts';
import type { CodeViewInstance, ReviewComment, ReviewScrollTarget } from './lib/app-types.ts';
import {
  fileHasVisibleDiff,
  getDiffLineCount,
  getTotalDiffLineCount,
  isMarkdownFilePath,
} from './lib/diff.ts';
import { abbreviateHomePath, fuzzyMatches, sortFiles } from './lib/files.ts';
import { isNativeInputTarget } from './lib/keyboard.ts';
import { isGeneratedWalkthroughFile } from './lib/narrative-walkthrough-diff.js';
import {
  getPendingPullRequestReviewComments,
  getReviewCommentsFromState,
  mergeReviewComments,
  toSubmittedReviewComment,
  toPullRequestReviewComment,
} from './lib/review-comments.ts';
import { getSelectedPathFromScroll } from './lib/review-scroll.ts';
import {
  SIDEBAR_COLLAPSE_THRESHOLD,
  SIDEBAR_DEFAULT_WIDTH,
  readSidebarWidth,
  writeSidebarWidth,
} from './lib/sidebar-width.ts';
import { getSourceLabel, getSourceKey } from './lib/source.ts';
import type {
  GitIdentity,
  PullRequestMergeOptions,
  PullRequestGeneralComment,
  PullRequestGeneralCommentThread,
  PullRequestExistingReviewComment,
  PullRequestReviewComment,
  PullRequestReviewEvent,
  RepositoryState,
  SharedWalkthroughSnapshot,
  WalkthroughCommitMessageResult,
  WalkthroughCommitResult,
} from './types.ts';

export {
  ReadOnlyGeneralCommentCard,
  type ReviewCommenting,
} from './app/components/merge-request/GeneralComments.tsx';

const emptyReviewComments: ReadonlyArray<ReviewComment> = [];
const emptyGeneralCommentThreads: ReadonlyArray<PullRequestGeneralCommentThread> = [];
const emptyPaths = new Set<string>();
const emptyWalkthroughNotes = new Map();
const readSharedSidebarWidth = () =>
  typeof localStorage === 'undefined' ? SIDEBAR_DEFAULT_WIDTH : readSidebarWidth();

const writeSharedSidebarWidth = (width: number) => {
  if (typeof localStorage !== 'undefined') {
    writeSidebarWidth(width);
  }
};

export type ReviewWalkthroughStatus = 'failed' | 'generating' | 'idle' | 'ready';
export type ReviewMode = 'comments' | 'tree' | 'walkthrough';

const getSnapshotReviewComments = (
  snapshot: SharedWalkthroughSnapshot,
): ReadonlyArray<ReviewComment> => {
  if (!snapshot.reviewComments?.length) {
    return emptyReviewComments;
  }

  return getReviewCommentsFromState({
    branch: snapshot.branch,
    files: snapshot.files,
    generatedAt: Date.parse(snapshot.exportedAt) || Date.now(),
    launchPath: snapshot.repository.root,
    reviewComments: snapshot.reviewComments as ReadonlyArray<PullRequestExistingReviewComment>,
    root: snapshot.repository.root,
    source: snapshot.repository.source,
  } satisfies RepositoryState);
};

const noop = () => {};

const disabledCommit = async (): Promise<WalkthroughCommitResult> => ({
  reason: 'Shared walkthroughs are read-only.',
  status: 'failed',
});

const disabledCommitMessage = async (): Promise<WalkthroughCommitMessageResult> => ({
  reason: 'Shared walkthroughs are read-only.',
  status: 'unavailable',
});

export type ReviewSurfaceProps = {
  commenting?: ReviewCommenting;
  externalUrl?: string;
  gitIdentity?: GitIdentity | null;
  initialMode?: ReviewMode;
  interactive?: {
    onCancelAutoMerge?: () => Promise<void> | void;
    onClosePullRequest?: () => Promise<void> | void;
    onGenerateWalkthrough: () => Promise<void> | void;
    onHome: () => void;
    onMergePullRequest?: (
      options: PullRequestMergeOptions & { autoMerge: boolean },
    ) => Promise<void> | void;
    onResolveDiscussion?: (discussionId: string, resolved: boolean) => Promise<void>;
    onSubmitComment: (
      comment: PullRequestReviewComment,
    ) => Promise<PullRequestExistingReviewComment>;
    onSubmitGeneralComment: (body: string) => Promise<void>;
    onSubmitReview: (
      event: PullRequestReviewEvent,
      comments: ReadonlyArray<PullRequestReviewComment>,
      body?: string,
    ) => Promise<void>;
    onUpdateComment: (commentId: string, body: string) => Promise<void>;
    onUpdateDescription?: (body: string) => Promise<void> | void;
    onUpdateGeneralComment: (commentId: string, body: string) => Promise<void>;
    onUpdateTitle?: (title: string) => Promise<void> | void;
    onUploadDescriptionAsset?: (file: File) => Promise<string> | string;
    walkthroughError?: string | null;
    walkthroughStatus: ReviewWalkthroughStatus;
  };
  onDeleteShare?: () => Promise<void> | void;
  onModeChange?: (mode: ReviewMode) => void;
  providerLabel?: string;
  repositoryUrl?: string;
  settingsBar?: ReactNode;
  sidebarPosition?: 'left' | 'right';
  signInLabel?: string;
  snapshot: SharedWalkthroughSnapshot;
  sourceDescriptionFooterAside?: ReactNode;
  title?: string;
};

export function ReviewSurface({
  commenting,
  externalUrl,
  gitIdentity = null,
  initialMode,
  interactive,
  onDeleteShare,
  onModeChange,
  providerLabel = 'provider',
  repositoryUrl,
  settingsBar,
  sidebarPosition = 'left',
  signInLabel = 'Sign in to comment',
  snapshot,
  sourceDescriptionFooterAside,
  title,
}: ReviewSurfaceProps) {
  const canComment = commenting?.canComment ?? Boolean(interactive);
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
  const submitReviewComment = commenting?.onSubmitComment ?? interactive?.onSubmitComment;
  const submitGeneralDiscussion =
    commenting?.onSubmitGeneralComment ?? interactive?.onSubmitGeneralComment;
  const updateReviewComment = commenting?.onUpdateComment ?? interactive?.onUpdateComment;
  const updateGeneralDiscussion =
    commenting?.onUpdateGeneralComment ?? interactive?.onUpdateGeneralComment;
  const resolveDiscussion = commenting?.onResolveDiscussion ?? interactive?.onResolveDiscussion;
  const sharedWalkthrough = useMemo(
    () => ({
      ...snapshot.walkthrough,
      commit: undefined,
    }),
    [snapshot.walkthrough],
  );
  const navigation = useNarrativeNavigation(
    sharedWalkthrough,
    snapshot.files,
    `${snapshot.repository.root}:${getSourceKey(snapshot.repository.source)}`,
  );
  const keymap = useMemo(() => createDefaultConfig().keymap, []);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [uncontrolledSidebarMode, setUncontrolledSidebarMode] = useState<ReviewMode>(
    () => initialMode ?? (interactive ? 'tree' : 'walkthrough'),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || !matchesShortcut(event, keymap, 'toggleSidebar')) {
        return;
      }
      event.preventDefault();
      setSidebarCollapsed((current) => !current);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [keymap]);
  const isSidebarModeControlled = Boolean(initialMode && onModeChange);
  const sidebarMode =
    isSidebarModeControlled && initialMode ? initialMode : uncontrolledSidebarMode;
  const [treeScrollTarget, setTreeScrollTarget] = useState<ReviewScrollTarget | null>(null);
  const {
    bumpItemVersion,
    collapsed,
    expandedGenerated,
    itemVersionByKey,
    selectedPath,
    setSelectedPath,
    toggleCollapsed,
    toggleViewed,
    viewed,
  } = useReviewFileState({
    initialSelectedPath: snapshot.files[0]?.path ?? null,
  });
  const { resizeSidebar, sidebarWidth } = useResizableSidebar({
    collapseThreshold: SIDEBAR_COLLAPSE_THRESHOLD,
    onCollapse: () => setSidebarCollapsed(true),
    onWidthCommit: writeSharedSidebarWidth,
    position: sidebarPosition,
    readWidth: readSharedSidebarWidth,
  });
  const snapshotReviewComments = useMemo(() => getSnapshotReviewComments(snapshot), [snapshot]);
  const [editedReviewCommentBodies, setEditedReviewCommentBodies] = useState<
    Readonly<Record<string, string>>
  >({});
  const visibleSnapshotReviewComments = useMemo(
    () =>
      snapshotReviewComments.map((comment) =>
        editedReviewCommentBodies[comment.id] != null &&
        editedReviewCommentBodies[comment.id] !== comment.body
          ? { ...comment, body: editedReviewCommentBodies[comment.id] }
          : comment,
      ),
    [editedReviewCommentBodies, snapshotReviewComments],
  );
  const [localReviewComments, setLocalReviewComments] =
    useState<ReadonlyArray<ReviewComment>>(emptyReviewComments);
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
    focusCommentId,
    focusCommentRequest,
    reviewCommentsRef,
    updateActiveReviewCommentDraft,
    updateComment,
  } = useReviewCommentDrafts({
    canCreateComment: canComment,
    comments: reviewComments,
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
  const showCommentsTab = Boolean(commenting || interactive || generalCommentCount > 0);
  const [generalCommentDraft, setGeneralCommentDraft] = useState('');
  const [generalCommentEditDraft, setGeneralCommentEditDraft] = useState('');
  const [editingGeneralCommentId, setEditingGeneralCommentId] = useState<string | null>(null);
  const [generalCommentEditError, setGeneralCommentEditError] = useState<string | null>(null);
  const [generalCommentEditSubmitting, setGeneralCommentEditSubmitting] = useState(false);
  const [generalCommentError, setGeneralCommentError] = useState<string | null>(null);
  const [focusedGeneralCommentId, setFocusedGeneralCommentId] = useState<string | null>(null);
  const [generalCommentScrollRequest, setGeneralCommentScrollRequest] = useState(0);
  const [generalCommentSubmitting, setGeneralCommentSubmitting] = useState(false);
  const [pullRequestReviewSubmitting, setPullRequestReviewSubmitting] =
    useState<PullRequestReviewEvent | null>(null);
  const [pullRequestCloseSubmitting, setPullRequestCloseSubmitting] = useState(false);
  const [pullRequestMergeSubmitting, setPullRequestMergeSubmitting] = useState(false);
  const [walkthroughRequestPending, setWalkthroughRequestPending] = useState(false);
  const walkthroughRequestPendingRef = useRef(false);
  const [walkthroughRequestId, setWalkthroughRequestId] = useState(0);
  const interactiveRef = useRef(interactive);

  const visibleFiles = useMemo(
    () =>
      sortFiles(snapshot.files).filter(
        (file) =>
          fuzzyMatches(file.path, fileSearchQuery) &&
          fileHasVisibleDiff(file, snapshot.preferences.showWhitespace),
      ),
    [fileSearchQuery, snapshot.files, snapshot.preferences.showWhitespace],
  );
  const totalLineCount = useMemo(
    () =>
      getTotalDiffLineCount(
        visibleFiles.map((file) => getDiffLineCount(file, snapshot.preferences.showWhitespace)),
      ),
    [snapshot.preferences.showWhitespace, visibleFiles],
  );
  const showTotalLineCount = sidebarMode !== 'comments' && totalLineCount.countable;
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
      setUncontrolledSidebarMode(mode);
      onModeChange?.(mode);
    },
    [onModeChange],
  );

  const activateGeneralComment = useCallback(
    (commentId: string) => {
      changeSidebarMode('comments');
      setFocusedGeneralCommentId(commentId);
      setGeneralCommentScrollRequest((current) => current + 1);
    },
    [changeSidebarMode],
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
      setEditedReviewCommentBodies((current) => ({ ...current, [commentId]: body }));
      if (comment) {
        bumpItemVersion(comment.filePath);
      }
    },
    [bumpItemVersion, reviewCommentsRef, updateReviewComment],
  );
  const deleteComment = useCallback(
    (commentId: string) => {
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (comment?.isReadOnly && comment.canDelete && commenting?.onDeleteComment) {
        updateActiveReviewCommentDraft(null);
        setLocalReviewComments((current) =>
          current.filter((candidate) => candidate.id !== commentId),
        );
        void commenting.onDeleteComment(commentId).catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : String(error));
        });
        return;
      }
      deleteLocalComment(commentId);
    },
    [commenting, deleteLocalComment, reviewCommentsRef, updateActiveReviewCommentDraft],
  );
  const submitComment = useCallback(
    (commentId: string) => {
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (
        !submitReviewComment ||
        !comment ||
        comment.isReadOnly ||
        !comment.body.trim() ||
        comment.remoteSubmit?.status === 'submitting'
      ) {
        return;
      }

      updateActiveReviewCommentDraft(null);
      setLocalReviewComments((current) =>
        current.map((candidate) =>
          candidate.id === commentId
            ? { ...candidate, remoteSubmit: { status: 'submitting' } }
            : candidate,
        ),
      );
      void submitReviewComment(
        toPullRequestReviewComment(comment, { includeSectionId: commenting != null }),
      )
        .then((submittedComment) => {
          clearCommentFocus(commentId);
          setLocalReviewComments((current) =>
            current.flatMap((candidate) => {
              if (candidate.id !== commentId) {
                return [candidate];
              }
              return [toSubmittedReviewComment(submittedComment, candidate)];
            }),
          );
          bumpItemVersion(comment.filePath);
        })
        .catch((error: unknown) => {
          setLocalReviewComments((current) =>
            current.map((candidate) =>
              candidate.id === commentId
                ? {
                    ...candidate,
                    remoteSubmit: {
                      error: error instanceof Error ? error.message : String(error),
                      status: 'error',
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
      commenting,
      reviewCommentsRef,
      submitReviewComment,
      updateActiveReviewCommentDraft,
    ],
  );
  const submitReview = useCallback(
    (event: PullRequestReviewEvent, body?: string) => {
      const source = snapshot.repository.source;
      if (
        !interactive ||
        pullRequestReviewSubmitting ||
        (source.type === 'pull-request' &&
          isPullRequestReviewActionDisabled(source.reviewStatus, event))
      ) {
        return;
      }

      const pendingComments = getPendingPullRequestReviewComments(
        reviewCommentsRef.current,
        activeReviewCommentDraftRef.current,
      );
      if (event === 'COMMENT' && pendingComments.length === 0 && !body?.trim()) {
        return;
      }
      const pendingIds = new Set(pendingComments.map((comment) => comment.id));
      setPullRequestReviewSubmitting(event);
      const formattedComments = pendingComments.map((comment) =>
        toPullRequestReviewComment(comment),
      );
      const submission = body
        ? interactive.onSubmitReview(event, formattedComments, body)
        : interactive.onSubmitReview(event, formattedComments);
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
      interactive,
      pullRequestReviewSubmitting,
      snapshot.repository.source,
      activeReviewCommentDraftRef,
      reviewCommentsRef,
      updateActiveReviewCommentDraft,
    ],
  );
  const closePullRequest = useCallback(() => {
    const source = snapshot.repository.source;
    if (
      !interactive?.onClosePullRequest ||
      pullRequestCloseSubmitting ||
      source.type !== 'pull-request' ||
      source.reviewStatus?.close?.disabled === true ||
      !source.reviewStatus?.close
    ) {
      return;
    }

    setPullRequestCloseSubmitting(true);
    void Promise.resolve(interactive.onClosePullRequest())
      .catch((error: unknown) => {
        window.alert(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setPullRequestCloseSubmitting(false));
  }, [interactive, pullRequestCloseSubmitting, snapshot.repository.source]);
  const mergePullRequest = useCallback(
    (options: PullRequestMergeOptions & { autoMerge: boolean }) => {
      if (!interactive?.onMergePullRequest || pullRequestMergeSubmitting) {
        return;
      }

      setPullRequestMergeSubmitting(true);
      void Promise.resolve(interactive.onMergePullRequest(options))
        .catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setPullRequestMergeSubmitting(false));
    },
    [interactive, pullRequestMergeSubmitting],
  );
  const cancelAutoMerge = useCallback(() => {
    if (!interactive?.onCancelAutoMerge || pullRequestMergeSubmitting) {
      return;
    }

    setPullRequestMergeSubmitting(true);
    void Promise.resolve(interactive.onCancelAutoMerge())
      .catch((error: unknown) => {
        window.alert(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setPullRequestMergeSubmitting(false));
  }, [interactive, pullRequestMergeSubmitting]);
  useEffect(() => {
    interactiveRef.current = interactive;
  }, [interactive]);

  useEffect(() => {
    if (!walkthroughRequestPending || walkthroughRequestId === 0) {
      return;
    }

    let cancelled = false;
    void Promise.resolve(interactiveRef.current?.onGenerateWalkthrough())
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
      !interactive ||
      interactive.walkthroughStatus === 'generating' ||
      walkthroughRequestPendingRef.current
    ) {
      return;
    }

    walkthroughRequestPendingRef.current = true;
    setWalkthroughRequestPending(true);
    setWalkthroughRequestId((current) => current + 1);
  }, [interactive]);
  useEffect(() => {
    if (sidebarMode === 'walkthrough' && interactive?.walkthroughStatus === 'idle') {
      startWalkthroughGeneration();
    }
  }, [interactive?.walkthroughStatus, sidebarMode, startWalkthroughGeneration]);
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
      setSelectedPath(path);
      setTreeScrollTarget((current) => ({
        behavior: 'smooth',
        path,
        request: (current?.request ?? 0) + 1,
      }));
    },
    [setSelectedPath],
  );
  const updateSelectedPathFromScroll = useCallback(
    (viewer: CodeViewInstance) => {
      const nextPath = getSelectedPathFromScroll(
        viewer,
        visibleFiles,
        snapshot.preferences.showWhitespace,
      );

      if (nextPath) {
        setSelectedPath((current) => (current === nextPath ? current : nextPath));
      }
    },
    [setSelectedPath, snapshot.preferences.showWhitespace, visibleFiles],
  );

  const diffLineHeight = getCodeFontLineHeight(
    normalizeCodeFontSizePreference(snapshot.preferences.codeFontSize),
  );
  const commonReviewProps = {
    activeSearchMatch: null,
    agentId: snapshot.walkthrough.agent,
    agentLabel: getAgentLabel(snapshot.walkthrough.agent),
    codeQualityFindings: snapshot.codeQualityFindings,
    collapsed,
    comments: reviewComments,
    commitMetadata: null,
    diffLineHeight,
    diffStyle: snapshot.preferences.diffStyle,
    disableWorkerPool: true,
    expandedGenerated,
    focusCommentId,
    focusCommentRequest,
    gitIdentity,
    hunkNavigation: null,
    initialMarkdownPreviewSectionIds,
    isReadOnly: !canComment,
    itemVersionByKey,
    keymap,
    loadingSectionIds: new Set<string>(),
    onCommentDraftChange: updateActiveReviewCommentDraft,
    onCreateComment: createComment,
    onDeleteComment: deleteComment,
    onLoadSection: noop,
    onResolveThread: resolveDiscussion ?? noop,
    onSaveCommentEdit: updateExistingReviewComment,
    onSelectPathFromScroll: noop,
    onSubmitComment: submitComment,
    onToggleCollapsed: toggleCollapsed,
    onToggleViewed: toggleViewed,
    onUpdateComment: updateComment,
    onUpdateSourceDescription: interactive?.onUpdateDescription,
    onUpdateSourceTitle: interactive?.onUpdateTitle,
    onUploadSourceDescriptionAsset: interactive?.onUploadDescriptionAsset,
    searchQuery: '',
    showWhitespace: snapshot.preferences.showWhitespace,
    source: snapshot.repository.source,
    supportsReviewCommentActions: submitReviewComment != null,
    theme: snapshot.preferences.theme,
    viewed,
    wordWrap: snapshot.preferences.wordWrap,
  };
  const source = snapshot.repository.source;
  const sourceMergeState = source.type === 'pull-request' ? source.mergeState : undefined;
  const isTerminalMergeState = sourceMergeState
    ? isTerminalPullRequestMergeState(sourceMergeState)
    : false;
  const sourceMergeStatusBadge =
    sourceMergeState && isTerminalMergeState ? (
      <PullRequestMergeStatusBadge mergeState={sourceMergeState} />
    ) : null;
  const sourceDescriptionActions =
    interactive && source.type === 'pull-request' ? (
      <PullRequestReviewButtons
        disabled={pullRequestReviewSubmitting != null || pullRequestCloseSubmitting}
        hasPendingComments={
          getPendingPullRequestReviewComments(localReviewComments, activeReviewCommentDraftState)
            .length > 0
        }
        onClosePullRequest={closePullRequest}
        onSubmitReview={submitReview}
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
    interactive && sourceMergeState && !isTerminalMergeState ? (
      <PullRequestMergeControls
        disabled={pullRequestMergeSubmitting}
        isPending={pullRequestMergeSubmitting}
        mergeState={sourceMergeState}
        onCancelAutoMerge={cancelAutoMerge}
        onMergePullRequest={mergePullRequest}
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
        onUpdateDescription={interactive?.onUpdateDescription}
        onUpdateTitle={interactive?.onUpdateTitle}
        onUploadDescriptionAsset={interactive?.onUploadDescriptionAsset}
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
    walkthroughRequestPending && interactive?.walkthroughStatus !== 'ready'
      ? 'generating'
      : interactive?.walkthroughStatus;
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
  const walkthroughReady = !interactive || walkthroughStatus === 'ready';
  const walkthroughFailed = walkthroughStatus === 'failed';
  const walkthroughStatusTitle = walkthroughFailed
    ? 'Walkthrough unavailable'
    : 'Generating walkthrough…';
  const walkthroughStatusDescription = walkthroughFailed
    ? (interactive?.walkthroughError ?? 'Fix the generation issue, then try again.')
    : null;
  const shellTheme =
    snapshot.preferences.theme === 'system' ? undefined : snapshot.preferences.theme;
  const requestWalkthrough = () => {
    startWalkthroughGeneration();
  };
  const reviewModes = [
    {
      icon: <Path aria-hidden size={14} weight="bold" />,
      label: 'Walkthrough',
      value: 'walkthrough',
    },
    {
      icon: <TreeStructure aria-hidden size={14} weight="bold" />,
      label: 'Tree',
      value: 'tree',
    },
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
    <div
      className={`app-shell share-shell${interactive ? ' merge-request-shell' : ''}${
        sidebarCollapsed ? ' sidebar-collapsed' : ''
      }`}
      data-sidebar-position={sidebarPosition}
      data-theme={shellTheme}
      style={
        sidebarCollapsed
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
        leading={
          interactive ? (
            <button
              aria-label="Back to Codiff"
              className="merge-request-nav-button merge-request-home-button"
              onClick={interactive.onHome}
              title="Back to Codiff"
              type="button"
            >
              <img
                alt=""
                aria-hidden
                className="merge-request-nav-icon"
                draggable={false}
                src="/icon.png"
              />
            </button>
          ) : undefined
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
        sidebarPosition={sidebarPosition}
        toggleTitle={`${sidebarCollapsed ? 'Expand' : 'Collapse'} sidebar`}
      />
      <aside className="squircle sidebar">
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
        {sidebarMode === 'tree' ? (
          <ReviewFileTree
            files={visibleFiles}
            onActivatePath={activateTreePath}
            selectedPath={visibleSelectedPath}
            showWhitespace={snapshot.preferences.showWhitespace}
          />
        ) : sidebarMode === 'comments' ? (
          <SidebarGeneralCommentList
            comments={generalComments}
            focusedCommentId={focusedGeneralCommentId}
            onActivateComment={activateGeneralComment}
          />
        ) : walkthroughReady ? (
          <NarrativeSidebar
            allowCommit={false}
            files={visibleFiles}
            navigation={navigation}
            showWhitespace={snapshot.preferences.showWhitespace}
            walkthrough={sharedWalkthrough}
          />
        ) : (
          <div className="sidebar-walkthrough-status-shell">
            <div
              className={`sidebar-walkthrough-status${walkthroughFailed ? '' : ' codex'}`}
              title={walkthroughStatusDescription ?? undefined}
            >
              {walkthroughFailed ? (
                <strong>{walkthroughStatusTitle}</strong>
              ) : (
                <WalkthroughProgress
                  phase={null}
                  responseLabelIndex={0}
                  stageRevision={walkthroughProgressRevision}
                />
              )}
              {walkthroughStatusDescription ? <span>{walkthroughStatusDescription}</span> : null}
            </div>
          </div>
        )}
        {showTotalLineCount ? (
          <div className="sidebar-settings-bar">
            <DiffLineCountBadge
              ariaLabelPrefix="Total change"
              className="sidebar-total-line-count sidebar-settings-line-count"
              lineCount={totalLineCount}
            />
          </div>
        ) : null}
      </aside>
      <div aria-hidden className="sidebar-resizer" onPointerDown={resizeSidebar} />
      <main className="review codiff-web-review">
        {sidebarMode === 'comments' ? (
          <MergeRequestCommentsView
            canComment={canComment}
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
        ) : sidebarMode === 'tree' ? (
          visibleFiles.length === 0 ? (
            <div className="empty-state">
              <div className="empty-panel squircle">
                <strong>No matching files</strong>
                <span>{fileSearchQuery}</span>
              </div>
            </div>
          ) : (
            <ReviewCodeView
              {...commonReviewProps}
              allowViewedToggle
              files={visibleFiles}
              forceExpandedPaths={emptyPaths}
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
            allowCommit={false}
            files={snapshot.files}
            navigation={navigation}
            onActiveReviewTargetChange={noop}
            onCommit={disabledCommit}
            onUpdateCommitMessage={disabledCommitMessage}
            renderDiffBlocks={renderWalkthroughDiffBlocks}
            showWhitespace={snapshot.preferences.showWhitespace}
            walkthrough={sharedWalkthrough}
          />
        ) : walkthroughFailed ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>{walkthroughStatusTitle}</strong>
              <p>{walkthroughStatusDescription}</p>
              <div className="empty-panel-actions">
                <button onClick={requestWalkthrough} type="button">
                  Try again
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="loading codex">
            <WalkthroughProgress
              phase={null}
              responseLabelIndex={0}
              stageRevision={walkthroughProgressRevision}
            />
          </div>
        )}
      </main>
    </div>
  );
}
