export type CodiffDiffStyle = 'split' | 'unified';
export type CodiffTheme = 'system' | 'light' | 'dark';

export type CodiffSettings = {
  copyCommentsOnClose: boolean;
  diffStyle: CodiffDiffStyle;
  lastRepositoryPath: string;
  openAIModel: string;
  showOutdated: boolean;
  showWhitespace: boolean;
  theme: CodiffTheme;
};

export type KeyCombo = string;

export type CodiffKeymap = {
  closeSearch: KeyCombo;
  commandBar: KeyCombo;
  diffSearch: KeyCombo;
  discardComment: KeyCombo;
  fileFilter: KeyCombo;
  nextSearchMatch: KeyCombo;
  prevSearchMatch: KeyCombo;
  submitComment: KeyCombo;
  toggleSidebar: KeyCombo;
};

export type CodiffConfig = {
  keymap: CodiffKeymap;
  settings: CodiffSettings;
};
