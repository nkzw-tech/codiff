import type {
  PullRequestExistingReviewComment,
  PullRequestGeneralCommentThread,
} from './review-comments.ts';
import type {
  ChangedFile,
  DiffComparison,
  DiffRange,
  EvolutionUnitId,
  GitFileStatus,
  GitSha,
  ResolvedReviewSource,
  ReviewSource,
  ReviewVersionId,
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
  diffStat?: { additions: number; deletions: number; filesChanged: number };
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
  diffStat?: { additions: number; deletions: number; filesChanged: number };
  parentShas: ReadonlyArray<GitSha>;
  sha: GitSha;
  shortSha: string;
  subject: string;
  webUrl?: string;
};

/** Complete canonical commit item consumed by current-review stack surfaces. */
export type ReviewCommitListEntry = ReviewCommitSummary & {
  role?: string;
};

export type DiffComparisonCommentAssociation = {
  commentId: string;
  filePath?: string;
  status: 'newly-anchored' | 'outdated' | 'resolved-by-change' | 'still-valid';
};

export type DiffComparisonBaseMovementCommit = {
  authoredAt: string;
  authorName: string;
  sha: GitSha;
  shortSha: string;
  subject: string;
  webUrl?: string;
};

export type DiffComparisonBaseMovement = {
  changed: boolean;
  commits?: ReadonlyArray<DiffComparisonBaseMovementCommit>;
  commitsBetween: number | null;
  commitTimestampDeltaMs: number | null;
  diffStat: { additions: number; deletions: number; filesChanged: number } | null;
  from: { committedAt: string | null; sha: GitSha; shortSha: string; webUrl?: string };
  relationship: 'forward' | 'backward' | 'divergent' | 'unknown';
  to: { committedAt: string | null; sha: GitSha; shortSha: string; webUrl?: string };
  truncated: boolean;
  warning?: string;
};

export type DiffComparisonSummary = {
  addedLines: number;
  baseMoved: boolean;
  commentsAffected: number;
  conflictFiles: number;
  deletedLines: number;
  empty: boolean;
  filesChanged: number;
  intentionalFiles: number;
  noiseFiles: number;
};

