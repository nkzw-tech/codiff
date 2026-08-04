import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type {
  LocalReviewNote,
  ProviderCommentDraft,
  ReviewComment,
  ReviewDraft,
} from '../../lib/app-types.ts';
import {
  getPendingPullRequestReviewComments,
  getReviewCommentRangeProps,
  isLocalReviewNote,
  isProviderCommentDraft,
  isProviderInlineComment,
  isReviewDraft,
  toProviderCommentSubmission,
  toProviderSubmittedReviewComment,
  toRenderedSubmittedReviewComment,
} from '../../lib/review-comments.ts';
import type {
  PullRequestReviewEvent,
  PullRequestReviewStatus,
  RepositoryState,
  ReviewAssistantRequest,
} from '../../types.ts';
import { useReviewCommentDrafts } from './useReviewCommentDrafts.ts';

type UseAppReviewCommentsOptions = {
  draftKind: ReviewDraft['kind'];
  initialReviewComments?: ReadonlyArray<ReviewComment>;
  isReviewActionDisabled: (
    reviewStatus: PullRequestReviewStatus | undefined,
    event: PullRequestReviewEvent,
  ) => boolean;
  onCommentFileChange: (filePath: string) => void;
  stateRef: RefObject<RepositoryState | null>;
};

export function useAppReviewComments({
  draftKind,
  initialReviewComments = [],
  isReviewActionDisabled,
  onCommentFileChange,
  stateRef,
}: UseAppReviewCommentsOptions) {
  const [reviewComments, setReviewComments] =
    useState<ReadonlyArray<ReviewComment>>(initialReviewComments);
  const [pullRequestReviewSubmitting, setPullRequestReviewSubmitting] =
    useState<PullRequestReviewEvent | null>(null);
  const commentDrafts = useReviewCommentDrafts({
    comments: reviewComments,
    draftKind,
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

  const updateRemoteSubmit = useCallback(
    (commentId: string, remoteSubmit: ProviderCommentDraft['remoteSubmit']) => {
      setReviewComments((current) =>
        current.map((comment) =>
          comment.id === commentId && isProviderCommentDraft(comment)
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

  const submitPullRequestComment = useCallback(
    (commentId: string) => {
      const currentState = stateRef.current;
      const comment = reviewCommentsRef.current.find(
        (candidate): candidate is ProviderCommentDraft =>
          candidate.id === commentId && isProviderCommentDraft(candidate),
      );
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
      let submission;
      try {
        submission = toProviderCommentSubmission(comment);
      } catch (error: unknown) {
        updateRemoteSubmit(comment.id, {
          error: error instanceof Error ? error.message : String(error),
          status: 'error',
        });
        return;
      }
      void window.codiff
        .submitPullRequestComment({
          comment: submission,
          source: currentState.source,
        })
        .then((submittedComment) => {
          clearCommentFocus(comment.id);
          setReviewComments((current) =>
            current.map((candidate) =>
              candidate.id === comment.id
                ? toRenderedSubmittedReviewComment(
                    toProviderSubmittedReviewComment(submittedComment, submission),
                    comment,
                  )
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
        reviewCommentsRef.current.filter(isProviderCommentDraft),
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
          comments: pendingComments.map((comment) => toProviderCommentSubmission(comment)),
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
  const hasPendingReviewComments =
    getPendingPullRequestReviewComments(providerDrafts, activeReviewCommentDraftState).length > 0;

  return {
    ...commentDrafts,
    askCodex,
    hasPendingReviewComments,
    localReviewNotes,
    providerDrafts,
    providerInlineComments,
    pullRequestReviewSubmitting,
    reviewComments,
    setLocalReviewNotes,
    setProviderDrafts,
    setReviewComments,
    submitPullRequestComment,
    submitPullRequestReview,
  };
}
