import type { CodexSkillStatus, CodiffLaunchOptions, TerminalHelperStatus } from '../types.ts';

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
