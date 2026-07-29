import type { GitSha, ResolvedReviewSource } from './review-identity.ts';
import type { NarrativeWalkthrough, PersistedWalkthrough } from './walkthrough.ts';

export type GenerationSettings = Readonly<Record<string, boolean | number | string>>;

/** Safe model policy that materially affects one generated component. */
export type GenerationProfile = {
  agent: NarrativeWalkthrough['agent'];
  authoringVersion: string;
  modelCandidates: ReadonlyArray<string>;
  settings?: GenerationSettings;
};

/** Provenance for one successful model-produced component. */
export type GenerationMetadata = {
  agent: NarrativeWalkthrough['agent'];
  generatedAt: string;
  model: string;
  profile: GenerationProfile;
};

export type WalkthroughGenerationUnitProgress = {
  detail?: string;
  id: string;
  label: string;
  status: 'failed' | 'generating' | 'pending' | 'preparing' | 'ready';
};

/** Format-neutral progress for one in-flight walkthrough generation. */
export type WalkthroughGenerationProgress = {
  completed?: number;
  phase: 'combining' | 'generating' | 'generating-units' | 'preparing';
  summary: string;
  total?: number;
  units?: ReadonlyArray<WalkthroughGenerationUnitProgress>;
};

export type WalkthroughProgressPhase = 'agent-generation' | 'response-received';
export type WalkthroughProgressEvent = {
  generation?: WalkthroughGenerationProgress;
  phase?: WalkthroughProgressPhase;
};

export type NarrativeWalkthroughResult =
  | {
      cacheKey?: string;
      pendingAssessmentThreadIds?: ReadonlyArray<string>;
      status: 'ready';
      walkthrough: PersistedWalkthrough;
    }
  | {
      code?: 'CODEX_NOT_FOUND' | 'CLAUDE_NOT_FOUND' | 'OPENCODE_NOT_FOUND' | 'PI_NOT_FOUND';
      reason: string;
      status: 'unavailable';
    };
export type NarrativeWalkthroughRequestOptions = {
  force?: boolean;
  previousWalkthrough?: PersistedWalkthrough;
};

export type WalkthroughCommitRequest = {
  body: string;
  paths: ReadonlyArray<string>;
  source?: ResolvedReviewSource;
  subject: string;
};
export type WalkthroughCommitResult =
  | { sha: GitSha; status: 'committed' }
  | { reason: string; status: 'failed' };
export type WalkthroughCommitMessageRequest = {
  body: string;
  paths: ReadonlyArray<string>;
  source?: ResolvedReviewSource;
  subject: string;
};
export type WalkthroughCommitMessageResult =
  | { body: string; status: 'ready'; subject: string }
  | { reason: string; status: 'unavailable' };

export type ReviewAssistantRequest = {
  comment: {
    anchor?: 'file' | 'line';
    body: string;
    filePath: string;
    lineNumber?: number;
    sectionId: string;
    side?: 'additions' | 'deletions';
    startLineNumber?: number;
    startSide?: 'additions' | 'deletions';
  };
  source?: ResolvedReviewSource;
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
  | { reply: string; status: 'ready' }
  | {
      code?: 'CODEX_NOT_FOUND' | 'CLAUDE_NOT_FOUND' | 'OPENCODE_NOT_FOUND' | 'PI_NOT_FOUND';
      reason: string;
      status: 'unavailable';
    };
