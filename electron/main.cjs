// @ts-check

const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { userInfo } = require('node:os');
const { basename, dirname, join, relative, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
} = require('electron');
const squirrelStartup = require('electron-squirrel-startup');
const {
  listRepositoryHistory,
  readDiffImageContent,
  readDiffSectionContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readRepositoryState,
  readWalkthroughRepositoryState,
  submitPullRequestComment,
  submitPullRequestReview,
  validateRepositoryPath,
} = require('./git-state.cjs');
const { normalizeOpenAIModel } = require('./codex.cjs');
const { normalizeClaudeModel } = require('./claude.cjs');
const { normalizeOpenCodeModel, renderOpenCodeCommand } = require('./opencode.cjs');
const { createWalkthroughCommit } = require('./walkthrough-commit.cjs');
const { diagnoseWalkthroughMismatch } = require('./walkthrough-diagnosis.cjs');
const { readCommitMessageReply } = require('./walkthrough-commit-message.cjs');
const { normalizePiModel } = require('./pi.cjs');
const {
  detectInitialAgentBackend,
  getAgent,
  getAgentMenuModels,
  listAgents,
  normalizeAgentBackend,
} = require('./agent.cjs');
const { buildInstallSkillMenuItem, listAgentSkills } = require('./agent-skills.cjs');
const {
  configToPreferences,
  createDefaultConfig,
  getConfigPath,
  initConfig,
  migrateFromPreferences,
  normalizeCodeFontFamily,
  normalizeCodeFontSize,
  readConfig,
  watchConfig,
  writeConfig,
} = require('./config.cjs');
const { readReviewAssistantReply } = require('./review-assist.cjs');
const {
  findMatchingWindowIdentity,
  getWindowIdentity,
  getWindowIdentityForSource,
} = require('./window-identity.cjs');
const { createPendingCommentsClipboardController } = require('./pending-comments.cjs');
const {
  getCommandLineLaunchOptions,
  getCommandLineRepositoryPath,
  getInitialRepositoryPath,
  getLaunchOptions,
  getLaunchPath,
} = require('./main/command-line.cjs');
const { createSkillInstaller } = require('./main/agent-skill.cjs');
const { createEditorOpener } = require('./main/editor.cjs');
const { createTerminalHelper } = require('./main/terminal-helper.cjs');
const {
  readWindowState,
  validateWindowStateOnScreen,
  writeWindowState,
} = require('./window-state.cjs');
const {
  normalizeNarrativeWalkthrough,
  readNarrativeWalkthrough,
} = require('./narrative-walkthrough.cjs');
const { uploadSharedSnapshot } = require('./shared-walkthrough-upload.cjs');
const {
  resolvePlanShareTarget,
  resolveWalkthroughShareTarget,
} = require('./walkthrough-sharing.cjs');
const { createCloudflareAccessClient } = require('./cloudflare-access.cjs');
const { mergeWalkthroughContexts } = require('./walkthrough-context.cjs');
const {
  MarkdownDocumentConflictError,
  readMarkdownDocument,
  resolveMarkdownPath,
  watchMarkdownDocument,
  writeMarkdownDocument,
} = require('./markdown-document.cjs');
const {
  normalizeRepositoryWatcherPath,
  repositoryWatcherSnapshotsMatchExpectedWrites,
} = require('./repository-watcher.cjs');
const { getPlanReviewPath, readPlanReview, writePlanReview } = require('./plan-review.cjs');
const { createSharedPlanSnapshot } = require('./shared-plan.cjs');
const { readLocalIdentity } = require('./local-identity.cjs');

/**
 * @typedef {import('../core/config/types.ts').CodiffConfig} CodiffConfig
 * @typedef {import('../core/types.ts').CodiffLaunchOptions} CodiffLaunchOptions
 * @typedef {import('../core/types.ts').CodiffTheme} CodiffTheme
 * @typedef {import('../core/types.ts').ReviewSource} ReviewSource
 * @typedef {{key: string; repositoryRoot: string; sourceKey: string}} WindowIdentity
 * @typedef {{direction: string; name: string; owner: string; repo: string}} GitHubRemote
 * @typedef {{repositoryPath?: string; launchOptions?: CodiffLaunchOptions}} SingleInstanceAdditionalData
 * @typedef {{head: string; pathSignatures: Record<string, string>; root: string; signature: string}} RepositoryWatcherSnapshot
 * @typedef {{completed: boolean; generation: number; version?: string}} RepositorySelfWrite
 * @typedef {{changed: boolean; checkTimer?: ReturnType<typeof setTimeout>; checking: boolean; interval?: ReturnType<typeof setInterval>; notify: (root: string) => void; pendingSelfWrites: Map<string, RepositorySelfWrite>; recheckRequested: boolean; repositoryPath: string; snapshot?: RepositoryWatcherSnapshot}} RepositoryWatcher
 * @typedef {{generation: number; path: string; webContentsId: number}} RepositorySelfWriteToken
 * @typedef {{args: Array<string>; command: string}} EditorCommand
 * @typedef {{launchOptions: CodiffLaunchOptions; pullRequestNumber: number | null; repositoryPath: string | null}} ParsedCommandLineArguments
 */

const root = dirname(__dirname);
/** @type {Map<number, RepositoryWatcher>} */
const repositoryWatchers = new Map();
/** @type {Map<number, WindowIdentity | null>} */
const windowIdentities = new Map();
/** @type {Map<number, string>} */
const windowRepositories = new Map();
/** @type {Map<number, CodiffLaunchOptions>} */
const windowLaunchOptions = new Map();
/** @type {Map<number, Promise<RepositoryState>>} */
const windowInitialRepositoryStates = new Map();
/** @type {Map<number, string>} */
const planInitialVersions = new Map();
/** @type {Set<number>} */
const readyPlanWindows = new Set();
/** @type {Map<number, Map<string, () => void>>} */
const markdownDocumentWatchers = new Map();
/** @type {Set<number>} */
const completedPlanWindows = new Set();
/** @type {Set<import('electron').BrowserWindow>} */
const openWindows = new Set();
const pendingCommentsClipboardController = createPendingCommentsClipboardController({ clipboard });
/** @type {CodiffConfig} */
let config = createDefaultConfig();

/**
 * @type {Map<string, ReturnType<typeof createSkillInstaller>>}
 */
const skillInstallers = new Map(
  listAgentSkills().map((skill) => [
    skill.id,
    createSkillInstaller({
      app,
      dialog,
      renderManagedFile:
        skill.id === 'opencode'
          ? (_file, template) => renderOpenCodeCommand(template, config.settings.opencodeModel)
          : undefined,
      root,
      skill,
    }),
  ]),
);

const refreshInstalledAgentFiles = () => {
  for (const installer of skillInstallers.values()) {
    try {
      installer.refreshManagedFiles();
    } catch {
      // A stale or read-only managed file should not prevent Codiff from starting.
    }
  }
};

