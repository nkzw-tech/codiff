import type { CodiffDiffStyle } from './config/types.ts';

export type * from './types/generation.ts';
export type * from './types/review-comments.ts';
export type * from './types/review-history.ts';
export type * from './types/review-identity.ts';
export type * from './types/walkthrough.ts';

export type CodiffFeatureFlags = {
  planSharing: boolean;
  walkthroughSharing: boolean;
};

export type CodiffTheme = 'system' | 'light' | 'dark';

export type CodiffPreferences = {
  agentBackend: 'codex' | 'claude' | 'opencode' | 'pi';
  claudeModel: string;
  codeFontFamily: string;
  codeFontSize: number;
  copyCommentsOnClose: boolean;
  diffStyle: CodiffDiffStyle;
  editorCommand: string;
  lastRepositoryPath: string;
  openAIModel: string;
  opencodeModel: string;
  piModel: string;
  reviewCommentsPrefix: string;
  showOutdated: boolean;
  showWhitespace: boolean;
  theme: CodiffTheme;
  walkthroughPrompt: string;
  wordWrap: boolean;
};

export type ReviewPreferences = Pick<
  CodiffPreferences,
  'codeFontFamily' | 'codeFontSize' | 'diffStyle' | 'showWhitespace' | 'theme' | 'wordWrap'
>;

export type CodiffUpdatePhase = 'available' | 'error' | 'idle' | 'installerReady' | 'updating';

export type CodiffUpdateStatus = {
  currentVersion: string;
  message?: string;
  phase: CodiffUpdatePhase;
  strategy?: 'download' | 'manual' | 'squirrel';
  version?: string;
};
