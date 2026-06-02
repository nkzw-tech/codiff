// @ts-check

const { execFile } = require('node:child_process');
const { dirname } = require('node:path');

/**
 * @typedef {{args: Array<string>; command: string}} EditorCommand
 * @typedef {{repoPath?: string}} EditorCommandContext
 */

/** @param {{getEditorCommand?: () => string; platform?: NodeJS.Platform; shell: import('electron').Shell}} options */
const createEditorOpener = ({
  getEditorCommand = () => '',
  platform = process.platform,
  shell,
}) => {
  /** @param {string} command */
  // Handles simple editor commands with quoted arguments. Keep this small unless
  // we need full shell-style escaping semantics.
  const parseEditorCommand = (command) =>
    command.match(/"[^"]+"|'[^']+'|\S+/g)?.map((part) => part.replace(/^['"]|['"]$/g, '')) ?? [];

  /** @param {string} command @param {ReadonlyArray<string>} args */
  const runEditorCommand = (command, args) =>
    new Promise((resolveCommand) => {
      execFile(command, args, { windowsHide: true }, (error) => resolveCommand(!error));
    });

  /**
   * @param {string} arg
   * @param {string} absolutePath
   * @param {EditorCommandContext} context
   */
  const replaceEditorPlaceholders = (arg, absolutePath, context) =>
    arg
      .replaceAll('{file}', absolutePath)
      .replaceAll('{repo}', context.repoPath || dirname(absolutePath));

  /**
   * @param {ReadonlyArray<string>} args
   * @param {string} absolutePath
   * @param {EditorCommandContext} context
   */
  const getCustomEditorArgs = (args, absolutePath, context) => {
    if (args.length === 0) {
      return [absolutePath];
    }

    const expandedArgs = args.map((arg) => replaceEditorPlaceholders(arg, absolutePath, context));
    return args.some((arg) => arg.includes('{file}'))
      ? expandedArgs
      : [...expandedArgs, absolutePath];
  };

  /** @param {string} absolutePath @param {EditorCommandContext} [context] @returns {Array<EditorCommand>} */
  const getEditorCommands = (absolutePath, context = {}) => {
    /** @type {Array<EditorCommand>} */
    const commands = [];
    const customEditor = process.env.CODIFF_EDITOR || getEditorCommand();
    if (customEditor) {
      const [command, ...args] = parseEditorCommand(customEditor);
      if (command) {
        commands.push({
          args: getCustomEditorArgs(args, absolutePath, context),
          command,
        });
      }
    }

    for (const command of ['/opt/homebrew/bin/code', '/usr/local/bin/code', 'code']) {
      commands.push({
        args: ['-g', absolutePath],
        command,
      });
    }

    if (platform === 'darwin') {
      commands.push({
        args: ['-a', 'Visual Studio Code', absolutePath],
        command: 'open',
      });
      commands.push({
        args: ['-t', absolutePath],
        command: 'open',
      });
    }

    return commands;
  };

  /** @param {string} absolutePath @param {EditorCommandContext} [context] */
  const openFileInEditor = async (absolutePath, context = {}) => {
    for (const { args, command } of getEditorCommands(absolutePath, context)) {
      if (await runEditorCommand(command, args)) {
        return;
      }
    }

    await shell.openPath(absolutePath);
  };

  return {
    getEditorCommands,
    openFileInEditor,
    parseEditorCommand,
  };
};

module.exports = { createEditorOpener };