const getActiveAgent = () => getAgent(config.settings.agentBackend);

/** @param {string} repositoryPath @param {ReviewSource} [source] */
const readRepositoryStateWithConfig = (repositoryPath, source) =>
  readRepositoryState(repositoryPath, source, {
    showWhitespace: config.settings.showWhitespace,
  });

/** @param {string} repositoryPath @param {CodiffLaunchOptions} launchOptions */
const readInitialRepositoryStateWithConfig = (repositoryPath, launchOptions) =>
  launchOptions.walkthrough && !launchOptions.walkthroughFile
    ? readWalkthroughRepositoryState(repositoryPath, launchOptions.source, {
        showWhitespace: config.settings.showWhitespace,
      })
    : readRepositoryStateWithConfig(repositoryPath, launchOptions.source);

/** @param {number} webContentsId */
const resolveWindowAgent = (webContentsId) => {
  const override = windowLaunchOptions.get(webContentsId)?.agentBackend;
  return getAgent(
    override === 'codex' || override === 'claude' || override === 'opencode' || override === 'pi'
      ? override
      : config.settings.agentBackend,
  );
};

/** @param {'codex' | 'claude' | 'opencode' | 'pi'} agentId */
const skillInstallerFor = (agentId) => skillInstallers.get(agentId);
const { getTerminalHelperStatus, installTerminalHelper } = createTerminalHelper({
  app,
  dialog,
  root,
});
const { openFileInEditor } = createEditorOpener({
  getEditorCommand: () => config.settings.editorCommand,
  shell,
});

const openConfigFile = async () => {
  initConfig();
  await openFileInEditor(getConfigPath());
};

/** @param {number} webContentsId */
const getMarkdownDocumentContext = (webContentsId) => ({
  planFile: windowLaunchOptions.get(webContentsId)?.planFile,
  repositoryRoot: windowRepositories.get(webContentsId) || getLaunchPath(),
});

/** @param {number} webContentsId */
const clearMarkdownDocumentWatchers = (webContentsId) => {
  const watchers = markdownDocumentWatchers.get(webContentsId);
  if (!watchers) {
    return;
  }
  for (const close of watchers.values()) {
    close();
  }
  markdownDocumentWatchers.delete(webContentsId);
};

/**
 * @param {import('electron').WebContents} webContents
 * @param {{kind: 'plan' | 'repository'; path: string}} request
 */
const ensureMarkdownDocumentWatcher = (webContents, request) => {
  const webContentsId = webContents.id;
  const resolved = resolveMarkdownPath(request, getMarkdownDocumentContext(webContentsId));
  const watchers = markdownDocumentWatchers.get(webContentsId) ?? new Map();
  if (watchers.has(resolved.id)) {
    return;
  }

  watchers.set(
    resolved.id,
    watchMarkdownDocument({
      onChange: (document) => {
        if (!webContents.isDestroyed()) {
          webContents.send('codiff:markdownDocumentChanged', {
            deleted: false,
            document,
            id: document.id,
          });
        }
      },
      onDelete: (id) => {
        if (!webContents.isDestroyed()) {
          webContents.send('codiff:markdownDocumentChanged', { deleted: true, id });
        }
      },
      resolved,
    }),
  );
  markdownDocumentWatchers.set(webContentsId, watchers);
};

/**
 * @param {number} webContentsId
 * @param {'canceled' | 'closed' | 'done' | 'open'} status
 * @param {import('../core/types.ts').PlanReview} [review]
 */
const writePlanResult = (webContentsId, status, review) => {
  const launchOptions = windowLaunchOptions.get(webContentsId);
  if (!launchOptions?.planFile || !launchOptions.planResultFile) {
    return;
  }
  if (status === 'done' || status === 'closed') {
    completedPlanWindows.add(webContentsId);
  } else if (completedPlanWindows.has(webContentsId)) {
    return;
  }

  try {
    writeFileSync(
      launchOptions.planResultFile,
      `${JSON.stringify({
        path: launchOptions.planFile,
        pid: process.pid,
        ...(review
          ? { reviewPath: getPlanReviewPath(app.getPath('userData'), launchOptions.planFile) }
          : {}),
        ...(review ? { review } : {}),
        ...(review && planInitialVersions.has(webContentsId)
          ? {
              documentChanged: review.document.version !== planInitialVersions.get(webContentsId),
            }
          : {}),
        status,
      })}\n`,
      'utf8',
    );
  } catch {
    // The waiting process may have been interrupted and removed its temporary result directory.
  }
};

const sendConfigChanged = () => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('codiff:configChanged', config);
    }
  }
};

/** @param {Partial<CodiffConfig>} nextConfig */
const updateConfig = (nextConfig) => {
  config = {
    keymap: { ...config.keymap, ...nextConfig.keymap },
    settings: {
      ...config.settings,
      ...nextConfig.settings,
      agentBackend: normalizeAgentBackend(
        nextConfig.settings?.agentBackend ?? config.settings.agentBackend,
      ),
      claudeModel: normalizeClaudeModel(
        nextConfig.settings?.claudeModel ?? config.settings.claudeModel,
      ),
      codeFontFamily: normalizeCodeFontFamily(
        nextConfig.settings?.codeFontFamily ?? config.settings.codeFontFamily,
      ),
      codeFontSize: normalizeCodeFontSize(
        nextConfig.settings?.codeFontSize ?? config.settings.codeFontSize,
      ),
      openAIModel: normalizeOpenAIModel(
        nextConfig.settings?.openAIModel ?? config.settings.openAIModel,
      ),
      opencodeModel: normalizeOpenCodeModel(
        nextConfig.settings?.opencodeModel ?? config.settings.opencodeModel,
      ),
      piModel: normalizePiModel(nextConfig.settings?.piModel ?? config.settings.piModel),
    },
  };
  nativeTheme.themeSource = config.settings.theme;
  writeConfig(config);
  refreshInstalledAgentFiles();
  sendConfigChanged();
  Menu.setApplicationMenu(buildApplicationMenu());
};

/** @param {'codex' | 'claude' | 'opencode' | 'pi'} backend */
const selectAgentBackend = (backend) => {
  const agentBackend = normalizeAgentBackend(backend);
  if (config.settings.agentBackend === agentBackend) {
    return;
  }

  updateConfig({ settings: { ...config.settings, agentBackend } });
};

/** @param {import('./agent.cjs').Agent} agent @param {string} model */
const selectAgentModel = (agent, model) => {
  const normalized = agent.normalizeModel(model);
  if (config.settings[agent.modelSettingKey] === normalized) {
    return;
  }

  updateConfig({ settings: { ...config.settings, [agent.modelSettingKey]: normalized } });
};

