const { execFile, execFileSync } = require('node:child_process');
const {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
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
const { readWalkthrough } = require('./walkthrough.cjs');

const root = dirname(__dirname);
const repositoryWatchers = new Map();
const windowRepositories = new Map();
const windowLaunchOptions = new Map();
let preferences = {
  copyCommentsOnClose: false,
  openAIModel: DEFAULT_OPENAI_MODEL,
  showWhitespace: false,
  theme: 'system',
};

const commitHashPattern = /^[0-9a-f]{4,64}$/i;
const pullRequestNumberPattern = /^#([1-9]\d*)$/;

const isCommitHashArgument = (arg) => commitHashPattern.test(arg) && !existsSync(resolve(arg));

const parsePullRequestNumberArgument = (arg) => {
  const match = arg.match(pullRequestNumberPattern);
  return match ? Number(match[1]) : null;
};

const parsePullRequestNumberValue = (value) => {
  const normalized = value.startsWith('#') ? value : `#${value}`;
  return parsePullRequestNumberArgument(normalized);
};

const isPullRequestMarkerArgument = (arg) => /^(?:pr|pull-request)$/i.test(arg);

const isPullRequestUrlArgument = (arg) => {
  try {
    const url = new URL(arg);
    return (
      url.hostname.toLowerCase() === 'github.com' &&
      /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
};

const parseGitHubRemoteUrl = (value) => {
  const trimmed = value.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2].replace(/\.git$/i, ''),
    };
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== 'github.com') {
      return null;
    }

    const match = url.pathname.match(/^\/([^/]+)\/(.+?)(?:\.git)?$/);
    return match
      ? {
          owner: match[1],
          repo: match[2].replace(/\.git$/i, ''),
        }
      : null;
  } catch {
    return null;
  }
};

const readGitHubRemotes = (repositoryPath) => {
  const repoRoot = execFileSync('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const raw = execFileSync('git', ['-C', repoRoot, 'remote', '-v'], { encoding: 'utf8' });
  const remotes = [];

  for (const line of raw.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    const remote = match ? parseGitHubRemoteUrl(match[2]) : null;
    if (remote) {
      remotes.push({
        direction: match[3],
        name: match[1],
        ...remote,
      });
    }
  }

  return remotes;
};

const selectGitHubRemote = (remotes) =>
  [...remotes].sort((left, right) => {
    const getPriority = (remote) =>
      remote.name === 'origin'
        ? remote.direction === 'fetch'
          ? 0
          : 1
        : remote.direction === 'fetch'
          ? 2
          : 3;
    return getPriority(left) - getPriority(right);
  })[0] ?? null;

const resolvePullRequestUrl = (repositoryPath, number) => {
  let remotes;
  try {
    remotes = readGitHubRemotes(repositoryPath);
  } catch {
    throw new Error(
      `Could not resolve PR #${number}. Run codiff from inside a GitHub repository or pass a full GitHub pull request URL.`,
    );
  }

  const remote = selectGitHubRemote(remotes);
  if (!remote) {
    throw new Error(
      `Could not resolve PR #${number} because this repository has no GitHub remote.`,
    );
  }

  return `https://github.com/${remote.owner}/${remote.repo}/pull/${number}`;
};

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
  let pullRequestNumber = null;
  let pullRequestUrl = null;
  let repositoryPath = null;

  for (let index = 0; index < positionals.length; index += 1) {
    const arg = positionals[index];
    if (!pullRequestUrl && isPullRequestUrlArgument(arg)) {
      pullRequestUrl = arg;
      continue;
    }

    if (!pullRequestUrl && pullRequestNumber == null) {
      const number = parsePullRequestNumberArgument(arg);
      if (number != null) {
        pullRequestNumber = number;
        continue;
      }

      const nextNumber = isPullRequestMarkerArgument(arg)
        ? parsePullRequestNumberValue(positionals[index + 1] ?? '')
        : null;
      if (nextNumber != null) {
        pullRequestNumber = nextNumber;
        index += 1;
        continue;
      }
    }

    if (!commitRef && isCommitHashArgument(arg)) {
      commitRef = arg;
    } else if (repositoryPath == null) {
      repositoryPath = arg;
    }
  }

  const envCommitRef = useEnvironment ? process.env.CODIFF_COMMIT_REF || '' : '';
  const envPullRequestNumber = useEnvironment
    ? parsePullRequestNumberValue(process.env.CODIFF_PULL_REQUEST_NUMBER || '')
    : null;
  const envPullRequestUrl = useEnvironment ? process.env.CODIFF_PULL_REQUEST_URL || '' : '';
  const sourcePullRequestNumber = envPullRequestNumber ?? pullRequestNumber;
  const sourceRef = envCommitRef || commitRef;
  const sourcePullRequestUrl = envPullRequestUrl || pullRequestUrl;
  const repositoryPathProvided = Boolean(
    repositoryPath || (useEnvironment && process.env.CODIFF_REPOSITORY_PATH),
  );
  return {
    launchOptions: {
      repositoryPathProvided,
      source: sourcePullRequestUrl
        ? {
            type: 'pull-request',
            url: sourcePullRequestUrl,
          }
        : sourceRef && sourcePullRequestNumber == null
          ? {
              ref: sourceRef,
              type: 'commit',
            }
          : undefined,
      walkthrough:
        (useEnvironment && process.env.CODIFF_WALKTHROUGH === '1') || values.walkthrough === true,
    },
    pullRequestNumber: sourcePullRequestNumber,
    repositoryPath,
  };
};

