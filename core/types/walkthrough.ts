import type { CodiffPreferences } from '../types.ts';
import type { GenerationMetadata } from './generation.ts';
import type {
  PlanCommentThread,
  PullRequestExistingReviewComment,
  PullRequestGeneralCommentThread,
  ReviewCommentPosition,
} from './review-comments.ts';
import type {
  CommitMetadata,
  PullRequestCodeQualityFinding,
  ReviewCommitSummary,
  TargetComparisonReviewStructure,
  VersionComparisonReviewStructure,
} from './review-history.ts';
import type {
  ChangedFile,
  DiffRange,
  DiffSection,
  GitFileStatus,
  GitSha,
  ResolvedReviewSource,
  ReviewSource,
} from './review-identity.ts';

export type CodiffMarkdownDocument = {
  content: string;
  id: string;
  kind: 'plan' | 'repository';
  path: string;
  version: string;
};
export type SaveMarkdownDocumentRequest = {
  baseVersion: string;
  content: string;
  kind: CodiffMarkdownDocument['kind'];
  path: string;
};
export type SaveMarkdownDocumentResult =
  | { document: CodiffMarkdownDocument; status: 'conflict' }
  | { document: CodiffMarkdownDocument; status: 'saved' };

export type WalkthroughContext = {
  changedFiles?: ReadonlyArray<{ path: string; rationale?: string; role: string }>;
  constraints?: ReadonlyArray<string>;
  decisions?: ReadonlyArray<string>;
  implementationSummary?: string;
  messages?: ReadonlyArray<{ role: 'assistant' | 'user'; text: string }>;
  objective?: string;
  risks?: ReadonlyArray<string>;
  source: {
    generatedAt: string;
    threadId?: string;
    type:
      | 'codex-session'
      | 'codex-session-excerpt'
      | 'claude-session'
      | 'claude-session-excerpt'
      | 'opencode-session'
      | 'opencode-session-excerpt'
      | 'pi-session'
      | 'pi-session-excerpt';
  };
  validation?: ReadonlyArray<string>;
  version: 1;
};

export type CodiffLaunchOptions = {
  agentBackend?: 'codex' | 'claude' | 'opencode' | 'pi';
  applyUpdate?: boolean;
  claudeSessionId?: string;
  codexSessionId?: string;
  opencodeSessionId?: string;
  piSessionId?: string;
  planFile?: string;
  planResultFile?: string;
  repositoryPathProvided: boolean;
  source?: ReviewSource;
  walkthrough: boolean;
  walkthroughContext?: WalkthroughContext;
  walkthroughFile?: string;
};

export type AgentSkillStatus = { installed: boolean; path: string };
/** @deprecated Use AgentSkillStatus. */
export type CodexSkillStatus = AgentSkillStatus;
export type TerminalHelperStatus = { command: string; installed: boolean; path: string };

export type WalkthroughIcon = 'bug' | 'wrench' | 'path' | 'flask' | 'beaker' | 'doc' | 'gear';
export type WalkthroughAnchor = {
  display: string;
  endLine?: number;
  sectionId?: string;
  sectionKind?: DiffSection['kind'];
  side?: 'additions' | 'deletions' | 'both';
  startLine?: number;
};
export type WalkthroughHunkNote = { body: string; hunkId: string };
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
export type WalkthroughHunk = {
  added: number;
  additionEnd?: number;
  additionStart?: number;
  anchor: WalkthroughAnchor;
  deleted: number;
  deletionEnd?: number;
  deletionStart?: number;
  id: string;
  kind?: 'patch' | 'synthetic';
  oldPath?: string;
  path: string;
  status: GitFileStatus;
};
export type WalkthroughHunkGroup = {
  added: number;
  changeType?: WalkthroughChangeType;
  commitNote?: string;
  deleted: number;
  hunkIds: ReadonlyArray<string>;
  hunks: ReadonlyArray<WalkthroughHunk>;
  id: string;
  notes?: ReadonlyArray<WalkthroughHunkNote>;
  summary?: string;
  title?: string;
};
export type WalkthroughRegion = {
  endLine: number;
  hunkId: string;
  id: string;
  side: 'additions' | 'deletions';
  startLine: number;
  title: string;
  tooltip: string;
};
export type WalkthroughStop = WalkthroughHunkGroup & {
  importance: 'critical' | 'normal' | 'context';
  prose: string;
};
export type WalkthroughStopV5 = WalkthroughStop & {
  regions?: ReadonlyArray<WalkthroughRegion>;
};
export type WalkthroughSupportGroup = WalkthroughHunkGroup & { note?: string; reason: string };
export type WalkthroughChapter = {
  blurb: string;
  icon: WalkthroughIcon;
  id: string;
  stops: ReadonlyArray<WalkthroughStop>;
  title: string;
};
export type WalkthroughCommit = { body?: string; title?: string };
/**
 * The released V4 persistence shape. This type is frozen: new walkthrough
 * capabilities belong to V5 artifacts and the runtime model, never here.
 */
