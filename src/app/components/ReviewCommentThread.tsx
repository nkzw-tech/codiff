import { XIcon as X } from '@phosphor-icons/react/X';
import type { DiffLineAnnotation } from '@pierre/diffs';
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import claudeIconUrl from '../../assets/claude.svg';
import codexIconUrl from '../../assets/codex.svg';
import { matchesShortcut } from '../../config/keymap.ts';
import type { CodiffKeymap } from '../../config/types.ts';
import type { ReviewComment, ReviewCommentAnnotationMetadata } from '../../lib/app-types.ts';
import { renderMarkdown } from '../../lib/markdown.tsx';
import {
  getReviewCommentLineLabel,
  shouldDiscardReviewCommentOnEscape,
} from '../../lib/review-comments.ts';
import type { GitIdentity, PullRequestExistingReviewComment } from '../../types.ts';
import { Gravatar } from './Gravatar.tsx';

function ReviewAvatar({
  author,
  identity,
}: {
  author?: PullRequestExistingReviewComment['author'];
  identity: GitIdentity | null;
}) {
  const label = author?.login || identity?.name || identity?.email || 'Git user';
  const avatarUrl = author?.avatarUrl || identity?.gravatarUrl;

  return <Gravatar fallback={label} size="medium" url={avatarUrl} />;
}

function AgentAvatar({ agentId }: { agentId: 'codex' | 'claude' }) {
  return (
    <img
      alt=""
      className="review-comment-avatar-codex"
      draggable={false}
      src={agentId === 'claude' ? claudeIconUrl : codexIconUrl}
    />
  );
}

const canAskCodexForBody = (comment: ReviewComment, body: string) =>
  !comment.isReadOnly && body.trim().length > 0 && comment.codexReply?.status !== 'loading';

const canSubmitCommentBodyToGitHub = (comment: ReviewComment, body: string) =>
  !comment.isReadOnly && body.trim().length > 0 && comment.githubSubmit?.status !== 'submitting';

type ReviewCommentThreadActions = {
  onAskCodex: (commentId: string, body: string) => void;
  onCommentBlur: (comment: ReviewComment, body: string) => void;
  onCommentFocus: (comment: ReviewComment) => void;
  onDeleteComment: (commentId: string) => void;
  onSubmitComment: (commentId: string, body: string) => void;
  onUpdateComment: (commentId: string, body: string) => void;
};

const getReviewCommentAuthorLabel = (comment: ReviewComment, identity: GitIdentity | null) =>
  comment.author?.login || identity?.name || identity?.email || 'Git user';

