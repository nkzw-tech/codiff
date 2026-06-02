// @ts-check

const {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
} = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

/**
 * @typedef {import('../src/config/types.ts').CodiffConfig} CodiffConfig
 * @typedef {import('../src/config/types.ts').CodiffDiffStyle} CodiffDiffStyle
 * @typedef {import('../src/config/types.ts').CodiffTheme} CodiffTheme
 * @typedef {import('../src/types.ts').CodiffPreferences} CodiffPreferences
 */

/** @type {CodiffConfig} */
const defaultConfigTemplate = require('../config/defaults.json');

const SCHEMA_URL =
  'https://raw.githubusercontent.com/nkzw-tech/codiff/main/src/config/codiff-config.schema.json';

/** @returns {CodiffConfig} */
const createDefaultConfig = () => ({
  keymap: { ...defaultConfigTemplate.keymap },
  settings: { ...defaultConfigTemplate.settings },
});

const getConfigDir = () => join(homedir(), '.codiff');

const getConfigPath = () => join(getConfigDir(), 'codiff.jsonc');

/**
 * Strip JSONC comments (line comments and block comments) to produce valid JSON.
 * @param {string} text
 * @returns {string}
 */
const stripJsoncComments = (text) => {
  let result = '';
  let i = 0;
  let inString = false;

  while (i < text.length) {
    if (inString) {
      if (text[i] === '\\') {
        result += text[i] + (text[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        inString = false;
      }
      result += text[i];
      i++;
      continue;
    }

    if (text[i] === '"') {
      inString = true;
      result += text[i];
      i++;
      continue;
    }

    if (text[i] === '/' && text[i + 1] === '/') {
      // Line comment: skip to end of line
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (text[i] === '/' && text[i + 1] === '*') {
      // Block comment: skip to closing */
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i++;
      }
      i += 2;
      continue;
    }

    result += text[i];
    i++;
  }

  return result;
};

/**
 * Strip trailing commas from JSON (e.g., `[1, 2,]` or `{"a": 1,}`).
 * @param {string} text
 * @returns {string}
 */
const stripTrailingCommas = (text) => text.replace(/,\s*([\]}])/g, '$1');

/**
 * Parse a JSONC string into a JavaScript object.
 * @param {string} text
 * @returns {unknown}
 */
const parseJsonc = (text) => JSON.parse(stripTrailingCommas(stripJsoncComments(text)));

/** @param {unknown} theme @returns {CodiffTheme} */
const normalizeTheme = (theme) =>
  theme === 'system' || theme === 'light' || theme === 'dark' ? theme : 'system';

/** @param {unknown} diffStyle @returns {CodiffDiffStyle} */
const normalizeDiffStyle = (diffStyle) =>
  diffStyle === 'split' || diffStyle === 'unified' ? diffStyle : 'split';

/** @param {unknown} path */
const normalizeLastRepositoryPath = (path) =>
  typeof path === 'string' && path.length > 0 ? path : '';

/**
 * Merge a partial config object on top of defaults.
 * @param {unknown} raw
 * @returns {CodiffConfig}
 */
const mergeConfig = (raw) => {
  const defaults = createDefaultConfig();

  if (typeof raw !== 'object' || raw === null) {
    return defaults;
  }

  const obj = /** @type {Record<string, unknown>} */ (raw);
  const rawSettings =
    typeof obj.settings === 'object' && obj.settings !== null
      ? /** @type {Record<string, unknown>} */ (obj.settings)
      : {};
  const rawKeymap =
    typeof obj.keymap === 'object' && obj.keymap !== null
      ? /** @type {Record<string, unknown>} */ (obj.keymap)
      : {};

  return {
    keymap: {
      closeSearch:
        typeof rawKeymap.closeSearch === 'string'
          ? rawKeymap.closeSearch
          : defaults.keymap.closeSearch,
      commandBar:
        typeof rawKeymap.commandBar === 'string'
          ? rawKeymap.commandBar
          : defaults.keymap.commandBar,
      diffSearch:
        typeof rawKeymap.diffSearch === 'string'
          ? rawKeymap.diffSearch
          : defaults.keymap.diffSearch,
      discardComment:
        typeof rawKeymap.discardComment === 'string'
          ? rawKeymap.discardComment
          : defaults.keymap.discardComment,
      fileFilter:
        typeof rawKeymap.fileFilter === 'string'
          ? rawKeymap.fileFilter
          : defaults.keymap.fileFilter,
      nextSearchMatch:
        typeof rawKeymap.nextSearchMatch === 'string'
          ? rawKeymap.nextSearchMatch
          : defaults.keymap.nextSearchMatch,
      openFile:
        typeof rawKeymap.openFile === 'string' ? rawKeymap.openFile : defaults.keymap.openFile,
      prevSearchMatch:
        typeof rawKeymap.prevSearchMatch === 'string'
          ? rawKeymap.prevSearchMatch
          : defaults.keymap.prevSearchMatch,
      submitComment:
        typeof rawKeymap.submitComment === 'string'
          ? rawKeymap.submitComment
          : defaults.keymap.submitComment,
      toggleSidebar:
        typeof rawKeymap.toggleSidebar === 'string'
          ? rawKeymap.toggleSidebar
          : defaults.keymap.toggleSidebar,
    },
    settings: {
      copyCommentsOnClose:
        typeof rawSettings.copyCommentsOnClose === 'boolean'
          ? rawSettings.copyCommentsOnClose
          : defaults.settings.copyCommentsOnClose,
      diffStyle: normalizeDiffStyle(rawSettings.diffStyle),
      editorCommand:
        typeof rawSettings.editorCommand === 'string'
          ? rawSettings.editorCommand
          : defaults.settings.editorCommand,
      lastRepositoryPath: normalizeLastRepositoryPath(rawSettings.lastRepositoryPath),
      openAIModel:
        typeof rawSettings.openAIModel === 'string'
          ? rawSettings.openAIModel
          : defaults.settings.openAIModel,
      showOutdated:
        typeof rawSettings.showOutdated === 'boolean'
          ? rawSettings.showOutdated
          : defaults.settings.showOutdated,
      showWhitespace:
        typeof rawSettings.showWhitespace === 'boolean'
          ? rawSettings.showWhitespace
          : defaults.settings.showWhitespace,
      theme: normalizeTheme(rawSettings.theme),
      wordWrap:
        typeof rawSettings.wordWrap === 'boolean'
          ? rawSettings.wordWrap
          : defaults.settings.wordWrap,
    },
  };
};

