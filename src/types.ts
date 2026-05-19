export type DiffSection = {
  binary: boolean;
  id: string;
  kind: 'commit' | 'pull-request' | 'staged' | 'unstaged';
  loadState?: 'binary' | 'deferred' | 'directory' | 'error' | 'ready' | 'too-large';
  newFile?: {
    cacheKey?: string;
    contents: string;
    name: string;
  };
  oldFile?: {
    cacheKey?: string;
    contents: string;
    name: string;
  };
  patch: string;
  summary?: {
    canLoad?: boolean;
    fileCount?: number;
    limit?: number;
    reason: string;
    size?: number;
  };
};

export type GitFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked';

export type ChangedFile = {
  fingerprint: string;
  oldPath?: string;
  path: string;
  sections: ReadonlyArray<DiffSection>;
  status: GitFileStatus;
};

export type ReviewSource =
  | {
      type: 'working-tree';
    }
  | {
      ref: string;
      type: 'commit';
    }
  | {
      headSha?: string;
      number?: number;
      owner?: string;
      repo?: string;
      title?: string;
      type: 'pull-request';
      url: string;
    };

export type HistoryEntry = {
  committedAt: number;
  parents: ReadonlyArray<string>;
  ref: string;
  subject: string;
};

export type RepositoryHistory = {
  entries: ReadonlyArray<HistoryEntry>;
  root: string;
};

export type RepositoryState = {
  files: ReadonlyArray<ChangedFile>;
  generatedAt: number;
  launchPath: string;
  reviewComments?: ReadonlyArray<PullRequestExistingReviewComment>;
  root: string;
  source: ReviewSource;
};

export type CodiffLaunchOptions = {
  repositoryPathProvided: boolean;
  source?: ReviewSource;
  walkthrough: boolean;
};

export type TerminalHelperStatus = {
  command: string;
  installed: boolean;
  path: string;
};

export type WalkthroughFile = {
  action: 'review' | 'scan' | 'skim';
  context: string;
  impact: 'wide' | 'contained' | 'mechanical';
  path: string;
  reason: string;
};

export type WalkthroughGroup = {
  files: ReadonlyArray<WalkthroughFile>;
  reason: string;
  title: string;
};

export type Walkthrough = {
  groups: ReadonlyArray<WalkthroughGroup>;
  summary: {
    focus: string;
    skim: string;
  };
  version: 1;
};

export type WalkthroughResult =
  | {
      status: 'ready';
      walkthrough: Walkthrough;
    }
  | {
      reason: string;
      status: 'unavailable';
    };

export type ReviewAssistantRequest = {
  comment: {
    body: string;
    filePath: string;
    lineNumber: number;
    sectionId: string;
    side: 'additions' | 'deletions';
    startLineNumber?: number;
    startSide?: 'additions' | 'deletions';
  };
  source?: ReviewSource;
  walkthroughNote?: {
    action: WalkthroughFile['action'];
    context: string;
    groupReason: string;
    groupTitle: string;
    impact: WalkthroughFile['impact'];
    reason: string;
  };
};

export type ReviewAssistantResult =
  | {
      reply: string;
      status: 'ready';
    }
  | {
      reason: string;
      status: 'unavailable';
    };

export type GitIdentity = {
  email: string;
  gravatarUrl?: string;
  name: string;
};

export type DiffSectionContentRequest = {
  force?: boolean;
  kind: DiffSection['kind'];
  path: string;
  source?: ReviewSource;
};

export type CodiffTheme = 'system' | 'light' | 'dark';

export type CodiffPreferences = {
  copyCommentsOnClose: boolean;
  openAIModel: string;
  showWhitespace: boolean;
  theme: CodiffTheme;
};

export type PullRequestReviewComment = {
  body: string;
  filePath: string;
  lineNumber: number;
  side: 'additions' | 'deletions';
  startLineNumber?: number;
  startSide?: 'additions' | 'deletions';
};

export type PullRequestExistingReviewComment = PullRequestReviewComment & {
  author: {
    avatarUrl?: string;
    login: string;
    url?: string;
  };
  id: string;
  submittedAt?: string;
  url?: string;
};

export type PullRequestReviewEvent = 'APPROVE' | 'REQUEST_CHANGES';

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
