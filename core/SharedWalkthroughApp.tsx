import { MarkdownEditor, type MarkdownEditorHandle } from '@nkzw/mdx-editor';
import useRelativeTime from '@nkzw/use-relative-time';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/ChatCircle';
import type { FileTreeRowDecorationRenderer } from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { ExternalLink, X } from 'lucide-react';
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Gravatar } from './app/components/Gravatar.tsx';
import {
  isTerminalPullRequestMergeState,
  isPullRequestReviewActionDisabled,
  PullRequestMergeControls,
  PullRequestMergeStatusBadge,
  PullRequestReviewButtons,
} from './app/components/Panels.tsx';
import { ReadOnlyMarkdownView } from './app/components/ReadOnlyMarkdownView.tsx';
import {
  PullRequestSourceDescription,
  ReviewCodeView,
  type ReviewDiffBlock,
} from './app/components/ReviewCodeView.tsx';
import { DiffLineCountBadge } from './app/components/Sidebar.tsx';
import { NarrativeSidebar } from './app/components/walkthrough/NarrativeSidebar.tsx';
import {
  NarrativeWalkthroughView,
  type WalkthroughBlockScrollTarget,
} from './app/components/walkthrough/NarrativeWalkthroughView.tsx';
import { useNarrativeNavigation } from './app/components/walkthrough/useNarrativeNavigation.ts';
import { WalkthroughProgress } from './app/components/walkthrough/WalkthroughProgress.tsx';
import { createDefaultConfig } from './config/defaults.ts';
import { matchesShortcut } from './config/keymap.ts';
import type { CodiffKeymap } from './config/types.ts';
import { getAgentLabel } from './lib/app-constants.ts';
import type {
  CodeViewInstance,
  ReviewComment,
  ReviewIdentity,
  ReviewScrollTarget,
} from './lib/app-types.ts';
import { DEFAULT_PADDING } from './lib/code-view-options.ts';
import {
  fileHasVisibleDiff,
  formatTreeLineCount,
  getDiffLineCount,
  getDiffLineCountTitle,
  getFirstVisibleSection,
  getItemId,
  getTotalDiffLineCount,
  isMarkdownFilePath,
} from './lib/diff.ts';
import { compactPath, fileTreeSort, fuzzyMatches, sortFiles, statusForTree } from './lib/files.ts';
import { isNativeInputTarget } from './lib/keyboard.ts';
import { isGeneratedWalkthroughFile } from './lib/narrative-walkthrough-diff.js';
import {
  getCommentKey,
  getReviewCommentsFromState,
  toPullRequestReviewComment,
} from './lib/review-comments.ts';
import {
  updateReviewIdentityCollapsed,
  updateReviewIdentityViewed,
} from './lib/review-identity.ts';
import {
  SIDEBAR_DEFAULT_WIDTH,
  clampSidebarWidth,
  readSidebarWidth,
  writeSidebarWidth,
} from './lib/sidebar-width.ts';
import { getSourceLabel, getSourceKey } from './lib/source.ts';
import type {
  ChangedFile,
  CodiffPreferences,
  GitIdentity,
  NarrativeWalkthrough,
  PullRequestMergeOptions,
  PullRequestGeneralComment,
  PullRequestGeneralCommentThread,
  PullRequestExistingReviewComment,
  PullRequestReviewComment,
  PullRequestReviewEvent,
  ReviewAuthor,
  RepositoryState,
  SharedWalkthroughSnapshot,
  WalkthroughCommitMessageResult,
  WalkthroughCommitResult,
} from './types.ts';

const emptyReviewComments: ReadonlyArray<ReviewComment> = [];
const emptyGeneralCommentThreads: ReadonlyArray<PullRequestGeneralCommentThread> = [];
const emptyPaths = new Set<string>();
const emptyWalkthroughNotes = new Map();
const walkthroughCodeViewBottomInset = 96;
const CODE_FONT_SIZE_DEFAULT = 13;
const defaultSharedPreferences: SharedWalkthroughSnapshot['preferences'] = {
  codeFontFamily: 'Fira Code',
  codeFontSize: CODE_FONT_SIZE_DEFAULT,
  diffStyle: 'split',
  showWhitespace: false,
  theme: 'system',
  wordWrap: false,
};

const readSharedSidebarWidth = () =>
  typeof localStorage === 'undefined' ? SIDEBAR_DEFAULT_WIDTH : readSidebarWidth();

const writeSharedSidebarWidth = (width: number) => {
  if (typeof localStorage !== 'undefined') {
    writeSidebarWidth(width);
  }
};

export type MergeRequestWalkthroughStatus = 'failed' | 'generating' | 'idle' | 'ready';
export type MergeRequestReviewMode = 'comments' | 'tree' | 'walkthrough';

export type SharedWalkthroughCommenting = {
  canComment: boolean;
  onDeleteComment: (commentId: string) => Promise<void>;
  onDeleteGeneralComment: (commentId: string) => Promise<void>;
  onReplyGeneralComment: (threadId: string, body: string) => Promise<void>;
  onResolveDiscussion: (discussionId: string, resolved: boolean) => Promise<void>;
  onSignIn: () => Promise<void> | void;
  onSubmitComment: (comment: PullRequestReviewComment) => Promise<PullRequestExistingReviewComment>;
  onSubmitGeneralComment: (body: string) => Promise<void>;
  onUpdateComment: (commentId: string, body: string) => Promise<void>;
  onUpdateGeneralComment: (commentId: string, body: string) => Promise<void>;
};

