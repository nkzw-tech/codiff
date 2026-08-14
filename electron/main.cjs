// @ts-check

const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { basename, dirname, join, relative, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  autoUpdater,
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
  readRepositoryState,
  readWalkthroughRepositoryState,
  submitPullRequestComment,
  submitPullRequestReview,
  validateRepositoryPath,
} = require('./git-state.cjs');
const { attachExternalLinkHandling } = require('./external-links.cjs');
const { normalizeOpenAIModel } = require('./codex.cjs');
const { normalizeClaudeModel } = require('./claude.cjs');
const { normalizeOpenCodeModel, renderOpenCodeCommand } = require('./opencode.cjs');
const { createWalkthroughCommit } = require('./walkthrough-commit.cjs');
const { readKeyboardLayout, watchKeyboardLayout } = require('./keyboard-layout.cjs');
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
const { releasePageUrl } = require('./update-check.cjs');
const { createUpdater, resolveUpdateStrategy } = require('./updater.cjs');
const { parseReviewUrl, resolveReviewUrl } = require('./review-source.cjs');
const {
  getPlanWindowTitle,
  getRepositoryWindowTitle,
  restoreRepositoryWindowTitleAfterLoad,
} = require('./window-title.cjs');
const {
  findMatchingWindowIdentity,
  getWindowIdentity,
  getWindowIdentityForRepositoryState,
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
const { createDefinitionSearchCoordinator } = require('./definition-search.cjs');
const { createTerminalHelper } = require('./main/terminal-helper.cjs');
const {
  readWindowState,
  validateWindowStateOnScreen,
  writeWindowState,
} = require('./window-state.cjs');
const {
  getNarrativeWalkthroughCacheKey,
  normalizeNarrativeWalkthrough,
  readNarrativeWalkthrough,
  resolveNarrativeWalkthroughModel,
} = require('./narrative-walkthrough.cjs');
const { readStoredWalkthrough, writeStoredWalkthrough } = require('./walkthrough-store.cjs');
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
  createRepositoryWatcherCoordinator,
  readRepositoryWatcherSnapshot,
} = require('./repository-watcher.cjs');
const { getPlanReviewPath, readPlanReview, writePlanReview } = require('./plan-review.cjs');
const { createSharedPlanSnapshot } = require('./shared-plan.cjs');
const { createWalkthroughProgressReporter } = require('./walkthrough-progress.cjs');

/**
 * @typedef {import('../core/config/types.ts').CodiffConfig} CodiffConfig
 * @typedef {import('../core/types.ts').CodiffLaunchOptions} CodiffLaunchOptions
 * @typedef {import('../core/types.ts').CodiffTheme} CodiffTheme
 * @typedef {import('../core/types.ts').ReviewSource} ReviewSource
 * @typedef {{key: string; repositoryRoot: string; sourceKey: string}} WindowIdentity
 * @typedef {{direction: string; name: string; owner: string; repo: string}} GitHubRemote
 * @typedef {{repositoryPath?: string; launchOptions?: CodiffLaunchOptions}} SingleInstanceAdditionalData
 * @typedef {{args: Array<string>; command: string}} EditorCommand
 * @typedef {{launchOptions: CodiffLaunchOptions; pullRequestNumber: number | null; repositoryPath: string | null}} ParsedCommandLineArguments
 */

const root = dirname(__dirname);
/** @type {Map<number, WindowIdentity | null>} */
const windowIdentities = new Map();
/** @type {Map<number, string>} */
const windowRepositories = new Map();
/** @type {Map<number, CodiffLaunchOptions>} */
const windowLaunchOptions = new Map();
/** @type {Map<number, Promise<RepositoryState>>} */
const windowInitialRepositoryStates = new Map();
/** @type {Map<number, number>} */
const walkthroughProgressGenerations = new Map();
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
const definitionSearchCoordinator = createDefinitionSearchCoordinator();

const openConfigFile = async () => {
  initConfig();
  await openFileInEditor(getConfigPath());
};

/** @param {number} webContentsId */
const getWindowRepositoryRoot = (webContentsId) =>
  windowIdentities.get(webContentsId)?.repositoryRoot ||
  windowRepositories.get(webContentsId) ||
  getLaunchPath();

/** @param {number} webContentsId */
const getMarkdownDocumentContext = (webContentsId) => ({
  planFile: windowLaunchOptions.get(webContentsId)?.planFile,
  repositoryRoot: getWindowRepositoryRoot(webContentsId),
});