function ReviewCommentEditor({
  agentId,
  agentLabel,
  comment,
  focusCommentId,
  focusCommentRequest,
  identity,
  isPullRequest,
  keymap,
  onAskCodex,
  onCommentBlur,
  onCommentFocus,
  onDeleteComment,
  onSubmitComment,
  onUpdateComment,
}: {
  agentId: 'codex' | 'claude';
  agentLabel: string;
  comment: ReviewComment;
  focusCommentId: string | null;
  focusCommentRequest: number;
  identity: GitIdentity | null;
  isPullRequest: boolean;
  keymap: CodiffKeymap;
} & ReviewCommentThreadActions) {
  const focusTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(comment.body);
  const isDirty = draft !== comment.body;
  const canAskCodex = canAskCodexForBody(comment, draft);
  const canSubmitComment = canSubmitCommentBodyToGitHub(comment, draft);
  const displayName = getReviewCommentAuthorLabel(comment, identity);
  const isFocusedComment = focusCommentId === comment.id;

  useEffect(() => {
    if (isFocusedComment) {
      focusTextareaRef.current?.focus();
    }
  }, [focusCommentRequest, isFocusedComment]);

  const commitDraft = useCallback(() => {
    if (!comment.isReadOnly && isDirty) {
      onUpdateComment(comment.id, draft);
    }
    return draft;
  }, [comment.id, comment.isReadOnly, draft, isDirty, onUpdateComment]);

  const askCodex = useCallback(() => {
    onAskCodex(comment.id, draft);
  }, [comment.id, draft, onAskCodex]);

  const submitComment = useCallback(() => {
    onSubmitComment(comment.id, draft);
  }, [comment.id, draft, onSubmitComment]);

  const handleCommentBlur = useCallback(() => {
    onCommentBlur(comment, commitDraft());
  }, [comment, commitDraft, onCommentBlur]);

  const handleCommentKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (matchesShortcut(event, keymap, 'submitComment')) {
        if (isPullRequest && canSubmitComment) {
          event.preventDefault();
          event.stopPropagation();
          submitComment();
          return;
        }

        if (!isPullRequest && canAskCodex) {
          event.preventDefault();
          event.stopPropagation();
          askCodex();
        }
        return;
      }

      if (!matchesShortcut(event, keymap, 'discardComment')) {
        return;
      }

      if (comment.isReadOnly) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (shouldDiscardReviewCommentOnEscape(draft)) {
        onDeleteComment(comment.id);
      }
    },
    [
      askCodex,
      canAskCodex,
      canSubmitComment,
      comment.id,
      comment.isReadOnly,
      draft,
      isPullRequest,
      keymap,
      onDeleteComment,
      submitComment,
    ],
  );

  return (
    <Fragment>
      <div className="review-comment">
        <ReviewAvatar author={comment.author} identity={identity} />
        <div className="review-comment-body">
          <div
            className={`review-comment-header${
              isPullRequest && !comment.isReadOnly ? ' with-comment-action' : ''
            }${comment.isReadOnly ? ' read-only' : ''}`}
          >
            <strong>{displayName}</strong>
            <span>{getReviewCommentLineLabel(comment)}</span>
            {!comment.isReadOnly ? (
              <button
                className="review-comment-action"
                disabled={!canAskCodex}
                onClick={askCodex}
                title={
                  canAskCodex ? `Ask ${agentLabel}` : `Write a note before asking ${agentLabel}`
                }
                type="button"
              >
                Ask
              </button>
            ) : null}
            {isPullRequest && !comment.isReadOnly ? (
              <button
                className="review-comment-action"
                disabled={!canSubmitComment}
                onClick={submitComment}
                title={
                  canSubmitComment ? 'Submit comment to GitHub' : 'Write a note before commenting'
                }
                type="button"
              >
                {comment.githubSubmit?.status === 'submitting' ? 'Sending' : 'Comment'}
              </button>
            ) : null}
            {!comment.isReadOnly ? (
              <button
                aria-label="Delete comment"
                className="review-comment-delete"
                onClick={() => onDeleteComment(comment.id)}
                title="Delete comment"
                type="button"
              >
                <X aria-hidden className="review-comment-delete-icon" size={14} weight="bold" />
              </button>
            ) : null}
          </div>
          <textarea
            aria-label={`Comment on ${comment.filePath} ${getReviewCommentLineLabel(comment)}`}
            className={`review-comment-input${comment.isReadOnly ? ' read-only' : ''}`}
            onBlur={handleCommentBlur}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onFocus={() => onCommentFocus(comment)}
            onKeyDown={handleCommentKeyDown}
            placeholder="Write a review comment…"
            readOnly={comment.isReadOnly}
            ref={isFocusedComment ? focusTextareaRef : undefined}
            rows={3}
            spellCheck
            value={draft}
          />
          {comment.githubSubmit?.status === 'error' ? (
            <div className="review-comment-error">{comment.githubSubmit.error}</div>
          ) : null}
        </div>
      </div>
      {comment.codexReply ? (
        <div className="review-comment codex">
          <AgentAvatar agentId={agentId} />
          <div className="review-comment-body codex">
            <div className="review-comment-header codex">
              <strong>{agentLabel}</strong>
            </div>
            <div
              className={`review-comment-codex-reply${
                comment.codexReply.status === 'loading' ? ' is-loading' : ''
              }${comment.codexReply.status === 'error' ? ' error' : ''}`}
            >
              {comment.codexReply.status === 'loading' ? (
                <span className="review-comment-codex-loading">Waiting for {agentLabel}…</span>
              ) : (
                renderMarkdown(comment.codexReply.body ?? comment.codexReply.error ?? '')
              )}
            </div>
          </div>
        </div>
      ) : null}
    </Fragment>
  );
}

export function ReviewCommentThread({
  agentId,
  agentLabel,
  annotation,
  comments,
  focusCommentId,
  focusCommentRequest,
  identity,
  isPullRequest,
  keymap,
  onAskCodex,
  onCommentBlur,
  onCommentFocus,
  onDeleteComment,
  onSubmitComment,
  onUpdateComment,
}: {
  agentId: 'codex' | 'claude';
  agentLabel: string;
  annotation: DiffLineAnnotation<ReviewCommentAnnotationMetadata>;
  comments: ReadonlyArray<ReviewComment>;
  focusCommentId: string | null;
  focusCommentRequest: number;
  identity: GitIdentity | null;
  isPullRequest: boolean;
  keymap: CodiffKeymap;
  onAskCodex: (commentId: string, body: string) => void;
  onCommentBlur: (comment: ReviewComment, body: string) => void;
  onCommentFocus: (comment: ReviewComment) => void;
  onDeleteComment: (commentId: string) => void;
  onSubmitComment: (commentId: string, body: string) => void;
  onUpdateComment: (commentId: string, body: string) => void;
}) {
  const annotationComments = annotation.metadata.commentIds
    .map((commentId) => comments.find((comment) => comment.id === commentId))
    .filter((comment): comment is ReviewComment => comment != null);

  if (annotationComments.length === 0) {
    return null;
  }

  return (
    <div className="review-comment-thread">
      {annotationComments.map((comment) => (
        <ReviewCommentEditor
          agentId={agentId}
          agentLabel={agentLabel}
          comment={comment}
          focusCommentId={focusCommentId}
          focusCommentRequest={focusCommentRequest}
          identity={identity}
          isPullRequest={isPullRequest}
          key={comment.id}
          keymap={keymap}
          onAskCodex={onAskCodex}
          onCommentBlur={onCommentBlur}
          onCommentFocus={onCommentFocus}
          onDeleteComment={onDeleteComment}
          onSubmitComment={onSubmitComment}
          onUpdateComment={onUpdateComment}
        />
      ))}
    </div>
  );
}
