// @ts-check

const electronProcessStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

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
const {
  configureCommandLog,
  recordCommandMilestone,
  runWithCommandAction,
  startCommandAction,
} = require('./command-log.cjs');

app.setName('Codiff');
const squirrelStartup = require('electron-squirrel-startup');
const {
  listRepositoryHistory,
  readDiffImageContent,
  readDiffSectionContent,
  readDiffSectionsContent,
  readGitIdentity,
  readRepositoryState,
  readReviewComments,
  readWalkthroughRepositoryState,
  resolveReviewContext,
  runWithCommandSignal,
  submitPullRequestComment,
  submitPullRequestReview,
  validateRepositoryPath,
} = require('./git-state.cjs');
const { attachExternalLinkHandling } = require('./external-links.cjs');
const { normalizeOpenAIModel } = require('./codex.cjs');
const { normalizeClaudeModel } = require('./claude.cjs');
const { normalizeOpenCodeModel, renderOpenCodeCommand } = require('./opencode.cjs');
const { parseJSONMessage } = require('./agent-shared.cjs');
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
  storeResolvedWindowState,
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
  NARRATIVE_WALKTHROUGH_AUTHORING_VERSION,
  createNarrativeWalkthroughGenerationRequest,
  narrativeWalkthroughResponseSchema,
  normalizeNarrativeWalkthrough,
  resolveNarrativeWalkthroughModel,
} = require('./narrative-walkthrough.cjs');
const {
  createCommitWalkthroughUnits,
  runStructuredWalkthroughGeneration,
  runWalkthroughGenerationTasks,
} = require('./walkthrough-generation-bridge.cjs');
const {
  createWalkthroughGenerationCoordinator,
} = require('./walkthrough-generation-coordinator.cjs');
const { getWalkthroughGenerationCacheKey } = require('./walkthrough-generation-cache-key.cjs');
const {
  invokeWalkthroughModel,
  parseStructuredModelResponse,
} = require('./walkthrough-model-invocation.cjs');
const {
  readStoredWalkthrough,
  replaceStoredAssessment,
  writeStoredWalkthrough,
} = require('./walkthrough-store.cjs');
const { buildWalkthroughAssessmentPlan } = require('./walkthrough-assessment-plan.cjs');
const { createWalkthroughAssessmentScheduler } = require('./walkthrough-assessment-scheduler.cjs');
const { loadAuthoring, parsePersistedWalkthrough } = require('./walkthrough-authoring-bridge.cjs');
const { walkthroughAssessmentResponseSchema } = require('./narrative-walkthrough-schema.cjs');
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
  getRepositoryWatcherInitialSnapshot,
  readRepositoryWatcherSnapshot,
} = require('./repository-watcher.cjs');
const { getPlanReviewPath, readPlanReview, writePlanReview } = require('./plan-review.cjs');
const { createSharedPlanSnapshot } = require('./shared-plan.cjs');
const { createWalkthroughProgressReporter } = require('./walkthrough-progress.cjs');
const { getLocalReviewWalkthroughCacheKey } = require('./local-review-walkthrough-cache-key.cjs');

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
/** @type {Map<number, Map<string, AbortController>>} */
const diffContentRequests = new Map();
/** @type {Map<number, CodiffLaunchOptions>} */
const windowLaunchOptions = new Map();
/** @type {Map<number, Promise<RepositoryState>>} */
const windowInitialRepositoryStates = new Map();
/** @type {Map<number, number>} */
const walkthroughProgressGenerations = new Map();
const walkthroughGenerationCoordinator = createWalkthroughGenerationCoordinator();
const walkthroughAssessmentScheduler = createWalkthroughAssessmentScheduler({
  replace: replaceStoredAssessment,
});
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
/** @type {Map<number, ReturnType<typeof startCommandAction>>} */
const initialLoadActions = new Map();
const pendingCommentsClipboardController = createPendingCommentsClipboardController({ clipboard });
/** @type {CodiffConfig} */
let config = createDefaultConfig();

/** @template Value @param {number} webContentsId @param {() => Value} callback */
const runInInitialLoadAction = (webContentsId, callback) => {
  const action = initialLoadActions.get(webContentsId);
  return action ? action.run(callback) : callback();
};

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
const abortDiffContentRequests = (webContentsId) => {
  const requests = diffContentRequests.get(webContentsId);
  if (!requests) {
    return;
  }
  diffContentRequests.delete(webContentsId);
  for (const controller of requests.values()) {
    controller.abort(new DOMException('Diff content request canceled.', 'AbortError'));
  }
};

