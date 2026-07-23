import { MarkdownEditor, type MarkdownEditorHandle } from '@nkzw/mdx-editor';
import useRelativeTime from '@nkzw/use-relative-time';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/ChatCircle';
import { X } from 'lucide-react';
import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { matchesShortcut } from '../../../config/keymap.ts';
import type { CodiffKeymap } from '../../../config/types.ts';
import type {
  GitIdentity,
  PullRequestGeneralComment,
  PullRequestGeneralCommentThread,
  ReviewAuthor,
  ReviewCommenting,
} from '../../../types.ts';
import { Avatar } from '../Avatar.tsx';
import { Button } from '../Button.tsx';
import { ReadOnlyMarkdownView } from '../ReadOnlyMarkdownView.tsx';
import { ResolvedThreadDisclosure } from '../ResolvedThreadDisclosure.tsx';

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
      <Avatar name={displayName} size="medium" url={comment.author.avatarUrl} />
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
  canDelete,
  canEdit,
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
  canDelete: boolean;
  canEdit: boolean;
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
      <Avatar name={displayName} size="medium" url={comment.author.avatarUrl} />
      <div className="review-comment-body source-description-body">
        <div
          className={`review-comment-header read-only general-comment-header${
            canEdit || canDelete || editing ? ' with-comment-action' : ''
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
              {canEdit ? (
                <button
                  className="review-comment-action"
                  onClick={() => onStartEdit(comment)}
                  type="button"
                >
                  Edit
                </button>
              ) : null}
              {canDelete ? (
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
  canDelete,
  canEdit,
  canReply,
  canResolve,
  editDraft,
  editError,
  editingCommentId,
  editSubmitting,
  focusedCommentId,
  focusedCommentRequest,
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
  canDelete: boolean;
  canEdit: boolean;
  canReply: boolean;
  canResolve: boolean;
  editDraft: string;
  editError: string | null;
  editingCommentId: string | null;
  editSubmitting: boolean;
  focusedCommentId: string | null;
  focusedCommentRequest: number;
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
  const hasFocusedComment =
    focusedCommentId != null && thread.comments.some((comment) => comment.id === focusedCommentId);
  const [resolutionOverride, setResolutionOverride] = useState<{
    base: boolean;
    value: boolean;
  } | null>(null);
  const effectiveResolved =
    resolutionOverride?.base === resolved ? resolutionOverride.value : resolved;

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
    const nextResolved = !effectiveResolved;
    setResolutionOverride({ base: resolved, value: nextResolved });
    setResolving(true);
    void onResolve(thread.id, nextResolved)
      .catch((error: unknown) => {
        setResolutionOverride(null);
        window.alert(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setResolving(false));
  }, [effectiveResolved, onResolve, resolved, resolving, thread.id]);

  const threadContent = (
    <>
      {thread.comments.map((comment) => (
        <GeneralCommentCard
          canDelete={canDelete && comment.canDelete === true}
          canEdit={canEdit && comment.canEdit === true}
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
      {thread.canReply && canReply && !effectiveResolved && !resolving ? (
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
      {thread.canResolve && canResolve ? (
        <div className="review-comment-thread-footer">
          <button
            className="review-comment-action"
            disabled={resolving}
            onClick={toggleResolved}
            type="button"
          >
            {resolving ? 'Saving' : effectiveResolved ? 'Reopen' : 'Resolve'}
          </button>
        </div>
      ) : null}
    </>
  );

  return effectiveResolved ? (
    <section className="general-comment-thread">
      <ResolvedThreadDisclosure
        commentCount={thread.comments.length}
        focused={hasFocusedComment}
        focusRequest={focusedCommentRequest}
        saving={resolving}
      >
        {threadContent}
      </ResolvedThreadDisclosure>
    </section>
  ) : (
    <section className="general-comment-thread">{threadContent}</section>
  );
}

export function SidebarGeneralCommentList({
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
                <Avatar name={displayName} size="small" url={comment.author.avatarUrl} />
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
        <Avatar
          name={gitIdentity?.name || gitIdentity?.email || 'You'}
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

export function MergeRequestCommentsView({
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
  onResolveDiscussion,
  onSaveEdit,
  onStartEdit,
  onSubmit,
  signInLabel,
  sourceDescription,
  submitting,
  threads,
}: {
  canComment: boolean;
  commenting?: ReviewCommenting;
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
  onResolveDiscussion?: (discussionId: string, resolved: boolean) => Promise<void>;
  onSaveEdit: () => void;
  onStartEdit: (comment: PullRequestGeneralComment) => void;
  onSubmit: () => void;
  signInLabel: string;
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
              canDelete={commenting?.onDeleteGeneralComment != null}
              canEdit={commenting?.onUpdateGeneralComment != null}
              canReply={commenting?.onReplyGeneralComment != null}
              canResolve={onResolveDiscussion != null || commenting?.onResolveDiscussion != null}
              editDraft={editDraft}
              editError={editError}
              editingCommentId={editingCommentId}
              editSubmitting={editSubmitting}
              focusedCommentId={focusedCommentId}
              focusedCommentRequest={focusedCommentRequest}
              key={thread.id}
              keymap={keymap}
              onCancelEdit={onCancelEdit}
              onChangeEditDraft={onChangeEditDraft}
              onDelete={(commentId) => {
                void commenting?.onDeleteGeneralComment?.(commentId).catch((error: unknown) => {
                  window.alert(error instanceof Error ? error.message : String(error));
                });
              }}
              onReply={(threadId, body) =>
                commenting?.onReplyGeneralComment?.(threadId, body) ??
                Promise.reject(new Error('Replying is unavailable.'))
              }
              onResolve={(threadId, resolved) =>
                onResolveDiscussion?.(threadId, resolved) ??
                commenting?.onResolveDiscussion?.(threadId, resolved) ??
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
      ) : commenting?.onSignIn ? (
        <div className="general-comment-sign-in">
          <Button action={commenting.onSignIn} pendingPlaceholder="Signing in…">
            {signInLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