export type NarrativeWalkthroughV4 = {
  agent: 'codex' | 'claude' | 'opencode' | 'pi';
  chapters: ReadonlyArray<WalkthroughChapter>;
  commit?: WalkthroughCommit;
  context?: WalkthroughContext;
  focus: string;
  generatedAt: string;
  kind: 'narrative';
  meta?: string;
  repo: { branch: string | null; root: string };
  source: ResolvedReviewSource;
  support: ReadonlyArray<WalkthroughSupportGroup>;
  title: string;
  version: 4;
};

/** Normalized code evidence captured before bounded prompt projection. */
export type WalkthroughCapturedContext = {
  branch: string | null;
  files: ReadonlyArray<{
    fingerprint: string;
    generated?: boolean;
    oldPath?: string;
    path: string;
    sections: ReadonlyArray<{
      binary: boolean;
      id: string;
      kind: DiffSection['kind'];
      loadState?: DiffSection['loadState'];
      newFile?: { contents: string; name: string };
      oldFile?: { contents: string; name: string };
      patch: string;
      range?: DiffRange;
      summary?: DiffSection['summary'];
    }>;
    status: GitFileStatus;
  }>;
  /** Normalized review source stripped of live provider capabilities and state. */
  source:
    | { type: 'working-tree' }
    | { sha: GitSha; type: 'commit' }
    | { baseSha: GitSha; headSha: GitSha; ref: string; type: 'branch-diff' }
    | { baseSha: GitSha; headSha: GitSha; ref: string; type: 'branch-working-tree' }
    | { base: string; head: string; symmetric: boolean; type: 'range' }
    | {
        description?: string;
        headSha?: GitSha;
        number?: number;
        projectPath?: string;
        provider?: 'github' | 'gitlab';
        targetBranch?: string;
        title?: string;
        type: 'pull-request';
        url: string;
      };
};

/** Resolved review selection and user-authored choices retained with the artifact. */
export type WalkthroughGenerationRequest = {
  customInstructions?: string;
  review:
    | {
        relation: 'single-diff';
        structure: 'single-diff';
      }
    | {
        range: DiffRange;
        relation: 'target-comparison';
        structure: TargetComparisonReviewStructure;
      };
};

/** Exact code identity against which one review thread is assessed. */
export type AssessmentCodeScope =
  | { type: 'single-diff' }
  | { range: DiffRange; type: 'target-comparison' }
  | { sha: GitSha; type: 'commit' };

export type AssessmentThreadAnchor = {
  filePath: string;
  lineNumber?: number;
  position?: ReviewCommentPosition;
  side?: 'additions' | 'deletions';
  startLineNumber?: number;
  startSide?: 'additions' | 'deletions';
};

export type AssessmentThreadComment = {
  anchor?: AssessmentThreadAnchor;
  author: { login: string; name?: string };
  body: string;
  id: string;
  submittedAt?: string;
};

/** Provider-neutral semantic input for exactly one current-review thread. */
export type AssessmentInput = {
  codeScope: AssessmentCodeScope;
  thread: {
    comments: ReadonlyArray<AssessmentThreadComment>;
    id: string;
  };
};

export type AssessmentIdentity = {
  codeScope: AssessmentCodeScope;
  threadId: string;
};

export type AssessmentCapturedPresentationState = {
  threadState: 'open' | 'resolved';
};

export type ThreadAssessmentResult = {
  disposition:
    | 'addressed'
    | 'partially-addressed'
    | 'still-applies'
    | 'no-longer-applicable'
    | 'unclear';
  explanation: string;
};

