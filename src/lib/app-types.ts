import type { CodeViewHandle } from '@pierre/diffs/react';
import type {
  ChangedFile,
  CommitMetadata,
  DiffSection,
  PullRequestExistingReviewComment,
  ReviewSource,
  Walkthrough,
  WalkthroughResult,
} from '../types.ts';

export type WalkthroughError = Extract<WalkthroughResult, { status: 'unavailable' }>;

export type ReviewCommentAnnotationMetadata = {
  commentIds: ReadonlyArray<string>;
  type: 'review-comment';
};

type MarkdownPreviewAnnotationMetadata = {
  addedLines: ReadonlySet<number>;
  contents: string;
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

type CommitDetailsAnnotationMetadata = {
  metadata: CommitMetadata;
  type: 'commit-details';
};

export type ReviewAnnotationMetadata =
  | CommitDetailsAnnotationMetadata
  | ImagePreviewAnnotationMetadata
  | MarkdownPreviewAnnotationMetadata
  | ReviewCommentAnnotationMetadata;

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
  path: string;
  request: number;
};

export type DiffLineCount = {
  additions: number;
  countable: boolean;
  deletions: number;
};

export type ReviewComment = {
  author?: PullRequestExistingReviewComment['author'];
  body: string;
  codexReply?: {
    body?: string;
    error?: string;
    status: 'error' | 'loading' | 'ready';
  };
  filePath: string;
  githubSubmit?: {
    error?: string;
    status: 'error' | 'submitting';
  };
  id: string;
  isOutdated?: boolean;
  isReadOnly?: boolean;
  lineNumber: number;
  sectionId: string;
  side: 'additions' | 'deletions';
  startLineNumber?: number;
  startSide?: 'additions' | 'deletions';
  submittedAt?: string;
  url?: string;
};

export type SidebarMode = 'tree' | 'walkthrough' | 'history';

export type PullRequestSource = Extract<ReviewSource, { type: 'pull-request' }>;

export type WalkthroughNote = {
  action: Walkthrough['groups'][number]['files'][number]['action'];
  context: string;
  groupReason: string;
  groupTitle: string;
  impact: Walkthrough['groups'][number]['files'][number]['impact'];
  order: number;
  reason: string;
};

export type SourceSession = {
  collapsed: Set<string>;
  reviewComments: ReadonlyArray<ReviewComment>;
  selectedPath: string | null;
  viewed: Record<string, string>;
  walkthrough: Walkthrough | null;
  walkthroughError: WalkthroughError | null;
};

export type RepositoryLoadError = {
  kind: 'generic' | 'not-a-repository';
  message: string;
};

export type CodeViewItemMetadata = {
  canRenderMarkdown: boolean;
  file: ChangedFile;
  isCollapsed: boolean;
  isMarkdownPreview: boolean;
  isSelected: boolean;
  isViewed: boolean;
  lineCount: DiffLineCount;
  section: DiffSection;
  sectionCount: number;
  walkthroughNote?: WalkthroughNote;
};
