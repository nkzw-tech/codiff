// @ts-check

const { contextBridge, ipcRenderer } = require('electron');

/** @type {Window['codiff']} */
const codiff = {
  askReviewAssistant: (request) => ipcRenderer.invoke('codiff:askReviewAssistant', request),
  createWalkthroughCommit: (request) =>
    ipcRenderer.invoke('codiff:createWalkthroughCommit', request),
  updateWalkthroughCommitMessage: (request) =>
    ipcRenderer.invoke('codiff:updateWalkthroughCommitMessage', request),
  getAgentSkillStatus: () => ipcRenderer.invoke('codiff:getAgentSkillStatus'),
  getConfig: () => ipcRenderer.invoke('codiff:getConfig'),
  getDiffSectionContent: (request) => ipcRenderer.invoke('codiff:getDiffSectionContent', request),
  getDiffImageContent: (request) => ipcRenderer.invoke('codiff:getDiffImageContent', request),
  getGitIdentity: () => ipcRenderer.invoke('codiff:getGitIdentity'),
  getLaunchOptions: () => ipcRenderer.invoke('codiff:getLaunchOptions'),
  getPreferences: () => ipcRenderer.invoke('codiff:getPreferences'),
  getRepositoryHistory: (limit, source) =>
    ipcRenderer.invoke('codiff:getRepositoryHistory', limit, source),
  getRepositoryState: (source) => ipcRenderer.invoke('codiff:getRepositoryState', source),
  getTerminalHelperStatus: () => ipcRenderer.invoke('codiff:getTerminalHelperStatus'),
  getNarrativeWalkthrough: (source) => ipcRenderer.invoke('codiff:getNarrativeWalkthrough', source),
  getWalkthrough: (source) => ipcRenderer.invoke('codiff:getWalkthrough', source),
  installAgentSkill: () => ipcRenderer.invoke('codiff:installAgentSkill'),
  installTerminalHelper: () => ipcRenderer.invoke('codiff:installTerminalHelper'),
  onConfigChanged: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {import('../src/config/types.ts').CodiffConfig} nextConfig */
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
  onRepositoryChanged: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {{root: string}} change */
    const listener = (_event, change) => callback(change);
    ipcRenderer.on('codiff:repositoryChanged', listener);
    return () => ipcRenderer.removeListener('codiff:repositoryChanged', listener);
  },
  openConfigFile: () => ipcRenderer.invoke('codiff:openConfigFile'),
  openFile: (path) => ipcRenderer.invoke('codiff:openFile', path),
  setDiffStyle: (value) => ipcRenderer.invoke('codiff:setDiffStyle', value),
  setShowOutdated: (value) => ipcRenderer.invoke('codiff:setShowOutdated', value),
  setWordWrap: (value) => ipcRenderer.invoke('codiff:setWordWrap', value),
  showInFolder: (path) => ipcRenderer.invoke('codiff:showInFolder', path),
  submitPullRequestComment: (request) =>
    ipcRenderer.invoke('codiff:submitPullRequestComment', request),
  submitPullRequestReview: (request) =>
    ipcRenderer.invoke('codiff:submitPullRequestReview', request),
};

contextBridge.exposeInMainWorld('codiff', codiff);
