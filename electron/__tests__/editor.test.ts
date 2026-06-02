import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createEditorOpener } = require('../main/editor.cjs') as {
  createEditorOpener: (options: {
    getEditorCommand?: () => string;
    platform?: NodeJS.Platform;
    shell: {
      openPath: (path: string) => Promise<string>;
    };
  }) => {
    getEditorCommands: (
      absolutePath: string,
      context?: {
        repoPath?: string;
      },
    ) => Array<{
      args: Array<string>;
      command: string;
    }>;
    parseEditorCommand: (command: string) => Array<string>;
  };
};

const createOpener = (
  options: { getEditorCommand?: () => string; platform?: NodeJS.Platform } = {},
) =>
  createEditorOpener({
    ...options,
    shell: {
      openPath: async () => '',
    },
  });

test('falls back to the macOS default text editor for text files without app associations', () => {
  const opener = createOpener({
    platform: 'darwin',
  });

  expect(opener.getEditorCommands('/Users/test/.codiff/codiff.jsonc')).toContainEqual({
    args: ['-t', '/Users/test/.codiff/codiff.jsonc'],
    command: 'open',
  });
});

test('parses custom editor commands with quoted arguments', () => {
  const opener = createOpener();

  expect(opener.parseEditorCommand('editor --goto "{file}"')).toEqual([
    'editor',
    '--goto',
    '{file}',
  ]);
});

test('uses the configured editor command before built-in commands', () => {
  const opener = createOpener({
    getEditorCommand: () => 'cursor --goto "{file}"',
  });

  expect(opener.getEditorCommands('/Users/test/project/file.ts')[0]).toEqual({
    args: ['--goto', '/Users/test/project/file.ts'],
    command: 'cursor',
  });
});

test('expands the repo placeholder in configured editor commands', () => {
  const opener = createOpener({
    getEditorCommand: () => 'subl "{repo}" "{file}"',
  });

  expect(
    opener.getEditorCommands('/Users/test/project/src/file.ts', {
      repoPath: '/Users/test/project',
    })[0],
  ).toEqual({
    args: ['/Users/test/project', '/Users/test/project/src/file.ts'],
    command: 'subl',
  });
});

test('appends the file path when the configured editor command only uses the repo placeholder', () => {
  const opener = createOpener({
    getEditorCommand: () => 'subl "{repo}"',
  });

  expect(
    opener.getEditorCommands('/Users/test/project/src/file.ts', {
      repoPath: '/Users/test/project',
    })[0],
  ).toEqual({
    args: ['/Users/test/project', '/Users/test/project/src/file.ts'],
    command: 'subl',
  });
});

test('lets CODIFF_EDITOR override the configured editor command', () => {
  const previous = process.env.CODIFF_EDITOR;
  process.env.CODIFF_EDITOR = 'zed --wait';

  try {
    const opener = createOpener({
      getEditorCommand: () => 'cursor --goto "{file}"',
    });

    expect(opener.getEditorCommands('/Users/test/project/file.ts')[0]).toEqual({
      args: ['--wait', '/Users/test/project/file.ts'],
      command: 'zed',
    });
  } finally {
    if (previous === undefined) {
      delete process.env.CODIFF_EDITOR;
    } else {
      process.env.CODIFF_EDITOR = previous;
    }
  }
});