const runDiffContentRequest = async (event, request, read) => {
  const requestId =
    typeof request?.requestId === 'string' && request.requestId
      ? request.requestId
      : `legacy:${Date.now()}:${Math.random()}`;
  const webContentsId = event.sender.id;
  const requests = diffContentRequests.get(webContentsId) ?? new Map();
  diffContentRequests.set(webContentsId, requests);
  requests
    .get(requestId)
    ?.abort(new DOMException('Diff content request superseded.', 'AbortError'));
  const controller = new AbortController();
  requests.set(requestId, controller);
  try {
    return await runWithCommandSignal(controller.signal, read);
  } finally {
    if (requests.get(requestId) === controller) {
      requests.delete(requestId);
    }
    if (requests.size === 0) {
      diffContentRequests.delete(webContentsId);
    }
  }
};

/** @param {string} repositoryPath @param {ReviewSource} [source] @param {string} [repositoryRoot] */
const readRepositoryStateWithConfig = (repositoryPath, source, repositoryRoot) =>
  readRepositoryState(repositoryPath, source, {
    repositoryRoot,
    showWhitespace: config.settings.showWhitespace,
  });

/** @param {string} repositoryPath @param {CodiffLaunchOptions} launchOptions @param {string} [repositoryRoot] */
const readInitialRepositoryStateWithConfig = (repositoryPath, launchOptions, repositoryRoot) =>
  launchOptions.walkthrough && !launchOptions.walkthroughFile
    ? readWalkthroughRepositoryState(repositoryPath, launchOptions.source, {
        showWhitespace: config.settings.showWhitespace,
      })
    : readRepositoryStateWithConfig(repositoryPath, launchOptions.source, repositoryRoot);

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
  storeResolvedWindowState(webContentsId, state, {
    identities: windowIdentities,
    launchOptions: windowLaunchOptions,
    repositories: windowRepositories,
  });
  const browserWindow = BrowserWindow.getAllWindows().find(
    (window) => window.webContents.id === webContentsId,
  );
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.setTitle(getRepositoryWindowTitle(state));
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

/**
 * @param {import('electron').BrowserWindow} browserWindow
 * @param {string} repositoryPath
 * @param {Promise<{head: string; pathSignatures: Record<string, string>; pathVersions: Record<string, string>; root: string; signature: string}> | undefined} initialSnapshot
 */