/** @param {import('./agent.cjs').Agent} agent */
const getAgentOptions = (agent) => ({
  fallbackModel: agent.fallbackModel,
  model: config.settings[agent.modelSettingKey],
  /** @param {string} fallbackModel */
  onModelFallback: async (fallbackModel) => {
    updateConfig({ settings: { ...config.settings, [agent.modelSettingKey]: fallbackModel } });
  },
});

/** @param {CodiffTheme} theme */
const updateTheme = (theme) => {
  updateConfig({ settings: { ...config.settings, theme } });
};

/** @param {number} size */
const setCodeFontSize = (size) => {
  const codeFontSize = normalizeCodeFontSize(size);
  if (config.settings.codeFontSize === codeFontSize) {
    return;
  }

  updateConfig({ settings: { ...config.settings, codeFontSize } });
};

const increaseCodeFontSize = () => {
  setCodeFontSize(config.settings.codeFontSize + 1);
};

const decreaseCodeFontSize = () => {
  setCodeFontSize(config.settings.codeFontSize - 1);
};

const resetCodeFontSize = () => {
  setCodeFontSize(13);
};

/** @param {string} repositoryPath */
const rememberLastRepositoryPath = (repositoryPath) => {
  if (config.settings.lastRepositoryPath === repositoryPath) {
    return;
  }

  config = {
    ...config,
    settings: {
      ...config.settings,
      lastRepositoryPath: repositoryPath,
    },
  };
  writeConfig(config);
};

