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
 * @typedef {{label: string; sourceSubdir: string; targetSubdir: string}} AgentSkill
 */

/**
 * @param {{
 *   app: import('electron').App;
 *   dialog: import('electron').Dialog;
 *   root: string;
 *   skill: AgentSkill;
 * }} options
 */
const createSkillInstaller = ({ app, dialog, root, skill }) => {
  const getSkillSourcePath = () =>
    app.isPackaged
      ? join(process.resourcesPath, 'app', skill.sourceSubdir)
      : join(root, skill.sourceSubdir);

  const getSkillTargetPath = () => join(app.getPath('home'), skill.targetSubdir);

  /** @param {string} targetPath */
  const isInstalledSkill = (targetPath) => {
    try {
      if (!existsSync(targetPath)) {
        return false;
      }

      const target = lstatSync(targetPath);
      if (!target.isSymbolicLink()) {
        return false;
      }

      return realpathSync(targetPath) === realpathSync(getSkillSourcePath());
    } catch {
      return false;
    }
  };

  const getStatus = () => {
    const targetPath = getSkillTargetPath();

    return {
      installed: isInstalledSkill(targetPath),
      path: targetPath,
    };
  };

  /** @param {import('electron').BaseWindow | undefined | null} browserWindow */
  const install = async (browserWindow) => {
    try {
      const sourcePath = getSkillSourcePath();
      const targetPath = getSkillTargetPath();

      if (!existsSync(sourcePath)) {
        throw new Error(`Could not find the ${skill.label} at ${sourcePath}.`);
      }

      mkdirSync(dirname(targetPath), { recursive: true });
      accessSync(dirname(targetPath), constants.W_OK);

      if (existsSync(targetPath)) {
        const target = lstatSync(targetPath);

        if (!target.isSymbolicLink()) {
          throw new Error(`${targetPath} already exists and is not a symlink.`);
        }

        unlinkSync(targetPath);
      }

      symlinkSync(sourcePath, targetPath, process.platform === 'win32' ? 'junction' : 'dir');

      /** @type {import('electron').MessageBoxOptions} */
      const successMessage = {
        buttons: ['OK'],
        message: `Installed the Codiff ${skill.label} at ${targetPath}.`,
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
