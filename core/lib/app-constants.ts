import type { CodiffAgentBackend, CodiffConfig } from '../config/types.ts';
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
  opencode: 'OpenCode',
  pi: 'Pi',
};

export const getAgentLabel = (backend: CodiffAgentBackend): string =>
  AGENT_LABELS[backend] ?? AGENT_LABELS.codex;

const AGENT_MODEL_SETTING_KEYS = {
  claude: 'claudeModel',
  codex: 'openAIModel',
  opencode: 'opencodeModel',
  pi: 'piModel',
} as const satisfies Record<CodiffAgentBackend, keyof CodiffConfig['settings']>;

/**
 * The effective agent CLI + model pair a walkthrough generation would use.
 * Changing anything else (e.g. an inactive backend's model) is not a switch.
 */
export const getAgentSelectionKey = (
  config: CodiffConfig,
  launchBackend?: CodiffAgentBackend,
): string => {
  const backend = launchBackend ?? config.settings.agentBackend;
  return `${backend}/${config.settings[AGENT_MODEL_SETTING_KEYS[backend]]}`;
};

export const defaultTerminalHelperStatus: TerminalHelperStatus = {
  command: 'codiff',
  installed: false,
  path: '',
};
