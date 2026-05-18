const {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join, relative, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseArgs } = require('node:util');
const {
  app,
  BrowserWindow,
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
  validateRepositoryPath,
} = require('./git-state.cjs');
const { readWalkthrough } = require('./walkthrough.cjs');

const root = dirname(__dirname);
const repositoryWatchers = new Map();
const windowRepositories = new Map();
const windowLaunchOptions = new Map();
let preferences = {
  showWhitespace: false,
};

const commitHashPattern = /^[0-9a-f]{4,64}$/i;

const isCommitHashArgument = (arg) => commitHashPattern.test(arg) && !existsSync(resolve(arg));

const parseCommandLineArguments = (commandLine = process.argv) => {
  const args = commandLine.slice(process.defaultApp ? 2 : 1);
  const useEnvironment = commandLine === process.argv;
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      commit: {
        type: 'string',
      },
      walkthrough: {
        short: 'w',
        type: 'boolean',
      },
    },
    strict: false,
  });

  let commitRef = typeof values.commit === 'string' ? values.commit : null;
  let repositoryPath = null;

  for (const arg of positionals) {
    if (!commitRef && isCommitHashArgument(arg)) {
      commitRef = arg;
    } else if (repositoryPath == null) {
      repositoryPath = arg;
    }
  }

  const envCommitRef = useEnvironment ? process.env.CODIFF_COMMIT_REF || '' : '';
  const sourceRef = envCommitRef || commitRef;
  return {
    launchOptions: {
      source: sourceRef
        ? {
            ref: sourceRef,
            type: 'commit',
          }
        : undefined,
      walkthrough:
        (useEnvironment && process.env.CODIFF_WALKTHROUGH === '1') || values.walkthrough === true,
    },
    repositoryPath,
  };
};

const getCommandLineRepositoryPath = (commandLine = process.argv) =>
  parseCommandLineArguments(commandLine).repositoryPath;

const getCommandLineLaunchOptions = (commandLine = process.argv) =>
  parseCommandLineArguments(commandLine).launchOptions;

const getLaunchPath = () =>
  resolve(process.env.CODIFF_REPOSITORY_PATH || getCommandLineRepositoryPath() || process.cwd());

const getLaunchOptions = () => getCommandLineLaunchOptions();

const getPreferencesPath = () => join(app.getPath('userData'), 'preferences.json');

const readPreferences = () => {
  try {
    return {
      ...preferences,
      ...JSON.parse(readFileSync(getPreferencesPath(), 'utf8')),
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

const resetRepositoryWatcher = async (webContentsId, repositoryPath) => {
  const watcher = repositoryWatchers.get(webContentsId);
  if (!watcher) {
    return;
  }

  const snapshot = await readRepositoryWatcherSnapshot(repositoryPath);
  watcher.changed = false;
  watcher.signature = snapshot.signature;
};

const startRepositoryWatcher = (browserWindow, repositoryPath) => {
  const webContentsId = browserWindow.webContents.id;
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

const openRepositoryFolder = async (browserWindow) => {
  const result = await dialog.showOpenDialog(browserWindow ?? undefined, {
    properties: ['openDirectory'],
  });

  if (!result.canceled && result.filePaths[0]) {
    createWindow(result.filePaths[0], { walkthrough: false });
  }
};

const getTerminalHelperSourcePath = () =>
  app.isPackaged ? join(process.resourcesPath, 'app/bin/codiff-app') : join(root, 'bin/codiff.js');

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

const installTerminalHelper = async (browserWindow) => {
  try {
    const sourcePath = getTerminalHelperSourcePath();
    const targetPath = join(getWritableHelperDirectory(), 'codiff');

    if (!existsSync(sourcePath)) {
      throw new Error(`Could not find terminal helper at ${sourcePath}.`);
    }

    if (existsSync(targetPath)) {
      const target = lstatSync(targetPath);

      if (!target.isSymbolicLink()) {
        throw new Error(`${targetPath} already exists and is not a symlink.`);
      }

      unlinkSync(targetPath);
    }

    symlinkSync(sourcePath, targetPath);

    await dialog.showMessageBox(browserWindow ?? undefined, {
      buttons: ['OK'],
      message: `Installed codiff at ${targetPath}.`,
      type: 'info',
    });
  } catch (error) {
    await dialog.showMessageBox(browserWindow ?? undefined, {
      buttons: ['OK'],
      detail: error instanceof Error ? error.message : String(error),
      message: 'Could not install the terminal helper.',
      type: 'error',
    });
  }
};

const buildApplicationMenu = () =>
  Menu.buildFromTemplate([
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                click: (_menuItem, browserWindow) => installTerminalHelper(browserWindow),
                label: 'Install Terminal Helper',
              },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
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
            browserWindow?.webContents.send('codiff:findInDiffs');
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
            preferences = {
              ...preferences,
              showWhitespace: menuItem.checked,
            };
            writePreferences();
            sendPreferencesChanged();
          },
          label: 'Show Whitespace',
          type: 'checkbox',
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        {
          accelerator: 'CommandOrControl+Alt+J',
          click: (_menuItem, browserWindow) => browserWindow?.webContents.toggleDevTools(),
          label: 'Toggle Developer Tools',
        },
      ],
    },
  ]);