/** @param {number} webContentsId @param {RepositoryState} state */
const storeResolvedRepositoryState = (webContentsId, state) => {
  windowRepositories.set(webContentsId, state.root);
  const browserWindow = BrowserWindow.getAllWindows().find(
    (window) => window.webContents.id === webContentsId,
  );
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.setTitle(getRepositoryWindowTitle(state));
  }
  const launchOptions = windowLaunchOptions.get(webContentsId);
  if (launchOptions) {
    windowLaunchOptions.set(webContentsId, {
      ...launchOptions,
      source: state.source,
    });
  }
  const identity = getWindowIdentityForRepositoryState(state);
  if (identity) {
    windowIdentities.set(webContentsId, identity);
  }
};

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

/**
 * @param {string} repositoryRoot
 * @param {Iterable<string>} [exactPaths]
 * @param {Iterable<string>} [knownDirtyPaths]
 */
const readSafeRepositoryWatcherSnapshot = async (
  repositoryRoot,
  exactPaths = [],
  knownDirtyPaths = [],
) => {
  try {
    return await readRepositoryWatcherSnapshot(repositoryRoot, exactPaths, knownDirtyPaths);
  } catch (error) {
    return {
      head: `error:${error instanceof Error ? error.message : String(error)}`,
      pathSignatures: {},
      pathVersions: {},
      root: repositoryRoot,
      signature: `error:${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

const repositoryWatcherCoordinator = createRepositoryWatcherCoordinator({
  readSnapshot: readSafeRepositoryWatcherSnapshot,
});

/** @param {number} webContentsId @param {string} repositoryPath */
const resetRepositoryWatcher = (webContentsId, repositoryPath) =>
  repositoryWatcherCoordinator.reset(webContentsId, repositoryPath);

/**
 * @param {number} webContentsId
 * @param {string} path
 */
const beginRepositorySelfWrite = (webContentsId, path) =>
  repositoryWatcherCoordinator.beginWrite(webContentsId, path);

/** @param {{generation: number; path: string; root: string} | null} token @param {string | null} version */
const finishRepositorySelfWrite = (token, version) =>
  repositoryWatcherCoordinator.finishWrite(token, version);

/** @param {import('electron').BrowserWindow} browserWindow @param {string} repositoryPath */
const startRepositoryWatcher = (browserWindow, repositoryPath) => {
  const webContentsId = browserWindow.webContents.id;
  void repositoryWatcherCoordinator.attach({
    getState: () => ({
      focused: !browserWindow.isDestroyed() && browserWindow.isFocused(),
      visible:
        !browserWindow.isDestroyed() && browserWindow.isVisible() && !browserWindow.isMinimized(),
    }),
    id: webContentsId,
    notify: (root) => {
      if (!browserWindow.isDestroyed()) {
        browserWindow.webContents.send('codiff:repositoryChanged', { root });
      }
    },
    root: repositoryPath,
  });
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

/**
 * Native menus live in the main process, so this event lets the renderer own
 * the actual source dialog and reuse it with the command palette.
 * @param {import('electron').BrowserWindow | undefined} browserWindow
 * @param {import('../core/types.ts').OpenReviewSourceKind} kind
 */
const requestOpenReviewSource = (browserWindow, kind) => {
  if (browserWindow instanceof BrowserWindow && !browserWindow.isDestroyed()) {
    browserWindow.webContents.send('codiff:openReviewSource', kind);
  }
};
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
                {
                  click: () => {
                    void checkForUpdatesFromMenu();
                  },
                  label: 'Check for Updates…',
                },
                { type: 'separator' },
                {
                  click: (_menuItem, browserWindow) =>
                    requestOpenReviewSource(browserWindow, 'pull-request'),
                  label: 'Open PR',
                },
                {
                  click: (_menuItem, browserWindow) =>
                    requestOpenReviewSource(browserWindow, 'commit'),
                  label: 'Open Commit',
                },
                {
                  click: (_menuItem, browserWindow) =>
                    requestOpenReviewSource(browserWindow, 'branch'),
                  label: 'Open Branch',
                },
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

  attachExternalLinkHandling(window.webContents, (url) => shell.openExternal(url));

  const webContentsId = window.webContents.id;
  openWindows.add(window);
  if (identity) {
    windowIdentities.set(webContentsId, identity);
  }
  windowRepositories.set(webContentsId, identity?.repositoryRoot || repositoryPath);
  windowLaunchOptions.set(webContentsId, launchOptions);
  const initialRepositoryStatePromise = launchOptions.planFile
    ? null
    : readInitialRepositoryStateWithConfig(repositoryPath, launchOptions);
  const initialRepositoryState = initialRepositoryStatePromise?.then((state) => {
    if (!window.isDestroyed()) {
      storeResolvedRepositoryState(webContentsId, state);
    }
    return state;
  });
  initialRepositoryState?.catch(() => {});
  if (initialRepositoryState) {
    windowInitialRepositoryStates.set(webContentsId, initialRepositoryState);
  }
  if (
    !launchOptions.planFile &&
    (!launchOptions.source ||
      launchOptions.source.type === 'branch' ||
      launchOptions.source.type === 'branch-working-tree')
  ) {
    void initialRepositoryState
      .then((state) => {
        if (
          (state.source.type === 'working-tree' || state.source.type === 'branch-working-tree') &&
          !window.isDestroyed()
        ) {
          startRepositoryWatcher(window, state.root);
        }
      })
      .catch(() => {});
  }
  window.on('blur', () => repositoryWatcherCoordinator.visibilityChanged(webContentsId));
  window.on('enter-full-screen', () => {
    window.webContents.send('codiff:windowFullScreenChanged', true);
  });
  window.on('focus', () => repositoryWatcherCoordinator.focus(webContentsId));
  window.on('hide', () => repositoryWatcherCoordinator.visibilityChanged(webContentsId));
  window.on('leave-full-screen', () => {
    window.webContents.send('codiff:windowFullScreenChanged', false);
  });
  window.on('minimize', () => repositoryWatcherCoordinator.visibilityChanged(webContentsId));
  window.on('restore', () => repositoryWatcherCoordinator.focus(webContentsId));
  window.on('show', () => repositoryWatcherCoordinator.focus(webContentsId));
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
    definitionSearchCoordinator.cancel(webContentsId);
    repositoryWatcherCoordinator.detach(webContentsId);
    clearMarkdownDocumentWatchers(webContentsId);
    completedPlanWindows.delete(webContentsId);
    planInitialVersions.delete(webContentsId);
    readyPlanWindows.delete(webContentsId);
    windowIdentities.delete(webContentsId);
    windowInitialRepositoryStates.delete(webContentsId);
    walkthroughProgressGenerations.delete(webContentsId);
    windowRepositories.delete(webContentsId);
    windowLaunchOptions.delete(webContentsId);
  });
  window.webContents.on('render-process-gone', () => {
    definitionSearchCoordinator.cancel(webContentsId);
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
      // The renderer's static HTML title can replace the title set while repository state loads.
      // Reapply the resolved title after every navigation so the native window list stays useful.
      void restoreRepositoryWindowTitleAfterLoad(window, initialRepositoryState).catch(() => {});
      return;
    }
    // The renderer's static HTML title replaces constructor titles during navigation.
    // Set this after every plan load so native window lists keep the plan filename.
    window.setTitle(getPlanWindowTitle(currentLaunchOptions.planFile));
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

  return {
    target: resolveWalkthroughShareTarget({
      email: uploader.email,
      overrideUrl: process.env.CODIFF_SHARE_SERVER_URL,
    }),
    uploader,
  };
};

/** @param {number} webContentsId */
const getPlanShareContext = async (webContentsId) => {
  const repositoryPath = windowRepositories.get(webContentsId) || getLaunchPath();
  const uploader = await readGitIdentity(repositoryPath);
  return {
    target: resolvePlanShareTarget({
      email: uploader.email,
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
      windowRepositories.set(matchingWebContentsId, identity?.repositoryRoot || repositoryPath);
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

const INITIAL_UPDATE_CHECK_DELAY_MS = 10 * 1000;
const UPDATE_CHECK_TIMER_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** @type {ReturnType<typeof createUpdater> | null} */
let updater = null;

/** @param {import('../core/types.ts').CodiffUpdateStatus} status */
const sendUpdateStatusChanged = (status) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('codiff:updateStatusChanged', status);
    }
  }
};

const hasSquirrelUpdateExe = () =>
  process.platform === 'win32' && existsSync(join(dirname(process.execPath), '..', 'Update.exe'));

const detectLinuxPackageFlavor = () =>
  existsSync('/etc/debian_version')
    ? /** @type {const} */ ('deb')
    : existsSync('/etc/redhat-release')
      ? /** @type {const} */ ('rpm')
      : null;

const initUpdater = () => {
  updater = createUpdater({
    arch: process.arch,
    autoUpdater,
    currentVersion: app.getVersion(),
    downloadDirectory: app.getPath('downloads'),
    isPackaged: app.isPackaged,
    linuxFlavor: process.platform === 'linux' ? detectLinuxPackageFlavor() : null,
    onStatusChange: sendUpdateStatusChanged,
    openExternal: (url) => shell.openExternal(url),
    openPath: (path) => shell.openPath(path),
    platform: process.platform,
    strategy: resolveUpdateStrategy({
      hasSquirrelUpdateExe: hasSquirrelUpdateExe(),
      platform: process.platform,
    }),
    updatesEnabled: config.settings.checkForUpdates,
  });
};

const runScheduledUpdateCheck = () => {
  if (updater && config.settings.checkForUpdates) {
    void updater.checkForUpdates().catch(() => {});
  }
};

const checkForUpdatesFromMenu = async () => {
  if (!updater) {
    return;
  }

  try {
    const status = await updater.checkForUpdates({ force: true });
    if (status.phase === 'idle') {
      void dialog.showMessageBox({
        message: `Codiff ${app.getVersion()} is up to date.`,
        type: 'info',
      });
    }
  } catch (error) {
    void dialog.showMessageBox({
      message: `Checking for updates failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      type: 'error',
    });
  }
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
    if (launchOptions.applyUpdate) {
      void updater?.applyLatest().catch(() => {});
    }
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

    watchKeyboardLayout((layout) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('codiff:keyboardLayoutChanged', layout);
        }
      }
    });

    initUpdater();
    setTimeout(runScheduledUpdateCheck, INITIAL_UPDATE_CHECK_DELAY_MS);
    setInterval(runScheduledUpdateCheck, UPDATE_CHECK_TIMER_INTERVAL_MS);

    const launchOptions = getLaunchOptions();
    focusOrCreateWindow(
      getInitialRepositoryPath(getLaunchPath(), launchOptions, config.settings.lastRepositoryPath),
      launchOptions,
    );
    if (launchOptions.applyUpdate) {
      void updater?.applyLatest().catch(() => {});
    }

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
      updater?.setUpdatesEnabled(config.settings.checkForUpdates);
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

