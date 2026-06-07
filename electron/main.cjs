// @ts-check

const { existsSync, readFileSync } = require('node:fs');
const { dirname, join, relative, resolve } = require('node:path');
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
  submitPullRequestComment,
  submitPullRequestReview,
  validateRepositoryPath,
} = require('./git-state.cjs');
const { normalizeOpenAIModel } = require('./codex.cjs');
const { normalizeClaudeModel } = require('./claude.cjs');
const { createWalkthroughCommit } = require('./walkthrough-commit.cjs');
const { readCommitMessageReply } = require('./walkthrough-commit-message.cjs');
const { getAgent, listAgents, normalizeAgentBackend } = require('./agent.cjs');
const {
  configToPreferences,
  createDefaultConfig,
  getConfigPath,
  initConfig,
  migrateFromPreferences,
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

/**
 * @typedef {import('../src/config/types.ts').CodiffConfig} CodiffConfig
 * @typedef {import('../src/types.ts').CodiffLaunchOptions} CodiffLaunchOptions
 * @typedef {import('../src/types.ts').CodiffTheme} CodiffTheme
 * @typedef {import('../src/types.ts').ReviewSource} ReviewSource
 * @typedef {{key: string; repositoryRoot: string; sourceKey: string}} WindowIdentity
 * @typedef {{direction: string; name: string; owner: string; repo: string}} GitHubRemote
 * @typedef {{repositoryPath?: string; launchOptions?: CodiffLaunchOptions}} SingleInstanceAdditionalData
 * @typedef {{changed: boolean; checking: boolean; interval?: ReturnType<typeof setInterval>; signature?: string}} RepositoryWatcher
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
const pendingCommentsClipboardController = createPendingCommentsClipboardController({ clipboard });
/** @type {CodiffConfig} */
let config = createDefaultConfig();

/** @type {Map<'codex' | 'claude', {agent: import('./agent.cjs').Agent; installer: ReturnType<typeof createSkillInstaller>}>} */
const skillInstallers = new Map(
  listAgents().map((agent) => [
    agent.id,
    { agent, installer: createSkillInstaller({ app, dialog, root, skill: agent.skill }) },
  ]),
);

const getActiveAgent = () => getAgent(config.settings.agentBackend);

/** @param {number} webContentsId */
const resolveWindowAgent = (webContentsId) => {
  const override = windowLaunchOptions.get(webContentsId)?.agentBackend;
  return getAgent(
    override === 'codex' || override === 'claude' ? override : config.settings.agentBackend,
  );
};

/** @param {'codex' | 'claude'} agentId */
const skillInstallerFor = (agentId) => skillInstallers.get(agentId)?.installer;
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
      openAIModel: normalizeOpenAIModel(
        nextConfig.settings?.openAIModel ?? config.settings.openAIModel,
      ),
    },
  };
  nativeTheme.themeSource = config.settings.theme;
  writeConfig(config);
  sendConfigChanged();
  Menu.setApplicationMenu(buildApplicationMenu());
};

/** @param {'codex' | 'claude'} backend */
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

/**
 * @param {import('../src/types.ts').WalkthroughContext | null | undefined} providedContext
 * @param {import('../src/types.ts').WalkthroughContext | null | undefined} sessionContext
 */
const mergeWalkthroughContexts = (providedContext, sessionContext) => {
  if (!providedContext) {
    return sessionContext;
  }

  if (!sessionContext) {
    return providedContext;
  }

  return {
    ...sessionContext,
    ...providedContext,
    messages: sessionContext.messages,
    risks: [...(sessionContext.risks || []), ...(providedContext.risks || [])],
    source: sessionContext.source,
  };
};

