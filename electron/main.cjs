// @ts-check

const { existsSync, readFileSync, writeFileSync } = require('node:fs');
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
  readGitIdentity,
  readDiffSectionContent,
  readRepositoryChangeSignature,
  readRepositoryState,
  submitPullRequestComment,
  submitPullRequestReview,
  validateRepositoryPath,
} = require('./git-state.cjs');
const {
  DEFAULT_OPENAI_MODEL,
  FALLBACK_OPENAI_MODEL,
  normalizeOpenAIModel,
  OPENAI_MODELS,
} = require('./codex.cjs');
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
const { createEditorOpener } = require('./main/editor.cjs');
const { createTerminalHelper } = require('./main/terminal-helper.cjs');
const { readWalkthrough } = require('./walkthrough.cjs');

/**
 * @typedef {import('../src/types.ts').CodiffLaunchOptions} CodiffLaunchOptions
 * @typedef {import('../src/types.ts').CodiffPreferences} CodiffPreferences
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
/** @type {CodiffPreferences} */
let preferences = {
  copyCommentsOnClose: false,
  lastRepositoryPath: '',
  openAIModel: DEFAULT_OPENAI_MODEL,
  showWhitespace: false,
  theme: 'system',
};

const { getTerminalHelperStatus, installTerminalHelper } = createTerminalHelper({
  app,
  dialog,
  root,
});
const { openFileInEditor } = createEditorOpener({ shell });

const getPreferencesPath = () => join(app.getPath('userData'), 'preferences.json');

/** @param {unknown} theme @returns {CodiffTheme} */
const normalizeTheme = (theme) =>
  theme === 'system' || theme === 'light' || theme === 'dark' ? theme : 'system';

/** @param {unknown} path */
const normalizeLastRepositoryPath = (path) =>
  typeof path === 'string' && path.length > 0 ? path : '';

/** @returns {CodiffPreferences} */
const readPreferences = () => {
  try {
    const storedPreferences = JSON.parse(readFileSync(getPreferencesPath(), 'utf8'));
    return {
      ...preferences,
      ...storedPreferences,
      lastRepositoryPath: normalizeLastRepositoryPath(storedPreferences?.lastRepositoryPath),
      openAIModel: normalizeOpenAIModel(storedPreferences?.openAIModel),
      theme: normalizeTheme(storedPreferences?.theme),
    };
  } catch {
    return preferences;
  }
};

const writePreferences = () => {
  writeFileSync(getPreferencesPath(), JSON.stringify(preferences, null, 2));
};

const sendPreferencesChanged = () => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('codiff:preferencesChanged', preferences);
    }
  }
};

/** @param {Partial<CodiffPreferences>} nextPreferences */
const updatePreferences = (nextPreferences) => {
  preferences = {
    ...preferences,
    ...nextPreferences,
    openAIModel: normalizeOpenAIModel(nextPreferences.openAIModel ?? preferences.openAIModel),
    theme: normalizeTheme(nextPreferences.theme ?? preferences.theme),
  };
  nativeTheme.themeSource = preferences.theme;
  writePreferences();
  sendPreferencesChanged();
  Menu.setApplicationMenu(buildApplicationMenu());
};

/** @param {string} model */
const selectOpenAIModel = (model) => {
  const openAIModel = normalizeOpenAIModel(model);
  if (preferences.openAIModel === openAIModel) {
    return;
  }

  updatePreferences({ openAIModel });
};

const getCodexOptions = () => ({
  fallbackModel: FALLBACK_OPENAI_MODEL,
  model: preferences.openAIModel,
  /** @param {string} fallbackModel */
  onModelFallback: async (fallbackModel) => {
    updatePreferences({ openAIModel: fallbackModel });
  },
});

/** @param {CodiffTheme} theme */
const updateTheme = (theme) => {
  updatePreferences({ theme });
};

