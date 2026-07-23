import type { MarkdownAnnotationAnchor } from '@nkzw/mdx-editor';
import type { ReviewAuthor } from './review-history.ts';
import type { ReviewSource } from './review-identity.ts';

export type PlanCommentAuthor = {
  avatarUrl?: string;
  email?: string;
  id: string;
  name: string;
  username?: string;
};

export type PlanCommentMessage = {
  author: PlanCommentAuthor;
  body: string;
  canDelete?: boolean;
  canEdit?: boolean;
  createdAt: string;
  id: string;
  updatedAt: string;
};

export type PlanCommentThread = {
  anchor: MarkdownAnnotationAnchor;
  canReply?: boolean;
  canResolve?: boolean;
  createdAt: string;
  createdBy: PlanCommentAuthor;
  id: string;
  messages: ReadonlyArray<PlanCommentMessage>;
  resolution?: { reason: 'agent-handled' | 'anchor-removed'; resolvedAt: string };
  status: 'open' | 'resolved';
  updatedAt: string;
};

export type PlanReview = {
  document: { id: string; path: string; version: string };
  threads: ReadonlyArray<PlanCommentThread>;
  version: 1;
};

export type PlanHandoffStatus = 'closed' | 'done';

export type PullRequestReviewComment = {
  anchor?: 'file' | 'line';
  body: string;
  filePath: string;
  lineNumber?: number;
  sectionId?: string;
  side?: 'additions' | 'deletions';
  startLineNumber?: number;
  startSide?: 'additions' | 'deletions';
  threadId?: string;
};

export type PullRequestExistingReviewComment = PullRequestReviewComment & {
  author: ReviewAuthor;
  canDelete?: boolean;
  canEdit?: boolean;
  canReplyThread?: boolean;
  canResolveThread?: boolean;
  id: string;
  isOutdated?: boolean;
  isThreadResolved?: boolean;
  submittedAt?: string;
  url?: string;
};

// These destination-specific names intentionally sit at the capability boundary.
// Their coordinate shapes are refined by the review-comment coordinate layer.
export type ProviderCommentSubmission = PullRequestReviewComment;
export type ShareCommentSubmission = PullRequestReviewComment;
export type SubmittedReviewComment = PullRequestExistingReviewComment;

export type PullRequestGeneralComment = {
  author: ReviewAuthor;
  body: string;
  canDelete?: boolean;
  canEdit?: boolean;
  id: string;
  submittedAt?: string;
  url?: string;
};

export type PullRequestGeneralCommentThread = {
  canReply?: boolean;
  canResolve?: boolean;
  comments: ReadonlyArray<PullRequestGeneralComment>;
  id: string;
  isResolved?: boolean;
};

export type ReviewCommenting = {
  canComment?: boolean;
  onDeleteComment?: (commentId: string) => Promise<void>;
  onDeleteGeneralComment?: (commentId: string) => Promise<void>;
  onReplyGeneralComment?: (threadId: string, body: string) => Promise<void>;
  onResolveDiscussion?: (discussionId: string, resolved: boolean) => Promise<void>;
  onSignIn?: () => Promise<void> | void;
  onSubmitComment?: (
    comment: PullRequestReviewComment,
  ) => Promise<PullRequestExistingReviewComment>;
  onSubmitGeneralComment?: (body: string) => Promise<void>;
  onUpdateComment?: (commentId: string, body: string) => Promise<void>;
  onUpdateGeneralComment?: (commentId: string, body: string) => Promise<void>;
};

export type PullRequestReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
export type SubmitPullRequestCommentRequest = {
  comment: PullRequestReviewComment;
  source: Extract<ReviewSource, { type: 'pull-request' }>;
};
export type SubmitPullRequestReviewRequest = {
  body?: string;
  comments: ReadonlyArray<PullRequestReviewComment>;
  event: PullRequestReviewEvent;
  source: Extract<ReviewSource, { type: 'pull-request' }>;
};
