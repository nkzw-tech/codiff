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
  pi: 'Pi',
};

export const getAgentLabel = (backend: CodiffAgentBackend): string =>
  AGENT_LABELS[backend] ?? AGENT_LABELS.codex;

/**
 * Return the short name of the currently active model for a given agent
 * backend (e.g. `openrouter/openai/gpt-5` → `gpt-5`). Used to display the
 * active model next to the agent label without overwhelming the UI with
 * provider prefixes.
 *
 * @param {CodiffAgentBackend} backend
 * @param {string} modelId
 * @returns {string}
 */
export const getAgentModelShortName = (backend: CodiffAgentBackend, modelId: string): string => {
  if (!modelId) {
    return '';
  }
  if (!modelId.includes('/')) {
    return modelId;
  }
  const parts = modelId.split('/');
  return parts.at(-1) || modelId;
};

export const defaultTerminalHelperStatus: TerminalHelperStatus = {
  command: 'codiff',
  installed: false,
  path: '',
};