/** @param {string} repositoryPath */
const rememberLastRepositoryPath = (repositoryPath) => {
  if (preferences.lastRepositoryPath === repositoryPath) {
    return;
  }

  preferences = {
    ...preferences,
    lastRepositoryPath: repositoryPath,
  };
  writePreferences();
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
const buildOpenAIModelSubmenu = () =>
  OPENAI_MODELS.map((model) => ({
    checked: preferences.openAIModel === model.id,
    click: () => selectOpenAIModel(model.id),
    label: model.label,
    type: 'radio',
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
                  label: 'OpenAI Model',
                  submenu: buildOpenAIModelSubmenu(),
                },
                { type: 'separator' },
                {
                  click:
                    /** @type {NonNullable<import('electron').MenuItemConstructorOptions['click']>} */ (
                      (_menuItem, browserWindow) => installTerminalHelper(browserWindow)
                    ),
                  label: 'Install Terminal Helper',
                },
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
                  label: 'OpenAI Model',
                  submenu: buildOpenAIModelSubmenu(),
                },
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
            checked: preferences.showWhitespace,
            click: (menuItem) => {
              updatePreferences({
                showWhitespace: menuItem.checked,
              });
            },
            label: 'Show Whitespace',
            type: 'checkbox',
          },
          {
            checked: preferences.copyCommentsOnClose,
            click: (menuItem) => {
              updatePreferences({
                copyCommentsOnClose: menuItem.checked,
              });
            },
            label: 'Copy Comments on Close',
            type: 'checkbox',
          },
          {
            label: 'Theme',
            submenu: [
              {
                checked: preferences.theme === 'system',
                click: () => updateTheme('system'),
                label: 'Match System',
                type: 'radio',
              },
              {
                checked: preferences.theme === 'light',
                click: () => updateTheme('light'),
                label: 'Light',
                type: 'radio',
              },
              {
                checked: preferences.theme === 'dark',
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
  const display = screen.getPrimaryDisplay();
  const { height, width } = display.workAreaSize;
  const window = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141414' : '#ffffff',
    center: true,
    height: Math.max(720, Math.floor(height * 0.86)),
    minHeight: 520,
    minWidth: 880,
    show: false,
    title: `Codiff - ${repositoryPath}`,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 25, y: 24 } } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs'),
    },
    width: Math.max(1120, Math.floor(width * 0.86)),
  });

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
    if (allowClose || quitting || !preferences.copyCommentsOnClose) {
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
      getInitialRepositoryPath(launchPath, launchOptions, preferences.lastRepositoryPath),
      launchOptions,
    );
  });

  app.on('ready', () => {
    preferences = readPreferences();
    nativeTheme.themeSource = preferences.theme;
    Menu.setApplicationMenu(buildApplicationMenu());
    const launchOptions = getLaunchOptions();
    focusOrCreateWindow(
      getInitialRepositoryPath(getLaunchPath(), launchOptions, preferences.lastRepositoryPath),
      launchOptions,
    );
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const launchOptions = getLaunchOptions();
      focusOrCreateWindow(
        getInitialRepositoryPath(getLaunchPath(), launchOptions, preferences.lastRepositoryPath),
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

    if (preferences.copyCommentsOnClose && !quitAfterCopyingPendingComments && windows.length) {
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
  const state = initialState
    ? await initialState
    : await readRepositoryState(repositoryPath, source || launchOptions?.source);
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

ipcMain.handle('codiff:getTerminalHelperStatus', () => getTerminalHelperStatus());

ipcMain.handle('codiff:installTerminalHelper', async (event) => {
  await installTerminalHelper(BrowserWindow.fromWebContents(event.sender));
  return getTerminalHelperStatus();
});

ipcMain.handle('codiff:getWalkthrough', async (event, source) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  const state = await readRepositoryState(repositoryPath, source || launchOptions?.source);
  return readWalkthrough(state, getCodexOptions());
});

ipcMain.handle('codiff:askReviewAssistant', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  const state = await readRepositoryState(repositoryPath, request?.source || launchOptions?.source);
  return readReviewAssistantReply(state, request, getCodexOptions());
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

ipcMain.handle('codiff:getRepositoryHistory', async (event, limit) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return listRepositoryHistory(repositoryPath, limit);
});

ipcMain.handle('codiff:getGitIdentity', async (event) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return readGitIdentity(repositoryPath);
});

ipcMain.handle('codiff:getPreferences', () => preferences);

ipcMain.handle('codiff:openFile', async (event, filePath) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const state = await readRepositoryState(repositoryPath);
  const repositoryFilePath = validateRepositoryPath(filePath);
  const absolutePath = resolve(state.root, repositoryFilePath);

  if (existsSync(absolutePath)) {
    await openFileInEditor(absolutePath);
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