export type ReviewRebaseOverlapCommit = {
  authoredAt: string;
  authorName: string;
  overlappingPaths: ReadonlyArray<string>;
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

/** Version Comparison reviewable units retain their own branded identity. */
export type ReviewEvolutionReviewableUnit =
  | {
      after: ReviewCommitSummary;
      confidence: 'exact' | 'high' | 'unmatched';
      kind: 'introduced';
      matchReasons?: ReadonlyArray<string>;
      matchScore?: number;
      order: number;
      reviewable: true;
      unitId: EvolutionUnitId;
    }
  | {
      before: ReviewCommitSummary;
      confidence: 'exact' | 'high' | 'unmatched';
      kind: 'removed';
      matchReasons?: ReadonlyArray<string>;
      matchScore?: number;
      order: number;
      reviewable: true;
      unitId: EvolutionUnitId;
    }
  | {
      after: ReviewCommitSummary;
      before: ReviewCommitSummary;
      confidence: 'exact' | 'high' | 'unmatched';
      kind: 'revised';
      matchReasons?: ReadonlyArray<string>;
      matchScore?: number;
      order: number;
      rebaseOverlaps?: ReadonlyArray<ReviewRebaseOverlapCommit>;
      reviewable: true;
      unitId: EvolutionUnitId;
    }
  | {
      after: ReviewCommitSummary;
      before: ReviewCommitSummary;
      confidence: 'exact' | 'high' | 'unmatched';
      kind: 'ambiguous';
      matchReasons?: ReadonlyArray<string>;
      matchScore?: number;
      order: number;
      reviewable: true;
      unitId: EvolutionUnitId;
    };

export type ReviewUnit = ReviewCommitUnit | ReviewEvolutionReviewableUnit;

/** Non-reviewable evolution markers retained for stack display. */
export type ReviewEvolutionMarkerUnit = {
  after?: ReviewCommitSummary;
  baseCommit?: ReviewCommitSummary;
  before?: ReviewCommitSummary;
  confidence: 'exact' | 'high' | 'unmatched';
  kind: 'retained' | 'rewritten-same-patch' | 'absorbed-into-base' | 'ambiguous';
  matchReasons?: ReadonlyArray<string>;
  matchScore?: number;
  order: number;
  reviewable: false;
  unitId: EvolutionUnitId;
};

/** Evolution Units are presented by their explicit numeric `order`. */
export type ReviewEvolutionUnit = ReviewUnit | ReviewEvolutionMarkerUnit;

export type VersionCommitKind = Exclude<ReviewEvolutionUnit['kind'], 'commit'>;

/** One Tree projection for the active review relation. */
export type TreeInspectionScope =
  | { kind: 'complete-diff' }
  | { kind: 'commit'; sha: GitSha }
  | { kind: 'evolution-unit'; unitId: EvolutionUnitId };

export type TargetComparisonReviewStructure = 'commit-by-commit' | 'net-change';
export type VersionComparisonReviewStructure = 'commit-evolution' | 'complete-comparison';

export type ReviewSelection =
  | { kind: 'target-comparison'; versionId: ReviewVersionId }
  | {
      fromVersionId: ReviewVersionId;
      kind: 'version-comparison';
      toVersionId: ReviewVersionId;
    };

export type ReviewEvolutionSummary = {
  absorbedIntoBase: number;
  added: number;
  ambiguous: number;
  /** Every selected change can be represented by a reviewable Evolution Unit. */
  completeCoverage: boolean;
  pairingCoverage: number;
  removed: number;
  retained: number;
  reviewable: number;
  revised: number;
  rewrittenSamePatch: number;
  unreviewableAmbiguous: number;
};

export type ReviewStructureRecommendation = {
  confidence?: number;
  rationale: string;
  suggestedStructure: VersionComparisonReviewStructure;
};

export type ReviewCommitEvolution = {
  recommendation: ReviewStructureRecommendation;
  summary: ReviewEvolutionSummary;
  units: ReadonlyArray<ReviewEvolutionUnit>;
  warnings?: ReadonlyArray<string>;
};

export type DiffComparisonAnalysis = {
  baseMovement?: DiffComparisonBaseMovement;
  commentAssociations?: ReadonlyArray<DiffComparisonCommentAssociation>;
  commitEvolution?: ReviewCommitEvolution;
  summary: DiffComparisonSummary;
  warnings?: ReadonlyArray<string>;
};

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

export type VersionComparisonReviewPlan =
  | {
      analysis?: DiffComparisonAnalysis;
      comparison?: DiffComparison;
      reviewRelation: 'version-comparison';
      structure: 'complete-comparison';
    }
  | {
      analysis?: DiffComparisonAnalysis;
      comparison?: DiffComparison;
      reviewRelation: 'version-comparison';
      structure: 'commit-evolution';
      units: ReadonlyArray<ReviewEvolutionReviewableUnit>;
    };

export type ReviewPlan = TargetComparisonReviewPlan | VersionComparisonReviewPlan;

export type ReviewVersionActivityReason = {
  kind: 'approval' | 'comment' | 'review';
  occurredAt: string;
};

export type ReviewVersionActivity = {
  latestAt: string;
  reasons: ReadonlyArray<ReviewVersionActivityReason>;
};

export type SuggestedReviewComparison = {
  fromVersionId: ReviewVersionId;
  reason: 'previous-version' | 'reviewer-activity';
  toVersionId: ReviewVersionId;
};

export type ReviewVersionOption = {
  activity?: ReviewVersionActivity;
  createdAt: string;
  diffStat?: { additions: number; deletions: number; filesChanged: number };
  isHead?: boolean;
  number?: number;
  previousCreatedAt?: string;
  previousNumber?: number;
  range: DiffRange;
  unavailableReason?: string;
  versionId: ReviewVersionId;
};

export type DiffComparisonView = {
  analysis: DiffComparisonAnalysis;
  comparison: DiffComparison;
  files: ReadonlyArray<ChangedFile>;
  from: ReviewVersionOption;
  to: ReviewVersionOption;
};

export type ReviewComparisonState = {
  aggregate:
    | { status: 'idle' | 'loading' }
    | { error: string; status: 'failed' }
    | { comparison: DiffComparisonView; status: 'ready' };
  evolution:
    | { status: 'idle' | 'loading' }
    | { error: string; status: 'failed' }
    | { evolution: ReviewCommitEvolution; status: 'ready' };
  fromVersionId: ReviewVersionId;
  toVersionId: ReviewVersionId;
};

export type ReviewVersionCompareEndpoint =
  | { kind: 'base' }
  | { kind: 'version'; versionId: ReviewVersionId }
  | { kind: 'head-sha'; sha: GitSha }
  | {
      baseSha: GitSha;
      commentId: string;
      headSha: GitSha;
      kind: 'comment-position';
      startSha: GitSha;
    };

type ReviewVersionRangeRequest = {
  from?: ReviewVersionCompareEndpoint;
  fromVersionId?: ReviewVersionId;
  source: Extract<ReviewSource, { type: 'pull-request' }>;
  to?: ReviewVersionCompareEndpoint;
  toVersionId?: ReviewVersionId;
};

export type ReviewVersionAggregateRequest = ReviewVersionRangeRequest;
export type ReviewVersionAggregateResult = {
  versionCompare: DiffComparisonView;
  warning?: string | null;
};

export type ReviewVersionEvolutionRequest = ReviewVersionRangeRequest;
export type ReviewVersionEvolutionResult = {
  versionCommitEvolution: ReviewCommitEvolution;
  warning?: string | null;
};

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