/**
 * Read and parse the config file. Returns defaults if the file does not exist or is invalid.
 * @returns {CodiffConfig}
 */
const readConfig = () => {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return createDefaultConfig();
  }

  try {
    const text = readFileSync(configPath, 'utf8');
    const raw = parseJsonc(text);
    return mergeConfig(raw);
  } catch {
    return createDefaultConfig();
  }
};

/**
 * Write a config object to the config file as JSONC with a $schema reference.
 * @param {CodiffConfig} config
 */
const writeConfig = (config) => {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const output = {
    $schema: SCHEMA_URL,
    keymap: config.keymap,
    settings: config.settings,
  };

  writeFileSync(getConfigPath(), JSON.stringify(output, null, 2) + '\n');
};

/**
 * Create the config file with defaults if it doesn't already exist.
 * @returns {boolean} true if the file was created, false if it already existed.
 */
const initConfig = () => {
  if (existsSync(getConfigPath())) {
    return false;
  }

  writeConfig(createDefaultConfig());
  return true;
};

/**
 * Migrate from the old preferences.json (in Electron's userData) to the new config file.
 * @param {string} userDataPath - Electron's app.getPath('userData')
 * @param {(model: string) => string} normalizeOpenAIModel
 */
const migrateFromPreferences = (userDataPath, normalizeOpenAIModel) => {
  const oldPath = join(userDataPath, 'preferences.json');

  if (!existsSync(oldPath)) {
    return;
  }

  // Only migrate if the new config doesn't exist yet
  if (existsSync(getConfigPath())) {
    // New config exists; remove old file
    try {
      renameSync(oldPath, oldPath + '.bak');
    } catch {
      // Ignore: best effort cleanup
    }
    return;
  }

  try {
    const oldPrefs = JSON.parse(readFileSync(oldPath, 'utf8'));
    const defaults = createDefaultConfig();
    const config = mergeConfig({
      settings: {
        ...oldPrefs,
        lastRepositoryPath: normalizeLastRepositoryPath(oldPrefs?.lastRepositoryPath),
        openAIModel: normalizeOpenAIModel(oldPrefs?.openAIModel ?? defaults.settings.openAIModel),
        theme: normalizeTheme(oldPrefs?.theme),
      },
    });
    writeConfig(config);
    renameSync(oldPath, oldPath + '.bak');
  } catch {
    // Migration failed; fall through to defaults
  }
};

/**
 * Watch the config file for changes.
 * @param {(config: CodiffConfig) => void} onChange
 * @returns {() => void} stop watching
 */
const watchConfig = (onChange) => {
  const configPath = getConfigPath();
  const configDir = getConfigDir();

  // Ensure the directory exists for watching
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  let debounceTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

  // Watch the directory so we detect file creation/deletion too
  const watcher = watch(configDir, (eventType, filename) => {
    if (filename !== 'codiff.jsonc') {
      return;
    }

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onChange(readConfig());
    }, 200);
  });

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    watcher.close();
  };
};

/**
 * Convert a CodiffConfig's settings to the legacy CodiffPreferences format
 * for backward compatibility with renderer code during migration.
 * @param {CodiffConfig} config
 * @returns {CodiffPreferences}
 */
const configToPreferences = (config) => ({
  ...config.settings,
});

module.exports = {
  configToPreferences,
  createDefaultConfig,
  getConfigPath,
  initConfig,
  mergeConfig,
  migrateFromPreferences,
  readConfig,
  watchConfig,
  writeConfig,
};
