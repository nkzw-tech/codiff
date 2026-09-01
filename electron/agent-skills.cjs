// @ts-check

/**
 * @typedef {'codex' | 'claude' | 'opencode' | 'pi'} AgentSkillId
 * @typedef {{
 *   legacyManagedMarkers?: ReadonlyArray<string>;
 *   managedMarker: string;
 *   sourceSubdir: string;
 *   targetSubdir: string;
 * }} AgentSkillFile
 * @typedef {{
 *   agentLabel: string;
 *   files?: ReadonlyArray<AgentSkillFile>;
 *   id: AgentSkillId;
 *   label: string;
 *   targets: ReadonlyArray<{
 *     sourceSubdir: string;
 *     targetSubdir: string;
 *     type: 'directory' | 'file';
 *   }>;
 * }} AgentSkill
 */

/** @type {ReadonlyArray<AgentSkill>} */
const AGENT_SKILLS = Object.freeze([
  {
    agentLabel: 'Codex',
    id: 'codex',
    label: 'Codex Skill',
    targets: [
      {
        sourceSubdir: 'codex/skills/codiff',
        targetSubdir: '.codex/skills/codiff',
        type: 'directory',
      },
    ],
  },
  {
    agentLabel: 'Claude Code',
    id: 'claude',
    label: 'Claude Code Skill',
    targets: [
      {
        sourceSubdir: 'claude/skills/codiff',
        targetSubdir: '.claude/skills/codiff',
        type: 'directory',
      },
    ],
  },
  {
    agentLabel: 'Pi',
    id: 'pi',
    label: 'Pi Skill',
    targets: [
      {
        sourceSubdir: 'pi/skills/codiff',
        targetSubdir: '.pi/agent/skills/codiff',
        type: 'directory',
      },
    ],
  },
  {
    agentLabel: 'OpenCode',
    files: [
      {
        legacyManagedMarkers: [
          '<!-- Managed by Codiff. Reinstall the OpenCode integration instead of editing this file. -->',
        ],
        managedMarker: '<!-- codiff-managed-opencode-command:v1 -->',
        sourceSubdir: 'opencode/commands/codiff.md',
        targetSubdir: '.config/opencode/commands/codiff.md',
      },
    ],
    id: 'opencode',
    label: 'OpenCode Integration',
    targets: [
      {
        sourceSubdir: 'opencode/skills/codiff',
        targetSubdir: '.config/opencode/skills/codiff',
        type: 'directory',
      },
      {
        sourceSubdir: 'opencode/plugins/codiff.js',
        targetSubdir: '.config/opencode/plugins/codiff.js',
        type: 'file',
      },
    ],
  },
]);

/** @returns {ReadonlyArray<AgentSkill>} */
const listAgentSkills = () => AGENT_SKILLS;

/**
 * @param {(skill: AgentSkill, browserWindow: import('electron').BaseWindow | undefined) => void} install
 * @returns {import('electron').MenuItemConstructorOptions}
 */
const buildInstallSkillMenuItem = (install) => ({
  label: 'Install Skill',
  submenu: AGENT_SKILLS.map((skill) => ({
    click: (_menuItem, browserWindow) => install(skill, browserWindow),
    label: skill.agentLabel,
  })),
});

module.exports = {
  buildInstallSkillMenuItem,
  listAgentSkills,
};
