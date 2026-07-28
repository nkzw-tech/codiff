import type { CodiffPreferences } from '../types.ts';
import type {
  PlanCommentThread,
  PullRequestExistingReviewComment,
  PullRequestGeneralCommentThread,
} from './review-comments.ts';
import type { CommitMetadata, PullRequestCodeQualityFinding } from './review-history.ts';
import type {
  ChangedFile,
  DiffSection,
  GitFileStatus,
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
export type WalkthroughStop = WalkthroughHunkGroup & {
  importance: 'critical' | 'normal' | 'context';
  prose: string;
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

/** The model-authored narrative stored inside a V5 artifact envelope. */
export type WalkthroughNarrativeV5 = Omit<NarrativeWalkthroughV4, 'version'>;

/**
 * The initial persisted V5 artifact boundary.
 *
 * The narrative deliberately starts with V4-equivalent behavior. Captured
 * context and generation request are artifact-owned capability positions that
 * later authoring revisions can populate without changing frozen V4 storage.
 */
export type WalkthroughArtifactV5 = {
  /** Sanitized, host-neutral context captured before prompt projection. */
  capturedContext: Record<never, never>;
  /** Resolved review selection and authoring choices for this artifact. */
  generationRequest: Record<never, never>;
  /** Model-authored content; artifact lifecycle state does not live here. */
  narrative: WalkthroughNarrativeV5;
  version: 5;
};

type Immutable<T> = T extends (...arguments_: Array<never>) => unknown
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
export type WalkthroughModel = Immutable<WalkthroughNarrativeV5> & {
  /** Present only when the source artifact supplied captured-context capability. */
  readonly capturedContext?: Immutable<WalkthroughArtifactV5['capturedContext']>;
  /** Present only when the source artifact supplied generation-request capability. */
  readonly generationRequest?: Immutable<WalkthroughArtifactV5['generationRequest']>;
  /** Informational persisted document version; never a capability gate. */
  readonly sourceVersion: 4 | 5;
};

/** Frozen name retained for V4-producing hosts until their explicit V5 integration. */
export type NarrativeWalkthrough = NarrativeWalkthroughV4;

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
  version: 1;
  walkthrough: NarrativeWalkthrough;
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
