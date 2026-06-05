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
      label: 'Codex Skill',
      targets: [
        { sourceSubdir: 'codex/skills/codiff', targetSubdir: '.codex/skills/codiff' },
        { sourceSubdir: 'codex/skills/walkthrough', targetSubdir: '.codex/skills/walkthrough' },
      ],
    },
  });

  return {
    getCodexSkillStatus: getStatus,
    installCodexSkill: install,
  };
};

module.exports = { createCodexSkillInstaller };