/** @param {CodiffTheme} theme */
const updateTheme = (theme) => {
  updateConfig({ settings: { ...config.settings, theme } });
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

/** @param {string} repositoryPath */
const readRepositoryWatcherSnapshot = async (repositoryPath) => {
  try {
    return await readRepositoryChangeSignature(repositoryPath);
  } catch (error) {
    return {
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
  watcher.signature = snapshot.signature;
};

/** @param {import('electron').BrowserWindow} browserWindow @param {string} repositoryPath */
const startRepositoryWatcher = (browserWindow, repositoryPath) => {
  const webContentsId = browserWindow.webContents.id;
  /** @type {RepositoryWatcher} */
  const watcher = {
    changed: false,
    checking: false,
    interval: undefined,
    signature: undefined,
  };
  repositoryWatchers.set(webContentsId, watcher);

  const checkForChanges = async (reset = false) => {
    if (watcher.checking || browserWindow.isDestroyed()) {
      return;
    }

    watcher.checking = true;
    try {
      const snapshot = await readRepositoryWatcherSnapshot(repositoryPath);
      if (reset || watcher.signature == null) {
        watcher.changed = false;
        watcher.signature = snapshot.signature;
        return;
      }

      if (!watcher.changed && watcher.signature !== snapshot.signature) {
        watcher.changed = true;
        browserWindow.webContents.send('codiff:repositoryChanged', {
          root: snapshot.root,
        });
      }
    } finally {
      watcher.checking = false;
    }
  };

  void checkForChanges(true);
  watcher.interval = setInterval(() => void checkForChanges(), 2500);
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
  return agent.models.map((model) => ({
    checked: config.settings[agent.modelSettingKey] === model.id,
    click: () => selectAgentModel(agent, model.id),
    label: model.label,
    type: 'radio',
  }));
};

/** @returns {Array<import('electron').MenuItemConstructorOptions>} */
const buildSkillMenuItems = () =>
  listAgents().map((agent) => ({
    click:
      /** @type {NonNullable<import('electron').MenuItemConstructorOptions['click']>} */ (
        (_menuItem, browserWindow) =>
          void skillInstallers.get(agent.id)?.installer.install(browserWindow)
      ),
    label: `Install ${agent.skill.label}`,
  }));

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
                ...buildSkillMenuItems(),
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
                ...buildSkillMenuItems(),
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
            ],
          },
          {
            label: 'Walkthrough',
            submenu: [
              {
                checked: config.settings.walkthroughOrder !== 'results',
                click: () => {
                  updateConfig({
                    settings: { ...config.settings, walkthroughOrder: 'keys' },
                  });
                },
                label: 'Key Changes',
                type: 'radio',
              },
              {
                checked: config.settings.walkthroughOrder === 'results',
                click: () => {
                  updateConfig({
                    settings: { ...config.settings, walkthroughOrder: 'results' },
                  });
                },
                label: 'Results First',
                type: 'radio',
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
          { role: 'reload' },
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
  const window = new BrowserWindow({
    autoHideMenuBar: process.platform !== 'linux',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141414' : '#ffffff',
    height: validatedState?.height ?? Math.max(720, Math.floor(height * 0.86)),
    minHeight: 520,
    minWidth: 880,
    show: false,
    title: `Codiff - ${repositoryPath}`,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 25, y: 22 } } : {}),
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
  if (identity) {
    windowIdentities.set(webContentsId, identity);
  }
  windowRepositories.set(webContentsId, repositoryPath);
  windowLaunchOptions.set(webContentsId, launchOptions);
  const initialRepositoryState = readRepositoryState(repositoryPath, launchOptions.source);
  initialRepositoryState.catch(() => {});
  windowInitialRepositoryStates.set(webContentsId, initialRepositoryState);
  if (!launchOptions.source) {
    startRepositoryWatcher(window, repositoryPath);
  }
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
    const watcher = repositoryWatchers.get(webContentsId);
    if (watcher?.interval) {
      clearInterval(watcher.interval);
    }
    repositoryWatchers.delete(webContentsId);
    windowIdentities.delete(webContentsId);
    windowInitialRepositoryStates.delete(webContentsId);
    windowRepositories.delete(webContentsId);
    windowLaunchOptions.delete(webContentsId);
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
    config = readConfig();
    config.settings.openAIModel = normalizeOpenAIModel(config.settings.openAIModel);
    config.settings.claudeModel = normalizeClaudeModel(config.settings.claudeModel);
    config.settings.agentBackend = normalizeAgentBackend(config.settings.agentBackend);
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
          openAIModel: normalizeOpenAIModel(nextConfig.settings.openAIModel),
        },
      };
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
    : await readRepositoryState(repositoryPath, source || launchOptions?.source);
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
    const state = await readRepositoryState(repositoryPath, source || launchOptions?.source);
    const walkthroughFile = launchOptions?.walkthroughFile;
    if (walkthroughFile) {
      const input = JSON.parse(readFileSync(walkthroughFile, 'utf8'));
      return {
        status: 'ready',
        walkthrough: normalizeNarrativeWalkthrough(input, state.files),
      };
    }

    const agent = resolveWindowAgent(event.sender.id);
    const walkthroughContext = mergeWalkthroughContexts(
      launchOptions?.walkthroughContext,
      agent.readSessionContext(launchOptions?.[agent.sessionLaunchOptionKey]),
    );
    return readNarrativeWalkthrough(state, agent, getAgentOptions(agent), walkthroughContext);
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: 'unavailable',
    };
  }
});

ipcMain.handle('codiff:askReviewAssistant', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  const state = await readRepositoryState(repositoryPath, request?.source || launchOptions?.source);
  const agent = resolveWindowAgent(event.sender.id);
  return readReviewAssistantReply(state, request, agent, getAgentOptions(agent));
});

ipcMain.handle('codiff:createWalkthroughCommit', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return createWalkthroughCommit(repositoryPath, request);
});

ipcMain.handle('codiff:updateWalkthroughCommitMessage', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  const state = await readRepositoryState(repositoryPath, request?.source || launchOptions?.source);
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
  return readDiffSectionContent(repositoryPath, request);
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

ipcMain.handle('codiff:setWalkthroughOrder', (_event, value) => {
  updateConfig({
    settings: {
      ...config.settings,
      walkthroughOrder: typeof value === 'string' && value.length > 0 ? value : 'keys',
    },
  });
});

ipcMain.handle('codiff:setWordWrap', (_event, value) => {
  updateConfig({ settings: { ...config.settings, wordWrap: Boolean(value) } });
});

ipcMain.handle('codiff:openConfigFile', () => openConfigFile());

ipcMain.handle('codiff:openFile', async (event, filePath) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const state = await readRepositoryState(repositoryPath);
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
  const state = await readRepositoryState(repositoryPath);
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
  const state = await readRepositoryState(repositoryPath);
  return relative(state.root, filePath);
});
