import type { CodeViewHandle } from '@pierre/diffs/react';
import type { ReactNode } from 'react';
import type {
  ChangedFile,
  DiffSection,
  NarrativeWalkthrough,
  NarrativeWalkthroughResult,
  PullRequestCodeQualityFinding,
  PullRequestExistingReviewComment,
  ReviewSource,
} from '../types.ts';

export type WalkthroughError = Extract<NarrativeWalkthroughResult, { status: 'unavailable' }>;

export type ReviewCommentAnnotationMetadata = {
  commentIds: ReadonlyArray<string>;
  type: 'review-comment';
};

export type CodeQualityAnnotationMetadata = {
  finding: PullRequestCodeQualityFinding;
  type: 'code-quality';
};

type MarkdownPreviewAnnotationMetadata = {
  addedLines: ReadonlySet<number>;
  contents: string;
  editable: boolean;
  layoutKey: string;
  path: string;
  sectionId: string;
  type: 'markdown-preview';
};

type ImagePreviewAnnotationMetadata = {
  path: string;
  sectionId: string;
  type: 'image-preview';
};

type WalkthroughHeaderAnnotationMetadata = {
  header: ReactNode;
  type: 'walkthrough-header';
};

export type ReviewAnnotationMetadata =
  | CodeQualityAnnotationMetadata
  | ImagePreviewAnnotationMetadata
  | MarkdownPreviewAnnotationMetadata
  | ReviewCommentAnnotationMetadata
  | WalkthroughHeaderAnnotationMetadata;

export type CodeViewInstance = NonNullable<
  ReturnType<CodeViewHandle<ReviewAnnotationMetadata>['getInstance']>
>;

export type DiffSearchMatch = {
  filePath: string;
  itemId: string;
  lineNumber?: number;
  side?: 'additions' | 'deletions';
};

export type DiffSearchResult = {
  file: ChangedFile;
  matchCount: number;
  matches: ReadonlyArray<DiffSearchMatch>;
};

export type ReviewScrollBehavior = 'instant' | 'smooth';

export type ReviewScrollTarget = {
  behavior?: ReviewScrollBehavior;
  blockId?: string;
  path?: string;
  request: number;
};

export type ReviewIdentity = {
  fingerprint: string;
  key: string;
};

export type DiffLineCount = {
  additions: number;
  countable: boolean;
  deletions: number;
};

export type ReviewComment = {
  anchor?: 'file' | 'line';
  author?: PullRequestExistingReviewComment['author'];
  body: string;
  canDelete?: boolean;
  canEdit?: boolean;
  canReplyThread?: boolean;
  canResolveThread?: boolean;
  codexReply?: {
    body?: string;
    error?: string;
    status: 'error' | 'loading' | 'ready';
  };
  filePath: string;
  id: string;
  isOutdated?: boolean;
  isReadOnly?: boolean;
  isThreadResolved?: boolean;
  lineNumber?: number;
  remoteSubmit?: {
    error?: string;
    status: 'error' | 'submitting';
  };
  sectionId: string;
  side?: 'additions' | 'deletions';
  startLineNumber?: number;
  startSide?: 'additions' | 'deletions';
  submittedAt?: string;
  threadId?: string;
  url?: string;
};

export type SidebarMode = 'tree' | 'walkthrough' | 'history';

export type PullRequestSource = Extract<ReviewSource, { type: 'pull-request' }>;

export type WalkthroughNote = {
  action: 'review' | 'scan' | 'skim';
  context: string;
  groupReason: string;
  groupTitle: string;
  impact: 'wide' | 'contained' | 'mechanical';
  order: number;
  reason: string;
};

export type SourceSession = {
  collapsed: Set<string>;
  expandedGenerated: Set<string>;
  /** Populated by a generated or pre-authored narrative walkthrough document. */
  narrativeWalkthrough?: NarrativeWalkthrough | null;
  reviewComments: ReadonlyArray<ReviewComment>;
  selectedPath: string | null;
  viewed: Record<string, string>;
  walkthroughError: WalkthroughError | null;
  walkthroughFiles: ReadonlyArray<{
    fingerprint: string;
    path: string;
    status: ChangedFile['status'];
  }>;
};

export type RepositoryLoadError = {
  kind: 'generic' | 'not-a-repository';
  message: string;
};

export type CodeViewItemMetadata = {
  blockId: string;
  canEditMarkdown: boolean;
  canRenderMarkdown: boolean;
  comments: ReadonlyArray<ReviewComment>;
  file: ChangedFile;
  isCollapsed: boolean;
  isMarkdownPreview: boolean;
  isSelected: boolean;
  isViewed: boolean;
  lineCount: DiffLineCount;
  reviewIdentity: ReviewIdentity;
  section: DiffSection;
  sectionCount: number;
  walkthroughNote?: WalkthroughNote;
};
