import type { CodiffConfig, CodiffKeymap, CodiffSettings } from './types.ts';

export const defaultSettings: CodiffSettings = {
  copyCommentsOnClose: false,
  lastRepositoryPath: '',
  openAIModel: 'gpt-5.3-codex-spark',
  showOutdated: false,
  showWhitespace: false,
  theme: 'system',
};

export const defaultKeymap: CodiffKeymap = {
  closeSearch: 'Escape',
  commandBar: 'Mod+Shift+p',
  diffSearch: 'Mod+f',
  discardComment: 'Escape',
  fileFilter: 'Mod+p',
  nextSearchMatch: 'Enter',
  prevSearchMatch: 'Shift+Enter',
  submitComment: 'Mod+Enter',
  toggleSidebar: 'Mod+b',
};

export const defaultConfig: CodiffConfig = {
  keymap: defaultKeymap,
  settings: defaultSettings,
};
