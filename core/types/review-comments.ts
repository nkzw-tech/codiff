import type { MarkdownAnnotationAnchor } from '@nkzw/mdx-editor';
import type { ReviewAuthor } from './review-history.ts';
import type { DiffRange, ReviewSource, Revision } from './review-identity.ts';

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

/** Durable persisted comment identity independent of a renderer section ID. */
export type ReviewCommentPosition = {
  range: DiffRange;
};

export type PullRequestReviewComment = {
  anchor?: 'file' | 'line';
  body: string;
  filePath: string;
  lineNumber?: number;
  position?: ReviewCommentPosition;
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

type ReviewCommentSubmissionBase = {
  anchor?: 'file' | 'line';
  body: string;
  filePath: string;
  lineNumber?: number;
  side?: 'additions' | 'deletions';
  startLineNumber?: number;
  startSide?: 'additions' | 'deletions';
  threadId?: string;
};

type CommitRevision = Extract<Revision, { sha: unknown }>;

export type ProviderReviewCommentPosition = {
  range: {
    base: CommitRevision;
    head: CommitRevision;
  };
};

export type ProviderCommentSubmission = ReviewCommentSubmissionBase &
  (
    | {
        position: ProviderReviewCommentPosition;
        sectionId?: never;
      }
    | {
        position?: never;
        sectionId?: never;
        threadId: string;
      }
  );

export type ShareCommentSubmission = ReviewCommentSubmissionBase &
  (
    | {
        position: ReviewCommentPosition;
        sectionId?: never;
      }
    | {
        position?: never;
        sectionId: string;
      }
  );

type SubmittedReviewCommentBase = ReviewCommentSubmissionBase & {
  author: ReviewAuthor;
  canDelete?: boolean;
  canEdit?: boolean;
  canReplyThread?: boolean;
  canResolveThread?: boolean;
  id: string;
  isOutdated?: boolean;
  isReadOnly: true;
  isThreadResolved?: boolean;
  resolvedSectionId?: string;
  submittedAt?: string;
  url?: string;
};

export type SubmittedReviewComment = SubmittedReviewCommentBase &
  (
    | {
        destination: 'provider';
        position?: ProviderReviewCommentPosition;
        sectionId?: never;
      }
    | {
        destination: 'share';
        position?: ReviewCommentPosition;
        sectionId?: string;
      }
  );

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