export type MergeRequestReviewAppProps = {
  externalUrl: string;
  gitIdentity?: GitIdentity | null;
  initialMode?: MergeRequestReviewMode;
  onCancelAutoMerge?: () => Promise<void> | void;
  onClosePullRequest?: () => Promise<void> | void;
  onGenerateWalkthrough: () => Promise<void> | void;
  onHome: () => void;
  onMergePullRequest?: (
    options: PullRequestMergeOptions & { autoMerge: boolean },
  ) => Promise<void> | void;
  onModeChange?: (mode: MergeRequestReviewMode) => void;
  onResolveDiscussion?: (discussionId: string, resolved: boolean) => Promise<void>;
  onSubmitComment: (comment: PullRequestReviewComment) => Promise<PullRequestExistingReviewComment>;
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
  preferences?: Partial<
    Pick<
      CodiffPreferences,
      'codeFontFamily' | 'codeFontSize' | 'diffStyle' | 'showWhitespace' | 'theme' | 'wordWrap'
    >
  >;
  settingsBar?: ReactNode;
  sourceDescriptionFooterAside?: ReactNode;
  sourceDescriptionFooterAsideKey?: string;
  state: RepositoryState;
  title: string;
  walkthrough: NarrativeWalkthrough | null;
  walkthroughError?: string | null;
  walkthroughStatus: MergeRequestWalkthroughStatus;
};

const getCodeFontLineHeight = (size: number) => Math.round((size * 20) / 13);

const normalizeCodeFontSizePreference = (size: number) =>
  Number.isFinite(size) ? Math.min(32, Math.max(10, Math.round(size))) : CODE_FONT_SIZE_DEFAULT;

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

const getAuthorDisplayName = (author: ReviewAuthor) => author.name || author.login;
const getGeneralCommentElementId = (commentId: string) => `general-comment:${commentId}`;