const startRepositoryWatcher = (browserWindow, repositoryPath, initialSnapshot) => {
  const webContentsId = browserWindow.webContents.id;
  void repositoryWatcherCoordinator.attach({
    getState: () => ({
      focused: !browserWindow.isDestroyed() && browserWindow.isFocused(),
      visible:
        !browserWindow.isDestroyed() && browserWindow.isVisible() && !browserWindow.isMinimized(),
    }),
    id: webContentsId,
    initialSnapshot,
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
 * @param {ReturnType<typeof startCommandAction>} initialLoadAction
 */
const createWindow = (
  repositoryPath,
  launchOptions = { repositoryPathProvided: true, walkthrough: false },
  identity,
  initialLoadAction,
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
  initialLoadActions.set(webContentsId, initialLoadAction);
  recordCommandMilestone('window-created', { actionId: initialLoadAction.id });
  openWindows.add(window);
  if (identity) {
    windowIdentities.set(webContentsId, identity);
  }
  windowRepositories.set(webContentsId, identity?.repositoryRoot || repositoryPath);
  windowLaunchOptions.set(webContentsId, launchOptions);
  const initialRepositoryStatePromise = launchOptions.planFile
    ? null
    : initialLoadAction.run(() =>
        readInitialRepositoryStateWithConfig(
          repositoryPath,
          launchOptions,
          identity?.repositoryRoot,
        ),
      );
  const initialRepositoryState = initialRepositoryStatePromise?.then(
    (state) => {
      recordCommandMilestone('repository-review-state-available', {
        actionId: initialLoadAction.id,
      });
      if (!window.isDestroyed()) {
        storeResolvedRepositoryState(webContentsId, state);
      }
      return state;
    },
    (error) => {
      initialLoadAction.finish({ error });
      if (initialLoadActions.get(webContentsId) === initialLoadAction) {
        initialLoadActions.delete(webContentsId);
      }
      throw error;
    },
  );
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
          startRepositoryWatcher(window, state.root, getRepositoryWatcherInitialSnapshot(state));
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
  window.once('ready-to-show', () => {
    window.show();
    if (launchOptions.planFile) {
      initialLoadAction.finish();
      initialLoadActions.delete(webContentsId);
    }
  });
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
    initialLoadActions.get(webContentsId)?.cancel();
    initialLoadActions.delete(webContentsId);
    openWindows.delete(window);
    repositoryWatcherCoordinator.detach(webContentsId);
    clearMarkdownDocumentWatchers(webContentsId);
    completedPlanWindows.delete(webContentsId);
    planInitialVersions.delete(webContentsId);
    readyPlanWindows.delete(webContentsId);
    walkthroughGenerationCoordinator.clear(
      webContentsId,
      new Error('The walkthrough window was closed.'),
    );
    abortDiffContentRequests(webContentsId);
    windowIdentities.delete(webContentsId);
    windowInitialRepositoryStates.delete(webContentsId);
    walkthroughProgressGenerations.delete(webContentsId);
    windowRepositories.delete(webContentsId);
    windowLaunchOptions.delete(webContentsId);
  });
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) {
      abortDiffContentRequests(webContentsId);
      walkthroughGenerationCoordinator.clear(
        webContentsId,
        new Error('The walkthrough renderer was reloaded.'),
      );
    }
  });
  window.webContents.on('render-process-gone', () => {
    walkthroughGenerationCoordinator.clear(
      webContentsId,
      new Error('The walkthrough renderer process exited.'),
    );
    abortDiffContentRequests(webContentsId);
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
  const uploader = await runInInitialLoadAction(webContentsId, () =>
    readGitIdentity(repositoryPath),
  );

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
  const initialLoadAction = startCommandAction({
    command: 'initial-load',
    cwd: repositoryPath,
    details: {
      explicitSource: Boolean(launchOptions.source),
      sourceType: launchOptions.source?.type,
    },
  });
  const identity = initialLoadAction.run(() => getWindowIdentity(repositoryPath, launchOptions));
  const matchingWebContentsId = findMatchingWindowIdentity(identity, windowIdentities);
  const matchingWindow =
    matchingWebContentsId == null
      ? null
      : BrowserWindow.getAllWindows().find(
          (window) => window.webContents.id === matchingWebContentsId,
        );

  if (matchingWindow) {
    if (launchOptions.planFile || launchOptions.walkthrough || launchOptions.walkthroughFile) {
      initialLoadActions.get(matchingWebContentsId)?.cancel();
      initialLoadActions.set(matchingWebContentsId, initialLoadAction);
      windowRepositories.set(matchingWebContentsId, identity?.repositoryRoot || repositoryPath);
      windowLaunchOptions.set(matchingWebContentsId, launchOptions);
      if (launchOptions.planFile) {
        planInitialVersions.delete(matchingWebContentsId);
        readyPlanWindows.delete(matchingWebContentsId);
        windowInitialRepositoryStates.delete(matchingWebContentsId);
      } else {
        const initialState = initialLoadAction.run(() =>
          readInitialRepositoryStateWithConfig(
            repositoryPath,
            launchOptions,
            identity?.repositoryRoot,
          ),
        );
        windowInitialRepositoryStates.set(matchingWebContentsId, initialState);
        initialState.then(
          () =>
            recordCommandMilestone('repository-review-state-available', {
              actionId: initialLoadAction.id,
            }),
          (error) => {
            initialLoadAction.finish({ error });
            if (initialLoadActions.get(matchingWebContentsId) === initialLoadAction) {
              initialLoadActions.delete(matchingWebContentsId);
            }
          },
        );
      }
      if (identity) {
        windowIdentities.set(matchingWebContentsId, identity);
      }
      walkthroughGenerationCoordinator.clear(
        matchingWebContentsId,
        new Error('The walkthrough window was retargeted.'),
      );
      abortDiffContentRequests(matchingWebContentsId);
      matchingWindow.reload();
      if (launchOptions.planFile) {
        initialLoadAction.finish();
        initialLoadActions.delete(matchingWebContentsId);
      }
    } else {
      initialLoadAction.finish();
    }
    focusWindow(matchingWindow);
    return matchingWindow;
  }

  return createWindow(repositoryPath, launchOptions, identity, initialLoadAction);
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
  configureCommandLog(app.getPath('logs'), { processStartedAt: electronProcessStartedAt });
  recordCommandMilestone('electron-process-start', {
    monotonicMs: 0,
    timestamp: electronProcessStartedAt,
  });
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
    recordCommandMilestone('electron-ready');
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
  if (!initialState) {
    void resetRepositoryWatcher(event.sender.id, state.root);
  }
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

ipcMain.handle('codiff:cancelNarrativeWalkthrough', (event) => {
  const progressGeneration = (walkthroughProgressGenerations.get(event.sender.id) || 0) + 1;
  walkthroughProgressGenerations.set(event.sender.id, progressGeneration);
  walkthroughGenerationCoordinator.cancel(event.sender.id, new Error('The review source changed.'));
});

/** @param {import('../core/types.ts').NarrativeWalkthroughUpdate} update */
const broadcastNarrativeWalkthroughUpdate = (update) => {
  for (const window of openWindows) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('codiff:narrativeWalkthroughUpdated', update);
    }
  }
};

