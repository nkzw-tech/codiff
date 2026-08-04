import type { MarkdownAnnotationAnchor } from '@nkzw/mdx-editor';
import type { ReviewAuthor } from './review-history.ts';
import type {
  DiffRange,
  GitSha,
  ReviewSource,
  ReviewVersionId,
  Revision,
} from './review-identity.ts';

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
  /** Provider version used to resolve the durable range, when applicable. */
  versionId?: ReviewVersionId;
};

export type PullRequestReviewComment = {
  anchor?: 'file' | 'line';
  body: string;
  filePath: string;
  lineNumber?: number;
  /** Local-only draft identity; provider payload builders deliberately omit it. */
  localDraftId?: string;
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
  /** Exact provider coordinates when the provider reports a start revision. */
  positionIdentity?: {
    baseSha: GitSha;
    headSha: GitSha;
    startSha: GitSha;
  };
  resolution?: {
    confidence: 'approximate' | 'exact';
    nearbyHunkContext?: { after?: string; before?: string };
    versions: ReadonlyArray<{ fromLabel: string; toLabel: string }>;
  };
  submittedAt?: string;
  url?: string;
  versionAssociation?: 'exact' | 'unmatched';
  versionHeadSha?: GitSha;
  versionId?: ReviewVersionId;
  versionLabel?: string;
};

export type PullRequestAIReviewDecision =
  | 'approved'
  | 'approved-with-comments'
  | 'changes-requested'
  | 'unknown';

export type PullRequestAIReview = {
  body: string;
  decision: PullRequestAIReviewDecision;
  id: string;
  reviewedHeadSha?: GitSha;
  reviewer: ReviewAuthor & { id: string };
  submittedAt?: string;
  url?: string;
  versionAssociation?: 'exact' | 'unmatched';
  versionHeadSha?: GitSha;
  versionId?: ReviewVersionId;
  versionLabel?: string;
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

export type ProviderCommentSubmission = ReviewCommentSubmissionBase & {
  /** Host-only identity used to account for partial review submission. */
  localDraftId: string;
  sectionId?: never;
} & ({ position: ProviderReviewCommentPosition } | { position?: never; threadId: string });

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
  comment: ProviderCommentSubmission;
  source: Extract<ReviewSource, { type: 'pull-request' }>;
};
export type SubmitPullRequestReviewRequest = {
  body?: string;
  comments: ReadonlyArray<ProviderCommentSubmission>;
  event: PullRequestReviewEvent;
  source: Extract<ReviewSource, { type: 'pull-request' }>;
};

export type SubmitPullRequestReviewResult =
  | {
      status: 'submitted';
      submittedDraftIds: ReadonlyArray<string>;
    }
  | {
      outcomeUnknownDraftIds?: ReadonlyArray<string>;
      reason: string;
      status: 'failed';
      submittedDraftIds: ReadonlyArray<string>;
    };
