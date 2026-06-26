// @ts-check

const { readFileSync } = require('node:fs');
const { userInfo } = require('node:os');
const { getAgent } = require('./agent.cjs');
const { readConfig, writeConfig } = require('./config.cjs');
const { createCloudflareAccessClient } = require('./cloudflare-access.cjs');
const {
  readGitIdentity,
  readRepositoryState,
  readWalkthroughRepositoryState,
} = require('./git-state.cjs');
const {
  normalizeNarrativeWalkthrough,
  readNarrativeWalkthrough,
} = require('./narrative-walkthrough.cjs');
const { uploadSharedSnapshot } = require('./shared-walkthrough-upload.cjs');
const { mergeWalkthroughContexts, readWalkthroughContext } = require('./walkthrough-context.cjs');
const { resolveWalkthroughShareTarget } = require('./walkthrough-sharing.cjs');

/**
 * @typedef {import('../core/types.ts').ReviewSource} ReviewSource
 */

/**
 * @param {{
 *   codiffVersion: string;
 *   openExternal: (url: string) => Promise<void>;
 *   serviceUrlOverride?: string;
 *   snapshot: Record<string, unknown>;
 *   target?: {authenticated: boolean; internal: boolean; serviceUrl: string};
 *   uploader: {email?: string; name?: string};
 * }} options
 */
const uploadSnapshot = async ({
  codiffVersion,
  openExternal,
  serviceUrlOverride,
  snapshot,
  target: targetOverride,
  uploader,
}) => {
  let username = '';
  try {
    username = userInfo().username;
  } catch {}

  const target =
    targetOverride ||
    resolveWalkthroughShareTarget({
      email: uploader.email,
      overrideUrl: serviceUrlOverride,
      username,
    });
  if (!target) {
    throw new Error('Sharing is not available for this user.');
  }

  const accessClient = target.authenticated
    ? createCloudflareAccessClient({ serviceUrl: target.serviceUrl })
    : null;

  try {
    return await uploadSharedSnapshot({
      authenticate: accessClient?.authenticate,
      fetchImpl: accessClient?.fetch,
      openClaimPage: false,
      openExternal,
      serviceUrl: target.serviceUrl,
      snapshot: {
        ...snapshot,
        codiffVersion,
        exportedAt: new Date().toISOString(),
      },
      uploader: target.internal ? uploader : undefined,
    });
  } finally {
    accessClient?.clear();
  }
};

/**
 * @param {{
 *   codiffVersion: string;
 *   config: ReturnType<typeof readConfig>;
 *   openExternal: (url: string) => Promise<void>;
 *   serviceUrlOverride?: string;
 *   state: import('../core/types.ts').RepositoryState;
 *   uploader: {email?: string; name?: string};
 *   walkthrough: import('../core/types.ts').NarrativeWalkthrough;
 * }} options
 */
const uploadWalkthrough = async ({
  codiffVersion,
  config,
  openExternal,
  serviceUrlOverride,
  state,
  uploader,
  walkthrough,
}) =>
  uploadSnapshot({
    codiffVersion,
    openExternal,
    serviceUrlOverride,
    snapshot: {
      branch: state.branch,
      files: state.files,
      kind: 'codiff-walkthrough-share',
      preferences: {
        codeFontFamily: config.settings.codeFontFamily,
        codeFontSize: config.settings.codeFontSize,
        diffStyle: config.settings.diffStyle,
        showWhitespace: config.settings.showWhitespace,
        theme: config.settings.theme,
        wordWrap: config.settings.wordWrap,
      },
      repository: {
        root: state.root,
        source: state.source,
        title:
          state.source.type === 'commit' || state.source.type === 'arc-commit'
            ? state.commitMetadata?.subject
            : undefined,
      },
      reviewComments: state.reviewComments,
      version: 1,
      walkthrough,
    },
    uploader,
  });

/**
 * @param {string} repositoryPath
 * @param {ReviewSource} source
 * @param {ReturnType<typeof readConfig>} config
 */
