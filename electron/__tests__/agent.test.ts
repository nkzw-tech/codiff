import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { AGENT_BACKENDS, DEFAULT_AGENT_BACKEND, getAgent, listAgents, normalizeAgentBackend } =
  require('../agent.cjs') as {
    AGENT_BACKENDS: ReadonlyArray<'codex' | 'claude' | 'pi'>;
    DEFAULT_AGENT_BACKEND: string;
    getAgent: (backendId: unknown) => {
      id: string;
      label: string;
      modelSettingKey: string;
      sessionLaunchOptionKey: string;
      notFoundCode: string;
      run: unknown;
      readSessionContext: unknown;
      skill?: { sourceSubdir: string; targetSubdir: string };
    };
    listAgents: () => ReadonlyArray<{ id: string }>;
    normalizeAgentBackend: (value: unknown) => string;
  };

test('normalizes unknown agent backends to the default', () => {
  expect(normalizeAgentBackend('claude')).toBe('claude');
  expect(normalizeAgentBackend('codex')).toBe('codex');
  expect(normalizeAgentBackend('pi')).toBe('pi');
  expect(normalizeAgentBackend('gpt')).toBe(DEFAULT_AGENT_BACKEND);
  expect(normalizeAgentBackend(undefined)).toBe(DEFAULT_AGENT_BACKEND);
});

test('lists all agent backends', () => {
  expect(AGENT_BACKENDS).toEqual(['codex', 'claude', 'pi']);
  expect(listAgents().map((agent) => agent.id)).toEqual(['codex', 'claude', 'pi']);
});

test('resolves the Codex agent with its session and skill wiring', () => {
  const agent = getAgent('codex');
  expect(agent.id).toBe('codex');
  expect(agent.modelSettingKey).toBe('openAIModel');
  expect(agent.sessionLaunchOptionKey).toBe('codexSessionId');
  expect(agent.notFoundCode).toBe('CODEX_NOT_FOUND');
  expect(agent.skill).toEqual({
    label: 'Codex Skill',
    targets: [{ sourceSubdir: 'codex/skills/codiff', targetSubdir: '.codex/skills/codiff' }],
  });
  expect(typeof agent.run).toBe('function');
  expect(typeof agent.readSessionContext).toBe('function');
});

test('resolves the Claude Code agent with its session and skill wiring', () => {
  const agent = getAgent('claude');
  expect(agent.id).toBe('claude');
  expect(agent.label).toBe('Claude Code');
  expect(agent.modelSettingKey).toBe('claudeModel');
  expect(agent.sessionLaunchOptionKey).toBe('claudeSessionId');
  expect(agent.notFoundCode).toBe('CLAUDE_NOT_FOUND');
  expect(agent.skill).toEqual({
    label: 'Claude Code Skill',
    targets: [{ sourceSubdir: 'claude/skills/codiff', targetSubdir: '.claude/skills/codiff' }],
  });
});

test('resolves the Pi agent with its session wiring but no skill', () => {
  const agent = getAgent('pi');
  expect(agent.id).toBe('pi');
  expect(agent.label).toBe('Pi');
  expect(agent.modelSettingKey).toBe('piModel');
  expect(agent.sessionLaunchOptionKey).toBe('piSessionId');
  expect(agent.notFoundCode).toBe('PI_NOT_FOUND');
  expect(agent.skill).toEqual({
  "label": "Pi Skill",
  "targets": [
    {
      "sourceSubdir": "pi/skills/codiff",
      "targetSubdir": ".pi/agent/skills/codiff",
    },
  ],
});
  expect(typeof agent.run).toBe('function');
  expect(typeof agent.readSessionContext).toBe('function');
});

test('falls back to the default backend for unknown ids', () => {
  expect(getAgent('unknown').id).toBe(DEFAULT_AGENT_BACKEND);
});
