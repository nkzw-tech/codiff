// @ts-check

const {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join } = require('node:path');

/**
 * @typedef {{
 *   legacyManagedMarkers?: ReadonlyArray<string>;
 *   managedMarker: string;
 *   sourceSubdir: string;
 *   targetSubdir: string;
 * }} AgentSkillFile
 * @typedef {{sourceSubdir: string; targetSubdir: string; type?: 'directory' | 'file'}} AgentSkillTarget
 * @typedef {{
 *   files?: ReadonlyArray<AgentSkillFile>;
 *   label: string;
 *   targets: ReadonlyArray<AgentSkillTarget>;
 * }} AgentSkill
 */

/**
 * Installs every skill an agent bundles with a single action: each is symlinked
 * from the app into the agent's skills directory.
 * @param {{
 *   app: import('electron').App;
 *   dialog: import('electron').Dialog;
 *   renderManagedFile?: (file: AgentSkillFile, template: string) => string;
 *   root: string;
 *   skill: AgentSkill;
 * }} options
 */
const createSkillInstaller = ({ app, dialog, renderManagedFile, root, skill }) => {
  /** @param {{sourceSubdir: string}} item */
  const getSourcePath = (item) =>
    app.isPackaged
      ? join(process.resourcesPath, 'app', item.sourceSubdir)
      : join(root, item.sourceSubdir);

  /** @param {{targetSubdir: string}} item */
  const getTargetPath = (item) => join(app.getPath('home'), item.targetSubdir);

  /** @param {AgentSkillFile} file */
  const getRenderedFile = (file) => {
    const template = readFileSync(getSourcePath(file), 'utf8');
    return renderManagedFile ? renderManagedFile(file, template) : template;
  };

  /** @param {AgentSkillFile} file @param {string} contents */
  const isManagedFile = (file, contents) => {
    const markers = new Set([file.managedMarker, ...(file.legacyManagedMarkers || [])]);
    return contents
      .split(/\r?\n/, 20)
      .slice(0, 20)
      .some((line) => markers.has(line));
  };

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

  /** @param {AgentSkillTarget} target */
  const getTargetStats = (target) => {
    try {
      return lstatSync(getTargetPath(target));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  };

  /** @param {AgentSkillFile} file */
  const isInstalledFile = (file) => {
    try {
      const targetPath = getTargetPath(file);
      return (
        existsSync(targetPath) &&
        lstatSync(targetPath).isFile() &&
        readFileSync(targetPath, 'utf8') === getRenderedFile(file)
      );
    } catch {
      return false;
    }
  };

  const getStatus = () => ({
    installed: skill.targets.every(isInstalledTarget) && (skill.files || []).every(isInstalledFile),
    // Representative path (the first skill); the install dialog lists them all.
    path: getTargetPath(skill.targets[0]),
  });

  /** @param {AgentSkillTarget} target @returns {string} the installed path */
  const installTarget = (target) => {
    const sourcePath = getSourcePath(target);
    const targetPath = getTargetPath(target);

    mkdirSync(dirname(targetPath), { recursive: true });
    accessSync(dirname(targetPath), constants.W_OK);

    const stats = getTargetStats(target);
    if (stats) {
      if (!isInstalledTarget(target)) {
        throw new Error(`${targetPath} already exists and is not managed by Codiff.`);
      }
      unlinkSync(targetPath);
    }

    const type =
      target.type === 'file' ? 'file' : process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(sourcePath, targetPath, type);
    return targetPath;
  };

  /** @param {AgentSkillFile} file @returns {string} the installed path */
  const installFile = (file) => {
    const targetPath = getTargetPath(file);

    mkdirSync(dirname(targetPath), { recursive: true });
    accessSync(dirname(targetPath), constants.W_OK);

    if (existsSync(targetPath)) {
      const stats = lstatSync(targetPath);
      const contents = stats.isFile() ? readFileSync(targetPath, 'utf8') : '';
      if (!stats.isFile() || !isManagedFile(file, contents)) {
        throw new Error(`${targetPath} already exists and is not managed by Codiff.`);
      }
    }

    writeFileSync(targetPath, getRenderedFile(file), { encoding: 'utf8', mode: 0o644 });
    return targetPath;
  };

  const refreshManagedFiles = () => {
    if (!skill.targets.every(isInstalledTarget)) {
      return;
    }

    for (const file of skill.files || []) {
      const targetPath = getTargetPath(file);
      if (!existsSync(targetPath)) {
        installFile(file);
        continue;
      }
      if (!lstatSync(targetPath).isFile()) {
        continue;
      }

      const contents = readFileSync(targetPath, 'utf8');
      if (!isManagedFile(file, contents)) {
        continue;
      }

      const rendered = getRenderedFile(file);
      if (contents !== rendered) {
        writeFileSync(targetPath, rendered, { encoding: 'utf8', mode: 0o644 });
      }
    }
  };

  /** @param {import('electron').BaseWindow | undefined | null} browserWindow */
  const install = async (browserWindow) => {
    try {
      for (const target of skill.targets) {
        const sourcePath = getSourcePath(target);
        const targetPath = getTargetPath(target);
        if (!existsSync(sourcePath)) {
          throw new Error(`Could not find the ${skill.label} at ${sourcePath}.`);
        }
        if (getTargetStats(target) && !isInstalledTarget(target)) {
          throw new Error(`${targetPath} already exists and is not managed by Codiff.`);
        }
      }

      for (const file of skill.files || []) {
        const sourcePath = getSourcePath(file);
        const targetPath = getTargetPath(file);
        if (!existsSync(sourcePath)) {
          throw new Error(`Could not find the ${skill.label} command at ${sourcePath}.`);
        }

        getRenderedFile(file);
        if (existsSync(targetPath)) {
          const stats = lstatSync(targetPath);
          const contents = stats.isFile() ? readFileSync(targetPath, 'utf8') : '';
          if (!stats.isFile() || !isManagedFile(file, contents)) {
            throw new Error(`${targetPath} already exists and is not managed by Codiff.`);
          }
        }
      }

      const installedPaths = [
        ...skill.targets.map(installTarget),
        ...(skill.files || []).map(installFile),
      ];

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
    refreshManagedFiles,
  };
};

module.exports = { createSkillInstaller };
