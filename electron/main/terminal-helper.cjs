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
const { join } = require('node:path');

/**
 * @param {{app: import('electron').App; dialog: import('electron').Dialog; root: string}} options
 */
const createTerminalHelper = ({ app, dialog, root }) => {
  const getTerminalHelperSourcePath = () =>
    app.isPackaged
      ? join(process.resourcesPath, 'app/bin/codiff-app')
      : join(root, 'bin/codiff.js');

  const getTerminalHelperTargetPaths = () => [
    '/opt/homebrew/bin/codiff',
    '/usr/local/bin/codiff',
    join(app.getPath('home'), '.local/bin/codiff'),
  ];

  const getPreferredTerminalHelperTargetPath = () => {
    for (const directory of ['/opt/homebrew/bin', '/usr/local/bin']) {
      try {
        if (existsSync(directory)) {
          accessSync(directory, constants.W_OK);
          return join(directory, 'codiff');
        }
      } catch {
        // Keep looking for a writable install location.
      }
    }

    return join(app.getPath('home'), '.local/bin/codiff');
  };

  /** @param {string} targetPath */
  const isInstalledTerminalHelper = (targetPath) => {
    try {
      if (!existsSync(targetPath)) {
        return false;
      }

      const target = lstatSync(targetPath);
      if (!target.isSymbolicLink()) {
        return false;
      }

      return realpathSync(targetPath) === realpathSync(getTerminalHelperSourcePath());
    } catch {
      return false;
    }
  };

  const getTerminalHelperStatus = () => {
    const installedPath = getTerminalHelperTargetPaths().find((targetPath) =>
      isInstalledTerminalHelper(targetPath),
    );

    return {
      command: 'codiff',
      installed: installedPath != null,
      path: installedPath || getPreferredTerminalHelperTargetPath(),
    };
  };

  const getWritableHelperDirectory = () => {
    for (const directory of ['/opt/homebrew/bin', '/usr/local/bin']) {
      try {
        if (existsSync(directory)) {
          accessSync(directory, constants.W_OK);
          return directory;
        }
      } catch {
        // Keep looking for a writable install location.
      }
    }

    const localBin = join(app.getPath('home'), '.local/bin');
    mkdirSync(localBin, { recursive: true });
    return localBin;
  };

  /** @param {import('electron').BaseWindow | undefined | null} browserWindow */
  const installTerminalHelper = async (browserWindow) => {
    try {
      const sourcePath = getTerminalHelperSourcePath();
      const targetPath = join(getWritableHelperDirectory(), 'codiff');

      if (!existsSync(sourcePath)) {
        throw new Error(`Could not find terminal helper at ${sourcePath}.`);
      }

      const target = lstatSync(targetPath, { throwIfNoEntry: false });
      if (target) {
        if (!target.isSymbolicLink()) {
          throw new Error(`${targetPath} already exists and is not a symlink.`);
        }

        unlinkSync(targetPath);
      }

      symlinkSync(sourcePath, targetPath);

      /** @type {import('electron').MessageBoxOptions} */
      const successMessage = {
        buttons: ['OK'],
        message: `Installed codiff at ${targetPath}.`,
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
        message: 'Could not install the terminal helper.',
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
    getTerminalHelperStatus,
    installTerminalHelper,
  };
};

module.exports = { createTerminalHelper };
