import type {
  GitIdentity,
  ShareCommentSubmission,
  SharedWalkthroughSnapshot,
  SubmittedReviewComment,
} from '@nkzw/codiff-core';
import {
  PlanReviewSurface,
  ReviewSurface,
  type PlanReviewCommenting,
  type ShareReviewCommentCapabilities,
} from '@nkzw/codiff-core/react';
import type { ComponentProps, ReactNode } from 'react';

export type SharedPlanCommenting = PlanReviewCommenting;
export type SharedWalkthroughCommenting = {
  canComment?: boolean;
  onDeleteComment?: (commentId: string) => Promise<void>;
  onDeleteGeneralComment?: (commentId: string) => Promise<void>;
  onReplyGeneralComment?: (threadId: string, body: string) => Promise<void>;
  onResolveDiscussion?: (discussionId: string, resolved: boolean) => Promise<void>;
  onSignIn?: () => Promise<void> | void;
  onSubmitComment?: (comment: ShareCommentSubmission) => Promise<SubmittedReviewComment>;
  onSubmitGeneralComment?: (body: string) => Promise<void>;
  onUpdateComment?: (commentId: string, body: string) => Promise<void>;
  onUpdateGeneralComment?: (commentId: string, body: string) => Promise<void>;
};

type SubmittedShareCommentMessage = {
  authorImage: null | string;
  authorName: string;
  authorUsername: null | string;
  body: string;
  canEdit: boolean;
  createdAt: string;
  id: string;
  threadId: string;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const submittedShareCommentMessage = (value: unknown): SubmittedShareCommentMessage => {
  const message = asRecord(value);
  if (
    !message ||
    typeof message.authorName !== 'string' ||
    typeof message.body !== 'string' ||
    typeof message.canEdit !== 'boolean' ||
    typeof message.createdAt !== 'string' ||
    typeof message.id !== 'string' ||
    typeof message.threadId !== 'string'
  ) {
    throw new Error('Unable to load the submitted walkthrough comment.');
  }
  return {
    authorImage: typeof message.authorImage === 'string' ? message.authorImage : null,
    authorName: message.authorName,
    authorUsername: typeof message.authorUsername === 'string' ? message.authorUsername : null,
    body: message.body,
    canEdit: message.canEdit,
    createdAt: message.createdAt,
    id: message.id,
    threadId: message.threadId,
  };
};

const toSubmittedReviewComment = (
  comment: ShareCommentSubmission,
  message: SubmittedShareCommentMessage,
  threadId: string,
  canResolveThread: boolean,
): SubmittedReviewComment => ({
  ...comment,
  author: {
    ...(message.authorImage ? { avatarUrl: message.authorImage } : {}),
    login: message.authorUsername ?? message.authorName,
    name: message.authorName,
  },
  body: message.body,
  ...(message.canEdit ? { canDelete: true, canEdit: true } : {}),
  ...(canResolveThread ? { canResolveThread: true } : {}),
  destination: 'share',
  id: message.id,
  isReadOnly: true,
  submittedAt: message.createdAt,
  threadId,
});

export const resolveSubmittedShareReply = ({
  canResolveThread,
  comment,
  result,
}: {
  canResolveThread: boolean;
  comment: ShareCommentSubmission & { threadId: string };
  result: unknown;
}) =>
  toSubmittedReviewComment(
    comment,
    submittedShareCommentMessage(result),
    comment.threadId,
    canResolveThread,
  );

export const resolveSubmittedShareThread = ({
  canResolveThread,
  comment,
  result,
}: {
  canResolveThread: boolean;
  comment: ShareCommentSubmission;
  result: unknown;
}) => {
  const thread = asRecord(result);
  const messages = thread ? asRecord(thread.messages) : null;
  const firstItem = messages && Array.isArray(messages.items) ? asRecord(messages.items[0]) : null;
  if (!thread || typeof thread.id !== 'string' || !firstItem) {
    throw new Error('Unable to load the submitted walkthrough comment.');
  }
  return toSubmittedReviewComment(
    comment,
    submittedShareCommentMessage(firstItem.node),
    thread.id,
    canResolveThread,
  );
};

export const createSharedReviewCommentCapabilities = (
  commenting?: SharedWalkthroughCommenting,
): ShareReviewCommentCapabilities | undefined =>
  commenting
    ? {
        authoring: {
          canCreateInline: commenting.canComment === true && commenting.onSubmitComment != null,
        },
        destination: 'share',
        general:
          commenting.canComment === true
            ? {
                onCreate: commenting.onSubmitGeneralComment,
                onDelete: commenting.onDeleteGeneralComment,
                onReply: commenting.onReplyGeneralComment,
                onResolve: commenting.onResolveDiscussion,
                onUpdate: commenting.onUpdateGeneralComment,
              }
            : {},
        inline:
          commenting.canComment === true
            ? {
                onDelete: commenting.onDeleteComment,
                onResolve: commenting.onResolveDiscussion,
                onSubmit: commenting.onSubmitComment,
                onUpdate: commenting.onUpdateComment,
              }
            : {},
        onSignIn: commenting.onSignIn,
      }
    : undefined;

export function SharedPlanApp({
  providerLabel,
  ...props
}: Omit<ComponentProps<typeof PlanReviewSurface>, 'signInLabel'> & {
  providerLabel: string;
}) {
  return <PlanReviewSurface {...props} signInLabel={`Sign in with ${providerLabel} to comment`} />;
}

export function SharedWalkthroughApp({
  commenting,
  gitIdentity,
  onDeleteShare,
  providerLabel,
  settingsBar,
  snapshot,
}: {
  commenting?: SharedWalkthroughCommenting;
  gitIdentity?: GitIdentity | null;
  onDeleteShare?: () => Promise<void> | void;
  providerLabel: string;
  settingsBar?: ReactNode;
  snapshot: SharedWalkthroughSnapshot;
}) {
  const comments = createSharedReviewCommentCapabilities(commenting);

  return (
    <ReviewSurface
      capabilities={comments ? { comments } : undefined}
      gitIdentity={gitIdentity}
      onDeleteShare={onDeleteShare}
      providerLabel={providerLabel}
      settingsBar={settingsBar}
      signInLabel={`Sign in with ${providerLabel} to comment`}
      snapshot={snapshot}
    />
  );
}
