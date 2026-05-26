import type {
  CodexSkillStatus,
  CodiffLaunchOptions,
  CodiffPreferences,
  TerminalHelperStatus,
} from '../types.ts';

export const HISTORY_PAGE_SIZE = 30;

export const defaultLaunchOptions: CodiffLaunchOptions = {
  repositoryPathProvided: false,
  walkthrough: false,
};

export const defaultCodexSkillStatus: CodexSkillStatus = {
  installed: false,
  path: '',
};

export const defaultTerminalHelperStatus: TerminalHelperStatus = {
  command: 'codiff',
  installed: false,
  path: '',
};

export const defaultPreferences: CodiffPreferences = {
  copyCommentsOnClose: false,
  diffStyle: 'split',
  lastRepositoryPath: '',
  openAIModel: 'gpt-5.3-codex-spark',
  showOutdated: false,
  showWhitespace: false,
  theme: 'system',
};