const getSingleDiffNarrativeWalkthrough = async (event, request) => {
  const source = request?.source;
  const options = request;
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  const abortController = walkthroughGenerationCoordinator.begin(event.sender.id);
  const progressGeneration = (walkthroughProgressGenerations.get(event.sender.id) || 0) + 1;
  walkthroughProgressGenerations.set(event.sender.id, progressGeneration);
  const reportProgress = createWalkthroughProgressReporter(
    event.sender,
    () => walkthroughProgressGenerations.get(event.sender.id) === progressGeneration,
  );

  try {
    reportProgress({ phase: 'preparing', summary: 'Loading review state.' });
    const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
    const state = await runWithCommandSignal(abortController.signal, () =>
      readRepositoryStateWithConfig(repositoryPath, source || launchOptions?.source),
    );
    abortController.signal.throwIfAborted();
    const agent = resolveWindowAgent(event.sender.id);
    const walkthroughFile = launchOptions?.walkthroughFile;
    if (walkthroughFile) {
      let contents;
      let input;
      try {
        contents = readFileSync(walkthroughFile, 'utf8');
      } catch (error) {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason;
        }
        const detail = error instanceof Error ? error.message : String(error);
        return {
          reason: `Could not read walkthrough file: ${detail}`,
          status: 'unavailable',
        };
      }

      const sessionContext = await Promise.resolve(
        agent.readSessionContext(launchOptions?.[agent.sessionLaunchOptionKey]),
      ).catch(() => null);
      abortController.signal.throwIfAborted();
      try {
        input = JSON.parse(contents);
      } catch (error) {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason;
        }
        const detail = error instanceof Error ? error.message : String(error);
        return {
          reason: `Could not read walkthrough file: ${detail}`,
          status: 'unavailable',
        };
      }

      try {
        abortController.signal.throwIfAborted();
        return {
          status: 'ready',
          walkthrough: await normalizeNarrativeWalkthrough(input, state.files, {
            agent: agent.id,
            branch: state.branch,
            context: sessionContext,
            generatedAt: state.generatedAt,
            model: 'imported',
            root: state.root,
            source: state.source,
          }),
        };
      } catch (error) {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason;
        }
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
    abortController.signal.throwIfAborted();
    const agentOptions = getAgentOptions(agent);
    const walkthroughModel = resolveNarrativeWalkthroughModel(state, agent, agentOptions.model);
    const walkthroughPrompt = config.settings.walkthroughPrompt;
    const generationRequest = await createNarrativeWalkthroughGenerationRequest(
      state,
      agent,
      walkthroughContext,
      walkthroughPrompt,
      options?.previousWalkthrough,
    );
    const modelCandidates = agent.getModelCandidates(walkthroughModel);
    const profile = {
      agent: agent.id,
      authoringVersion: NARRATIVE_WALKTHROUGH_AUTHORING_VERSION,
      modelCandidates,
    };
    const cacheRequest = {
      prompt: generationRequest.prompt,
      responseSchema: narrativeWalkthroughResponseSchema,
    };
    const cacheKey = getWalkthroughGenerationCacheKey({
      profile,
      request: cacheRequest,
      state,
    });
    let artifact = null;
    const activeCacheKey = cacheKey;
    if (!options?.force) {
      const storedWalkthrough = readStoredWalkthrough(cacheKey);
      let cachedWalkthrough = null;
      try {
        cachedWalkthrough = storedWalkthrough
          ? await parsePersistedWalkthrough(storedWalkthrough)
          : null;
      } catch {
        // Ignore malformed cache entries and regenerate from current inputs.
      }
      if (cachedWalkthrough) {
        reportProgress({
          completed: 1,
          phase: 'combining',
          summary: 'Loaded the cached walkthrough.',
          total: 1,
          units: [{ id: 'narrative', label: 'Walkthrough narrative', status: 'ready' }],
        });
        if (cachedWalkthrough.version !== 5) {
          return {
            status: 'ready',
            walkthrough: {
              ...cachedWalkthrough,
              ...(walkthroughContext ? { context: walkthroughContext } : {}),
              agent: agent.id,
              repo: { branch: state.branch, root: state.root },
              source: state.source,
            },
          };
        }
        artifact = cachedWalkthrough;
      }
    }

    let generatedModel = artifact?.narrative?.generationMetadata?.model ?? walkthroughModel;
    if (!artifact) {
      let notFoundCode;
      const result = await runWalkthroughGenerationTasks({
        onProgress: reportProgress,
        reusableComponents: walkthroughGenerationCoordinator.getReusable(
          event.sender.id,
          cacheKey,
          options?.force,
        ),
        signal: abortController.signal,
        tasks: [
          {
            id: 'narrative',
            identity: cacheKey,
            label: 'Walkthrough narrative',
            profile,
            run: async ({ profile: taskProfile, semanticInput, signal }) => {
              try {
                reportProgress('agent-generation');
                const invocation = await invokeWalkthroughModel({
                  agent,
                  agentOptions: { ...agentOptions, onProgress: reportProgress },
                  outputName: generationRequest.outputName,
                  profile: taskProfile,
                  prompt: semanticInput.prompt,
                  repoRoot: state.root,
                  schema: generationRequest.schema,
                  signal,
                  timeoutMessage: generationRequest.timeoutMessage,
                  timeoutMs: generationRequest.timeoutMs,
                });
                reportProgress('response-received');
                const walkthrough = await normalizeNarrativeWalkthrough(
                  parseStructuredModelResponse(invocation.response),
                  state.files,
                  {
                    agent: agent.id,
                    branch: state.branch,
                    customInstructions:
                      typeof walkthroughPrompt === 'string' ? walkthroughPrompt : undefined,
                    generatedAt: invocation.generationMetadata.generatedAt,
                    model: invocation.generationMetadata.model,
                    root: state.root,
                    source: state.source,
                  },
                  generationRequest.hunkIdByAlias,
                );
                if (walkthroughContext && !walkthrough.narrative.context) {
                  walkthrough.narrative.context = walkthroughContext;
                }
                return { generationMetadata: invocation.generationMetadata, output: walkthrough };
              } catch (error) {
                if (agent.isNotFoundError(error)) {
                  notFoundCode = agent.notFoundCode;
                }
                throw error;
              }
            },
            semanticInput: { prompt: generationRequest.prompt },
          },
        ],
      });
      walkthroughGenerationCoordinator.retain(
        event.sender.id,
        abortController,
        cacheKey,
        result.components,
      );
      if (result.status !== 'ready') {
        return {
          ...(notFoundCode ? { code: notFoundCode } : {}),
          reason: result.reason,
          status: 'unavailable',
        };
      }
      const narrativeComponent = result.components.find(
        (component) => component.identity === cacheKey,
      );
      artifact = narrativeComponent?.output ?? null;
      if (!artifact) {
        throw new Error('Walkthrough generation completed without a validated narrative.');
      }
      generatedModel = narrativeComponent?.generationMetadata.model ?? walkthroughModel;
      abortController.signal.throwIfAborted();
      try {
        const cacheableWalkthrough = {
          ...artifact,
          narrative: { ...artifact.narrative },
        };
        delete cacheableWalkthrough.narrative.context;
        writeStoredWalkthrough(cacheKey, cacheableWalkthrough);
      } catch {
        // Caching is optional; a filesystem failure must not hide a generated result.
      }
    }

    const authoring = await loadAuthoring();
    const assessmentModels = [
      generatedModel,
      ...(agent.fallbackModel && agent.fallbackModel !== generatedModel
        ? [agent.fallbackModel]
        : []),
    ];
    const assessmentProfile = authoring.createAssessmentGenerationProfile({
      agent: agent.id,
      modelCandidates: assessmentModels,
      settings: { scope: 'single-diff-assessment' },
    });
    const assessmentPlan = buildWalkthroughAssessmentPlan({
      artifact,
      authoring,
      comments: state.reviewComments ?? [],
      profile: assessmentProfile,
    });
    let assessmentStorageReady = readStoredWalkthrough(activeCacheKey)?.version === 5;
    try {
      if (!authoring.assessmentValuesEqual(artifact, assessmentPlan.artifact)) {
        writeStoredWalkthrough(activeCacheKey, assessmentPlan.artifact);
      } else if (!assessmentStorageReady) {
        writeStoredWalkthrough(activeCacheKey, artifact);
      }
      assessmentStorageReady = true;
    } catch {
      // Caching is optional; narrative publication remains successful.
    }

    const pendingAssessmentThreadIds = new Set(
      assessmentStorageReady
        ? assessmentPlan.tasks.map((task) => task.demand.identity.threadId)
        : [],
    );
    for (const task of assessmentStorageReady ? assessmentPlan.tasks : []) {
      void walkthroughAssessmentScheduler.schedule({
        cacheKey: activeCacheKey,
        demand: task.demand,
        expectedComponent: task.expectedComponent,
        generate: () =>
          authoring.generateAssessmentComponent({
            capturedContext: assessmentPlan.artifact.capturedContext,
            demand: task.demand,
            profile: assessmentProfile,
            runModel: async ({ profile: runProfile, prompt }) => {
              const invocation = await invokeWalkthroughModel({
                agent,
                agentOptions: getAgentOptions(agent),
                outputName: 'walkthrough-assessment.json',
                profile: runProfile,
                prompt,
                repoRoot: state.root,
                schema: walkthroughAssessmentResponseSchema,
                timeoutMessage: `${agent.label} assessment timed out.`,
                timeoutMs: agent.defaultTimeoutMs,
              });
              return {
                generationMetadata: invocation.generationMetadata,
                response: parseStructuredModelResponse(invocation.response),
              };
            },
          }),
        onUpdate: (walkthrough) => {
          pendingAssessmentThreadIds.delete(task.demand.identity.threadId);
          broadcastNarrativeWalkthroughUpdate({
            cacheKey: activeCacheKey,
            pendingAssessmentThreadIds: [...pendingAssessmentThreadIds],
            walkthrough: walkthroughContext
              ? {
                  ...walkthrough,
                  narrative: {
                    ...walkthrough.narrative,
                    content: { ...walkthrough.narrative.content, context: walkthroughContext },
                  },
                }
              : walkthrough,
          });
        },
      });
    }
    return {
      cacheKey: activeCacheKey,
      pendingAssessmentThreadIds: [...pendingAssessmentThreadIds],
      status: 'ready',
      walkthrough: walkthroughContext
        ? {
            ...assessmentPlan.artifact,
            narrative: {
              ...assessmentPlan.artifact.narrative,
              content: {
                ...assessmentPlan.artifact.narrative.content,
                context: walkthroughContext,
              },
            },
          }
        : assessmentPlan.artifact,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    reportProgress({
      completed: 0,
      phase: 'generating',
      summary: 'Walkthrough generation failed.',
      total: 1,
      units: [
        { detail: reason, id: 'narrative', label: 'Walkthrough narrative', status: 'failed' },
      ],
    });
    return {
      reason,
      status: 'unavailable',
    };
  } finally {
    walkthroughGenerationCoordinator.finish(event.sender.id, abortController);
  }
};

