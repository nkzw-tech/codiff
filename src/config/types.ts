export type CodiffDiffStyle = 'split' | 'unified';
export type CodiffTheme = 'system' | 'light' | 'dark';
export type CodiffAgentBackend = 'codex' | 'claude' | 'pi';

export type CodiffSettings = {
  agentBackend: CodiffAgentBackend;
  claudeModel: string;
  codeFontFamily: string;
  codeFontSize: number;
  copyCommentsOnClose: boolean;
  diffStyle: CodiffDiffStyle;
  editorCommand: string;
  lastRepositoryPath: string;
  openAIModel: string;
  piModel: string;
  showOutdated: boolean;
  showWhitespace: boolean;
  theme: CodiffTheme;
  walkthroughPrompt: string;
  wordWrap: boolean;
};

export type KeyCombo = string;

// A shortcut can be a single combo or a list of aliases that all trigger the action.
export type KeyComboBinding = KeyCombo | ReadonlyArray<KeyCombo>;

export type CodiffKeymap = {
  closeSearch: KeyCombo;
  commandBar: KeyCombo;
  diffSearch: KeyCombo;
  discardComment: KeyCombo;
  fileFilter: KeyCombo;
  nextHunk: KeyComboBinding;
  nextSearchMatch: KeyCombo;
  openFile: KeyCombo;
  prevHunk: KeyComboBinding;
  prevSearchMatch: KeyCombo;
  shortcutsHelp: KeyCombo;
  submitComment: KeyCombo;
  toggleSidebar: KeyCombo;
  toggleWordWrap: KeyCombo;
};

export type CodiffConfig = {
  keymap: CodiffKeymap;
  settings: CodiffSettings;
};
