import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { ReviewComment } from '../../lib/app-types.ts';
import { findReusableReviewCommentDraft, getCommentKey } from '../../lib/review-comments.ts';

type ReviewCommentDraft = Pick<ReviewComment, 'body' | 'id'>;

type UseReviewCommentDraftsOptions = {
  canCreateComment?: boolean;
  comments: ReadonlyArray<ReviewComment>;
  onCommentFileChange: (filePath: string) => void;
  setComments: Dispatch<SetStateAction<ReadonlyArray<ReviewComment>>>;
};

const updateCommentBody = (
  comments: ReadonlyArray<ReviewComment>,
  commentId: string,
  body: string,
) => {
  let changed = false;
  const next = comments.map((comment) => {
    if (comment.id !== commentId || comment.isReadOnly || comment.body === body) {
      return comment;
    }
    changed = true;
    return { ...comment, body };
  });
  return changed ? next : comments;
};

export function useReviewCommentDrafts({
  canCreateComment = true,
  comments,
  onCommentFileChange,
  setComments,
}: UseReviewCommentDraftsOptions) {
  const [activeReviewCommentDraftState, setActiveReviewCommentDraftState] =
    useState<ReviewCommentDraft | null>(null);
  const activeReviewCommentDraftRef = useRef<ReviewCommentDraft | null>(null);
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  const [focusCommentRequest, setFocusCommentRequest] = useState(0);
  const reviewCommentsRef = useRef(comments);

  useEffect(() => {
    reviewCommentsRef.current = comments;
  }, [comments]);

  const updateActiveReviewCommentDraft = useCallback((comment: ReviewCommentDraft | null) => {
    activeReviewCommentDraftRef.current = comment;
    setActiveReviewCommentDraftState((current) => {
      if (comment == null) {
        return current == null ? current : null;
      }

      const body = comment.body.trim().length > 0 ? 'pending' : '';
      return current?.id === comment.id && current.body === body
        ? current
        : { body, id: comment.id };
    });
  }, []);

  const focusComment = useCallback((commentId: string) => {
    setFocusCommentId(commentId);
    setFocusCommentRequest((current) => current + 1);
  }, []);

  const clearCommentFocus = useCallback((commentId: string) => {
    setFocusCommentId((current) => (current === commentId ? null : current));
  }, []);

  const resetCommentFocus = useCallback(() => {
    setFocusCommentId(null);
    setFocusCommentRequest(0);
  }, []);

  const createComment = useCallback(
    (comment: Omit<ReviewComment, 'body' | 'id'>) => {
      if (!canCreateComment) {
        return;
      }

      const commentKey = getCommentKey(comment);
      const emptyExistingComment = reviewCommentsRef.current.find(
        (candidate) => candidate.body.length === 0 && getCommentKey(candidate) === commentKey,
      );
      if (emptyExistingComment) {
        focusComment(emptyExistingComment.id);
        return;
      }

      const emptyDraft = findReusableReviewCommentDraft(
        reviewCommentsRef.current,
        activeReviewCommentDraftRef.current,
      );
      if (emptyDraft) {
        const id = crypto.randomUUID();
        focusComment(id);
        setComments((current) =>
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
        onCommentFileChange(emptyDraft.filePath);
        onCommentFileChange(comment.filePath);
        return;
      }

      const id = crypto.randomUUID();
      focusComment(id);
      setComments((current) => [...current, { ...comment, body: '', id }]);
      onCommentFileChange(comment.filePath);
    },
    [canCreateComment, focusComment, onCommentFileChange, setComments],
  );

  const updateComment = useCallback(
    (commentId: string, body: string) => {
      reviewCommentsRef.current = updateCommentBody(reviewCommentsRef.current, commentId, body);
      setComments((current) => updateCommentBody(current, commentId, body));
    },
    [setComments],
  );

  const deleteComment = useCallback(
    (commentId: string) => {
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      updateActiveReviewCommentDraft(null);
      clearCommentFocus(commentId);
      setComments((current) => current.filter((candidate) => candidate.id !== commentId));
      if (comment) {
        onCommentFileChange(comment.filePath);
      }
    },
    [clearCommentFocus, onCommentFileChange, setComments, updateActiveReviewCommentDraft],
  );

  return {
    activeReviewCommentDraftRef,
    activeReviewCommentDraftState,
    clearCommentFocus,
    createComment,
    deleteComment,
    focusComment,
    focusCommentId,
    focusCommentRequest,
    resetCommentFocus,
    reviewCommentsRef,
    updateActiveReviewCommentDraft,
    updateComment,
  };
}