export type AssessmentOutcome =
  | {
      generationMetadata: GenerationMetadata;
      result: ThreadAssessmentResult;
      status: 'ready';
    }
  | { error: string; status: 'failed' };

/** One independently replaceable thread assessment. */
export type AssessmentComponent = {
  capturedPresentationState: AssessmentCapturedPresentationState;
  identity: AssessmentIdentity;
  input: AssessmentInput;
  outcome: AssessmentOutcome;
};

/** Absence means assessment was not requested; an empty list means none were eligible. */
export type AssessmentCollection = {
  items: ReadonlyArray<AssessmentComponent>;
};

/** Model-authored content produced by one successful narrative call. */
export type WalkthroughNarrativeContentV5 = Omit<
  NarrativeWalkthroughV4,
  'chapters' | 'repo' | 'source' | 'version'
> & {
  chapters: ReadonlyArray<
    Omit<WalkthroughChapter, 'stops'> & { stops: ReadonlyArray<WalkthroughStopV5> }
  >;
  /** Display identity only; persisted V5 never contains a checkout-local root. */
  repo: { branch: string | null };
  source: WalkthroughCapturedContext['source'];
};

/** One successful aggregate narrative call. */
export type WalkthroughSingleCallNarrativeV5 = {
  content: WalkthroughNarrativeContentV5;
  generationMetadata: GenerationMetadata;
  structure: 'net-change' | 'single-diff';
};

/** One independently reusable commit narrative call. */
export type WalkthroughCommitNarrativeUnitV5 = {
  /** Canonical display metadata. Older stored V5 artifacts may omit it. */
  commit?: ReviewCommitSummary;
  content: WalkthroughNarrativeContentV5;
  generationMetadata: GenerationMetadata;
  sha: GitSha;
};

/** Persisted V5 topology for aggregate or commit-by-commit target reviews. */
export type WalkthroughNarrativeV5 =
  | WalkthroughSingleCallNarrativeV5
  | {
      structure: 'commit-by-commit';
      units: ReadonlyArray<WalkthroughCommitNarrativeUnitV5>;
    };

/**
 * The persisted V5 artifact boundary.
 *
 * Captured context and the resolved generation request stay artifact-owned,
 * while each narrative component records the metadata for its own successful
 * model call. Frozen V4 storage remains a separate read-only contract.
 */
export type WalkthroughArtifactV5 = {
  /** Background-generated components stored independently from narrative content. */
  assessments?: AssessmentCollection;
  /** Sanitized, host-neutral context captured before prompt projection. */
  capturedContext: WalkthroughCapturedContext;
  /** Resolved review selection and authoring choices for this artifact. */
  generationRequest: WalkthroughGenerationRequest;
  /** Model-authored content; artifact lifecycle state does not live here. */
  narrative: WalkthroughNarrativeV5;
  version: 5;
};

type Immutable<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends (...arguments_: Array<never>) => unknown
    ? T
    : T extends ReadonlyArray<infer Item>
      ? ReadonlyArray<Immutable<Item>>
      : T extends object
        ? { readonly [Key in keyof T]: Immutable<T[Key]> }
        : T;

/**
 * Core's immutable, document-derived rendering and navigation representation.
 *
 * Persisted JSON is normalized exactly once at the Core trust boundary. The
 * model is never serialized as V4 or V5, and `sourceVersion` is diagnostic
 * only. Rendering and reuse decisions must narrow optional capability fields
 * instead of checking the source document version. Live provider state stays
 * separate from this captured model.
 */