ipcMain.handle('codiff:getUpdateStatus', () =>
  updater ? updater.getStatus() : { currentVersion: app.getVersion(), phase: 'idle' },
);

ipcMain.handle('codiff:applyUpdate', () =>
  updater ? updater.applyUpdate() : { currentVersion: app.getVersion(), phase: 'idle' },
);

ipcMain.handle('codiff:dismissUpdate', () =>
  updater ? updater.dismissUpdate() : { currentVersion: app.getVersion(), phase: 'idle' },
);

ipcMain.handle('codiff:openReleasePage', () => {
  const version = updater?.getStatus().version;
  return shell.openExternal(
    version ? releasePageUrl(version) : 'https://github.com/nkzw-tech/codiff/releases',
  );
});

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
  storeResolvedRepositoryState(event.sender.id, state);
  rememberLastRepositoryPath(state.root);
  void resetRepositoryWatcher(event.sender.id, state.root);
  return state;
});

ipcMain.handle('codiff:resolvePullRequestUrl', (event, value) => {
  const input = typeof value === 'string' ? value.trim() : '';
  const parsedUrl = parseReviewUrl(input);
  if (parsedUrl) {
    return parsedUrl.url;
  }

  const number = input.match(/^#?([1-9]\d*)$/);
  if (!number) {
    throw new Error('Enter a pull request number or a GitHub or GitLab pull request link.');
  }

  // Reuse the CLI resolver so a bare number follows the repository's preferred remote.
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return resolveReviewUrl(repositoryPath, Number(number[1]));
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

ipcMain.handle('codiff:getNarrativeWalkthrough', async (event, source, options) => {
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  const progressGeneration = (walkthroughProgressGenerations.get(event.sender.id) || 0) + 1;
  walkthroughProgressGenerations.set(event.sender.id, progressGeneration);
  const reportProgress = createWalkthroughProgressReporter(
    event.sender,
    () => walkthroughProgressGenerations.get(event.sender.id) === progressGeneration,
  );

  try {
    const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
    const state = await readRepositoryStateWithConfig(
      repositoryPath,
      source || launchOptions?.source,
    );
    const agent = resolveWindowAgent(event.sender.id);
    const walkthroughFile = launchOptions?.walkthroughFile;
    if (walkthroughFile) {
      let contents;
      let input;
      try {
        contents = readFileSync(walkthroughFile, 'utf8');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          reason: `Could not read walkthrough file: ${detail}`,
          status: 'unavailable',
        };
      }

      const sessionContext = await Promise.resolve(
        agent.readSessionContext(launchOptions?.[agent.sessionLaunchOptionKey]),
      ).catch(() => null);
      try {
        input = JSON.parse(contents);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          reason: `Could not read walkthrough file: ${detail}`,
          status: 'unavailable',
        };
      }

      try {
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
    const agentOptions = getAgentOptions(agent);
    const walkthroughModel = resolveNarrativeWalkthroughModel(state, agent, agentOptions.model);
    const walkthroughPrompt = config.settings.walkthroughPrompt;
    const cacheKey = getNarrativeWalkthroughCacheKey(
      state,
      agent,
      walkthroughModel,
      walkthroughContext,
      walkthroughPrompt,
    );
    if (!options?.force) {
      const cachedWalkthrough = readStoredWalkthrough(cacheKey);
      if (cachedWalkthrough) {
        return {
          status: 'ready',
          walkthrough: {
            ...cachedWalkthrough,
            ...(walkthroughContext ? { context: walkthroughContext } : {}),
            agent: agent.id,
            repo: {
              branch: state.branch,
              root: state.root,
            },
            source: state.source,
          },
        };
      }
    }

    let generatedModel = walkthroughModel;
    const onModelFallback = agentOptions.onModelFallback;
    const result = await readNarrativeWalkthrough(
      state,
      agent,
      {
        ...agentOptions,
        model: walkthroughModel,
        onModelFallback: async (fallbackModel, originalModel) => {
          generatedModel = fallbackModel;
          await onModelFallback(fallbackModel, originalModel);
        },
        onProgress: reportProgress,
      },
      walkthroughContext,
      walkthroughPrompt,
      options?.previousWalkthrough,
    );
    if (result.status === 'ready') {
      const generatedCacheKey = getNarrativeWalkthroughCacheKey(
        state,
        agent,
        generatedModel,
        walkthroughContext,
        walkthroughPrompt,
      );
      try {
        const cacheableWalkthrough = { ...result.walkthrough };
        delete cacheableWalkthrough.context;
        writeStoredWalkthrough(generatedCacheKey, cacheableWalkthrough);
      } catch {
        // Caching is optional; a filesystem failure must not hide a generated result.
      }
    }
    return result;
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
    getPlanShareContext(event.sender.id),
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
  const result = await createWalkthroughCommit(repositoryPath, request, (chunk) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('codiff:walkthroughCommitOutput', chunk);
    }
  });
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

ipcMain.handle('codiff:getKeyboardLayout', () => readKeyboardLayout());

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

ipcMain.handle('codiff:openRepositoryFolder', (event) =>
  openRepositoryFolder(BrowserWindow.fromWebContents(event.sender) ?? undefined),
);

ipcMain.handle('codiff:findDefinitions', (event, request) =>
  definitionSearchCoordinator.find(
    event.sender.id,
    getWindowRepositoryRoot(event.sender.id),
    request,
  ),
);

ipcMain.handle('codiff:openFile', async (event, filePath, lineNumber) => {
  const repositoryRoot = getWindowRepositoryRoot(event.sender.id);
  const repositoryFilePath = validateRepositoryPath(filePath);
  const absolutePath = resolve(repositoryRoot, repositoryFilePath);

  if (existsSync(absolutePath)) {
    await openFileInEditor(absolutePath, {
      lineNumber: Number.isSafeInteger(lineNumber) && lineNumber > 0 ? lineNumber : undefined,
      repoPath: repositoryRoot,
    });
  } else {
    await shell.openPath(repositoryRoot);
  }
});

ipcMain.handle('codiff:showInFolder', (event, filePath) => {
  const repositoryRoot = getWindowRepositoryRoot(event.sender.id);
  const repositoryFilePath = validateRepositoryPath(filePath);
  const absolutePath = resolve(repositoryRoot, repositoryFilePath);

  if (existsSync(absolutePath)) {
    shell.showItemInFolder(absolutePath);
  } else {
    void shell.openPath(repositoryRoot);
  }
});

ipcMain.handle('codiff:getRelativePath', (event, filePath) =>
  relative(getWindowRepositoryRoot(event.sender.id), filePath),
);
