import type { CodiffLaunchOptions, CodiffPreferences, TerminalHelperStatus } from '../types.ts';

export const HISTORY_PAGE_SIZE = 30;

export const defaultLaunchOptions: CodiffLaunchOptions = {
  repositoryPathProvided: false,
  walkthrough: false,
};

export const defaultTerminalHelperStatus: TerminalHelperStatus = {
  command: 'codiff',
  installed: false,
  path: '',
};

export const defaultPreferences: CodiffPreferences = {
  copyCommentsOnClose: false,
  lastRepositoryPath: '',
  openAIModel: 'gpt-5.3-codex-spark',
  showWhitespace: false,
  theme: 'system',
};