const getCommandLineRepositoryPath = (commandLine = process.argv) =>
  parseCommandLineArguments(commandLine).repositoryPath;

const getCommandLineLaunchOptions = (commandLine = process.argv, fallbackPath = process.cwd()) => {
  const { launchOptions, pullRequestNumber, repositoryPath } =
    parseCommandLineArguments(commandLine);
  if (pullRequestNumber == null || launchOptions.source) {
    return launchOptions;
  }

  return {
    ...launchOptions,
    source: {
      type: 'pull-request',
      url: resolvePullRequestUrl(
        resolve(
          (commandLine === process.argv ? process.env.CODIFF_REPOSITORY_PATH : '') ||
            repositoryPath ||
            fallbackPath,
        ),
        pullRequestNumber,
      ),
    },
  };
};

const getLaunchPath = () =>
  resolve(process.env.CODIFF_REPOSITORY_PATH || getCommandLineRepositoryPath() || process.cwd());

const getLaunchOptions = () => getCommandLineLaunchOptions();

const getPreferencesPath = () => join(app.getPath('userData'), 'preferences.json');

const normalizeTheme = (theme) =>
  theme === 'system' || theme === 'light' || theme === 'dark' ? theme : 'system';

const readPreferences = () => {
  try {
    const storedPreferences = JSON.parse(readFileSync(getPreferencesPath(), 'utf8'));
    return {
      ...preferences,
      ...storedPreferences,
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
  onModelFallback: async (fallbackModel) => {
    updatePreferences({ openAIModel: fallbackModel });
  },
});

const updateTheme = (theme) => {
  updatePreferences({ theme });
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
    createWindow(result.filePaths[0], { repositoryPathProvided: true, walkthrough: false });
  }
};

const getTerminalHelperSourcePath = () =>
  app.isPackaged ? join(process.resourcesPath, 'app/bin/codiff-app') : join(root, 'bin/codiff.js');

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
    return true;
  } catch (error) {
    await dialog.showMessageBox(browserWindow ?? undefined, {
      buttons: ['OK'],
      detail: error instanceof Error ? error.message : String(error),
      message: 'Could not install the terminal helper.',
      type: 'error',
    });
    return false;
  }
};

