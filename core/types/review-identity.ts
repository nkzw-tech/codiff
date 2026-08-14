import type {
  PullRequestMergeState,
  PullRequestReviewStatus,
  PullRequestReviewer,
  ReviewAuthor,
} from './review-history.ts';

export type DiffSection = {
  binary: boolean;
  id: string;
  kind: 'commit' | 'pull-request' | 'staged' | 'unstaged';
  loadState?: 'binary' | 'deferred' | 'directory' | 'error' | 'ready' | 'too-large';
  newFile?: { cacheKey?: string; contents: string; name: string };
  oldFile?: { cacheKey?: string; contents: string; name: string };
  patch: string;
  range?: DiffRange;
  summary?: {
    canLoad?: boolean;
    fileCount?: number;
    fingerprint?: string;
    limit?: number;
    reason: string;
    size?: number;
  };
};

export type GitFileStatus =
  | 'added'
  | 'conflicted'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'untracked';

export type ChangedFile = {
  fingerprint: string;
  generated?: boolean;
  oldPath?: string;
  path: string;
  sections: ReadonlyArray<DiffSection>;
  status: GitFileStatus;
};

export type GitSha = string & { readonly __gitSha: unique symbol };
export type EvolutionUnitId = string & { readonly __evolutionUnitId: unique symbol };
export type ReviewVersionId = string & { readonly __reviewVersionId: unique symbol };

/** Sources that can be entered from the palette or native application menu. */
export type OpenReviewSourceKind = 'branch' | 'commit' | 'pull-request';

export type ReviewSource =
  | { type: 'working-tree' }
  | { ref: string; type: 'commit' }
  | { ref: string; type: 'branch' }
  | { baseSha: GitSha; headSha: GitSha; ref: string; type: 'branch-diff' }
  | {
      baseSha?: GitSha;
      headSha?: GitSha;
      ref: string;
      type: 'branch-working-tree';
    }
  | { base: string; head: string; symmetric: boolean; type: 'range' }
  | {
      author?: ReviewAuthor;
      canEditDescription?: boolean;
      canEditReviewers?: boolean;
      canEditTitle?: boolean;
      description?: string;
      headSha?: string;
      host?: string;
      mergeState?: PullRequestMergeState;
      number?: number;
      owner?: string;
      projectPath?: string;
      provider?: 'github' | 'gitlab';
      repo?: string;
      reviewers?: ReadonlyArray<PullRequestReviewer>;
      reviewStatus?: PullRequestReviewStatus;
      targetBranch?: string;
      title?: string;
      type: 'pull-request';
      url: string;
    };

export type ResolvedReviewSource =
  | Exclude<ReviewSource, { type: 'branch' | 'branch-working-tree' | 'commit' }>
  | { sha: GitSha; type: 'commit' }
  | { baseSha: GitSha; headSha: GitSha; ref: string; type: 'branch-working-tree' };

export type RevisionLabel = {
  kind: 'bookmark' | 'branch' | 'commit' | 'review-marker' | 'tag' | 'version';
  text: string;
  url?: string;
};

export type Revision =
  | { aliases?: ReadonlyArray<RevisionLabel>; kind?: 'commit'; label: RevisionLabel; sha: GitSha }
  | { aliases?: ReadonlyArray<RevisionLabel>; kind: 'index'; label: RevisionLabel }
  | { aliases?: ReadonlyArray<RevisionLabel>; kind: 'working-copy'; label: RevisionLabel };

export type DiffRange = { base: Revision; head: Revision };
export type DiffComparison = { after: DiffRange; before: DiffRange };

export type ReviewContextRequest = {
  baseSha: GitSha;
  filePath: string;
  headSha: GitSha;
  oldPath?: string;
  range: DiffRange;
  source: ResolvedReviewSource;
  status: GitFileStatus;
};

/** Display-only result used to expand unchanged review context. */
export type ReviewContextResult =
  | {
      newFile: NonNullable<DiffSection['newFile']>;
      oldFile: NonNullable<DiffSection['oldFile']> | null;
      status: 'ready';
    }
  | { reason: string; status: 'unavailable' };

/**
 * Host capability for resolving unchanged context without mutating captured
 * walkthrough provenance or generated-component reuse inputs.
 */
export type ReviewContextResolver = (request: ReviewContextRequest) => Promise<ReviewContextResult>;

export type GitIdentity = {
  email: string;
  gravatarUrl?: string;
  name: string;
  username?: string;
};

export type DiffSectionContentRequest = {
  force?: boolean;
  kind: DiffSection['kind'];
  path: string;
  requestId?: string;
  showWhitespace?: boolean;
  source?: ResolvedReviewSource;
};
export type DiffSectionsContentRequest = {
  requestId?: string;
  source: Extract<ResolvedReviewSource, { type: 'pull-request' }>;
};

export type DiffSectionsContentResult = {
  headSha?: GitSha;
  sections: ReadonlyArray<{ path: string; section: DiffSection }>;
};

export type DiffImageContentRequest = {
  kind: DiffSection['kind'];
  path: string;
  requestId?: string;
  source?: ResolvedReviewSource;
};

export type DiffImageRevision = { dataUrl: string; mimeType: string; name: string; size: number };

export type DiffImageContentResult =
  | { newImage?: DiffImageRevision; oldImage?: DiffImageRevision; status: 'ready' }
  | { reason: string; status: 'unavailable' };