/** @param {ReadonlyArray<any>} values @param {number} limit @param {(value: any) => Promise<void>} visit */
const forEachWalkthroughUnit = async (values, limit, visit) => {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const value = values[nextIndex];
      nextIndex += 1;
      await visit(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
};

const getTargetComparisonNarrativeWalkthrough = async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const progressGeneration = (walkthroughProgressGenerations.get(event.sender.id) || 0) + 1;
  walkthroughProgressGenerations.set(event.sender.id, progressGeneration);
  const reportProgress = createWalkthroughProgressReporter(
    event.sender,
    () => walkthroughProgressGenerations.get(event.sender.id) === progressGeneration,
  );
  if (
    request?.kind !== 'target-comparison' ||
    !request.source ||
    request.source.type !== 'pull-request'
  ) {
    return { reason: 'A structured pull request request is required.', status: 'unavailable' };
  }
  const abortController = walkthroughGenerationCoordinator.begin(event.sender.id);

  try {
    reportProgress({ phase: 'preparing', summary: 'Loading target comparison.' });
    const whole = await runWithCommandSignal(abortController.signal, () =>
      readRepositoryStateWithConfig(repositoryPath, request.source),
    );
    abortController.signal.throwIfAborted();
    const authoring = await loadAuthoring();
    const agent = resolveWindowAgent(event.sender.id);
    const agentOptions = getAgentOptions(agent);
    const modelCandidates = [
      ...new Set([
        agent.normalizeModel(agentOptions.model),
        agent.normalizeModel(agentOptions.fallbackModel ?? agent.fallbackModel),
      ]),
    ];
    const profileForScope = (scope) =>
      authoring.createWalkthroughGenerationProfile({
        agent: agent.id,
        modelCandidates,
        settings: {
          scope: scope.kind,
          ...('sha' in scope ? { sha: scope.sha } : {}),
        },
      });
    const selection = request.selection;
    const units =
      selection.structure === 'commit-by-commit'
        ? createCommitWalkthroughUnits(request.commits)
        : undefined;
    /** @type {Record<string, import('../core/types.ts').RepositoryState>} */
    const byCommitSha = {};
    if (units) {
      reportProgress({
        completed: 0,
        phase: 'preparing',
        summary: `Preparing ${units.length} commit diffs.`,
        total: units.length,
      });
      await forEachWalkthroughUnit(units, 3, async (unit) => {
        const parentSha = unit.commit.parentShas[0];
        byCommitSha[unit.commit.sha] = await runWithCommandSignal(abortController.signal, () =>
          readRepositoryStateWithConfig(
            repositoryPath,
            parentSha
              ? {
                  base: parentSha,
                  head: unit.commit.sha,
                  symmetric: false,
                  type: 'range',
                }
              : { ref: unit.commit.sha, type: 'commit' },
          ),
        );
      });
      abortController.signal.throwIfAborted();
    }

    const generationRequest = authoring.createWalkthroughGenerationRequest(
      {
        range: selection.range,
        relation: 'target-comparison',
        structure: selection.structure,
      },
      config.settings.walkthroughPrompt,
    );
    const cacheKey = getLocalReviewWalkthroughCacheKey({
      generationRequest,
      profile: profileForScope({ kind: 'complete-diff' }),
      state: whole,
    });
    /** @type {import('../core/types.ts').WalkthroughArtifactV5 | null} */
    let artifact = null;
    if (!request.force) {
      const cached = readStoredWalkthrough(cacheKey);
      if (cached?.version === 5) {
        try {
          artifact = await parsePersistedWalkthrough(cached);
        } catch {
          // Ignore malformed cache entries and regenerate from authoritative inputs.
        }
      }
    }

    const runModel = async ({ profile, prompt, signal }) => {
      const result = await invokeWalkthroughModel({
        agent,
        agentOptions,
        outputName: 'walkthrough.json',
        profile,
        prompt,
        repoRoot: whole.root,
        schema: narrativeWalkthroughResponseSchema,
        signal,
        timeoutMessage: `${agent.label} walkthrough generation timed out.`,
        timeoutMs: agent.defaultTimeoutMs || 600_000,
      });
      return {
        generationMetadata: result.generationMetadata,
        response: parseStructuredModelResponse(result.response),
      };
    };

    if (!artifact) {
      const result = await runStructuredWalkthroughGeneration({
        customInstructions: config.settings.walkthroughPrompt,
        narrativeProfile: profileForScope,
        onProgress: reportProgress,
        reusableComponents: walkthroughGenerationCoordinator.getReusable(
          event.sender.id,
          cacheKey,
          request.force,
        ),
        runModel,
        selection,
        states: { byCommitSha, whole },
        units,
      });
      walkthroughGenerationCoordinator.retain(
        event.sender.id,
        abortController,
        cacheKey,
        result.reusableComponents,
      );
      if (result.status !== 'ready') {
        return { failures: result.failures, reason: result.reason, status: 'unavailable' };
      }
      artifact = result.artifact;
    }

    const assessmentProfile = authoring.createAssessmentGenerationProfile({
      agent: agent.id,
      modelCandidates,
      settings: { scope: 'target-comparison-assessment' },
    });
    const assessmentPlan = buildWalkthroughAssessmentPlan({
      artifact,
      authoring,
      byCommitSha,
      comments: whole.reviewComments ?? [],
      profile: assessmentProfile,
      units,
    });
    let assessmentStorageReady = readStoredWalkthrough(cacheKey)?.version === 5;
    try {
      if (!authoring.assessmentValuesEqual(artifact, assessmentPlan.artifact)) {
        writeStoredWalkthrough(cacheKey, assessmentPlan.artifact);
      } else if (!assessmentStorageReady) {
        writeStoredWalkthrough(cacheKey, artifact);
      }
      assessmentStorageReady = true;
    } catch {
      // Caching is optional; narrative publication remains successful.
    }
    const pendingAssessmentThreadIds = new Set(
      assessmentStorageReady
        ? assessmentPlan.tasks.map((task) => task.demand.identity.threadId)
        : [],
    );
    for (const task of assessmentStorageReady ? assessmentPlan.tasks : []) {
      void walkthroughAssessmentScheduler.schedule({
        cacheKey,
        demand: task.demand,
        expectedComponent: task.expectedComponent,
        generate: () =>
          authoring.generateAssessmentComponent({
            capturedContext: assessmentPlan.artifact.capturedContext,
            demand: task.demand,
            profile: assessmentProfile,
            runModel: async ({ profile, prompt }) => {
              const result = await invokeWalkthroughModel({
                agent,
                agentOptions: getAgentOptions(agent),
                outputName: 'walkthrough-assessment.json',
                profile,
                prompt,
                repoRoot: whole.root,
                schema: walkthroughAssessmentResponseSchema,
                timeoutMessage: `${agent.label} assessment timed out.`,
              });
              return {
                generationMetadata: result.generationMetadata,
                response: parseStructuredModelResponse(result.response),
              };
            },
          }),
        onUpdate: (walkthrough) => {
          pendingAssessmentThreadIds.delete(task.demand.identity.threadId);
          broadcastNarrativeWalkthroughUpdate({
            cacheKey,
            pendingAssessmentThreadIds: [...pendingAssessmentThreadIds],
            walkthrough,
          });
        },
      });
    }
    return {
      cacheKey,
      pendingAssessmentThreadIds: [...pendingAssessmentThreadIds],
      status: 'ready',
      walkthrough: assessmentPlan.artifact,
    };
  } catch (error) {
    const agent = resolveWindowAgent(event.sender.id);
    return {
      ...(agent.isNotFoundError?.(error) ? { code: agent.notFoundCode } : {}),
      reason: error instanceof Error ? error.message : String(error),
      status: 'unavailable',
    };
  } finally {
    walkthroughGenerationCoordinator.finish(event.sender.id, abortController);
  }
};