const parseEditorCommand = (command) =>
  command.match(/"[^"]+"|'[^']+'|\S+/g)?.map((part) => part.replace(/^['"]|['"]$/g, '')) ?? [];

const runEditorCommand = (command, args) =>
  new Promise((resolveCommand) => {
    execFile(command, args, { windowsHide: true }, (error) => resolveCommand(!error));
  });

const getEditorCommands = (absolutePath) => {
  const commands = [];
  const customEditor = process.env.CODIFF_EDITOR;
  if (customEditor) {
    const [command, ...args] = parseEditorCommand(customEditor);
    if (command) {
      const hasFilePlaceholder = args.some((arg) => arg.includes('{file}'));
      commands.push({
        args:
          args.length > 0
            ? [
                ...args.map((arg) => arg.replaceAll('{file}', absolutePath)),
                ...(hasFilePlaceholder ? [] : [absolutePath]),
              ]
            : [absolutePath],
        command,
      });
    }
  }

  for (const command of ['/opt/homebrew/bin/code', '/usr/local/bin/code', 'code']) {
    commands.push({
      args: ['-g', absolutePath],
      command,
    });
  }

  if (process.platform === 'darwin') {
    commands.push({
      args: ['-a', 'Visual Studio Code', absolutePath],
      command: 'open',
    });
  }

  return commands;
};

const openFileInEditor = async (absolutePath) => {
  for (const { args, command } of getEditorCommands(absolutePath)) {
    if (await runEditorCommand(command, args)) {
      return;
    }
  }

  await shell.openPath(absolutePath);
};

const buildOpenAIModelSubmenu = () =>
  OPENAI_MODELS.map((model) => ({
    checked: preferences.openAIModel === model.id,
    click: () => selectOpenAIModel(model.id),
    label: model.label,
    type: 'radio',
  }));

const buildApplicationMenu = () =>
  Menu.buildFromTemplate([
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
          click: (_menuItem, browserWindow) => browserWindow?.webContents.toggleDevTools(),
          label: 'Toggle Developer Tools',
        },
      ],
    },
  ]);

let nextCopyPendingCommentsRequestId = 0;
const pendingCopyPendingCommentsRequests = new Map();
let quitting = false;

ipcMain.on('codiff:copyPendingCommentsResult', (event, requestId, markdown) => {
  const pending = pendingCopyPendingCommentsRequests.get(requestId);
  if (!pending || pending.webContentsId !== event.sender.id) {
    return;
  }

  pendingCopyPendingCommentsRequests.delete(requestId);
  pending.resolve(typeof markdown === 'string' ? markdown : '');
});

const requestPendingCommentsMarkdown = (browserWindow) =>
  new Promise((resolve) => {
    if (browserWindow.isDestroyed() || browserWindow.webContents.isDestroyed()) {
      resolve('');
      return;
    }

    const requestId = ++nextCopyPendingCommentsRequestId;
    const webContentsId = browserWindow.webContents.id;
    const timeout = setTimeout(() => {
      if (pendingCopyPendingCommentsRequests.delete(requestId)) {
        resolve('');
      }
    }, 2000);

    pendingCopyPendingCommentsRequests.set(requestId, {
      resolve: (markdown) => {
        clearTimeout(timeout);
        resolve(markdown);
      },
      webContentsId,
    });

    browserWindow.webContents.send('codiff:copyPendingCommentsRequest', requestId);
  });

const createWindow = (
  repositoryPath,
  launchOptions = { repositoryPathProvided: true, walkthrough: false },
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
  windowRepositories.set(webContentsId, repositoryPath);
  windowLaunchOptions.set(webContentsId, launchOptions);
  if (!launchOptions.source) {
    startRepositoryWatcher(window, repositoryPath);
  }
  window.once('ready-to-show', () => window.show());
  let allowClose = false;
  window.on('close', (event) => {
    if (allowClose || quitting || !preferences.copyCommentsOnClose) {
      return;
    }

    event.preventDefault();
    requestPendingCommentsMarkdown(window)
      .then((markdown) => {
        if (markdown) {
          clipboard.writeText(markdown);
        }
      })
      .finally(() => {
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
      additionalData?.launchOptions || getCommandLineLaunchOptions(commandLine, workingDirectory),
    );
  });

  app.on('ready', () => {
    preferences = readPreferences();
    nativeTheme.themeSource = preferences.theme;
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

  app.on('before-quit', () => {
    quitting = true;
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
