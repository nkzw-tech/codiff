// @ts-check

const { createSkillInstaller } = require('./agent-skill.cjs');

/**
 * Backward-compatible Codex skill installer. New code should use
 * {@link createSkillInstaller} with the agent's skill descriptor directly.
 * @param {{app: import('electron').App; dialog: import('electron').Dialog; root: string}} options
 */
const createCodexSkillInstaller = ({ app, dialog, root }) => {
  const { getStatus, install } = createSkillInstaller({
    app,
    dialog,
    root,
    skill: {
      id: 'codex',
      label: 'Codex Skill',
      targets: [{ sourceSubdir: 'codex/skills/codiff', targetSubdir: '.codex/skills/codiff' }],
    },
  });

  return {
    getCodexSkillStatus: getStatus,
    installCodexSkill: install,
  };
};

module.exports = { createCodexSkillInstaller };
