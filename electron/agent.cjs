// @ts-check

const codex = require('./codex.cjs');
const claude = require('./claude.cjs');
const { readCodexSessionContext } = require('./codex-session-context.cjs');
const { readClaudeSessionContext } = require('./claude-session-context.cjs');

/**
 * @typedef {import('../src/types.ts').WalkthroughContext} WalkthroughContext
 * @typedef {{
 *   fallbackModel?: string;
 *   model?: string;
 *   onModelFallback?: (fallbackModel: string, originalModel: string) => Promise<void> | void;
 * }} AgentOptions
 * @typedef {{
 *   id: 'codex' | 'claude';
 *   label: string;
 *   cliName: string;
 *   cliPathEnvVar: string;
 *   models: ReadonlyArray<{id: string; label: string}>;
 *   defaultModel: string;
 *   fallbackModel: string;
 *   modelSettingKey: 'openAIModel' | 'claudeModel';
 *   normalizeModel: (value: unknown) => string;
 *   notFoundCode: string;
 *   isNotFoundError: (error: unknown) => boolean;
 *   run: (
 *     repoRoot: string,
 *     prompt: string,
 *     schema: unknown,
 *     outputName?: string,
 *     timeoutMessage?: string,
 *     options?: AgentOptions,
 *   ) => Promise<string>;
 *   readSessionContext: (sessionId: string | undefined) => WalkthroughContext | null;
 *   sessionLaunchOptionKey: 'codexSessionId' | 'claudeSessionId';
 *   skill: {label: string; sourceSubdir: string; targetSubdir: string};
 * }} Agent
 */

const DEFAULT_AGENT_BACKEND = 'codex';
/** @type {ReadonlyArray<'codex' | 'claude'>} */
const AGENT_BACKENDS = Object.freeze(['codex', 'claude']);

/** @returns {Agent} */
const createCodexAgent = () => ({
  id: 'codex',
  label: 'Codex',
  cliName: 'codex',
  cliPathEnvVar: 'CODIFF_CODEX_PATH',
  models: codex.OPENAI_MODELS,
  defaultModel: codex.DEFAULT_OPENAI_MODEL,
  fallbackModel: codex.FALLBACK_OPENAI_MODEL,
  modelSettingKey: 'openAIModel',
  normalizeModel: codex.normalizeOpenAIModel,
  notFoundCode: codex.CODEX_NOT_FOUND_CODE,
  isNotFoundError: codex.isCodexNotFoundError,
  run: codex.runCodex,
  readSessionContext: readCodexSessionContext,
  sessionLaunchOptionKey: 'codexSessionId',
  skill: {
    label: 'Codex Skill',
    sourceSubdir: 'codex/skills/codiff',
    targetSubdir: '.codex/skills/codiff',
  },
});

/** @returns {Agent} */
const createClaudeAgent = () => ({
  id: 'claude',
  label: 'Claude Code',
  cliName: 'claude',
  cliPathEnvVar: 'CODIFF_CLAUDE_PATH',
  models: claude.CLAUDE_MODELS,
  defaultModel: claude.DEFAULT_CLAUDE_MODEL,
  fallbackModel: claude.FALLBACK_CLAUDE_MODEL,
  modelSettingKey: 'claudeModel',
  normalizeModel: claude.normalizeClaudeModel,
  notFoundCode: claude.CLAUDE_NOT_FOUND_CODE,
  isNotFoundError: claude.isClaudeNotFoundError,
  run: claude.runClaude,
  readSessionContext: readClaudeSessionContext,
  sessionLaunchOptionKey: 'claudeSessionId',
  skill: {
    label: 'Claude Code Skill',
    sourceSubdir: 'claude/skills/codiff',
    targetSubdir: '.claude/skills/codiff',
  },
});

/** @type {Record<'codex' | 'claude', () => Agent>} */
const AGENT_FACTORIES = {
  claude: createClaudeAgent,
  codex: createCodexAgent,
};

/** @param {unknown} value @returns {'codex' | 'claude'} */
const normalizeAgentBackend = (value) =>
  value === 'codex' || value === 'claude' ? value : DEFAULT_AGENT_BACKEND;

/** @param {unknown} backendId @returns {Agent} */
const getAgent = (backendId) => AGENT_FACTORIES[normalizeAgentBackend(backendId)]();

/** @returns {ReadonlyArray<Agent>} */
const listAgents = () => AGENT_BACKENDS.map((id) => AGENT_FACTORIES[id]());

module.exports = {
  AGENT_BACKENDS,
  DEFAULT_AGENT_BACKEND,
  getAgent,
  listAgents,
  normalizeAgentBackend,
};