const createWindow = (repositoryPath, launchOptions = { walkthrough: false }) => {
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
    // Keep the native Windows/Linux title bar so the desktop window has
    // normal minimize/maximize/close controls. Codiff's upstream hidden title
    // bar works on macOS, but on Windows it leaves our packaged app without a
    // practical close button.
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
  windowRepositories.set(webContentsId, repositoryPath);
  windowLaunchOptions.set(webContentsId, launchOptions);
  if (!launchOptions.source) {
    startRepositoryWatcher(window, repositoryPath);
  }
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    const watcher = repositoryWatchers.get(webContentsId);
    if (watcher?.interval) {
      clearInterval(watcher.interval);
    }
    repositoryWatchers.delete(webContentsId);
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
    createWindow(
      resolve(
        additionalData?.repositoryPath ||
          getCommandLineRepositoryPath(commandLine) ||
          workingDirectory,
      ),
      additionalData?.launchOptions || getCommandLineLaunchOptions(commandLine),
    );
  });

  app.on('ready', () => {
    preferences = readPreferences();
    Menu.setApplicationMenu(buildApplicationMenu());
    createWindow(getLaunchPath(), getLaunchOptions());
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(getLaunchPath(), getLaunchOptions());
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

ipcMain.handle('codiff:getRepositoryState', async (event, source) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  const state = await readRepositoryState(repositoryPath, source || launchOptions?.source);
  await resetRepositoryWatcher(event.sender.id, repositoryPath);
  return state;
});

ipcMain.handle(
  'codiff:getLaunchOptions',
  (event) =>
    windowLaunchOptions.get(event.sender.id) || {
      walkthrough: false,
    },
);

ipcMain.handle('codiff:getWalkthrough', async (event, source) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  const state = await readRepositoryState(repositoryPath, source || launchOptions?.source);
  return readWalkthrough(state);
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

ipcMain.handle('codiff:writeReviewComments', async (event, payload) => {
  // Persist the renderer's in-memory review comments next to the repository
  // being reviewed. This gives external automation a stable file to read after
  // a human finishes commenting in the Codiff window.
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const state = await readRepositoryState(repositoryPath);
  const directory = join(state.root, '.codiff');
  const markdownPath = join(directory, 'review-comments.md');
  const jsonPath = join(directory, 'review-comments.json');

  // Treat the IPC payload as untrusted UI input: normalize missing/malformed
  // values so a bad renderer message cannot crash the main process handler.
  const comments = Array.isArray(payload?.comments) ? payload.comments : [];
  const markdown = typeof payload?.markdown === 'string' ? payload.markdown : '';

  mkdirSync(directory, { recursive: true });
  writeFileSync(markdownPath, markdown, 'utf8');
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        comments,
        generatedAt: new Date().toISOString(),
        repositoryRoot: state.root,
        source: state.source,
      },
      null,
      2,
    ),
    'utf8',
  );

  return { jsonPath, markdownPath };
});

ipcMain.handle('codiff:getRelativePath', async (event, filePath) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const state = await readRepositoryState(repositoryPath);
  return relative(state.root, filePath);
});
