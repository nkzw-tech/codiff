import type { CodiffConfig } from './config/types.ts';
import type {
  AgentSkillStatus,
  CodiffFeatureFlags,
  CodiffLaunchOptions,
  CodiffMarkdownDocument,
  CodiffPreferences,
  DiffImageContentRequest,
  DiffImageContentResult,
  DiffSection,
  DiffSectionContentRequest,
  GitIdentity,
  NarrativeWalkthroughResult,
  PlanHandoffStatus,
  PlanReview,
  RepositoryHistory,
  RepositoryState,
  ReviewAssistantRequest,
  ReviewAssistantResult,
  ReviewSource,
  SaveMarkdownDocumentRequest,
  SaveMarkdownDocumentResult,
  SharePlanResult,
  SharedWalkthroughSnapshot,
  ShareWalkthroughResult,
  SubmitPullRequestCommentRequest,
  PullRequestExistingReviewComment,
  SubmitPullRequestReviewRequest,
  TerminalHelperStatus,
  WalkthroughCommitMessageRequest,
  WalkthroughCommitMessageResult,
  WalkthroughCommitRequest,
  WalkthroughCommitResult,
} from './types.ts';

declare module '*.css';

declare global {
  interface Window {
    codiff: {
      askReviewAssistant: (request: ReviewAssistantRequest) => Promise<ReviewAssistantResult>;
      completePlan: (review: PlanReview, status: PlanHandoffStatus) => Promise<void>;
      createWalkthroughCommit: (
        request: WalkthroughCommitRequest,
      ) => Promise<WalkthroughCommitResult>;
      decreaseCodeFontSize: () => Promise<void>;
      getAgentSkillStatus: () => Promise<AgentSkillStatus>;
      getConfig: () => Promise<CodiffConfig>;
      getDiffImageContent: (request: DiffImageContentRequest) => Promise<DiffImageContentResult>;
      getDiffSectionContent: (request: DiffSectionContentRequest) => Promise<DiffSection>;
      getFeatureFlags: () => Promise<CodiffFeatureFlags>;
      getGitIdentity: () => Promise<GitIdentity>;
      getLaunchOptions: () => Promise<CodiffLaunchOptions>;
      getMarkdownDocument: (request: {
        kind: CodiffMarkdownDocument['kind'];
        path: string;
      }) => Promise<CodiffMarkdownDocument>;
      getNarrativeWalkthrough: (source?: ReviewSource) => Promise<NarrativeWalkthroughResult>;
      getPlanReview: () => Promise<PlanReview | null>;
      getPreferences: () => Promise<CodiffPreferences>;
      getRepositoryHistory: (limit?: number, source?: ReviewSource) => Promise<RepositoryHistory>;
      getRepositoryState: (source?: ReviewSource) => Promise<RepositoryState>;
      getTerminalHelperStatus: () => Promise<TerminalHelperStatus>;
      increaseCodeFontSize: () => Promise<void>;
      installAgentSkill: () => Promise<AgentSkillStatus>;
      installTerminalHelper: () => Promise<TerminalHelperStatus>;
      isWindowFullScreen: () => Promise<boolean>;
      markPlanReady: () => Promise<void>;
      onConfigChanged: (callback: (config: CodiffConfig) => void) => () => void;
      onCopyPendingCommentsRequest: (callback: () => string | Promise<string>) => () => void;
      onFindInDiffs: (callback: () => void) => () => void;
      onMarkdownDocumentChanged: (
        callback: (
          change:
            | { deleted: true; id: string }
            | { deleted: false; document: CodiffMarkdownDocument; id: string },
        ) => void,
      ) => () => void;
      onPlanCloseRequested: (callback: () => void) => () => void;
      onRefreshRequest: (callback: () => void) => () => void;
      onRepositoryChanged: (callback: (change: { root: string }) => void) => () => void;
      onWindowFullScreenChanged: (callback: (isFullScreen: boolean) => void) => () => void;
      openConfigFile: () => Promise<void>;
      openFile: (path: string) => Promise<void>;
      resetCodeFontSize: () => Promise<void>;
      saveMarkdownDocument: (
        request: SaveMarkdownDocumentRequest,
      ) => Promise<SaveMarkdownDocumentResult>;
      savePlanReview: (review: PlanReview) => Promise<PlanReview>;
      setDiffStyle: (value: CodiffPreferences['diffStyle']) => Promise<void>;
      setShowOutdated: (value: boolean) => Promise<void>;
      setWordWrap: (value: boolean) => Promise<void>;
      sharePlan: (review: PlanReview) => Promise<SharePlanResult>;
      shareWalkthrough: (snapshot: SharedWalkthroughSnapshot) => Promise<ShareWalkthroughResult>;
      showInFolder: (path: string) => Promise<void>;
      submitPullRequestComment: (
        request: SubmitPullRequestCommentRequest,
      ) => Promise<PullRequestExistingReviewComment>;
      submitPullRequestReview: (request: SubmitPullRequestReviewRequest) => Promise<void>;
      updateWalkthroughCommitMessage: (
        request: WalkthroughCommitMessageRequest,
      ) => Promise<WalkthroughCommitMessageResult>;
    };
  }
}
