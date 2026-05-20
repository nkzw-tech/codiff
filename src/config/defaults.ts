import type { CodiffConfig, CodiffKeymap, CodiffSettings } from './types.ts';

export const defaultSettings: CodiffSettings = {
  copyCommentsOnClose: false,
  openAIModel: 'gpt-5.3-codex-spark',
  showWhitespace: false,
  theme: 'system',
};

export const defaultKeymap: CodiffKeymap = {
  closeSearch: 'Escape',
  diffSearch: 'Mod+f',
  discardComment: 'Escape',
  fileFilter: 'Mod+p',
  nextSearchMatch: 'Enter',
  prevSearchMatch: 'Shift+Enter',
  submitComment: 'Mod+Enter',
};

export const defaultConfig: CodiffConfig = {
  keymap: defaultKeymap,
  settings: defaultSettings,
};