export type WalkthroughModel = Immutable<Omit<NarrativeWalkthroughV4, 'chapters' | 'version'>> & {
  /** Present only when the artifact included current-review assessments. */
  readonly assessments?: Immutable<AssessmentCollection>;
  /** Present only when the source artifact supplied captured-context capability. */
  readonly capturedContext?: Immutable<WalkthroughArtifactV5['capturedContext']>;
  readonly chapters: Immutable<WalkthroughNarrativeContentV5['chapters']>;
  /** Present only when one call produced the complete narrative. */
  readonly generationMetadata?: Immutable<GenerationMetadata>;
  /** Present only when the source artifact supplied generation-request capability. */
  readonly generationRequest?: Immutable<WalkthroughArtifactV5['generationRequest']>;
  /** Informational persisted document version; never a capability gate. */
  readonly sourceVersion: 4 | 5;
  /** Present only for V5 and derived from the persisted narrative discriminator. */
  readonly structure?: WalkthroughNarrativeV5['structure'];
  /** Preserved commit ownership after chapter and support IDs are namespaced. */
  readonly units?: ReadonlyArray<{
    readonly chapterIds: ReadonlyArray<string>;
    readonly commit?: Immutable<ReviewCommitSummary>;
    readonly identity: { readonly kind: 'commit'; readonly sha: GitSha };
    readonly supportIds: ReadonlyArray<string>;
  }>;
};

/** Transient provider state joined only for live assessment presentation. */
export type LiveReviewState = {
  currentThreadStateById?: ReadonlyMap<string, 'open' | 'resolved'>;
  pendingAssessmentThreadIds?: ReadonlySet<string>;
};

export type NarrativeWalkthroughUpdate = {
  cacheKey: string;
  pendingAssessmentThreadIds: ReadonlyArray<string>;
  walkthrough: WalkthroughArtifactV5;
};

/** Frozen name retained for V4-producing hosts until their explicit V5 integration. */
export type NarrativeWalkthrough = NarrativeWalkthroughV4;

/** Persisted walkthrough documents accepted at host and sharing boundaries. */
export type PersistedWalkthrough = NarrativeWalkthroughV4 | WalkthroughArtifactV5;

/** Capability checks are field-based so model behavior is independent of document labels. */
export const hasCapturedContextCapability = (
  walkthrough: WalkthroughModel,
): walkthrough is WalkthroughModel & {
  readonly capturedContext: Immutable<WalkthroughArtifactV5['capturedContext']>;
} => 'capturedContext' in walkthrough;

/** Capability checks are field-based so later request shapes do not require version branches. */
export const hasGenerationRequestCapability = (
  walkthrough: WalkthroughModel,
): walkthrough is WalkthroughModel & {
  readonly generationRequest: Immutable<WalkthroughArtifactV5['generationRequest']>;
} => 'generationRequest' in walkthrough;

export type SharedWalkthroughReviewScope =
  | {
      kind: 'merge-request';
      structure: TargetComparisonReviewStructure;
    }
  | {
      from: { label: string; sha: GitSha };
      kind: 'version-comparison';
      structure: VersionComparisonReviewStructure;
      to: { label: string; sha: GitSha };
    };

export type SharedWalkthroughSnapshot = {
  branch: string | null;
  codeQualityFindings?: ReadonlyArray<PullRequestCodeQualityFinding>;
  codiffVersion: string;
  commitMetadata?: CommitMetadata;
  exportedAt: string;
  files: ReadonlyArray<ChangedFile>;
  kind: 'codiff-walkthrough-share';
  preferences: Pick<
    CodiffPreferences,
    'codeFontFamily' | 'codeFontSize' | 'diffStyle' | 'showWhitespace' | 'theme' | 'wordWrap'
  >;
  repository: {
    generalComments?: ReadonlyArray<PullRequestGeneralCommentThread>;
    root: string;
    source: ResolvedReviewSource;
    title?: string;
  };
  reviewComments?: ReadonlyArray<PullRequestExistingReviewComment>;
  reviewScope?: SharedWalkthroughReviewScope;
  version: 1;
  walkthrough: PersistedWalkthrough;
};
export type SharedPlanSnapshot = {
  codiffVersion: string;
  document: { content: string; name: string; title: string };
  exportedAt: string;
  kind: 'codiff-plan-share';
  preferences: Pick<CodiffPreferences, 'theme'>;
  review: { threads: ReadonlyArray<PlanCommentThread>; version: 1 };
  source?: { agent?: 'claude' | 'codex' | 'opencode' | 'pi'; sessionId?: string };
  version: 1;
};
export type WalkthroughShareManifestV1 = SharedWalkthroughSnapshot;
export type ShareResult =
  | { status: 'uploaded'; url: string }
  | { reason: string; status: 'failed' };
export type SharePlanResult = ShareResult;
export type ShareWalkthroughResult = ShareResult;
