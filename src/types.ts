import type { CodiffDiffStyle } from './config/types.ts';

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
    fingerprint?: string;
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
      ref: string;
      type: 'branch';
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
  author: string;
  committedAt: number;
  gravatarUrl?: string;
  parents: ReadonlyArray<string>;
  ref: string;
  scope?: 'base' | 'pull-request';
  subject: string;
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
  parents: ReadonlyArray<string>;
  ref: string;
  refs: ReadonlyArray<string>;
  shortRef: string;
  signature: {
    key?: string;
    signer?: string;
    status: string;
  };
  stats: {
    additions: number;
    binaryFiles: number;
    deletions: number;
    files: number;
    renamedFiles: number;
  };
  subject: string;
  trailers: ReadonlyArray<{
    key: string;
    value: string;
  }>;
};

export type RepositoryHistory = {
  entries: ReadonlyArray<HistoryEntry>;
  root: string;
};

export type RepositoryState = {
  branch: string | null;
  commitMetadata?: CommitMetadata;
  files: ReadonlyArray<ChangedFile>;
  generatedAt: number;
  launchPath: string;
  reviewComments?: ReadonlyArray<PullRequestExistingReviewComment>;
  root: string;
  source: ReviewSource;
};

export type WalkthroughContext = {
  changedFiles?: ReadonlyArray<{
    path: string;
    rationale?: string;
    role: string;
  }>;
  constraints?: ReadonlyArray<string>;
  decisions?: ReadonlyArray<string>;
  implementationSummary?: string;
  messages?: ReadonlyArray<{
    role: 'assistant' | 'user';
    text: string;
  }>;
  objective?: string;
  risks?: ReadonlyArray<string>;
  source: {
    generatedAt: string;
    threadId?: string;
    type: 'codex-session' | 'codex-session-excerpt' | 'claude-session' | 'claude-session-excerpt';
  };
  validation?: ReadonlyArray<string>;
  version: 1;
};

export type CodiffLaunchOptions = {
  agentBackend?: 'codex' | 'claude';
  claudeSessionId?: string;
  codexSessionId?: string;
  repositoryPathProvided: boolean;
  source?: ReviewSource;
  walkthrough: boolean;
  walkthroughContext?: WalkthroughContext;
  /** Path to a pre-authored {@link NarrativeWalkthrough} JSON file (--walkthrough-file). */
  walkthroughFile?: string;
};

export type AgentSkillStatus = {
  installed: boolean;
  path: string;
};

/** @deprecated Use {@link AgentSkillStatus}. */
export type CodexSkillStatus = AgentSkillStatus;

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
      code?: 'CODEX_NOT_FOUND' | 'CLAUDE_NOT_FOUND';
      reason: string;
      status: 'unavailable';
    };

/**
 * Narrative Walkthrough (version 2). A richer, story-shaped walkthrough than the
 * file-ordering {@link Walkthrough}. It separates order-independent *segments*
 * (addressable slices of the live diff) from one or more *orders* (reading views
 * over those segments — e.g. key-changes-first vs results-first). The diff content
 * itself is never embedded: a segment anchors into the live diff codiff computes
 * from the repository.
 */
export type WalkthroughIcon = 'bug' | 'wrench' | 'path' | 'flask' | 'beaker' | 'doc' | 'gear';

/** Where a segment points into the live diff. Mirrors the comment-anchor fields. */
export type WalkthroughAnchor = {
  /** Human-readable location, e.g. 'src/App.tsx:311' or 'src/hooks/useHunkOrder.ts (new)'. */
  display: string;
  /** End line on the {@link side} (inclusive). Omitted for 'file' granularity. */
  endLine?: number;
  /** Matches {@link DiffSection.id}, e.g. 'src/App.tsx:staged'. */
  sectionId?: string;
  sectionKind?: DiffSection['kind'];
  side?: 'additions' | 'deletions' | 'both';
  /** Start line on the {@link side}. Omitted for 'file' granularity. */
  startLine?: number;
};