/** @param {string} repositoryPath @param {Iterable<string>} [additionalPaths] */
const readRepositoryWatcherSnapshot = async (repositoryPath, additionalPaths = []) => {
  try {
    return await readRepositoryChangeSignature(repositoryPath, additionalPaths);
  } catch (error) {
    return {
      head: `error:${error instanceof Error ? error.message : String(error)}`,
      pathSignatures: {},
      root: repositoryPath,
      signature: `error:${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/** @param {number} webContentsId @param {string} repositoryPath */
const resetRepositoryWatcher = async (webContentsId, repositoryPath) => {
  const watcher = repositoryWatchers.get(webContentsId);
  if (!watcher) {
    return;
  }

  const snapshot = await readRepositoryWatcherSnapshot(repositoryPath);
  watcher.changed = false;
  watcher.pendingSelfWrites.clear();
  watcher.snapshot = snapshot;
};

/** @param {number} webContentsId */
const scheduleRepositoryWatcherCheck = (webContentsId) => {
  const watcher = repositoryWatchers.get(webContentsId);
  if (!watcher) {
    return;
  }

  if (watcher.checkTimer) {
    clearTimeout(watcher.checkTimer);
  }
  watcher.checkTimer = setTimeout(() => {
    const currentWatcher = repositoryWatchers.get(webContentsId);
    if (!currentWatcher) {
      return;
    }
    currentWatcher.checkTimer = undefined;
    void checkRepositoryWatcher(webContentsId);
  }, 250);
};

/** @param {number} webContentsId @param {boolean} [reset] */
const checkRepositoryWatcher = async (webContentsId, reset = false) => {
  const watcher = repositoryWatchers.get(webContentsId);
  if (!watcher) {
    return;
  }
  if (watcher.checkTimer) {
    clearTimeout(watcher.checkTimer);
    watcher.checkTimer = undefined;
  }
  if (watcher.checking) {
    watcher.recheckRequested = true;
    return;
  }

  watcher.checking = true;
  const pendingSelfWrites = new Map(watcher.pendingSelfWrites);
  const snapshotPaths = new Set([
    ...Object.keys(watcher.snapshot?.pathSignatures ?? {}),
    ...pendingSelfWrites.keys(),
  ]);
  try {
    const snapshot = await readRepositoryWatcherSnapshot(watcher.repositoryPath, snapshotPaths);
    if (reset || watcher.snapshot == null) {
      watcher.changed = false;
      watcher.pendingSelfWrites.clear();
      watcher.snapshot = snapshot;
      return;
    }

    if (watcher.changed) {
      return;
    }

    const pendingWritesChanged =
      watcher.pendingSelfWrites.size !== pendingSelfWrites.size ||
      [...pendingSelfWrites].some(
        ([path, pendingWrite]) =>
          watcher.pendingSelfWrites.get(path)?.generation !== pendingWrite.generation,
      );
    if (pendingWritesChanged) {
      watcher.recheckRequested = true;
      return;
    }
    if ([...pendingSelfWrites.values()].some(({ completed }) => !completed)) {
      return;
    }

    const expectedPathVersions = new Map(
      [...pendingSelfWrites]
        .filter((entry) => entry[1].version)
        .map(([path, pendingWrite]) => [path, /** @type {string} */ (pendingWrite.version)]),
    );
    if (
      repositoryWatcherSnapshotsMatchExpectedWrites(
        watcher.snapshot,
        snapshot,
        expectedPathVersions,
      )
    ) {
      watcher.snapshot = snapshot;
      for (const [path, pendingWrite] of pendingSelfWrites) {
        const currentWrite = watcher.pendingSelfWrites.get(path);
        if (pendingWrite.completed && currentWrite?.generation === pendingWrite.generation) {
          watcher.pendingSelfWrites.delete(path);
        }
      }
      return;
    }

    watcher.changed = true;
    watcher.notify(snapshot.root);
  } finally {
    watcher.checking = false;
    const hasCompletedSelfWrites = [...watcher.pendingSelfWrites.values()].some(
      ({ completed }) => completed,
    );
    if (watcher.recheckRequested || (!watcher.changed && hasCompletedSelfWrites)) {
      watcher.recheckRequested = false;
      scheduleRepositoryWatcherCheck(webContentsId);
    }
  }
};

/**
 * @param {number} webContentsId
 * @param {string} path
 * @returns {RepositorySelfWriteToken | null}
 */
const beginRepositorySelfWrite = (webContentsId, path) => {
  const watcher = repositoryWatchers.get(webContentsId);
  if (!watcher || watcher.changed) {
    return null;
  }

  const normalizedPath = normalizeRepositoryWatcherPath(path);
  const generation = (watcher.pendingSelfWrites.get(normalizedPath)?.generation ?? 0) + 1;
  watcher.pendingSelfWrites.set(normalizedPath, {
    completed: false,
    generation,
  });
  if (watcher.checking) {
    watcher.recheckRequested = true;
  }
  return { generation, path: normalizedPath, webContentsId };
};

/** @param {RepositorySelfWriteToken | null} token @param {string | null} version */
const finishRepositorySelfWrite = (token, version) => {
  if (!token) {
    return;
  }

  const watcher = repositoryWatchers.get(token.webContentsId);
  const pendingWrite = watcher?.pendingSelfWrites.get(token.path);
  if (!watcher || pendingWrite?.generation !== token.generation) {
    return;
  }

  if (version) {
    pendingWrite.completed = true;
    pendingWrite.version = version;
  } else {
    watcher.pendingSelfWrites.delete(token.path);
  }
  scheduleRepositoryWatcherCheck(token.webContentsId);
};

/** @param {import('electron').BrowserWindow} browserWindow @param {string} repositoryPath */
const startRepositoryWatcher = (browserWindow, repositoryPath) => {
  const webContentsId = browserWindow.webContents.id;
  /** @type {RepositoryWatcher} */
  const watcher = {
    changed: false,
    checkTimer: undefined,
    checking: false,
    interval: undefined,
    notify: (root) => {
      if (!browserWindow.isDestroyed()) {
        browserWindow.webContents.send('codiff:repositoryChanged', { root });
      }
    },
    pendingSelfWrites: new Map(),
    recheckRequested: false,
    repositoryPath,
    snapshot: undefined,
  };
  repositoryWatchers.set(webContentsId, watcher);

  void checkRepositoryWatcher(webContentsId, true);
  watcher.interval = setInterval(() => void checkRepositoryWatcher(webContentsId), 2500);
};

/** @param {import('electron').BaseWindow | undefined} browserWindow */
const openRepositoryFolder = async (browserWindow) => {
  const options = {
    properties: /** @type {Array<'openDirectory'>} */ (['openDirectory']),
  };
  const result = browserWindow
    ? await dialog.showOpenDialog(browserWindow, options)
    : await dialog.showOpenDialog(options);

  if (!result.canceled && result.filePaths[0]) {
    focusOrCreateWindow(result.filePaths[0], { repositoryPathProvided: true, walkthrough: false });
  }
};

/** @returns {Array<import('electron').MenuItemConstructorOptions>} */
const buildAgentSubmenu = () =>
  listAgents().map((agent) => ({
    checked: config.settings.agentBackend === agent.id,
    click: () => selectAgentBackend(agent.id),
    label: agent.label,
    type: 'radio',
  }));

/** @returns {Array<import('electron').MenuItemConstructorOptions>} */
const buildModelSubmenu = () => {
  const agent = getActiveAgent();
  const selectedModel = config.settings[agent.modelSettingKey];
  return getAgentMenuModels(agent, selectedModel).map((model) => ({
    checked: selectedModel === model.id,
    click: () => selectAgentModel(agent, model.id),
    label: model.label,
    type: 'radio',
  }));
};

const getInstallSkillMenuItem = () =>
  buildInstallSkillMenuItem(
    (skill, browserWindow) => void skillInstallers.get(skill.id)?.install(browserWindow),
  );

/** @returns {import('electron').Menu} */
const buildApplicationMenu = () =>
  Menu.buildFromTemplate(
    /** @type {Array<import('electron').MenuItemConstructorOptions>} */ ([
      ...(process.platform === 'darwin'
        ? [
            {
              label: 'Codiff',
              submenu: [
                { role: 'about' },
                { type: 'separator' },
                {
                  label: 'Agent',
                  submenu: buildAgentSubmenu(),
                },
                {
                  label: 'Model',
                  submenu: buildModelSubmenu(),
                },
                { type: 'separator' },
                {
                  click: () => {
                    void openConfigFile();
                  },
                  label: 'Open Config File...',
                },
                { type: 'separator' },
                {
                  click:
                    /** @type {NonNullable<import('electron').MenuItemConstructorOptions['click']>} */ (
                      (_menuItem, browserWindow) => installTerminalHelper(browserWindow)
                    ),
                  label: 'Install Terminal Helper',
                },
                getInstallSkillMenuItem(),
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            },
          ]
        : []),
      {
        label: 'File',
        submenu: [
          ...(process.platform === 'darwin'
            ? []
            : [
                {
                  label: 'Agent',
                  submenu: buildAgentSubmenu(),
                },
                {
                  label: 'Model',
                  submenu: buildModelSubmenu(),
                },
                { type: 'separator' },
                {
                  click: () => {
                    void openConfigFile();
                  },
                  label: 'Open Config File...',
                },
                { type: 'separator' },
                {
                  click:
                    /** @type {NonNullable<import('electron').MenuItemConstructorOptions['click']>} */ (
                      (_menuItem, browserWindow) => installTerminalHelper(browserWindow)
                    ),
                  label: 'Install Terminal Helper',
                },
                getInstallSkillMenuItem(),
                { type: 'separator' },
              ]),
          {
            accelerator: 'CommandOrControl+O',
            click: (_menuItem, browserWindow) => openRepositoryFolder(browserWindow),
            label: 'Open Folder...',
          },
          { type: 'separator' },
          process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          {
            accelerator: 'CommandOrControl+F',
            click: (_menuItem, browserWindow) => {
              if (browserWindow instanceof BrowserWindow) {
                browserWindow.webContents.send('codiff:findInDiffs');
              }
            },
            label: 'Find in Diffs',
          },
        ],
      },
      {
        label: 'View',
        submenu: [
          {
            label: 'Diff',
            submenu: [
              {
                checked: config.settings.diffStyle === 'split',
                click: () => {
                  updateConfig({
                    settings: { ...config.settings, diffStyle: 'split' },
                  });
                },
                label: 'Split',
                type: 'radio',
              },
              {
                checked: config.settings.diffStyle === 'unified',
                click: () => {
                  updateConfig({
                    settings: { ...config.settings, diffStyle: 'unified' },
                  });
                },
                label: 'Unified',
                type: 'radio',
              },
              { type: 'separator' },
              {
                checked: config.settings.wordWrap,
                click: (menuItem) => {
                  updateConfig({
                    settings: { ...config.settings, wordWrap: menuItem.checked },
                  });
                },
                label: 'Word Wrap',
                type: 'checkbox',
              },
              {
                checked: config.settings.showWhitespace,
                click: (menuItem) => {
                  updateConfig({
                    settings: { ...config.settings, showWhitespace: menuItem.checked },
                  });
                },
                label: 'Show Whitespace',
                type: 'checkbox',
              },
              { type: 'separator' },
              {
                label: 'Font Size',
                submenu: [
                  {
                    accelerator: process.platform === 'darwin' ? 'Command+Plus' : 'Control+Plus',
                    click: increaseCodeFontSize,
                    label: 'Increase',
                  },
                  {
                    accelerator: 'CommandOrControl+-',
                    click: decreaseCodeFontSize,
                    label: 'Decrease',
                  },
                  {
                    accelerator: 'CommandOrControl+0',
                    click: resetCodeFontSize,
                    label: 'Reset',
                  },
                ],
              },
            ],
          },
          {
            label: 'Comments',
            submenu: [
              {
                checked: config.settings.showOutdated,
                click: (menuItem) => {
                  updateConfig({
                    settings: { ...config.settings, showOutdated: menuItem.checked },
                  });
                },
                label: 'Show Outdated Comments',
                type: 'checkbox',
              },
              {
                checked: config.settings.copyCommentsOnClose,
                click: (menuItem) => {
                  updateConfig({
                    settings: { ...config.settings, copyCommentsOnClose: menuItem.checked },
                  });
                },
                label: 'Copy Comments on Close',
                type: 'checkbox',
              },
            ],
          },
          {
            label: 'Theme',
            submenu: [
              {
                checked: config.settings.theme === 'system',
                click: () => updateTheme('system'),
                label: 'Match System',
                type: 'radio',
              },
              {
                checked: config.settings.theme === 'light',
                click: () => updateTheme('light'),
                label: 'Light',
                type: 'radio',
              },
              {
                checked: config.settings.theme === 'dark',
                click: () => updateTheme('dark'),
                label: 'Dark',
                type: 'radio',
              },
            ],
          },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          {
            // In-place refresh handled by the renderer; the window itself is
            // only reloaded via Force Reload below.
            accelerator: 'CommandOrControl+R',
            click: (_menuItem, browserWindow) => {
              if (browserWindow instanceof BrowserWindow) {
                browserWindow.webContents.send('codiff:refreshRequest');
              }
            },
            label: 'Refresh Changes',
          },
          { role: 'forceReload' },
          {
            accelerator: 'CommandOrControl+Alt+J',
            click: (_menuItem, browserWindow) => {
              if (browserWindow instanceof BrowserWindow) {
                browserWindow.webContents.toggleDevTools();
              }
            },
            label: 'Toggle Developer Tools',
          },
        ],
      },
    ]),
  );

let copyingPendingCommentsBeforeQuit = false;
let quitting = false;
let quitAfterCopyingPendingComments = false;

ipcMain.on(
  'codiff:copyPendingCommentsResult',
  pendingCommentsClipboardController.handleCopyPendingCommentsResult,
);

/**
 * @param {string} repositoryPath
 * @param {CodiffLaunchOptions} [launchOptions]
 * @param {WindowIdentity | null} [identity]
 */
const createWindow = (
  repositoryPath,
  launchOptions = { repositoryPathProvided: true, walkthrough: false },
  identity = getWindowIdentity(repositoryPath, launchOptions),
) => {
  const savedState = readWindowState();
  const validatedState = savedState
    ? validateWindowStateOnScreen(savedState, screen.getAllDisplays())
    : null;

  const display = screen.getPrimaryDisplay();
  const { height, width } = display.workAreaSize;
  const useMacVibrancy = process.platform === 'darwin';
  const window = new BrowserWindow({
    autoHideMenuBar: process.platform !== 'linux',
    backgroundColor: useMacVibrancy
      ? '#00000000'
      : nativeTheme.shouldUseDarkColors
        ? '#141414'
        : '#ffffff',
    height: validatedState?.height ?? Math.max(720, Math.floor(height * 0.86)),
    minHeight: 520,
    minWidth: 880,
    show: false,
    title: launchOptions.planFile
      ? `Codiff Plan - ${basename(launchOptions.planFile)}`
      : `Codiff - ${repositoryPath}`,
    titleBarStyle: useMacVibrancy ? 'hiddenInset' : 'default',
    ...(useMacVibrancy
      ? {
          trafficLightPosition: { x: 12, y: 12 },
          transparent: true,
          vibrancy: 'under-window',
          visualEffectState: 'followWindow',
        }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs'),
    },
    width: validatedState?.width ?? Math.max(1120, Math.floor(width * 0.86)),
    ...(validatedState ? { x: validatedState.x, y: validatedState.y } : { center: true }),
  });

  if (validatedState?.isMaximized) {
    window.maximize();
  }
  if (validatedState?.isFullScreen) {
    window.setFullScreen(true);
  }

  const webContentsId = window.webContents.id;
  openWindows.add(window);
  if (identity) {
    windowIdentities.set(webContentsId, identity);
  }
  windowRepositories.set(webContentsId, repositoryPath);
  windowLaunchOptions.set(webContentsId, launchOptions);
  const initialRepositoryState = launchOptions.planFile
    ? null
    : readInitialRepositoryStateWithConfig(repositoryPath, launchOptions);
  initialRepositoryState?.catch(() => {});
  if (initialRepositoryState) {
    windowInitialRepositoryStates.set(webContentsId, initialRepositoryState);
  }
  if (!launchOptions.planFile && !launchOptions.source) {
    void initialRepositoryState
      .then((state) => {
        if (state.source.type === 'working-tree' && !window.isDestroyed()) {
          startRepositoryWatcher(window, repositoryPath);
        }
      })
      .catch(() => {});
  }
  window.on('enter-full-screen', () => {
    window.webContents.send('codiff:windowFullScreenChanged', true);
  });
  window.on('leave-full-screen', () => {
    window.webContents.send('codiff:windowFullScreenChanged', false);
  });
  window.once('ready-to-show', () => window.show());
  let allowClose = false;
  let copyingPendingCommentsBeforeClose = false;
  window.on('close', (event) => {
    try {
      const normalBounds = window.getNormalBounds();
      writeWindowState({
        height: normalBounds.height,
        isFullScreen: window.isFullScreen(),
        isMaximized: window.isMaximized(),
        width: normalBounds.width,
        x: normalBounds.x,
        y: normalBounds.y,
      });
    } catch {}

    if (launchOptions.planFile) {
      if (completedPlanWindows.has(webContentsId)) {
        return;
      }
      if (!readyPlanWindows.has(webContentsId)) {
        writePlanResult(webContentsId, 'canceled');
        return;
      }
      event.preventDefault();
      if (!window.webContents.isDestroyed()) {
        window.webContents.send('codiff:planCloseRequested');
      }
      return;
    }

    if (allowClose || quitting || !config.settings.copyCommentsOnClose) {
      return;
    }

    event.preventDefault();
    if (copyingPendingCommentsBeforeClose) {
      return;
    }

    copyingPendingCommentsBeforeClose = true;
    pendingCommentsClipboardController.copyPendingCommentsToClipboard([window]).finally(() => {
      allowClose = true;
      if (!window.isDestroyed()) {
        window.close();
      }
    });
  });
  window.on('closed', () => {
    openWindows.delete(window);
    const watcher = repositoryWatchers.get(webContentsId);
    if (watcher?.checkTimer) {
      clearTimeout(watcher.checkTimer);
    }
    if (watcher?.interval) {
      clearInterval(watcher.interval);
    }
    repositoryWatchers.delete(webContentsId);
    clearMarkdownDocumentWatchers(webContentsId);
    completedPlanWindows.delete(webContentsId);
    planInitialVersions.delete(webContentsId);
    readyPlanWindows.delete(webContentsId);
    windowIdentities.delete(webContentsId);
    windowInitialRepositoryStates.delete(webContentsId);
    windowRepositories.delete(webContentsId);
    windowLaunchOptions.delete(webContentsId);
  });
  window.webContents.on('render-process-gone', () => {
    writePlanResult(webContentsId, 'canceled');
  });
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, _errorDescription, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        writePlanResult(webContentsId, 'canceled');
      }
    },
  );
  window.webContents.on('did-finish-load', () => {
    const currentLaunchOptions = windowLaunchOptions.get(webContentsId);
    if (!currentLaunchOptions?.planFile) {
      return;
    }
    void readMarkdownDocument(
      { kind: 'plan', path: currentLaunchOptions.planFile },
      getMarkdownDocumentContext(webContentsId),
    ).then(
      (document) => {
        if (!planInitialVersions.has(webContentsId)) {
          planInitialVersions.set(webContentsId, document.version);
        }
      },
      () => {
        writePlanResult(webContentsId, 'canceled');
      },
    );
  });

  const rendererURL = process.env.ELECTRON_RENDERER_URL;
  if (rendererURL) {
    window.loadURL(rendererURL);
  } else {
    window.loadURL(pathToFileURL(join(root, 'dist/index.html')).toString());
  }
};

/** @param {import('electron').BrowserWindow} window */
const focusWindow = (window) => {
  if (window.isMinimized()) {
    window.restore();
  }

  if (!window.isVisible()) {
    window.show();
  }

  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  }
  window.focus();
};

/** @param {number} webContentsId */
const getWalkthroughShareContext = async (webContentsId) => {
  const repositoryPath = windowRepositories.get(webContentsId) || getLaunchPath();
  const uploader = await readGitIdentity(repositoryPath);
  let username = '';
  try {
    username = userInfo().username;
  } catch {}

  return {
    target: resolveWalkthroughShareTarget({
      email: uploader.email,
      overrideUrl: process.env.CODIFF_SHARE_SERVER_URL,
      username,
    }),
    uploader,
  };
};

const getPlanShareContext = () => {
  const uploader = readLocalIdentity();
  return {
    target: resolvePlanShareTarget({
      overrideUrl: process.env.CODIFF_SHARE_SERVER_URL,
    }),
    uploader,
  };
};

/**
 * @param {Promise<{target: {authenticated: boolean; internal: boolean; serviceUrl: string} | null; uploader: {email?: string; name?: string}}> | {target: {authenticated: boolean; internal: boolean; serviceUrl: string} | null; uploader: {email?: string; name?: string}}} context
 * @param {Record<string, unknown>} snapshot
 */
const shareSnapshot = async (context, snapshot) => {
  /** @type {ReturnType<typeof createCloudflareAccessClient> | null} */
  let accessClient = null;
  try {
    const { target, uploader } = await context;
    if (!target) {
      return {
        reason: 'Sharing is not available for this user.',
        status: /** @type {const} */ ('failed'),
      };
    }
    if (target.authenticated) {
      accessClient = createCloudflareAccessClient({
        serviceUrl: target.serviceUrl,
      });
    }
    const url = await uploadSharedSnapshot({
      authenticate: accessClient?.authenticate,
      fetchImpl: accessClient?.fetch,
      openExternal: (url) => shell.openExternal(url),
      serviceUrl: target.serviceUrl,
      snapshot: {
        ...snapshot,
        codiffVersion: app.getVersion(),
        exportedAt: new Date().toISOString(),
      },
      uploader: target.internal ? uploader : undefined,
    });
    clipboard.writeText(url);
    return { status: /** @type {const} */ ('uploaded'), url };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: /** @type {const} */ ('failed'),
    };
  } finally {
    accessClient?.clear();
  }
};

/**
 * @param {string} repositoryPath
 * @param {CodiffLaunchOptions} [launchOptions]
 */
const focusOrCreateWindow = (
  repositoryPath,
  launchOptions = { repositoryPathProvided: true, walkthrough: false },
) => {
  const identity = getWindowIdentity(repositoryPath, launchOptions);
  const matchingWebContentsId = findMatchingWindowIdentity(identity, windowIdentities);
  const matchingWindow =
    matchingWebContentsId == null
      ? null
      : BrowserWindow.getAllWindows().find(
          (window) => window.webContents.id === matchingWebContentsId,
        );

  if (matchingWindow) {
    if (launchOptions.planFile || launchOptions.walkthrough || launchOptions.walkthroughFile) {
      windowRepositories.set(matchingWebContentsId, repositoryPath);
      windowLaunchOptions.set(matchingWebContentsId, launchOptions);
      if (launchOptions.planFile) {
        planInitialVersions.delete(matchingWebContentsId);
        readyPlanWindows.delete(matchingWebContentsId);
        windowInitialRepositoryStates.delete(matchingWebContentsId);
      } else {
        windowInitialRepositoryStates.set(
          matchingWebContentsId,
          readInitialRepositoryStateWithConfig(repositoryPath, launchOptions),
        );
      }
      if (identity) {
        windowIdentities.set(matchingWebContentsId, identity);
      }
      matchingWindow.reload();
    }
    focusWindow(matchingWindow);
    return matchingWindow;
  }

  return createWindow(repositoryPath, launchOptions, identity);
};

const lock =
  !squirrelStartup &&
  app.requestSingleInstanceLock({
    launchOptions: getLaunchOptions(),
    repositoryPath: getLaunchPath(),
  });

if (squirrelStartup || !lock) {
  app.quit();
} else {
  app.setName('Codiff');

  app.on('second-instance', (event, commandLine, workingDirectory, additionalData) => {
    const data = /** @type {SingleInstanceAdditionalData} */ (additionalData || {});
    const launchOptions =
      data.launchOptions || getCommandLineLaunchOptions(commandLine, workingDirectory);
    const launchPath = resolve(
      data.repositoryPath || getCommandLineRepositoryPath(commandLine) || workingDirectory,
    );
    focusOrCreateWindow(
      getInitialRepositoryPath(launchPath, launchOptions, config.settings.lastRepositoryPath),
      launchOptions,
    );
  });

  app.on('ready', () => {
    migrateFromPreferences(app.getPath('userData'), normalizeOpenAIModel);
    const shouldDetectInitialAgent = !existsSync(getConfigPath());
    config = readConfig();
    config.settings.openAIModel = normalizeOpenAIModel(config.settings.openAIModel);
    config.settings.opencodeModel = normalizeOpenCodeModel(config.settings.opencodeModel);
    config.settings.claudeModel = normalizeClaudeModel(config.settings.claudeModel);
    config.settings.piModel = normalizePiModel(config.settings.piModel);
    config.settings.agentBackend = shouldDetectInitialAgent
      ? detectInitialAgentBackend()
      : normalizeAgentBackend(config.settings.agentBackend);
    if (shouldDetectInitialAgent) {
      writeConfig(config);
    }
    refreshInstalledAgentFiles();
    nativeTheme.themeSource = config.settings.theme;
    Menu.setApplicationMenu(buildApplicationMenu());

    const launchOptions = getLaunchOptions();
    focusOrCreateWindow(
      getInitialRepositoryPath(getLaunchPath(), launchOptions, config.settings.lastRepositoryPath),
      launchOptions,
    );

    watchConfig((nextConfig) => {
      config = {
        ...nextConfig,
        settings: {
          ...nextConfig.settings,
          agentBackend: normalizeAgentBackend(nextConfig.settings.agentBackend),
          claudeModel: normalizeClaudeModel(nextConfig.settings.claudeModel),
          codeFontFamily: normalizeCodeFontFamily(nextConfig.settings.codeFontFamily),
          codeFontSize: normalizeCodeFontSize(nextConfig.settings.codeFontSize),
          openAIModel: normalizeOpenAIModel(nextConfig.settings.openAIModel),
          opencodeModel: normalizeOpenCodeModel(nextConfig.settings.opencodeModel),
          piModel: normalizePiModel(nextConfig.settings.piModel),
        },
      };
      refreshInstalledAgentFiles();
      nativeTheme.themeSource = config.settings.theme;
      sendConfigChanged();
      Menu.setApplicationMenu(buildApplicationMenu());
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const launchOptions = getLaunchOptions();
      focusOrCreateWindow(
        getInitialRepositoryPath(
          getLaunchPath(),
          launchOptions,
          config.settings.lastRepositoryPath,
        ),
        launchOptions,
      );
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    const windows = BrowserWindow.getAllWindows().filter(
      (window) => !window.isDestroyed() && !window.webContents.isDestroyed(),
    );

    if (config.settings.copyCommentsOnClose && !quitAfterCopyingPendingComments && windows.length) {
      event.preventDefault();
      if (copyingPendingCommentsBeforeQuit) {
        return;
      }

      copyingPendingCommentsBeforeQuit = true;
      void pendingCommentsClipboardController
        .copyPendingCommentsToClipboard(windows)
        .finally(() => {
          quitAfterCopyingPendingComments = true;
          quitting = true;
          app.quit();
        });
      return;
    }

    quitting = true;
  });
}

ipcMain.handle('codiff:getRepositoryState', async (event, source) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  const initialState = !source ? windowInitialRepositoryStates.get(event.sender.id) : undefined;
  if (initialState) {
    windowInitialRepositoryStates.delete(event.sender.id);
  }
  const state = initialState
    ? await initialState
    : await readRepositoryStateWithConfig(repositoryPath, source || launchOptions?.source);
  windowRepositories.set(event.sender.id, state.root);
  if (launchOptions) {
    windowLaunchOptions.set(event.sender.id, {
      ...launchOptions,
      source: state.source,
    });
  }
  rememberLastRepositoryPath(state.root);
  const identity = getWindowIdentityForSource(state.root, state.source);
  if (identity) {
    windowIdentities.set(event.sender.id, identity);
  }
  void resetRepositoryWatcher(event.sender.id, repositoryPath);
  return state;
});

ipcMain.handle('codiff:getMarkdownDocument', async (event, request) => {
  const document = await readMarkdownDocument(request, getMarkdownDocumentContext(event.sender.id));
  if (request.kind === 'plan' && !planInitialVersions.has(event.sender.id)) {
    planInitialVersions.set(event.sender.id, document.version);
  }
  ensureMarkdownDocumentWatcher(event.sender, request);
  return document;
});

ipcMain.handle('codiff:saveMarkdownDocument', async (event, request) => {
  const context = getMarkdownDocumentContext(event.sender.id);
  let selfWrite = null;
  try {
    if (request.kind === 'repository') {
      selfWrite = beginRepositorySelfWrite(
        event.sender.id,
        resolveMarkdownPath(request, context).path,
      );
    }
    const document = await writeMarkdownDocument(request, context);
    finishRepositorySelfWrite(selfWrite, document.version);
    return { document, status: 'saved' };
  } catch (error) {
    finishRepositorySelfWrite(selfWrite, null);
    if (error instanceof MarkdownDocumentConflictError) {
      return { document: error.document, status: 'conflict' };
    }
    throw error;
  }
});

ipcMain.handle('codiff:getPlanReview', async (event) => {
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  if (!launchOptions?.planFile) {
    throw new Error('This window does not have a plan document.');
  }
  return readPlanReview(app.getPath('userData'), launchOptions.planFile);
});

ipcMain.handle('codiff:savePlanReview', async (event, review) => {
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  if (!launchOptions?.planFile) {
    throw new Error('This window does not have a plan document.');
  }
  return writePlanReview(app.getPath('userData'), launchOptions.planFile, review);
});

ipcMain.handle('codiff:completePlan', async (event, review, requestedStatus) => {
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  if (!launchOptions?.planFile) {
    throw new Error('This window does not have a plan document.');
  }
  const status = requestedStatus === 'closed' ? 'closed' : 'done';
  const savedReview = await writePlanReview(
    app.getPath('userData'),
    launchOptions.planFile,
    review,
  );
  writePlanResult(event.sender.id, status, savedReview);
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle('codiff:markPlanReady', async (event) => {
  readyPlanWindows.add(event.sender.id);
  writePlanResult(event.sender.id, 'open');
});

ipcMain.handle(
  'codiff:getLaunchOptions',
  (event) =>
    windowLaunchOptions.get(event.sender.id) || {
      repositoryPathProvided: false,
      walkthrough: false,
    },
);

ipcMain.handle('codiff:getAgentSkillStatus', (event) => {
  const installer = skillInstallerFor(resolveWindowAgent(event.sender.id).id);
  return installer ? installer.getStatus() : { installed: false, path: '' };
});

ipcMain.handle('codiff:installAgentSkill', async (event) => {
  const installer = skillInstallerFor(resolveWindowAgent(event.sender.id).id);
  if (!installer) {
    return { installed: false, path: '' };
  }

  await installer.install(BrowserWindow.fromWebContents(event.sender));
  return installer.getStatus();
});

ipcMain.handle('codiff:getTerminalHelperStatus', () => getTerminalHelperStatus());

ipcMain.handle('codiff:installTerminalHelper', async (event) => {
  await installTerminalHelper(BrowserWindow.fromWebContents(event.sender));
  return getTerminalHelperStatus();
});

ipcMain.handle('codiff:getNarrativeWalkthrough', async (event, source) => {
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  try {
    const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
    const state = await readRepositoryStateWithConfig(
      repositoryPath,
      source || launchOptions?.source,
    );
    const agent = resolveWindowAgent(event.sender.id);
    const walkthroughFile = launchOptions?.walkthroughFile;
    if (walkthroughFile) {
      let input;
      try {
        input = JSON.parse(readFileSync(walkthroughFile, 'utf8'));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          reason: `Could not read walkthrough file: ${detail}`,
          status: 'unavailable',
        };
      }

      try {
        const sessionContext = await Promise.resolve(
          agent.readSessionContext(launchOptions?.[agent.sessionLaunchOptionKey]),
        ).catch(() => null);
        return {
          status: 'ready',
          walkthrough: normalizeNarrativeWalkthrough(input, state.files, {
            agent: agent.id,
            branch: state.branch,
            context: sessionContext,
            generatedAt: state.generatedAt,
            root: state.root,
            source: state.source,
          }),
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // The usual cause of an unanchored working-tree walkthrough is that the
        // changes were committed (or reverted) after it was authored. Surface a
        // specific explanation when we can determine one.
        const diagnosis = await diagnoseWalkthroughMismatch({
          hasFiles: state.files.length > 0,
          input,
          repositoryRoot: state.root,
        }).catch(() => null);
        return {
          reason: diagnosis || `Walkthrough file could not be applied to this diff: ${detail}`,
          status: 'unavailable',
        };
      }
    }

    const walkthroughContext = mergeWalkthroughContexts(
      launchOptions?.walkthroughContext,
      await agent.readSessionContext(launchOptions?.[agent.sessionLaunchOptionKey]),
    );
    return readNarrativeWalkthrough(
      state,
      agent,
      getAgentOptions(agent),
      walkthroughContext,
      config.settings.walkthroughPrompt,
    );
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: 'unavailable',
    };
  }
});

ipcMain.handle('codiff:shareWalkthrough', async (event, snapshot) => {
  return shareSnapshot(getWalkthroughShareContext(event.sender.id), snapshot);
});

ipcMain.handle('codiff:sharePlan', async (event, review) => {
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  if (!launchOptions?.planFile) {
    return {
      reason: 'This window does not have a plan document.',
      status: 'failed',
    };
  }
  const document = await readMarkdownDocument(
    { kind: 'plan', path: launchOptions.planFile },
    getMarkdownDocumentContext(event.sender.id),
  );
  const agent = resolveWindowAgent(event.sender.id);
  const sessionId = launchOptions[agent.sessionLaunchOptionKey];
  return shareSnapshot(
    getPlanShareContext(),
    createSharedPlanSnapshot({
      agent: agent.id,
      codiffVersion: app.getVersion(),
      content: document.content,
      filePath: launchOptions.planFile,
      review,
      sessionId,
      theme: config.settings.theme,
    }),
  );
});

ipcMain.handle('codiff:getFeatureFlags', async (event) => {
  const sharing = Boolean((await getWalkthroughShareContext(event.sender.id)).target);
  return {
    planSharing: sharing,
    walkthroughSharing: windowLaunchOptions.get(event.sender.id)?.planFile ? false : sharing,
  };
});

ipcMain.handle('codiff:askReviewAssistant', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  const state = await readRepositoryStateWithConfig(
    repositoryPath,
    request?.source || launchOptions?.source,
  );
  const agent = resolveWindowAgent(event.sender.id);
  return readReviewAssistantReply(state, request, agent, getAgentOptions(agent));
});

ipcMain.handle('codiff:createWalkthroughCommit', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const result = await createWalkthroughCommit(repositoryPath, request);
  if (result.status === 'committed') {
    await resetRepositoryWatcher(event.sender.id, repositoryPath);
  }
  return result;
});

ipcMain.handle('codiff:updateWalkthroughCommitMessage', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  const state = await readRepositoryStateWithConfig(
    repositoryPath,
    request?.source || launchOptions?.source,
  );
  const agent = resolveWindowAgent(event.sender.id);
  return readCommitMessageReply(state, request, agent, getAgentOptions(agent));
});

ipcMain.handle('codiff:submitPullRequestComment', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return submitPullRequestComment(repositoryPath, request);
});

ipcMain.handle('codiff:submitPullRequestReview', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return submitPullRequestReview(repositoryPath, request);
});

ipcMain.handle('codiff:getDiffSectionContent', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return readDiffSectionContent(repositoryPath, {
    ...request,
    showWhitespace: request?.showWhitespace ?? config.settings.showWhitespace,
  });
});

ipcMain.handle('codiff:getDiffImageContent', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return readDiffImageContent(repositoryPath, request);
});

ipcMain.handle('codiff:getRepositoryHistory', async (event, limit, source) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return listRepositoryHistory(repositoryPath, limit, source);
});

ipcMain.handle('codiff:getGitIdentity', async (event) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return readGitIdentity(repositoryPath);
});

ipcMain.handle('codiff:getPreferences', () => configToPreferences(config));

ipcMain.handle('codiff:getConfig', () => config);

ipcMain.handle('codiff:isWindowFullScreen', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window?.isFullScreen() ?? false;
});

ipcMain.handle('codiff:setDiffStyle', (_event, value) => {
  updateConfig({
    settings: {
      ...config.settings,
      diffStyle: value === 'unified' ? 'unified' : 'split',
    },
  });
});

ipcMain.handle('codiff:setShowOutdated', (_event, value) => {
  updateConfig({ settings: { ...config.settings, showOutdated: Boolean(value) } });
});

ipcMain.handle('codiff:setWordWrap', (_event, value) => {
  updateConfig({ settings: { ...config.settings, wordWrap: Boolean(value) } });
});

ipcMain.handle('codiff:increaseCodeFontSize', () => {
  increaseCodeFontSize();
});

ipcMain.handle('codiff:decreaseCodeFontSize', () => {
  decreaseCodeFontSize();
});

ipcMain.handle('codiff:resetCodeFontSize', () => {
  resetCodeFontSize();
});

ipcMain.handle('codiff:openConfigFile', () => openConfigFile());

ipcMain.handle('codiff:openFile', async (event, filePath) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const state = await readRepositoryStateWithConfig(repositoryPath);
  const repositoryFilePath = validateRepositoryPath(filePath);
  const absolutePath = resolve(state.root, repositoryFilePath);

  if (existsSync(absolutePath)) {
    await openFileInEditor(absolutePath, { repoPath: state.root });
  } else {
    await shell.openPath(state.root);
  }
});

ipcMain.handle('codiff:showInFolder', async (event, filePath) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const state = await readRepositoryStateWithConfig(repositoryPath);
  const repositoryFilePath = validateRepositoryPath(filePath);
  const absolutePath = resolve(state.root, repositoryFilePath);

  if (existsSync(absolutePath)) {
    shell.showItemInFolder(absolutePath);
  } else {
    shell.openPath(state.root);
  }
});

ipcMain.handle('codiff:getRelativePath', async (event, filePath) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const state = await readRepositoryStateWithConfig(repositoryPath);
  return relative(state.root, filePath);
});
