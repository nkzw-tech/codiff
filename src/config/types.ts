export type CodiffTheme = 'system' | 'light' | 'dark';

export type CodiffSettings = {
  copyCommentsOnClose: boolean;
  openAIModel: string;
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
};

export type CodiffConfig = {
  keymap: CodiffKeymap;
  settings: CodiffSettings;
};
