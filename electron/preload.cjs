// @ts-check

const { contextBridge, ipcRenderer } = require('electron');

const applyPlatformAttribute = () => {
  document.documentElement?.setAttribute('data-codiff-platform', process.platform);
};

if (document.documentElement) {
  applyPlatformAttribute();
} else {
  window.addEventListener('DOMContentLoaded', applyPlatformAttribute, { once: true });
}

/** @type {Window['codiff']} */
const codiff = {
  askReviewAssistant: (request) => ipcRenderer.invoke('codiff:askReviewAssistant', request),
  createWalkthroughCommit: (request) =>
    ipcRenderer.invoke('codiff:createWalkthroughCommit', request),
  completePlan: (review, status) => ipcRenderer.invoke('codiff:completePlan', review, status),
  updateWalkthroughCommitMessage: (request) =>
    ipcRenderer.invoke('codiff:updateWalkthroughCommitMessage', request),
  getAgentSkillStatus: () => ipcRenderer.invoke('codiff:getAgentSkillStatus'),
  getConfig: () => ipcRenderer.invoke('codiff:getConfig'),
  decreaseCodeFontSize: () => ipcRenderer.invoke('codiff:decreaseCodeFontSize'),
  getDiffSectionContent: (request) => ipcRenderer.invoke('codiff:getDiffSectionContent', request),
  getFeatureFlags: () => ipcRenderer.invoke('codiff:getFeatureFlags'),
  getDiffImageContent: (request) => ipcRenderer.invoke('codiff:getDiffImageContent', request),
  getGitIdentity: () => ipcRenderer.invoke('codiff:getGitIdentity'),
  getLaunchOptions: () => ipcRenderer.invoke('codiff:getLaunchOptions'),
  getMarkdownDocument: (request) => ipcRenderer.invoke('codiff:getMarkdownDocument', request),
  getPreferences: () => ipcRenderer.invoke('codiff:getPreferences'),
  getPlanReview: () => ipcRenderer.invoke('codiff:getPlanReview'),
  getRepositoryHistory: (limit, source) =>
    ipcRenderer.invoke('codiff:getRepositoryHistory', limit, source),
  getRepositoryState: (source) => ipcRenderer.invoke('codiff:getRepositoryState', source),
  getTerminalHelperStatus: () => ipcRenderer.invoke('codiff:getTerminalHelperStatus'),
  getNarrativeWalkthrough: (source) => ipcRenderer.invoke('codiff:getNarrativeWalkthrough', source),
  installAgentSkill: () => ipcRenderer.invoke('codiff:installAgentSkill'),
  installTerminalHelper: () => ipcRenderer.invoke('codiff:installTerminalHelper'),
  increaseCodeFontSize: () => ipcRenderer.invoke('codiff:increaseCodeFontSize'),
  isWindowFullScreen: () => ipcRenderer.invoke('codiff:isWindowFullScreen'),
  markPlanReady: () => ipcRenderer.invoke('codiff:markPlanReady'),
  onConfigChanged: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {import('../core/config/types.ts').CodiffConfig} nextConfig */
    const listener = (_event, nextConfig) => callback(nextConfig);
    ipcRenderer.on('codiff:configChanged', listener);
    return () => ipcRenderer.removeListener('codiff:configChanged', listener);
  },
  onCopyPendingCommentsRequest: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {number} requestId */
    const listener = (_event, requestId) => {
      Promise.resolve(callback()).then(
        (markdown) => {
          ipcRenderer.send(
            'codiff:copyPendingCommentsResult',
            requestId,
            typeof markdown === 'string' ? markdown : '',
          );
        },
        () => {
          ipcRenderer.send('codiff:copyPendingCommentsResult', requestId, '');
        },
      );
    };
    ipcRenderer.on('codiff:copyPendingCommentsRequest', listener);
    return () => ipcRenderer.removeListener('codiff:copyPendingCommentsRequest', listener);
  },
  onFindInDiffs: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('codiff:findInDiffs', listener);
    return () => ipcRenderer.removeListener('codiff:findInDiffs', listener);
  },
  onMarkdownDocumentChanged: (callback) => {
    const listener = (_event, change) => callback(change);
    ipcRenderer.on('codiff:markdownDocumentChanged', listener);
    return () => ipcRenderer.removeListener('codiff:markdownDocumentChanged', listener);
  },
  onPlanCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('codiff:planCloseRequested', listener);
    return () => ipcRenderer.removeListener('codiff:planCloseRequested', listener);
  },
  onWindowFullScreenChanged: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {boolean} isFullScreen */
    const listener = (_event, isFullScreen) => callback(Boolean(isFullScreen));
    ipcRenderer.on('codiff:windowFullScreenChanged', listener);
    return () => ipcRenderer.removeListener('codiff:windowFullScreenChanged', listener);
  },
  onRepositoryChanged: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {{root: string}} change */
    const listener = (_event, change) => callback(change);
    ipcRenderer.on('codiff:repositoryChanged', listener);
    return () => ipcRenderer.removeListener('codiff:repositoryChanged', listener);
  },
  onRefreshRequest: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('codiff:refreshRequest', listener);
    return () => ipcRenderer.removeListener('codiff:refreshRequest', listener);
  },
  openConfigFile: () => ipcRenderer.invoke('codiff:openConfigFile'),
  openFile: (path) => ipcRenderer.invoke('codiff:openFile', path),
  setDiffStyle: (value) => ipcRenderer.invoke('codiff:setDiffStyle', value),
  setShowOutdated: (value) => ipcRenderer.invoke('codiff:setShowOutdated', value),
  setWordWrap: (value) => ipcRenderer.invoke('codiff:setWordWrap', value),
  sharePlan: (review) => ipcRenderer.invoke('codiff:sharePlan', review),
  shareWalkthrough: (snapshot) => ipcRenderer.invoke('codiff:shareWalkthrough', snapshot),
  resetCodeFontSize: () => ipcRenderer.invoke('codiff:resetCodeFontSize'),
  saveMarkdownDocument: (request) => ipcRenderer.invoke('codiff:saveMarkdownDocument', request),
  savePlanReview: (review) => ipcRenderer.invoke('codiff:savePlanReview', review),
  showInFolder: (path) => ipcRenderer.invoke('codiff:showInFolder', path),
  submitPullRequestComment: (request) =>
    ipcRenderer.invoke('codiff:submitPullRequestComment', request),
  submitPullRequestReview: (request) =>
    ipcRenderer.invoke('codiff:submitPullRequestReview', request),
};

contextBridge.exposeInMainWorld('codiff', codiff);
