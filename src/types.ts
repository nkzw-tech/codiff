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
      /** Resolved base commit for a branch diff snapshot. */
      baseRef: string;
      /** Resolved head commit for a branch diff snapshot. */
      headRef: string;
      /** Target branch the current branch was compared against. */
      ref: string;
      type: 'branch-diff';
    }
  | {
      /** Base ref (left side). For symmetric ranges the diff starts at its merge-base with head. */
      base: string;
      /** Head ref (right side). */
      head: string;
      /** `true` for `base...head` (merge-base), `false` for `base..head` (direct). */
      symmetric: boolean;
      type: 'range';
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

/**
 * Narrative Walkthrough. It separates order-independent *segments* (addressable
 * slices of the live diff) from one or more *orders* (reading views over those
 * segments, e.g. key-changes-first vs results-first). The diff content itself is
 * never embedded: a segment anchors into the live diff codiff computes from the
 * repository.
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

/**
 * Change-type tag shown on a file row in the commit composer. Mirrors the
 * walkthrough's narrative roles so a reviewer recognises each file at a glance.
 */
export type WalkthroughChangeType =
  | 'fix'
  | 'feature'
  | 'refactor'
  | 'test'
  | 'generated'
  | 'lockfile'
  | 'snapshot'
  | 'i18n'
  | 'docs';

/** Order-independent atom: one addressable slice of the diff with its line counts. */
export type WalkthroughSegment = {
  added: number;
  anchor: WalkthroughAnchor;
  /** Change-type tag for the commit composer's file row. */
  changeType?: WalkthroughChangeType;
  comments?: ReadonlyArray<WalkthroughSeedComment>;
  /** One-line note the generated commit body uses for this file (falls back to {@link summary}). */
  commitNote?: string;
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
  /** Additional segments that render under this same conceptual stop. */
  relatedSegmentIds?: ReadonlyArray<string>;
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

/**
 * Marks the walkthrough's diff as a staging set that can be committed and seeds
 * the commit composer Codiff renders as the walkthrough's terminal stop. Only
 * honored when {@link NarrativeWalkthrough.source} is a working tree — you can
 * only commit a live staging set, never a past commit, branch, or pull request.
 */
export type WalkthroughCommit = {
  /**
   * The agent-drafted commit body — a few paragraphs of prose describing the
   * change as a whole. Shown editable by default; the reviewer can rewrite it,
   * or ask the agent to regenerate it for a narrowed file selection.
   */
  body?: string;
  /** Suggested first line for the commit message. */
  title?: string;
};

export type NarrativeWalkthrough = {
  agent: 'codex' | 'claude';
  /**
   * When present, the diff is a committable staging set: Codiff adds a commit
   * composer at the end of the walkthrough. Stripped unless `source` is a working tree.
   */
  commit?: WalkthroughCommit;
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
      code?: 'CODEX_NOT_FOUND' | 'CLAUDE_NOT_FOUND';
      reason: string;
      status: 'unavailable';
    };

/** Commit the selected files from a walkthrough's staging set. */
export type WalkthroughCommitRequest = {
  /** Body of the commit message (everything after the subject line). */
  body: string;
  /** Repo-relative paths to commit; other staged changes are left untouched. */
  paths: ReadonlyArray<string>;
  source?: ReviewSource;
  /** First line of the commit message. */
  subject: string;
};

export type WalkthroughCommitResult =
  | {
      /** Full SHA of the new commit. */
      hash: string;
      status: 'committed';
    }
  | {
      reason: string;
      status: 'failed';
    };

/**
 * Ask the connected agent to rewrite the commit message for the current file
 * selection — used when the reviewer drops files from the staging set and the
 * pre-drafted body no longer matches what is being committed.
 */
export type WalkthroughCommitMessageRequest = {
  /** The current body, given to the agent as the message to revise. */
  body: string;
  /** Repo-relative paths still selected for the commit. */
  paths: ReadonlyArray<string>;
  source?: ReviewSource;
  /** The current subject line. */
  subject: string;
};

export type WalkthroughCommitMessageResult =
  | {
      body: string;
      status: 'ready';
      subject: string;
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
    action: 'review' | 'scan' | 'skim';
    context: string;
    groupReason: string;
    groupTitle: string;
    impact: 'wide' | 'contained' | 'mechanical';
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
  walkthroughOrder: string;
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