const scrollCommentIntoContainerView = (container: HTMLElement, element: HTMLElement) => {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const top =
    container.scrollTop +
    elementRect.top -
    containerRect.top -
    Math.max(0, (container.clientHeight - elementRect.height) / 2);

  container.scrollTo({
    behavior: 'smooth',
    top,
  });
};
const plainTextCommentPattern =
  /<!--[\s\S]*?-->|<\/?(?:details|summary)\b[^>]*>|```[\s\S]*?```|`([^`]+)`|\[([^\]]+)\]\([^)]+\)|[*_~>#]+/g;

const getCommentPreview = (body: string) => {
  const preview = body
    .replaceAll(
      plainTextCommentPattern,
      (_, inlineCode: string | undefined, linkText: string | undefined) =>
        inlineCode ?? linkText ?? ' ',
    )
    .replaceAll(/\s+/g, ' ')
    .trim();
  return preview || 'Comment';
};

const formatSubmittedAt = (value: string) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
};

function RelativeSubmittedAtTime({
  submittedAt,
  timestamp,
}: {
  submittedAt: string;
  timestamp: number;
}) {
  const relativeTime = useRelativeTime(timestamp);
  return (
    <time dateTime={submittedAt} title={formatSubmittedAt(submittedAt)}>
      {relativeTime}
    </time>
  );
}

function SubmittedAtTime({ submittedAt }: { submittedAt: string }) {
  const timestamp = Date.parse(submittedAt);
  if (!Number.isFinite(timestamp)) {
    return (
      <time dateTime={submittedAt} title={submittedAt}>
        {submittedAt}
      </time>
    );
  }
  return <RelativeSubmittedAtTime submittedAt={submittedAt} timestamp={timestamp} />;
}

export function ReadOnlyGeneralCommentCard({
  className = '',
  comment,
  focused = false,
}: {
  className?: string;
  comment: PullRequestGeneralComment;
  focused?: boolean;
}) {
  const displayName = getAuthorDisplayName(comment.author);
  const classes = ['review-comment', 'general-comment-card', focused ? 'focused' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={classes} id={getGeneralCommentElementId(comment.id)}>
      <Gravatar fallback={displayName} size="medium" url={comment.author.avatarUrl} />
      <div className="review-comment-body source-description-body">
        <div className="review-comment-header read-only general-comment-header">
          <strong title={`@${comment.author.login}`}>{displayName}</strong>
          {comment.submittedAt ? <SubmittedAtTime submittedAt={comment.submittedAt} /> : null}
        </div>
        <ReadOnlyMarkdownView
          ariaLabel={`Comment by ${displayName}`}
          className="review-comment-markdown-editor general-comment-markdown-editor"
          contentClassName="review-comment-input read-only general-comment-input"
          fallback={<div className="review-comment-input read-only" />}
          value={comment.body}
          variant="embedded"
        />
      </div>
    </article>
  );
}

function GeneralCommentCard({
  comment,
  editDraft,
  editError,
  editing,
  editSubmitting,
  focused,
  keymap,
  onCancelEdit,
  onChangeEditDraft,
  onDelete,
  onSaveEdit,
  onStartEdit,
}: {
  comment: PullRequestGeneralComment;
  editDraft: string;
  editError: string | null;
  editing: boolean;
  editSubmitting: boolean;
  focused: boolean;
  keymap: CodiffKeymap;
  onCancelEdit: () => void;
  onChangeEditDraft: (draft: string) => void;
  onDelete: (commentId: string) => void;
  onSaveEdit: () => void;
  onStartEdit: (comment: PullRequestGeneralComment) => void;
}) {
  const displayName = getAuthorDisplayName(comment.author);
  const canSaveEdit = editing && !editSubmitting && Boolean(editDraft.trim());
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const handleEditKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!matchesShortcut(event, keymap, 'submitComment') || !canSaveEdit) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onSaveEdit();
    },
    [canSaveEdit, keymap, onSaveEdit],
  );
  const setEditorRef = useCallback(
    (editor: MarkdownEditorHandle | null) => {
      editorRef.current = editor;
      if (editor && editing) {
        requestAnimationFrame(() => {
          editor.focus({ defaultSelection: 'rootEnd', preventScroll: true });
        });
      }
    },
    [editing],
  );

  useEffect(() => {
    if (!editing) {
      return;
    }

    requestAnimationFrame(() => {
      editorRef.current?.focus({ defaultSelection: 'rootEnd', preventScroll: true });
    });
  }, [editing]);

  return (
    <article
      className={`review-comment general-comment-card${focused ? ' focused' : ''}`}
      id={getGeneralCommentElementId(comment.id)}
    >
      <Gravatar fallback={displayName} size="medium" url={comment.author.avatarUrl} />
      <div className="review-comment-body source-description-body">
        <div
          className={`review-comment-header read-only general-comment-header${
            comment.canEdit || comment.canDelete || editing ? ' with-comment-action' : ''
          }`}
        >
          <strong title={`@${comment.author.login}`}>{displayName}</strong>
          {comment.submittedAt ? <SubmittedAtTime submittedAt={comment.submittedAt} /> : null}
          {editing ? (
            <span className="general-comment-edit-actions">
              <button
                className="review-comment-action"
                disabled={editSubmitting}
                onClick={onCancelEdit}
                type="button"
              >
                Cancel
              </button>
              <button
                className="review-comment-action"
                disabled={!canSaveEdit}
                onClick={onSaveEdit}
                type="button"
              >
                {editSubmitting ? 'Saving' : 'Save'}
              </button>
            </span>
          ) : (
            <>
              {comment.canEdit ? (
                <button
                  className="review-comment-action"
                  onClick={() => onStartEdit(comment)}
                  type="button"
                >
                  Edit
                </button>
              ) : null}
              {comment.canDelete ? (
                <button
                  aria-label="Delete comment"
                  className="review-comment-delete"
                  onClick={() => onDelete(comment.id)}
                  title="Delete comment"
                  type="button"
                >
                  <X aria-hidden className="review-comment-delete-icon" size={14} />
                </button>
              ) : null}
            </>
          )}
        </div>
        {editing ? (
          <>
            <Suspense fallback={<div className="review-comment-input" />}>
              <MarkdownEditor
                ariaLabel={`Edit comment by ${displayName}`}
                className="review-comment-markdown-editor general-comment-markdown-editor"
                colorScheme="inherit"
                contentClassName="review-comment-input general-comment-input"
                density="compact"
                onChange={onChangeEditDraft}
                onKeyDown={handleEditKeyDown}
                readOnly={editSubmitting}
                ref={setEditorRef}
                spellCheck
                value={editDraft}
                variant="embedded"
              />
            </Suspense>
            {editError ? <div className="review-comment-error">{editError}</div> : null}
          </>
        ) : (
          <ReadOnlyMarkdownView
            ariaLabel={`Comment by ${displayName}`}
            className="review-comment-markdown-editor general-comment-markdown-editor"
            contentClassName="review-comment-input read-only general-comment-input"
            fallback={<div className="review-comment-input read-only" />}
            value={comment.body}
            variant="embedded"
          />
        )}
      </div>
    </article>
  );
}

function GeneralCommentThreadCard({
  canComment,
  editDraft,
  editError,
  editingCommentId,
  editSubmitting,
  focusedCommentId,
  keymap,
  onCancelEdit,
  onChangeEditDraft,
  onDelete,
  onReply,
  onResolve,
  onSaveEdit,
  onStartEdit,
  thread,
}: {
  canComment: boolean;
  editDraft: string;
  editError: string | null;
  editingCommentId: string | null;
  editSubmitting: boolean;
  focusedCommentId: string | null;
  keymap: CodiffKeymap;
  onCancelEdit: () => void;
  onChangeEditDraft: (draft: string) => void;
  onDelete: (commentId: string) => void;
  onReply: (threadId: string, body: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onSaveEdit: () => void;
  onStartEdit: (comment: PullRequestGeneralComment) => void;
  thread: PullRequestGeneralCommentThread;
}) {
  const [replyDraft, setReplyDraft] = useState('');
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const [showReply, setShowReply] = useState(false);
  const [resolving, setResolving] = useState(false);
  const resolved = thread.isResolved === true;
  const submitReply = useCallback(() => {
    const body = replyDraft.trim();
    if (!body || replying) {
      return;
    }
    setReplyError(null);
    setReplying(true);
    void onReply(thread.id, body)
      .then(() => {
        setReplyDraft('');
        setShowReply(false);
      })
      .catch((error: unknown) => {
        setReplyError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setReplying(false));
  }, [onReply, replyDraft, replying, thread.id]);
  const toggleResolved = useCallback(() => {
    if (resolving) {
      return;
    }
    setResolving(true);
    void onResolve(thread.id, !resolved)
      .catch((error: unknown) => {
        window.alert(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setResolving(false));
  }, [onResolve, resolved, resolving, thread.id]);

  return (
    <section className="general-comment-thread">
      {thread.comments.map((comment) => (
        <GeneralCommentCard
          comment={comment}
          editDraft={editDraft}
          editError={editingCommentId === comment.id ? editError : null}
          editing={editingCommentId === comment.id}
          editSubmitting={editSubmitting && editingCommentId === comment.id}
          focused={comment.id === focusedCommentId}
          key={comment.id}
          keymap={keymap}
          onCancelEdit={onCancelEdit}
          onChangeEditDraft={onChangeEditDraft}
          onDelete={onDelete}
          onSaveEdit={onSaveEdit}
          onStartEdit={onStartEdit}
        />
      ))}
      {thread.canReply && canComment && !resolved ? (
        showReply ? (
          <GeneralCommentComposer
            disabled={false}
            draft={replyDraft}
            error={replyError}
            gitIdentity={null}
            keymap={keymap}
            onChangeDraft={setReplyDraft}
            onSubmit={submitReply}
            submitting={replying}
          />
        ) : (
          <div className="review-comment-thread-footer">
            <button
              className="review-comment-action"
              onClick={() => setShowReply(true)}
              type="button"
            >
              Reply
            </button>
          </div>
        )
      ) : null}
      {thread.canResolve ? (
        <div className="review-comment-thread-footer">
          <button
            className="review-comment-action"
            disabled={resolving}
            onClick={toggleResolved}
            type="button"
          >
            {resolving ? 'Saving' : resolved ? 'Reopen' : 'Resolve'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function SidebarGeneralCommentList({
  comments,
  focusedCommentId,
  onActivateComment,
}: {
  comments: ReadonlyArray<PullRequestGeneralComment>;
  focusedCommentId: string | null;
  onActivateComment: (commentId: string) => void;
}) {
  if (comments.length === 0) {
    return (
      <div className="sidebar-comments-empty">
        <strong>No comments yet</strong>
        <span>Start the discussion in the main panel.</span>
      </div>
    );
  }

  return (
    <div className="history-list sidebar-comment-list">
      {comments.map((comment, index) => {
        const displayName = getAuthorDisplayName(comment.author);
        const selected = comment.id === focusedCommentId;
        return (
          <button
            aria-current={selected ? 'true' : undefined}
            className={`history-entry sidebar-comment-entry with-metadata${selected ? ' selected' : ''}`}
            key={comment.id}
            onClick={() => onActivateComment(comment.id)}
            title={comment.body}
            type="button"
          >
            <span className="history-entry-ref">#{index + 1}</span>
            <span className="history-entry-subject">{getCommentPreview(comment.body)}</span>
            <span className="history-entry-meta">
              <span className="history-entry-author">
                <Gravatar fallback={displayName} size="small" url={comment.author.avatarUrl} />
                <span>{displayName}</span>
              </span>
              {comment.submittedAt ? <SubmittedAtTime submittedAt={comment.submittedAt} /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function GeneralCommentComposer({
  disabled,
  draft,
  error,
  gitIdentity,
  keymap,
  onChangeDraft,
  onSubmit,
  submitting,
}: {
  disabled: boolean;
  draft: string;
  error: string | null;
  gitIdentity: GitIdentity | null;
  keymap: CodiffKeymap;
  onChangeDraft: (draft: string) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const canSubmit = !disabled && !submitting && Boolean(draft.trim());
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!matchesShortcut(event, keymap, 'submitComment') || !canSubmit) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onSubmit();
    },
    [canSubmit, keymap, onSubmit],
  );
  return (
    <section className="review-comment-thread general-comment-composer">
      <div className="review-comment">
        <Gravatar
          fallback={gitIdentity?.name || gitIdentity?.email || 'You'}
          size="medium"
          url={gitIdentity?.gravatarUrl}
        />
        <div className="review-comment-body">
          <div className="review-comment-header general-comment-header general-comment-composer-header">
            <strong>{gitIdentity?.name || gitIdentity?.email || 'You'}</strong>
            <button
              className="review-comment-action"
              disabled={!canSubmit}
              onClick={onSubmit}
              title={canSubmit ? 'Submit comment' : 'Write a comment before commenting'}
              type="button"
            >
              <ChatCircle aria-hidden className="review-comment-action-icon" size={14} />
              {submitting ? 'Sending' : 'Comment'}
            </button>
          </div>
          <Suspense fallback={<div className="review-comment-input" />}>
            <MarkdownEditor
              ariaLabel="Add comment"
              className="review-comment-markdown-editor"
              colorScheme="inherit"
              contentClassName="review-comment-input"
              density="compact"
              onChange={onChangeDraft}
              onKeyDown={handleKeyDown}
              placeholder="Write a comment…"
              readOnly={disabled || submitting}
              spellCheck
              value={draft}
              variant="embedded"
            />
          </Suspense>
          {error ? <div className="review-comment-error">{error}</div> : null}
        </div>
      </div>
    </section>
  );
}

function MergeRequestCommentsView({
  canComment,
  commenting,
  draft,
  editDraft,
  editError,
  editingCommentId,
  editSubmitting,
  error,
  focusedCommentId,
  focusedCommentRequest,
  gitIdentity,
  keymap,
  onCancelEdit,
  onChangeDraft,
  onChangeEditDraft,
  onSaveEdit,
  onStartEdit,
  onSubmit,
  sourceDescription,
  submitting,
  threads,
}: {
  canComment: boolean;
  commenting?: SharedWalkthroughCommenting;
  draft: string;
  editDraft: string;
  editError: string | null;
  editingCommentId: string | null;
  editSubmitting: boolean;
  error: string | null;
  focusedCommentId: string | null;
  focusedCommentRequest: number;
  gitIdentity: GitIdentity | null;
  keymap: CodiffKeymap;
  onCancelEdit: () => void;
  onChangeDraft: (draft: string) => void;
  onChangeEditDraft: (draft: string) => void;
  onSaveEdit: () => void;
  onStartEdit: (comment: PullRequestGeneralComment) => void;
  onSubmit: () => void;
  sourceDescription?: ReactNode;
  submitting: boolean;
  threads: ReadonlyArray<PullRequestGeneralCommentThread>;
}) {
  const commentsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusedCommentId == null) {
      return;
    }

    const container = commentsRef.current;
    const element = document.getElementById(getGeneralCommentElementId(focusedCommentId));
    if (!container || !element) {
      return;
    }

    scrollCommentIntoContainerView(container, element);
  }, [focusedCommentId, focusedCommentRequest]);

  return (
    <div className="merge-request-comments-view" ref={commentsRef}>
      {sourceDescription ? (
        <div className="merge-request-comments-source-description">{sourceDescription}</div>
      ) : null}
      {threads.length > 0 ? (
        <div className="general-comment-list">
          {threads.map((thread) => (
            <GeneralCommentThreadCard
              canComment={canComment}
              editDraft={editDraft}
              editError={editError}
              editingCommentId={editingCommentId}
              editSubmitting={editSubmitting}
              focusedCommentId={focusedCommentId}
              key={thread.id}
              keymap={keymap}
              onCancelEdit={onCancelEdit}
              onChangeEditDraft={onChangeEditDraft}
              onDelete={(commentId) => {
                void commenting?.onDeleteGeneralComment(commentId).catch((error: unknown) => {
                  window.alert(error instanceof Error ? error.message : String(error));
                });
              }}
              onReply={(threadId, body) =>
                commenting?.onReplyGeneralComment(threadId, body) ??
                Promise.reject(new Error('Replying is unavailable.'))
              }
              onResolve={(threadId, resolved) =>
                commenting?.onResolveDiscussion(threadId, resolved) ??
                Promise.reject(new Error('Resolving is unavailable.'))
              }
              onSaveEdit={onSaveEdit}
              onStartEdit={onStartEdit}
              thread={thread}
            />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <div className="empty-panel squircle">
            <strong>No comments yet</strong>
            <span>Add a comment to start the discussion.</span>
          </div>
        </div>
      )}
      {canComment ? (
        <GeneralCommentComposer
          disabled={false}
          draft={draft}
          error={error}
          gitIdentity={gitIdentity}
          keymap={keymap}
          onChangeDraft={onChangeDraft}
          onSubmit={onSubmit}
          submitting={submitting}
        />
      ) : commenting ? (
        <div className="general-comment-sign-in">
          <button className="codiff-open-button" onClick={commenting.onSignIn} type="button">
            Sign in with GitLab to comment
          </button>
        </div>
      ) : null}
    </div>
  );
}

const disabledCommit = async (): Promise<WalkthroughCommitResult> => ({
  reason: 'Shared walkthroughs are read-only.',
  status: 'failed',
});

const disabledCommitMessage = async (): Promise<WalkthroughCommitMessageResult> => ({
  reason: 'Shared walkthroughs are read-only.',
  status: 'unavailable',
});

function SharedFileTree({
  files,
  onActivatePath,
  selectedPath,
  showWhitespace,
}: {
  files: ReadonlyArray<ChangedFile>;
  onActivatePath: (path: string) => void;
  selectedPath: string | null;
  showWhitespace: boolean;
}) {
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const filePathSet = useMemo(() => new Set(paths), [paths]);
  const lineCountsByPath = useMemo(
    () => new Map(files.map((file) => [file.path, getDiffLineCount(file, showWhitespace)])),
    [files, showWhitespace],
  );
  const lineCountsByPathRef = useRef(lineCountsByPath);
  const renderTreeRowDecoration = useCallback<FileTreeRowDecorationRenderer>(({ item }) => {
    const lineCount = lineCountsByPathRef.current.get(item.path);
    return lineCount?.countable
      ? {
          text: formatTreeLineCount(lineCount),
          title: getDiffLineCountTitle(lineCount),
        }
      : null;
  }, []);
  const status = useMemo(
    () =>
      files.map((file) => ({
        path: file.path,
        status: statusForTree[file.status],
      })),
    [files],
  );
  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    gitStatus: status,
    initialExpansion: 'open',
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    itemHeight: 30,
    paths,
    renderRowDecoration: renderTreeRowDecoration,
    sort: fileTreeSort,
    unsafeCSS: `
      :host {
        --trees-bg-override: transparent;
        --trees-bg-muted-override: var(--hover-wash);
        --trees-border-color-override: var(--sidebar-border);
        --trees-fg-muted-override: var(--muted);
        --trees-fg-override: var(--sidebar-text);
        --trees-focus-ring-color-override: var(--tree-selection-focus);
        --trees-padding-inline-override: 4px;
        --trees-search-bg-override: rgb(127 127 127 / 0.1);
        --trees-search-fg-override: var(--sidebar-text);
        --trees-selected-bg-override: color-mix(in srgb, var(--tree-selection-bg) 46%, transparent);
        --trees-selected-fg-override: var(--sidebar-text);
        --trees-selected-focused-border-color-override: color-mix(in srgb, var(--tree-selection-focus) 42%, transparent);
        --truncate-marker-background-color: transparent;
        color-scheme: var(--codiff-tree-color-scheme, light dark);
        color: var(--sidebar-text);
        font: 13px/1.35 var(--font-sans);
      }

      button[data-type='item'] {
        background-color: transparent;
        border-radius: 14px;
        corner-shape: squircle;
      }

      [data-item-section='decoration'] {
        color: var(--muted);
        font: 600 10px/1 var(--font-mono);
        letter-spacing: 0;
      }
    `,
  });

  useLayoutEffect(() => {
    lineCountsByPathRef.current = lineCountsByPath;
    if (model.getFileTreeContainer()) {
      model.render({});
    }
  }, [lineCountsByPath, model]);

  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);

  useEffect(() => {
    model.setGitStatus(status);
  }, [model, status]);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }

    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect();
    }
    model.getItem(selectedPath)?.select();
  }, [model, selectedPath]);

  const handleTreeClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      for (const target of event.nativeEvent.composedPath()) {
        if (!('getAttribute' in target) || typeof target.getAttribute !== 'function') {
          continue;
        }

        const path = target.getAttribute('data-item-path');
        if (path && filePathSet.has(path)) {
          onActivatePath(path);
          return;
        }
      }
    },
    [filePathSet, onActivatePath],
  );

  return (
    <div className="file-tree-shell">
      <FileTree className="file-tree" model={model} onClick={handleTreeClick} />
    </div>
  );
}

type ReviewSurfaceProps = {
  commenting?: SharedWalkthroughCommenting;
  externalUrl?: string;
  gitIdentity?: GitIdentity | null;
  initialMode?: MergeRequestReviewMode;
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
    walkthroughStatus: MergeRequestWalkthroughStatus;
  };
  onModeChange?: (mode: MergeRequestReviewMode) => void;
  settingsBar?: ReactNode;
  snapshot: SharedWalkthroughSnapshot;
  sourceDescriptionFooterAside?: ReactNode;
  sourceDescriptionFooterAsideKey?: string;
  title?: string;
};

function ReviewSurface({
  commenting,
  externalUrl,
  gitIdentity = null,
  initialMode,
  interactive,
  onModeChange,
  settingsBar,
  snapshot,
  sourceDescriptionFooterAside,
  sourceDescriptionFooterAsideKey,
  title,
}: ReviewSurfaceProps) {
  const canComment = commenting?.canComment ?? Boolean(interactive);
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
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedGenerated, setExpandedGenerated] = useState<ReadonlySet<string>>(() => new Set());
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [itemVersionByKey, setItemVersionByKey] = useState<Record<string, number>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(
    () => snapshot.files[0]?.path ?? null,
  );
  const [sidebarWidth, setSidebarWidth] = useState(readSharedSidebarWidth);
  const [uncontrolledSidebarMode, setUncontrolledSidebarMode] = useState<MergeRequestReviewMode>(
    () => initialMode ?? (interactive ? 'tree' : 'walkthrough'),
  );
  const isSidebarModeControlled = Boolean(initialMode && onModeChange);
  const sidebarMode = isSidebarModeControlled ? initialMode : uncontrolledSidebarMode;
  const [treeScrollTarget, setTreeScrollTarget] = useState<ReviewScrollTarget | null>(null);
  const [viewed, setViewed] = useState<Record<string, string>>({});
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
    () => [...visibleSnapshotReviewComments, ...localReviewComments],
    [localReviewComments, visibleSnapshotReviewComments],
  );
  const reviewCommentsRef = useRef(reviewComments);
  const generalCommentThreads = snapshot.repository.generalComments ?? emptyGeneralCommentThreads;
  const generalComments = useMemo(
    () =>
      (snapshot.repository.generalComments ?? emptyGeneralCommentThreads).flatMap(
        (thread) => thread.comments,
      ),
    [snapshot.repository.generalComments],
  );
  const generalCommentCount = generalComments.length;
  const [generalCommentDraft, setGeneralCommentDraft] = useState('');
  const [generalCommentEditDraft, setGeneralCommentEditDraft] = useState('');
  const [editingGeneralCommentId, setEditingGeneralCommentId] = useState<string | null>(null);
  const [generalCommentEditError, setGeneralCommentEditError] = useState<string | null>(null);
  const [generalCommentEditSubmitting, setGeneralCommentEditSubmitting] = useState(false);
  const [generalCommentError, setGeneralCommentError] = useState<string | null>(null);
  const [focusedGeneralCommentId, setFocusedGeneralCommentId] = useState<string | null>(null);
  const [generalCommentScrollRequest, setGeneralCommentScrollRequest] = useState(0);
  const [generalCommentSubmitting, setGeneralCommentSubmitting] = useState(false);
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  const [focusCommentRequest, setFocusCommentRequest] = useState(0);
  const [pullRequestReviewSubmitting, setPullRequestReviewSubmitting] =
    useState<PullRequestReviewEvent | null>(null);
  const [pullRequestCloseSubmitting, setPullRequestCloseSubmitting] = useState(false);
  const [pullRequestMergeSubmitting, setPullRequestMergeSubmitting] = useState(false);
  const [walkthroughRequestPending, setWalkthroughRequestPending] = useState(false);
  const walkthroughRequestPendingRef = useRef(false);
  const [walkthroughRequestId, setWalkthroughRequestId] = useState(0);
  const interactiveRef = useRef(interactive);

  useEffect(() => {
    reviewCommentsRef.current = reviewComments;
  }, [reviewComments]);

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

  useEffect(() => {
    const root = document.documentElement;
    if (snapshot.preferences.theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', snapshot.preferences.theme);
    }
  }, [snapshot.preferences.theme]);

  useEffect(() => {
    const root = document.documentElement;
    const codeFontFamily = snapshot.preferences.codeFontFamily.trim();
    const codeFontSize = normalizeCodeFontSizePreference(snapshot.preferences.codeFontSize);

    if (codeFontFamily) {
      root.style.setProperty('--font-diff-mono', `${JSON.stringify(codeFontFamily)}, monospace`);
    }

    root.style.setProperty('--font-diff-size', `${codeFontSize}px`);
    root.style.setProperty('--font-diff-line-height', `${getCodeFontLineHeight(codeFontSize)}px`);
  }, [snapshot.preferences.codeFontFamily, snapshot.preferences.codeFontSize]);

  const bumpItemVersion = useCallback((key: string) => {
    setItemVersionByKey((current) => ({
      ...current,
      [key]: (current[key] ?? 0) + 1,
    }));
  }, []);
  const changeSidebarMode = useCallback(
    (mode: MergeRequestReviewMode) => {
      setUncontrolledSidebarMode(mode);
      onModeChange?.(mode);
    },
    [onModeChange],
  );

  const createComment = useCallback(
    (comment: Omit<ReviewComment, 'body' | 'id'>) => {
      if (!canComment) {
        return;
      }

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
        setLocalReviewComments((current) =>
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
      setLocalReviewComments((current) => [...current, { ...comment, body: '', id }]);
      bumpItemVersion(comment.filePath);
    },
    [bumpItemVersion, canComment],
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
  const updateComment = useCallback((commentId: string, body: string) => {
    setLocalReviewComments((current) =>
      current.map((comment) =>
        comment.id === commentId && !comment.isReadOnly ? { ...comment, body } : comment,
      ),
    );
  }, []);
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
    [bumpItemVersion, updateReviewComment],
  );
  const deleteComment = useCallback(
    (commentId: string) => {
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (comment?.isReadOnly && comment.canDelete && commenting?.onDeleteComment) {
        void commenting.onDeleteComment(commentId).catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : String(error));
        });
        return;
      }
      setFocusCommentId((current) => (current === commentId ? null : current));
      setLocalReviewComments((current) =>
        current.filter((candidate) => candidate.id !== commentId),
      );
      if (comment) {
        bumpItemVersion(comment.filePath);
      }
    },
    [bumpItemVersion, commenting],
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

      setLocalReviewComments((current) =>
        current.map((candidate) =>
          candidate.id === commentId
            ? { ...candidate, remoteSubmit: { status: 'submitting' } }
            : candidate,
        ),
      );
      void submitReviewComment(toPullRequestReviewComment(comment))
        .then(() => {
          setFocusCommentId((current) => (current === commentId ? null : current));
          setLocalReviewComments((current) =>
            current.filter((candidate) => candidate.id !== commentId),
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
    [bumpItemVersion, submitReviewComment],
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

      const pendingComments = reviewCommentsRef.current.filter(
        (comment) => !comment.isReadOnly && !comment.threadId && comment.body.trim(),
      );
      const pendingIds = new Set(pendingComments.map((comment) => comment.id));
      setPullRequestReviewSubmitting(event);
      const formattedComments = pendingComments.map(toPullRequestReviewComment);
      const submission = body
        ? interactive.onSubmitReview(event, formattedComments, body)
        : interactive.onSubmitReview(event, formattedComments);
      void submission
        .then(() => {
          setLocalReviewComments((current) =>
            current.filter((comment) => !pendingIds.has(comment.id)),
          );
        })
        .catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setPullRequestReviewSubmitting(null));
    },
    [interactive, pullRequestReviewSubmitting, snapshot.repository.source],
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

    const cleanup = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener('pointermove', handleMove);
      handle.removeEventListener('pointerup', handleEnd);
      handle.removeEventListener('pointercancel', handleEnd);
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
    };

    const handleMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(moveEvent.clientX - shellLeft));
    };

    const handleEnd = () => {
      cleanup();
      setSidebarWidth((width) => {
        writeSharedSidebarWidth(width);
        return width;
      });
    };

    handle.addEventListener('pointermove', handleMove);
    handle.addEventListener('pointerup', handleEnd);
    handle.addEventListener('pointercancel', handleEnd);
  }, []);

  const toggleCollapsed = useCallback(
    (file: ChangedFile, isCollapsed: boolean, reviewKey: string) => {
      setCollapsed((current) => {
        const next = new Set(current);
        if (isCollapsed) {
          next.delete(reviewKey);
        } else {
          next.add(reviewKey);
        }
        return next;
      });
      setExpandedGenerated((current) => {
        const next = new Set(current);
        if (isCollapsed && isGeneratedWalkthroughFile(file)) {
          next.add(reviewKey);
        } else {
          next.delete(reviewKey);
        }
        return next;
      });
      bumpItemVersion(reviewKey);
    },
    [bumpItemVersion],
  );
  const toggleViewed = useCallback(
    (_file: ChangedFile, isViewed: boolean, reviewIdentity: ReviewIdentity) => {
      setViewed((current) => updateReviewIdentityViewed(current, reviewIdentity, isViewed));
      setCollapsed((current) => updateReviewIdentityCollapsed(current, reviewIdentity, isViewed));
      if (!isViewed) {
        setExpandedGenerated((current) => {
          const next = new Set(current);
          next.delete(reviewIdentity.key);
          return next;
        });
      }
      bumpItemVersion(reviewIdentity.key);
    },
    [bumpItemVersion],
  );
  const activateTreePath = useCallback((path: string) => {
    setSelectedPath(path);
    setTreeScrollTarget((current) => ({
      behavior: 'smooth',
      path,
      request: (current?.request ?? 0) + 1,
    }));
  }, []);
  const updateSelectedPathFromScroll = useCallback(
    (viewer: CodeViewInstance) => {
      if (visibleFiles.length === 0) {
        return;
      }

      const activationTop = viewer.getScrollTop() + DEFAULT_PADDING;
      let nextPath = visibleFiles[0]?.path ?? null;
      let nextDistance = Number.NEGATIVE_INFINITY;

      for (const file of visibleFiles) {
        const section = getFirstVisibleSection(file, snapshot.preferences.showWhitespace);
        const itemTop = section ? viewer.getTopForItem(getItemId(section)) : undefined;
        if (itemTop == null) {
          continue;
        }

        const distance = itemTop - activationTop;
        if (distance <= 0 && distance > nextDistance) {
          nextDistance = distance;
          nextPath = file.path;
        }
      }

      if (nextPath) {
        setSelectedPath((current) => (current === nextPath ? current : nextPath));
      }
    },
    [snapshot.preferences.showWhitespace, visibleFiles],
  );

  const diffLineHeight = getCodeFontLineHeight(
    normalizeCodeFontSizePreference(snapshot.preferences.codeFontSize),
  );
  const commonReviewProps = {
    activeSearchMatch: null,
    agentId: snapshot.walkthrough.agent,
    agentLabel: getAgentLabel(snapshot.walkthrough.agent),
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
    isPullRequest: snapshot.repository.source.type === 'pull-request',
    isReadOnly: !canComment,
    itemVersionByKey,
    keymap,
    loadingSectionIds: new Set<string>(),
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
        onClosePullRequest={closePullRequest}
        onSubmitReview={submitReview}
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
  const sourceDescriptionFooterKey =
    interactive && sourceMergeState && !isTerminalMergeState
      ? [
          'merge',
          pullRequestMergeSubmitting ? 'submitting' : 'idle',
          sourceMergeState.sha,
          String(sourceMergeState.autoMergeEnabled),
          String(sourceMergeState.canCancelAutoMerge),
          String(sourceMergeState.canMerge),
          String(sourceMergeState.canSetAutoMerge),
          sourceMergeState.status,
          sourceMergeState.statusLabel,
          String(sourceMergeState.options.removeSourceBranch),
          String(sourceMergeState.options.squash),
          ...sourceMergeState.checks.map(
            (check) => `${check.status}:${check.label}:${check.detail ?? ''}:${check.url ?? ''}`,
          ),
          sourceDescriptionFooterAsideKey ? `aside:${sourceDescriptionFooterAsideKey}` : '',
        ].join('|')
      : sourceDescriptionFooter
        ? (sourceDescriptionFooterAsideKey ?? 'custom')
        : '';
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
      <div className="wt-stop wt-diff-surface">
        <ReviewCodeView
          {...commonReviewProps}
          allowViewedToggle
          blocks={blocks}
          bottomInset={walkthroughCodeViewBottomInset}
          files={[]}
          forceExpandedPaths={new Set()}
          onActiveBlockChange={onActiveBlockChange}
          scrollTarget={blockScrollTarget}
          selectedPath={null}
          showSourceDescription
          sourceDescriptionActions={sourceDescriptionActions}
          sourceDescriptionFooter={sourceDescriptionFooter}
          sourceDescriptionFooterKey={sourceDescriptionFooterKey}
          walkthroughNotes={emptyWalkthroughNotes}
        />
      </div>
    );
  };

  const sourceLabel =
    snapshot.repository.source.type === 'working-tree'
      ? ''
      : ` · ${getSourceLabel(snapshot.repository.source)}`;
  const rootLabel = `${compactPath(snapshot.repository.root)}${snapshot.branch ? ` (${snapshot.branch})` : ''}`;
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

  return (
    <div
      className={`app-shell share-shell${interactive ? ' merge-request-shell' : ''}`}
      data-theme={shellTheme}
      style={{ gridTemplateColumns: `${sidebarWidth}px 0 minmax(0, 1fr)` }}
    >
      <aside className="squircle sidebar">
        <div className="sidebar-header">
          <div className="sidebar-path-row">
            {interactive ? (
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
            ) : null}
            <div className="sidebar-path" title={title ?? snapshot.repository.root}>
              {title ? `${title} · ` : null}
              {rootLabel}
              {sourceLabel}
            </div>
            {externalUrl ? (
              <a
                aria-label="Open merge request in GitLab"
                className="merge-request-nav-button"
                href={externalUrl}
                rel="noreferrer"
                target="_blank"
                title="Open merge request in GitLab"
              >
                <ExternalLink aria-hidden size={16} />
              </a>
            ) : null}
          </div>
        </div>
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
        <div aria-label="Review order" className="sidebar-mode-toggle" role="tablist">
          <button
            aria-selected={sidebarMode === 'tree'}
            onClick={() => changeSidebarMode('tree')}
            role="tab"
            type="button"
          >
            Tree
          </button>
          <button
            aria-selected={sidebarMode === 'walkthrough'}
            onClick={() => changeSidebarMode('walkthrough')}
            role="tab"
            type="button"
          >
            Walkthrough
          </button>
          {commenting || interactive || generalCommentCount > 0 ? (
            <button
              aria-label={
                generalCommentCount > 0 ? `Comments (${generalCommentCount})` : 'Comments'
              }
              aria-selected={sidebarMode === 'comments'}
              onClick={() => changeSidebarMode('comments')}
              role="tab"
              title={
                generalCommentCount > 0
                  ? `${generalCommentCount} ${generalCommentCount === 1 ? 'comment' : 'comments'}`
                  : 'Comments'
              }
              type="button"
            >
              <span>Comments</span>
              {generalCommentCount > 0 ? (
                <span aria-hidden className="sidebar-tab-count">
                  {generalCommentCount}
                </span>
              ) : null}
            </button>
          ) : null}
        </div>
        {sidebarMode === 'tree' ? (
          <SharedFileTree
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
        {settingsBar || showTotalLineCount ? (
          <div className="sidebar-settings-bar">
            {settingsBar}
            {showTotalLineCount ? (
              <DiffLineCountBadge
                ariaLabelPrefix="Total change"
                className="sidebar-total-line-count sidebar-settings-line-count"
                lineCount={totalLineCount}
              />
            ) : null}
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
              sourceDescriptionFooterKey={sourceDescriptionFooterKey}
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
          <div className="loading codex italic">
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

export function SharedWalkthroughApp({
  commenting,
  gitIdentity,
  settingsBar,
  snapshot,
}: {
  commenting?: SharedWalkthroughCommenting;
  gitIdentity?: GitIdentity | null;
  settingsBar?: ReactNode;
  snapshot: SharedWalkthroughSnapshot;
}) {
  return (
    <ReviewSurface
      commenting={commenting}
      gitIdentity={gitIdentity}
      settingsBar={settingsBar}
      snapshot={snapshot}
    />
  );
}

export function MergeRequestReviewApp({
  externalUrl,
  gitIdentity,
  initialMode,
  onCancelAutoMerge,
  onClosePullRequest,
  onGenerateWalkthrough,
  onHome,
  onMergePullRequest,
  onModeChange,
  onResolveDiscussion,
  onSubmitComment,
  onSubmitGeneralComment,
  onSubmitReview,
  onUpdateComment,
  onUpdateDescription,
  onUpdateGeneralComment,
  onUpdateTitle,
  onUploadDescriptionAsset,
  preferences,
  settingsBar,
  sourceDescriptionFooterAside,
  sourceDescriptionFooterAsideKey,
  state,
  title,
  walkthrough,
  walkthroughError,
  walkthroughStatus,
}: MergeRequestReviewAppProps) {
  const placeholderWalkthrough = useMemo<NarrativeWalkthrough>(
    () => ({
      agent: 'codex',
      chapters: [],
      focus: 'Generate a walkthrough to review this merge request in narrative order.',
      generatedAt: new Date(state.generatedAt).toISOString(),
      kind: 'narrative',
      repo: {
        branch: state.branch,
        root: state.root,
      },
      source: state.source,
      support: [],
      title,
      version: 4,
    }),
    [state.branch, state.generatedAt, state.root, state.source, title],
  );
  const resolvedPreferences = useMemo(
    () => ({
      ...defaultSharedPreferences,
      ...preferences,
    }),
    [preferences],
  );
  const snapshot = useMemo<SharedWalkthroughSnapshot>(
    () => ({
      branch: state.branch,
      codiffVersion: 'web',
      exportedAt: new Date(state.generatedAt).toISOString(),
      files: state.files,
      kind: 'codiff-walkthrough-share',
      preferences: resolvedPreferences,
      repository: {
        generalComments: state.generalComments,
        root: state.root,
        source: state.source,
        title,
      },
      reviewComments: state.reviewComments,
      version: 1,
      walkthrough: walkthrough ?? placeholderWalkthrough,
    }),
    [placeholderWalkthrough, resolvedPreferences, state, title, walkthrough],
  );

  return (
    <ReviewSurface
      externalUrl={externalUrl}
      gitIdentity={gitIdentity}
      initialMode={initialMode}
      interactive={{
        onCancelAutoMerge,
        onClosePullRequest,
        onGenerateWalkthrough,
        onHome,
        onMergePullRequest,
        onResolveDiscussion,
        onSubmitComment,
        onSubmitGeneralComment,
        onSubmitReview,
        onUpdateComment,
        onUpdateDescription,
        onUpdateGeneralComment,
        onUpdateTitle,
        onUploadDescriptionAsset,
        walkthroughError,
        walkthroughStatus,
      }}
      onModeChange={onModeChange}
      settingsBar={settingsBar}
      snapshot={snapshot}
      sourceDescriptionFooterAside={sourceDescriptionFooterAside}
      sourceDescriptionFooterAsideKey={sourceDescriptionFooterAsideKey}
      title={title}
    />
  );
}