ipcMain.handle('codiff:getNarrativeWalkthrough', (event, request) =>
  request?.kind === 'target-comparison'
    ? getTargetComparisonNarrativeWalkthrough(event, request)
    : getSingleDiffNarrativeWalkthrough(event, request),
);

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
  return runWithCommandAction(
    {
      command: 'walkthrough-commit',
      cwd: repositoryPath,
      details: { fileCount: Array.isArray(request?.paths) ? request.paths.length : 0 },
    },
    async () => {
      const result = await createWalkthroughCommit(repositoryPath, request, (chunk) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('codiff:walkthroughCommitOutput', chunk);
        }
      });
      if (result.status === 'committed') {
        await resetRepositoryWatcher(event.sender.id, repositoryPath);
      }
      return result;
    },
  );
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
  try {
    return await submitPullRequestReview(repositoryPath, request);
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: 'failed',
      submittedDraftIds: [],
    };
  }
});

ipcMain.handle('codiff:getDiffSectionContent', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return runDiffContentRequest(event, request, () =>
    runInInitialLoadAction(event.sender.id, () =>
      readDiffSectionContent(repositoryPath, {
        ...request,
        showWhitespace: request?.showWhitespace ?? config.settings.showWhitespace,
      }),
    ),
  );
});

ipcMain.handle('codiff:getDiffSectionsContent', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return runDiffContentRequest(event, request, () =>
    readDiffSectionsContent(repositoryPath, request),
  );
});

