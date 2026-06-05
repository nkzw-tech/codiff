// @ts-check

const {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} = require('node:fs');
const { dirname, join } = require('node:path');

/**
 * @typedef {{sourceSubdir: string; targetSubdir: string}} AgentSkillTarget
 * @typedef {{label: string; targets: ReadonlyArray<AgentSkillTarget>}} AgentSkill
 */

/**
 * Installs every skill an agent bundles (e.g. `codiff` and `walkthrough`) with a
 * single action: each is symlinked from the app into the agent's skills directory.
 * @param {{
 *   app: import('electron').App;
 *   dialog: import('electron').Dialog;
 *   root: string;
 *   skill: AgentSkill;
 * }} options
 */
const createSkillInstaller = ({ app, dialog, root, skill }) => {
  /** @param {AgentSkillTarget} target */
  const getSourcePath = (target) =>
    app.isPackaged
      ? join(process.resourcesPath, 'app', target.sourceSubdir)
      : join(root, target.sourceSubdir);

  /** @param {AgentSkillTarget} target */
  const getTargetPath = (target) => join(app.getPath('home'), target.targetSubdir);

  /** @param {AgentSkillTarget} target */
  const isInstalledTarget = (target) => {
    try {
      const targetPath = getTargetPath(target);
      if (!existsSync(targetPath)) {
        return false;
      }

      const stats = lstatSync(targetPath);
      if (!stats.isSymbolicLink()) {
        return false;
      }

      return realpathSync(targetPath) === realpathSync(getSourcePath(target));
    } catch {
      return false;
    }
  };

  const getStatus = () => ({
    installed: skill.targets.every(isInstalledTarget),
    // Representative path (the first skill); the install dialog lists them all.
    path: getTargetPath(skill.targets[0]),
  });

  /** @param {AgentSkillTarget} target @returns {string} the installed path */
  const installTarget = (target) => {
    const sourcePath = getSourcePath(target);
    const targetPath = getTargetPath(target);

    if (!existsSync(sourcePath)) {
      throw new Error(`Could not find the ${skill.label} at ${sourcePath}.`);
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    accessSync(dirname(targetPath), constants.W_OK);

    if (existsSync(targetPath)) {
      const stats = lstatSync(targetPath);
      if (!stats.isSymbolicLink()) {
        throw new Error(`${targetPath} already exists and is not a symlink.`);
      }
      unlinkSync(targetPath);
    }

    symlinkSync(sourcePath, targetPath, process.platform === 'win32' ? 'junction' : 'dir');
    return targetPath;
  };

  /** @param {import('electron').BaseWindow | undefined | null} browserWindow */
  const install = async (browserWindow) => {
    try {
      const installedPaths = skill.targets.map(installTarget);

      /** @type {import('electron').MessageBoxOptions} */
      const successMessage = {
        buttons: ['OK'],
        detail: installedPaths.join('\n'),
        message: `Installed the Codiff ${skill.label}.`,
        type: 'info',
      };
      if (browserWindow) {
        await dialog.showMessageBox(browserWindow, successMessage);
      } else {
        await dialog.showMessageBox(successMessage);
      }
      return true;
    } catch (error) {
      /** @type {import('electron').MessageBoxOptions} */
      const errorMessage = {
        buttons: ['OK'],
        detail: error instanceof Error ? error.message : String(error),
        message: `Could not install the ${skill.label}.`,
        type: 'error',
      };
      if (browserWindow) {
        await dialog.showMessageBox(browserWindow, errorMessage);
      } else {
        await dialog.showMessageBox(errorMessage);
      }
      return false;
    }
  };

  return {
    getStatus,
    install,
  };
};

module.exports = { createSkillInstaller };
