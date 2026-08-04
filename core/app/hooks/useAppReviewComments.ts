import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type {
  LocalReviewNote,
  ProviderCommentDraft,
  ReviewComment,
  ReviewDraft,
} from '../../lib/app-types.ts';
import {
  getReviewCommentRangeProps,
  isLocalReviewNote,
  isProviderCommentDraft,
  isProviderInlineComment,
  isReviewDraft,
} from '../../lib/review-comments.ts';
import type { RepositoryState, ReviewAssistantRequest } from '../../types.ts';
import { useReviewCommentDrafts } from './useReviewCommentDrafts.ts';

type UseAppReviewCommentsOptions = {
  draftKind: ReviewDraft['kind'];
  initialReviewComments?: ReadonlyArray<ReviewComment>;
  onCommentFileChange: (filePath: string) => void;
  stateRef: RefObject<RepositoryState | null>;
};

export function useAppReviewComments({
  draftKind,
  initialReviewComments = [],
  onCommentFileChange,
  stateRef,
}: UseAppReviewCommentsOptions) {
  const [reviewComments, setReviewComments] =
    useState<ReadonlyArray<ReviewComment>>(initialReviewComments);
  const commentDrafts = useReviewCommentDrafts({
    comments: reviewComments,
    draftKind,
    onCommentFileChange,
    setComments: setReviewComments,
  });

  const updateCodexReply = useCallback(
    (commentId: string, filePath: string, codexReply: NonNullable<ReviewDraft['codexReply']>) => {
      setReviewComments((current) =>
        current.map((comment) =>
          comment.id === commentId && isReviewDraft(comment)
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
    (comment: ReviewDraft) => {
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

  const localReviewNotes = reviewComments.filter(isLocalReviewNote);
  const providerDrafts = reviewComments.filter(isProviderCommentDraft);
  const providerInlineComments = reviewComments.filter(isProviderInlineComment);
  const setLocalReviewNotes = useCallback<Dispatch<SetStateAction<ReadonlyArray<LocalReviewNote>>>>(
    (update) => {
      setReviewComments((current) => {
        const currentNotes = current.filter(isLocalReviewNote);
        const nextNotes = typeof update === 'function' ? update(currentNotes) : update;
        return [...current.filter((comment) => !isLocalReviewNote(comment)), ...nextNotes];
      });
    },
    [],
  );
  const setProviderDrafts = useCallback<
    Dispatch<SetStateAction<ReadonlyArray<ProviderCommentDraft>>>
  >((update) => {
    setReviewComments((current) => {
      const currentDrafts = current.filter(isProviderCommentDraft);
      const nextDrafts = typeof update === 'function' ? update(currentDrafts) : update;
      return [...current.filter((comment) => !isProviderCommentDraft(comment)), ...nextDrafts];
    });
  }, []);

  return {
    ...commentDrafts,
    askCodex,
    localReviewNotes,
    providerDrafts,
    providerInlineComments,
    reviewComments,
    setLocalReviewNotes,
    setProviderDrafts,
    setReviewComments,
  };
}
