// @ts-check

const codex = require('./codex.cjs');
const claude = require('./claude.cjs');
const pi = require('./pi.cjs');
const { readCodexSessionContext } = require('./codex-session-context.cjs');
const { readClaudeSessionContext } = require('./claude-session-context.cjs');
const { readPiSessionContext } = require('./pi-session-context.cjs');

/**
 * @typedef {import('../src/types.ts').WalkthroughContext} WalkthroughContext
 * @typedef {{
 *   fallbackModel?: string;
 *   model?: string;
 *   onModelFallback?: (fallbackModel: string, originalModel: string) => Promise<void> | void;
 *   onPartialText?: (delta: string) => void;
 * }} AgentOptions
 * @typedef {{
 *   id: 'codex' | 'claude' | 'pi';
 *   label: string;
 *   cliName: string;
 *   cliPathEnvVar: string;
 *   models: ReadonlyArray<{id: string; label: string}>;
 *   defaultModel: string;
 *   fallbackModel: string;
 *   modelSettingKey: 'openAIModel' | 'claudeModel' | 'piModel';
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
 *   sessionLaunchOptionKey: 'codexSessionId' | 'claudeSessionId' | 'piSessionId';
 *   skill?: {
 *     label: string;
 *     targets: Array<{sourceSubdir: string; targetSubdir: string}>;
 *   };
 * }} Agent
 */

const DEFAULT_AGENT_BACKEND = 'codex';
/** @type {ReadonlyArray<'codex' | 'claude' | 'pi'>} */
const AGENT_BACKENDS = Object.freeze(['codex', 'claude', 'pi']);

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
    targets: [{ sourceSubdir: 'codex/skills/codiff', targetSubdir: '.codex/skills/codiff' }],
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
    targets: [{ sourceSubdir: 'claude/skills/codiff', targetSubdir: '.claude/skills/codiff' }],
  },
});

/** @returns {Agent} */
const createPiAgent = () => {
  // Kick off model discovery eagerly so the agent menu can populate the
  // model submenu with the real Pi models as soon as the SDK has loaded.
  // The result is cached on the `pi` module and exposed via the proxy on
  // `pi.PI_MODELS`. Failures are intentionally swallowed — the lazy
  // `getPiModels()` call inside `runPi` will surface a clear error then.
  pi.getPiModels().catch(() => {});

  return {
    id: 'pi',
    label: 'Pi',
    cliName: 'pi',
    cliPathEnvVar: 'CODIFF_PI_PATH',
    models: pi.PI_MODELS,
    defaultModel: pi.DEFAULT_PI_MODEL,
    fallbackModel: pi.FALLBACK_PI_MODEL,
    modelSettingKey: 'piModel',
    normalizeModel: pi.normalizePiModel,
    notFoundCode: pi.PI_NOT_FOUND_CODE,
    isNotFoundError: pi.isPiNotFoundError,
    run: pi.runPi,
    readSessionContext: readPiSessionContext,
    sessionLaunchOptionKey: 'piSessionId',
    skill: {
      label: 'Pi Skill',
      targets: [{ sourceSubdir: 'pi/skills/codiff', targetSubdir: '.pi/agent/skills/codiff' }],
    },
  };
};

/** @type {Record<'codex' | 'claude' | 'pi', () => Agent>} */
const AGENT_FACTORIES = {
  claude: createClaudeAgent,
  codex: createCodexAgent,
  pi: createPiAgent,
};

/** @param {unknown} value @returns {'codex' | 'claude' | 'pi'} */
const normalizeAgentBackend = (value) =>
  value === 'codex' || value === 'claude' || value === 'pi' ? value : DEFAULT_AGENT_BACKEND;

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
