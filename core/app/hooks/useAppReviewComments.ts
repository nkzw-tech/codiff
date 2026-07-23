import { useCallback, useState, type RefObject } from 'react';
import type { ReviewComment } from '../../lib/app-types.ts';
import { getReviewCommentRangeProps } from '../../lib/review-comments.ts';
import type { RepositoryState, ReviewAssistantRequest } from '../../types.ts';
import { useReviewCommentDrafts } from './useReviewCommentDrafts.ts';

type UseAppReviewCommentsOptions = {
  initialReviewComments?: ReadonlyArray<ReviewComment>;
  onCommentFileChange: (filePath: string) => void;
  stateRef: RefObject<RepositoryState | null>;
};

export function useAppReviewComments({
  initialReviewComments = [],
  onCommentFileChange,
  stateRef,
}: UseAppReviewCommentsOptions) {
  const [reviewComments, setReviewComments] =
    useState<ReadonlyArray<ReviewComment>>(initialReviewComments);
  const commentDrafts = useReviewCommentDrafts({
    comments: reviewComments,
    onCommentFileChange,
    setComments: setReviewComments,
  });

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

  const askCodex = useCallback(
    (comment: ReviewComment) => {
      const currentState = stateRef.current;
      if (
        !currentState ||
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
    [stateRef, updateCodexReply],
  );

  return {
    ...commentDrafts,
    askCodex,
    reviewComments,
    setReviewComments,
  };
}