const readShareState = async (repositoryPath, source, config) =>
  Promise.all([
    readRepositoryState(repositoryPath, source, {
      showWhitespace: config.settings.showWhitespace,
    }),
    readGitIdentity(repositoryPath),
  ]);

/**
 * @param {string} repositoryPath
 * @param {ReviewSource | undefined} source
 * @param {ReturnType<typeof readConfig>} config
 */
const readGeneratedShareState = async (repositoryPath, source, config) =>
  Promise.all([
    readWalkthroughRepositoryState(repositoryPath, source, {
      showWhitespace: config.settings.showWhitespace,
    }),
    readGitIdentity(repositoryPath),
  ]);

/**
 * @param {{
 *   agent?: 'claude' | 'codex' | 'opencode' | 'pi';
 *   codiffVersion: string;
 *   openExternal: (url: string) => Promise<void>;
 *   repositoryPath: string;
 *   serviceUrlOverride?: string;
 *   source?: ReviewSource;
 *   walkthroughFile: string;
 * }} options
 */
const shareWalkthroughFile = async ({
  agent,
  codiffVersion,
  openExternal,
  repositoryPath,
  serviceUrlOverride,
  source = { type: 'working-tree' },
  walkthroughFile,
}) => {
  const config = readConfig();
  const [state, uploader] = await readShareState(repositoryPath, source, config);

  let input;
  try {
    input = JSON.parse(readFileSync(walkthroughFile, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read walkthrough file: ${detail}`);
  }

  const walkthrough = normalizeNarrativeWalkthrough(input, state.files, {
    agent,
    branch: state.branch,
    generatedAt: state.generatedAt,
    root: state.root,
    source: state.source,
  });

  return uploadWalkthrough({
    codiffVersion,
    config,
    openExternal,
    serviceUrlOverride,
    state,
    uploader,
    walkthrough,
  });
};

/**
 * @param {{
 *   agent?: 'claude' | 'codex' | 'opencode' | 'pi';
 *   claudeSessionId?: string;
 *   codexSessionId?: string;
 *   codiffVersion: string;
 *   openExternal: (url: string) => Promise<void>;
 *   opencodeSessionId?: string;
 *   piSessionId?: string;
 *   repositoryPath: string;
 *   serviceUrlOverride?: string;
 *   source?: ReviewSource;
 *   walkthroughContextPath?: string;
 * }} options
 */
const generateAndShareWalkthrough = async ({
  agent: agentOverride,
  claudeSessionId,
  codexSessionId,
  codiffVersion,
  openExternal,
  opencodeSessionId,
  piSessionId,
  repositoryPath,
  serviceUrlOverride,
  source,
  walkthroughContextPath,
}) => {
  const config = readConfig();
  const agent = getAgent(agentOverride || config.settings.agentBackend);
  const [state, uploader] = await readGeneratedShareState(repositoryPath, source, config);
  const sessionIds = {
    claudeSessionId,
    codexSessionId,
    opencodeSessionId,
    piSessionId,
  };
  const providedContext = walkthroughContextPath
    ? readWalkthroughContext(walkthroughContextPath, codexSessionId)
    : null;
  const sessionContext = await agent.readSessionContext(sessionIds[agent.sessionLaunchOptionKey]);
  const result = await readNarrativeWalkthrough(
    state,
    agent,
    {
      fallbackModel: agent.fallbackModel,
      model: config.settings[agent.modelSettingKey],
      onModelFallback: async (fallbackModel) => {
        config.settings[agent.modelSettingKey] = fallbackModel;
        writeConfig(config);
      },
    },
    mergeWalkthroughContexts(providedContext, sessionContext),
    config.settings.walkthroughPrompt,
  );

  if (result.status !== 'ready') {
    throw new Error(result.reason || `${agent.label} could not generate a walkthrough.`);
  }

  return uploadWalkthrough({
    codiffVersion,
    config,
    openExternal,
    serviceUrlOverride,
    state,
    uploader,
    walkthrough: result.walkthrough,
  });
};

module.exports = {
  generateAndShareWalkthrough,
  shareWalkthroughFile,
  uploadSnapshot,
};