/** A review comment seeded by the walkthrough, anchored like a live comment. */
export type WalkthroughSeedComment = {
  author?: string;
  /** May be '' to seed an empty composer at this anchor. */
  body: string;
  id: string;
  lineNumber: number;
  side: 'additions' | 'deletions';
  startLineNumber?: number;
  startSide?: 'additions' | 'deletions';
};

/** Order-independent atom: one addressable slice of the diff with its line counts. */
export type WalkthroughSegment = {
  added: number;
  anchor: WalkthroughAnchor;
  comments?: ReadonlyArray<WalkthroughSeedComment>;
  deleted: number;
  granularity: 'line' | 'hunk' | 'file';
  /** Stable within the document, e.g. 's1'. */
  id: string;
  oldPath?: string;
  path: string;
  status: GitFileStatus;
  /** Short, plain-text gist of the slice. */
  summary?: string;
  /** Default framing; an order's stop may override it. */
  title?: string;
};

/** A named chapter/phase within an order. */
export type WalkthroughPhase = {
  blurb: string;
  icon: WalkthroughIcon;
  id: string;
  /** 1-based position. */
  n: number;
  title: string;
};

/** One stop in an order's sequence: a segment plus this order's framing of it. */
export type WalkthroughStop = {
  importance: 'critical' | 'normal' | 'context';
  phaseId: string;
  /** Agent narration (markdown / inline code). */
  prose: string;
  segmentId: string;
  /** Overrides the segment's title for this order. */
  title?: string;
};

/** A file changed alongside the work but kept off the narrative path. */
export type WalkthroughRestItem = {
  note?: string;
  /** Why it is off the path, e.g. 'Generated' | 'Lockfile' | 'Snapshot' | 'Mechanical'. */
  reason: string;
  segmentId: string;
};

/** One reading order — a view over the document's segments. */
export type WalkthroughOrder = {
  id: string;
  label: string;
  phases: ReadonlyArray<WalkthroughPhase>;
  rest: ReadonlyArray<WalkthroughRestItem>;
  restBlurb: string;
  restLabel: string;
  sequence: ReadonlyArray<WalkthroughStop>;
  tagline: string;
};

export type NarrativeWalkthrough = {
  agent: 'codex' | 'claude';
  /** The originating conversation, embedded for in-app Q&A. */
  context?: WalkthroughContext;
  /** An id present in {@link orders}. */
  defaultOrder: string;
  /** 1–2 sentence summary of the change. */
  focus: string;
  /** ISO timestamp. */
  generatedAt: string;
  kind: 'narrative';
  /** Display string, e.g. '6 stops · 4 chapters'. */
  meta?: string;
  orders: ReadonlyArray<WalkthroughOrder>;
  repo: {
    branch: string | null;
    root: string;
  };
  segments: ReadonlyArray<WalkthroughSegment>;
  source: ReviewSource;
  title: string;
  version: 2;
};

export type NarrativeWalkthroughResult =
  | {
      status: 'ready';
      walkthrough: NarrativeWalkthrough;
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
      code?: 'CODEX_NOT_FOUND' | 'CLAUDE_NOT_FOUND';
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

export type DiffImageContentRequest = {
  kind: DiffSection['kind'];
  path: string;
  source?: ReviewSource;
};

export type DiffImageRevision = {
  dataUrl: string;
  mimeType: string;
  name: string;
  size: number;
};

export type DiffImageContentResult =
  | {
      newImage?: DiffImageRevision;
      oldImage?: DiffImageRevision;
      status: 'ready';
    }
  | {
      reason: string;
      status: 'unavailable';
    };

export type CodiffTheme = 'system' | 'light' | 'dark';

export type CodiffPreferences = {
  agentBackend: 'codex' | 'claude';
  claudeModel: string;
  copyCommentsOnClose: boolean;
  diffStyle: CodiffDiffStyle;
  editorCommand: string;
  lastRepositoryPath: string;
  openAIModel: string;
  showOutdated: boolean;
  showWhitespace: boolean;
  theme: CodiffTheme;
  wordWrap: boolean;
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
  isOutdated?: boolean;
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
