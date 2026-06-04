import type { CodiffAgentBackend } from '../config/types.ts';
import type { AgentSkillStatus, CodiffLaunchOptions, TerminalHelperStatus } from '../types.ts';

export const HISTORY_PAGE_SIZE = 30;

export const defaultLaunchOptions: CodiffLaunchOptions = {
  repositoryPathProvided: false,
  walkthrough: false,
};

export const defaultAgentSkillStatus: AgentSkillStatus = {
  installed: false,
  path: '',
};

const AGENT_LABELS: Record<CodiffAgentBackend, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export const getAgentLabel = (backend: CodiffAgentBackend): string =>
  AGENT_LABELS[backend] ?? AGENT_LABELS.codex;

export const defaultTerminalHelperStatus: TerminalHelperStatus = {
  command: 'codiff',
  installed: false,
  path: '',
};
