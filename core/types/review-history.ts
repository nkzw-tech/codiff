import type {
  PullRequestExistingReviewComment,
  PullRequestGeneralCommentThread,
} from './review-comments.ts';
import type {
  ChangedFile,
  GitFileStatus,
  GitSha,
  ResolvedReviewSource,
} from './review-identity.ts';

export type ReviewAuthor = {
  avatarUrl?: string;
  login: string;
  name?: string;
  url?: string;
};

export type PullRequestReviewer = ReviewAuthor & { approved: boolean; id: string };
export type PullRequestReviewActionStatus = { disabled?: boolean; reason?: string };
export type PullRequestReviewStatus = {
  approve?: PullRequestReviewActionStatus;
  close?: PullRequestReviewActionStatus;
  comment?: PullRequestReviewActionStatus;
  requestChanges?: PullRequestReviewActionStatus;
};

export type PullRequestMergeCheckStatus = 'failed' | 'neutral' | 'pending' | 'success';
export type PullRequestMergeCheck = {
  detail?: string;
  label: string;
  status: PullRequestMergeCheckStatus;
  url?: string;
};
export type PullRequestMergeOptions = { removeSourceBranch: boolean; squash: boolean };
export type PullRequestMergeState = {
  autoMergeEnabled: boolean;
  canCancelAutoMerge: boolean;
  canMerge: boolean;
  canSetAutoMerge: boolean;
  checks: ReadonlyArray<PullRequestMergeCheck>;
  detailedStatus?: string;
  forceRemoveSourceBranch: boolean;
  mergeError?: string;
  options: PullRequestMergeOptions;
  reason?: string;
  sha: string;
  status: 'blocked' | 'checking' | 'closed' | 'merged' | 'ready' | 'waiting';
  statusLabel: string;
};

export type PullRequestCodeQualityFinding = {
  description: string;
  engineName?: string;
  filePath: string;
  fingerprint: string;
  lineNumber: number;
  severity: 'blocker' | 'critical' | 'info' | 'major' | 'minor' | 'unknown';
  status: 'existing' | 'new' | 'resolved';
  url?: string;
};

export type HistoryEntry = {
  author: string;
  committedAt: number;
  gravatarUrl?: string;
  parentShas: ReadonlyArray<GitSha>;
  scope?: 'base' | 'pull-request';
  sha: GitSha;
  subject: string;
};

/** Canonical provider-neutral commit item in a current review stack. */
export type ReviewCommitSummary = {
  authoredAt: string;
  authorName: string;
  parentShas: ReadonlyArray<GitSha>;
  sha: GitSha;
  shortSha: string;
  subject: string;
  webUrl?: string;
};

/** One ordinary commit in a Target Comparison review plan. */
export type ReviewCommitUnit = {
  commit: ReviewCommitSummary;
  kind: 'commit';
  order: number;
  reviewable: true;
};

/** Reviewable work units begin with ordinary commits; V01 adds Evolution Units. */
export type ReviewUnit = ReviewCommitUnit;

/** One Tree projection for a Target Comparison. */
export type TreeInspectionScope = { kind: 'complete-diff' } | { kind: 'commit'; sha: GitSha };

export type TargetComparisonReviewStructure = 'commit-by-commit' | 'net-change';

/** Target Comparison generation never uses Evolution Units. */
export type TargetComparisonReviewPlan =
  | {
      reviewRelation: 'target-comparison';
      structure: 'net-change';
    }
  | {
      reviewRelation: 'target-comparison';
      structure: 'commit-by-commit';
      units: ReadonlyArray<ReviewCommitUnit>;
    };

/** Resolved generation plan; V01 extends this union with Version Comparison plans. */
export type ReviewPlan = TargetComparisonReviewPlan;

export type ReviewStrategySummary = {
  confidence: number;
  mode: TargetComparisonReviewStructure;
  reason: string;
};

export type CommitMetadataPerson = {
  date: string;
  email: string;
  gravatarUrl?: string;
  name: string;
};

export type CommitMetadataFile = {
  additions?: number;
  binary: boolean;
  deletions?: number;
  oldPath?: string;
  path: string;
  status: GitFileStatus;
};

export type CommitMetadata = {
  author: CommitMetadataPerson;
  body: string;
  committer: CommitMetadataPerson;
  files: ReadonlyArray<CommitMetadataFile>;
  parentShas: ReadonlyArray<GitSha>;
  refs: ReadonlyArray<string>;
  sha: GitSha;
  shortSha: string;
  signature: { key?: string; signer?: string; status: string };
  stats: {
    additions: number;
    binaryFiles: number;
    deletions: number;
    files: number;
    renamedFiles: number;
  };
  subject: string;
  trailers: ReadonlyArray<{ key: string; value: string }>;
};

export type RepositoryHistory = { entries: ReadonlyArray<HistoryEntry>; root: string };

export type RepositoryState = {
  branch: string | null;
  codeQualityFindings?: ReadonlyArray<PullRequestCodeQualityFinding>;
  commitMetadata?: CommitMetadata;
  files: ReadonlyArray<ChangedFile>;
  generalComments?: ReadonlyArray<PullRequestGeneralCommentThread>;
  generatedAt: number;
  launchPath: string;
  reviewComments?: ReadonlyArray<PullRequestExistingReviewComment>;
  reviewCommentsError?: string;
  reviewCommentsLoadState?: 'failed' | 'loaded' | 'not-loaded';
  root: string;
  source: ResolvedReviewSource;
};