ipcMain.handle('codiff:getDiffImageContent', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return runDiffContentRequest(event, request, () =>
    runInInitialLoadAction(event.sender.id, () => readDiffImageContent(repositoryPath, request)),
  );
});

ipcMain.on('codiff:cancelDiffContentRequest', (event, requestId) => {
  if (typeof requestId !== 'string') {
    return;
  }
  diffContentRequests
    .get(event.sender.id)
    ?.get(requestId)
    ?.abort(new DOMException('Diff content request canceled.', 'AbortError'));
});

ipcMain.handle('codiff:resolveReviewContext', async (event, request, requestId) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return runDiffContentRequest(event, { requestId }, () =>
    resolveReviewContext(repositoryPath, request),
  );
});

ipcMain.handle('codiff:getRepositoryHistory', async (event, limit, source) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return runInInitialLoadAction(event.sender.id, () =>
    listRepositoryHistory(repositoryPath, limit, source),
  );
});

ipcMain.on('codiff:initialLoadMilestone', (event, name) => {
  if (name !== 'first-usable-review-rendered' && name !== 'deferred-review-data-complete') {
    return;
  }
  const action = initialLoadActions.get(event.sender.id);
  if (!action) {
    return;
  }
  recordCommandMilestone(name, { actionId: action.id });
  if (name === 'deferred-review-data-complete') {
    action.finish();
    initialLoadActions.delete(event.sender.id);
  }
});

ipcMain.handle('codiff:getReviewComments', async (event, source, requestId) => {
  if (source?.type !== 'pull-request') {
    throw new Error('Review comments require a pull-request source.');
  }
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return runDiffContentRequest(event, { requestId }, () =>
    runInInitialLoadAction(event.sender.id, () => readReviewComments(repositoryPath, source)),
  );
});

ipcMain.handle('codiff:getGitIdentity', async (event) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return runInInitialLoadAction(event.sender.id, () => readGitIdentity(repositoryPath));
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

ipcMain.handle('codiff:openFile', async (event, filePath) => {
  const repositoryRoot = getWindowRepositoryRoot(event.sender.id);
  const repositoryFilePath = validateRepositoryPath(filePath);
  const absolutePath = resolve(repositoryRoot, repositoryFilePath);

  if (existsSync(absolutePath)) {
    await openFileInEditor(absolutePath, { repoPath: repositoryRoot });
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
