import { useCallback, useState, type RefObject } from 'react';
import type { ReviewComment } from '../../lib/app-types.ts';
import {
  getPendingPullRequestReviewComments,
  getReviewCommentRangeProps,
  toPullRequestReviewComment,
} from '../../lib/review-comments.ts';
import type {
  PullRequestReviewEvent,
  PullRequestReviewStatus,
  RepositoryState,
  ReviewAssistantRequest,
} from '../../types.ts';
import { useReviewCommentDrafts } from './useReviewCommentDrafts.ts';

type UseAppReviewCommentsOptions = {
  isReviewActionDisabled: (
    reviewStatus: PullRequestReviewStatus | undefined,
    event: PullRequestReviewEvent,
  ) => boolean;
  onCommentFileChange: (filePath: string) => void;
  stateRef: RefObject<RepositoryState | null>;
};

export function useAppReviewComments({
  isReviewActionDisabled,
  onCommentFileChange,
  stateRef,
}: UseAppReviewCommentsOptions) {
  const [reviewComments, setReviewComments] = useState<ReadonlyArray<ReviewComment>>([]);
  const [pullRequestReviewSubmitting, setPullRequestReviewSubmitting] =
    useState<PullRequestReviewEvent | null>(null);
  const commentDrafts = useReviewCommentDrafts({
    comments: reviewComments,
    onCommentFileChange,
    setComments: setReviewComments,
  });
  const {
    activeReviewCommentDraftRef,
    activeReviewCommentDraftState,
    clearCommentFocus,
    reviewCommentsRef,
    updateActiveReviewCommentDraft,
  } = commentDrafts;

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
      onCommentFileChange(filePath);
    },
    [onCommentFileChange],
  );

  const updateRemoteSubmit = useCallback(
    (commentId: string, remoteSubmit: ReviewComment['remoteSubmit']) => {
      setReviewComments((current) =>
        current.map((comment) =>
          comment.id === commentId
            ? {
                ...comment,
                remoteSubmit,
              }
            : comment,
        ),
      );
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (comment) {
        onCommentFileChange(comment.filePath);
      }
    },
    [onCommentFileChange, reviewCommentsRef],
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
          ...(comment.lineNumber != null ? { lineNumber: comment.lineNumber } : {}),
          sectionId: comment.sectionId,
          ...(comment.side ? { side: comment.side } : {}),
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
    [reviewCommentsRef, stateRef, updateCodexReply],
  );

  const submitPullRequestComment = useCallback(
    (commentId: string) => {
      const currentState = stateRef.current;
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (
        currentState?.source.type !== 'pull-request' ||
        !comment ||
        comment.body.trim().length === 0 ||
        comment.remoteSubmit?.status === 'submitting'
      ) {
        return;
      }

      updateRemoteSubmit(comment.id, { status: 'submitting' });
      updateActiveReviewCommentDraft(null);
      void window.codiff
        .submitPullRequestComment({
          comment: toPullRequestReviewComment(comment),
          source: currentState.source,
        })
        .then((submittedComment) => {
          clearCommentFocus(comment.id);
          setReviewComments((current) =>
            current.map((candidate) =>
              candidate.id === comment.id
                ? {
                    author: submittedComment.author,
                    body: submittedComment.body,
                    filePath: submittedComment.filePath,
                    id: submittedComment.id,
                    isReadOnly: true,
                    ...(submittedComment.anchor === 'file' ? { anchor: 'file' as const } : {}),
                    ...(submittedComment.lineNumber != null
                      ? { lineNumber: submittedComment.lineNumber }
                      : {}),
                    sectionId: comment.sectionId,
                    ...(submittedComment.side ? { side: submittedComment.side } : {}),
                    ...getReviewCommentRangeProps(submittedComment),
                    submittedAt: submittedComment.submittedAt,
                    ...(submittedComment.threadId ? { threadId: submittedComment.threadId } : {}),
                    url: submittedComment.url,
                  }
                : candidate,
            ),
          );
          onCommentFileChange(comment.filePath);
        })
        .catch((error: unknown) => {
          updateRemoteSubmit(comment.id, {
            error: error instanceof Error ? error.message : String(error),
            status: 'error',
          });
        });
    },
    [
      clearCommentFocus,
      onCommentFileChange,
      reviewCommentsRef,
      stateRef,
      updateActiveReviewCommentDraft,
      updateRemoteSubmit,
    ],
  );

  const submitPullRequestReview = useCallback(
    (event: PullRequestReviewEvent, body?: string) => {
      const currentState = stateRef.current;
      if (
        currentState?.source.type !== 'pull-request' ||
        pullRequestReviewSubmitting ||
        isReviewActionDisabled(currentState.source.reviewStatus, event)
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
      const pendingCommentIds = new Set(pendingComments.map((comment) => comment.id));
      setPullRequestReviewSubmitting(event);
      return window.codiff
        .submitPullRequestReview({
          ...(body ? { body } : {}),
          comments: pendingComments.map((comment) => toPullRequestReviewComment(comment)),
          event,
          source: currentState.source,
        })
        .then(() => {
          updateActiveReviewCommentDraft(null);
          setReviewComments((current) =>
            current.filter((comment) => !pendingCommentIds.has(comment.id)),
          );
        })
        .catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : String(error));
          throw error;
        })
        .finally(() => {
          setPullRequestReviewSubmitting(null);
        });
    },
    [
      activeReviewCommentDraftRef,
      isReviewActionDisabled,
      pullRequestReviewSubmitting,
      reviewCommentsRef,
      stateRef,
      updateActiveReviewCommentDraft,
    ],
  );

  const hasPendingReviewComments =
    getPendingPullRequestReviewComments(reviewComments, activeReviewCommentDraftState).length > 0;

  return {
    ...commentDrafts,
    askCodex,
    hasPendingReviewComments,
    pullRequestReviewSubmitting,
    reviewComments,
    setReviewComments,
    submitPullRequestComment,
    submitPullRequestReview,
  };
}
