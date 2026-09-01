// @ts-check

const { randomUUID } = require('node:crypto');
const {
  accessSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { basename, dirname, join } = require('node:path');

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
 *   id: 'codex' | 'claude' | 'opencode' | 'pi';
 *   label: string;
 *   successDetail?: string;
 *   targets: ReadonlyArray<AgentSkillTarget>;
 * }} AgentSkill
 */

/**
 * Installs every skill an agent bundles with a single action: each is symlinked
 * from the app into the agent's skills directory.
 * @param {{
 *   app: import('electron').App;
 *   dialog: import('electron').Dialog;
 *   fileOperations?: {
 *     linkSync?: typeof linkSync;
 *     renameSync?: typeof renameSync;
 *     symlinkSync?: typeof symlinkSync;
 *     writeFileSync?: typeof writeFileSync;
 *   };
 *   getActiveStatus?: (skillId: 'codex' | 'claude' | 'opencode' | 'pi') => Promise<boolean>;
 *   renderManagedFile?: (file: AgentSkillFile, template: string) => string;
 *   root: string;
 *   skill: AgentSkill;
 * }} options
 */
const createSkillInstaller = ({
  app,
  dialog,
  fileOperations = {},
  getActiveStatus = async () => false,
  renderManagedFile,
  root,
  skill,
}) => {
  const createHardLink = fileOperations.linkSync || linkSync;
  const movePath = fileOperations.renameSync || renameSync;
  const createSymlink = fileOperations.symlinkSync || symlinkSync;
  const writeFile = fileOperations.writeFileSync || writeFileSync;
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

  const inactiveDetails = {
    claude: 'Restart Claude Code with the Codiff Channel enabled.',
    codex: 'Codex CLI 0.149.0 or newer with `codex queue` is required.',
    opencode: 'Restart OpenCode so the Codiff plugin can register this session.',
    pi: 'Restart Pi so the Codiff extension can register this session.',
  };

  /** @param {typeof getActiveStatus} [resolveActiveStatus] */
  const getStatus = async (resolveActiveStatus = getActiveStatus) => {
    const active = await resolveActiveStatus(skill.id).catch(() => false);
    return {
      active,
      ...(!active && { detail: inactiveDetails[skill.id] }),
      installed:
        skill.targets.every(isInstalledTarget) && (skill.files || []).every(isInstalledFile),
      // Representative path (the first skill); the install dialog lists them all.
      path: getTargetPath(skill.targets[0]),
    };
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

    writeFile(targetPath, getRenderedFile(file), { encoding: 'utf8', mode: 0o644 });
    return targetPath;
  };

  /** @param {import('node:fs').Stats | null} stats */
  const metadata = (stats) =>
    stats && { dev: stats.dev, ino: stats.ino, mode: stats.mode, mtimeMs: stats.mtimeMs };

  /**
   * @param {{definition: AgentSkillFile | AgentSkillTarget; kind: 'file' | 'target'; sourcePath: string; targetPath: string}} item
   * @param {string} [targetPath]
   */
  const captureDestination = (item, targetPath = item.targetPath) => {
    let stats;
    try {
      stats = lstatSync(targetPath);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    if (item.kind === 'target') {
      if (!stats.isSymbolicLink() || realpathSync(targetPath) !== realpathSync(item.sourcePath)) {
        throw new Error(`${item.targetPath} already exists and is not managed by Codiff.`);
      }
      return { metadata: metadata(stats) };
    }

    const contents = stats.isFile() ? readFileSync(targetPath, 'utf8') : '';
    if (
      !stats.isFile() ||
      !isManagedFile(/** @type {AgentSkillFile} */ (item.definition), contents)
    ) {
      throw new Error(`${item.targetPath} already exists and is not managed by Codiff.`);
    }
    return { contents, metadata: metadata(stats) };
  };

  /** @param {ReturnType<typeof captureDestination>} left @param {ReturnType<typeof captureDestination>} right */
  const sameDestination = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  /**
   * @param {{definition: AgentSkillFile | AgentSkillTarget; kind: 'file' | 'target'; sourcePath: string; targetPath: string; snapshot: ReturnType<typeof captureDestination>}} item
   * @param {string} [targetPath]
   */
  const revalidateDestination = (item, targetPath) => {
    const current = captureDestination(item, targetPath);
    if (!sameDestination(current, item.snapshot)) {
      throw new Error(`${item.targetPath} changed during installation.`);
    }
  };

  const installTransaction = () => {
    const items = [
      ...skill.targets.map((definition) => ({
        definition,
        kind: /** @type {const} */ ('target'),
        sourcePath: getSourcePath(definition),
        targetPath: getTargetPath(definition),
      })),
      ...(skill.files || []).map((definition) => ({
        contents: getRenderedFile(definition),
        definition,
        kind: /** @type {const} */ ('file'),
        sourcePath: getSourcePath(definition),
        targetPath: getTargetPath(definition),
      })),
    ];

    for (const item of items) {
      if (!existsSync(item.sourcePath)) {
        throw new Error(`Could not find the ${skill.label} at ${item.sourcePath}.`);
      }
      item.snapshot = captureDestination(item);
    }

    const staged = [];
    try {
      for (const item of items) {
        const parent = dirname(item.targetPath);
        mkdirSync(parent, { recursive: true });
        accessSync(parent, constants.W_OK);
        const suffix = randomUUID();
        const name = basename(item.targetPath);
        const stagePath = join(parent, `.${name}.codiff-stage-${suffix}`);
        const backupPath = join(parent, `.${name}.codiff-backup-${suffix}`);
        try {
          if (item.kind === 'target') {
            const target = /** @type {AgentSkillTarget} */ (item.definition);
            const type =
              target.type === 'file' ? 'file' : process.platform === 'win32' ? 'junction' : 'dir';
            createSymlink(item.sourcePath, stagePath, type);
          } else {
            writeFile(stagePath, item.contents, { encoding: 'utf8', mode: 0o644 });
          }
        } catch (error) {
          try {
            rmSync(stagePath, { force: true, recursive: true });
          } catch {
            // The main rollback still needs to clean earlier staged destinations.
          }
          throw error;
        }
        staged.push({
          ...item,
          backupMoved: false,
          backupPath,
          committed: false,
          committedSnapshot: null,
          stagedSnapshot: captureDestination(item, stagePath),
          stagePath,
        });
      }

      for (const item of staged) {
        revalidateDestination(item);
        if (!sameDestination(captureDestination(item, item.stagePath), item.stagedSnapshot)) {
          throw new Error(`${item.stagePath} changed during installation.`);
        }
        if (item.snapshot) {
          movePath(item.targetPath, item.backupPath);
          item.backupMoved = true;
          revalidateDestination(item, item.backupPath);
        }
        if (item.kind === 'target') {
          const target = /** @type {AgentSkillTarget} */ (item.definition);
          const type =
            target.type === 'file' ? 'file' : process.platform === 'win32' ? 'junction' : 'dir';
          createSymlink(readlinkSync(item.stagePath), item.targetPath, type);
        } else {
          createHardLink(item.stagePath, item.targetPath);
        }
        item.committed = true;
        item.committedSnapshot = captureDestination(item);
      }
    } catch (error) {
      for (const item of staged.toReversed()) {
        if (item.committed) {
          try {
            if (
              item.committedSnapshot &&
              sameDestination(captureDestination(item), item.committedSnapshot)
            ) {
              rmSync(item.targetPath, { force: true, recursive: true });
            }
          } catch {
            // A destination changed outside this transaction must not be removed.
          }
        }
        if (item.backupMoved) {
          try {
            if (!captureDestination(item)) {
              movePath(item.backupPath, item.targetPath);
            }
          } catch {
            // Preserve the original backup rather than overwrite a changed destination.
          }
        }
        try {
          rmSync(item.stagePath, { force: true, recursive: true });
        } catch {
          // Continue rolling back the remaining destinations.
        }
      }
      throw error;
    }

    for (const item of staged) {
      try {
        rmSync(item.backupPath, { force: true, recursive: true });
        rmSync(item.stagePath, { force: true, recursive: true });
      } catch {
        // The installation is committed; private stale artifacts are safer than rollback.
      }
    }
    return items.map(({ targetPath }) => targetPath);
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
      const installedPaths = installTransaction();

      /** @type {import('electron').MessageBoxOptions} */
      const successMessage = {
        buttons: ['OK'],
        detail: [skill.successDetail, ...installedPaths].filter(Boolean).join('\n\n'),
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
