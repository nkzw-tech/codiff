import type { GitSha, ResolvedReviewSource } from './review-identity.ts';
import type { NarrativeWalkthrough } from './walkthrough.ts';

export type WalkthroughProgressPhase = 'agent-generation' | 'response-received';
export type WalkthroughProgressEvent = { phase: WalkthroughProgressPhase };

export type NarrativeWalkthroughResult =
  | { status: 'ready'; walkthrough: NarrativeWalkthrough }
  | {
      code?: 'CODEX_NOT_FOUND' | 'CLAUDE_NOT_FOUND' | 'OPENCODE_NOT_FOUND' | 'PI_NOT_FOUND';
      reason: string;
      status: 'unavailable';
    };
export type NarrativeWalkthroughRequestOptions = {
  force?: boolean;
  previousWalkthrough?: NarrativeWalkthrough;
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
