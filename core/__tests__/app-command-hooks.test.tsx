/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { useAppCommands } from '../app/hooks/useAppCommands.ts';
import { useAppKeyboardShortcuts } from '../app/hooks/useAppKeyboardShortcuts.ts';
import { createDefaultConfig, defaultKeymap } from '../config/defaults.ts';
import { createReviewCommandTarget } from '../lib/review-command-target.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact } from './helpers/react.tsx';

type AppCommandsOptions = Parameters<typeof useAppCommands>[0];
type AppKeyboardShortcutsOptions = Parameters<typeof useAppKeyboardShortcuts>[0];
type AppKeyboardShortcutsState = ReturnType<typeof useAppKeyboardShortcuts>;

function AppCommandsHarness({
  onCommands,
  options,
}: {
  onCommands: (commands: ReturnType<typeof useAppCommands>) => void;
  options: AppCommandsOptions;
}) {
  const commands = useAppCommands(options);
  onCommands(commands);
  return null;
}

function AppKeyboardShortcutsHarness({
  onState,
  options,
}: {
  onState: (state: AppKeyboardShortcutsState) => void;
  options: AppKeyboardShortcutsOptions;
}) {
  const state = useAppKeyboardShortcuts(options);
  onState(state);
  return null;
}

test('app commands register the complete command set and delegate dynamic actions', async () => {
  const file = createChangedFile('src/app.ts');
  const source = { type: 'working-tree' } as const;
  const target = createReviewCommandTarget(source, file);
  const preferencesRef = {
    current: {
      ...createDefaultConfig().settings,
    },
  };
  const viewedRef = {
    current: {
      [target.reviewIdentity.key]: target.reviewIdentity.fingerprint,
    },
  };
  const changeSidebarMode = vi.fn();
  const focusFileFilter = vi.fn();
  const getReviewCommandTarget = vi.fn(() => target);
  const onCopyPendingComments = vi.fn(() => '# Address these Review Notes');
  const onOpenDiffSearch = vi.fn();
  const onOpenReviewSource = vi.fn();
  const onOpenSelectedFile = vi.fn();
  const onRefreshRepository = vi.fn();
  const onToggleSidebar = vi.fn();
  const onToggleViewed = vi.fn();
  const onToggleWordWrap = vi.fn();
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  let commands: ReturnType<typeof useAppCommands> = [];
  await using _view = await renderReact(
    <AppCommandsHarness
      onCommands={(nextCommands) => (commands = nextCommands)}
      options={{
        changeSidebarMode,
        copyPendingCommentsLabel: 'Copy Review Notes',
        focusFileFilter,
        getReviewCommandTarget,
        onCopyPendingComments,
        onOpenDiffSearch,
        onOpenReviewSource,
        onOpenSelectedFile,
        onRefreshRepository,
        onToggleSidebar,
        onToggleViewed,
        onToggleWordWrap,
        preferencesRef,
        viewedRef,
      }}
    />,
  );

  expect(commands.map((command) => command.id)).toEqual([
    'file-filter',
    'diff-search',
    'open-pull-request',
    'open-commit',
    'open-branch',
    'open-folder',
    'sidebar-tree',
    'sidebar-history',
    'sidebar-walkthrough',
    'copy-comments',
    'copy-comments-and-close',
    'toggle-viewed',
    'open-file',
    'toggle-sidebar',
    'toggle-outdated-comments',
    'toggle-diff-layout',
    'toggle-word-wrap',
    'increase-code-font-size',
    'decrease-code-font-size',
    'reset-code-font-size',
    'open-config-file',
    'reload',
  ]);
  const command = (id: string) => {
    const match = commands.find((candidate) => candidate.id === id);
    if (!match) {
      throw new Error(`Missing command: ${id}`);
    }
    return match;
  };
  command('file-filter').execute();
  command('diff-search').execute();
  command('open-pull-request').execute();
  command('open-commit').execute();
  command('open-branch').execute();
  command('sidebar-history').execute();
  command('open-file').execute();
  command('toggle-sidebar').execute();
  command('toggle-word-wrap').execute();
  command('copy-comments').execute();
  command('reload').execute();
  command('toggle-viewed').execute();
  expect(focusFileFilter).toHaveBeenCalledOnce();
  expect(onOpenDiffSearch).toHaveBeenCalledOnce();
  expect(onOpenReviewSource.mock.calls).toEqual([['pull-request'], ['commit'], ['branch']]);
  expect(changeSidebarMode).toHaveBeenCalledWith('history');
  expect(onOpenSelectedFile).toHaveBeenCalledOnce();
  expect(onToggleSidebar).toHaveBeenCalledOnce();
  expect(onToggleWordWrap).toHaveBeenCalledOnce();
  expect(onRefreshRepository).toHaveBeenCalledOnce();
  expect(onCopyPendingComments).toHaveBeenCalledOnce();
  expect(writeText).toHaveBeenCalledWith('# Address these Review Notes');
  expect(command('open-file').description?.()).toBe(file.path);
  expect(onToggleViewed).toHaveBeenCalledWith(file, true, target.reviewIdentity);
  expect(command('toggle-word-wrap').description?.()).toBe('Enable Word Wrap');
  expect(command('copy-comments').title).toBe('Copy Review Notes');
  expect(command('copy-comments-and-close').title).toBe('Copy Review Notes and Close');
  preferencesRef.current.wordWrap = true;
  expect(command('toggle-word-wrap').description?.()).toBe('Disable Word Wrap');
});

const keyboardKeymap = {
  ...defaultKeymap,
  commandBar: 'c',
  diffSearch: 'f',
  fileFilter: 'l',
  nextHunk: 'n',
  openFile: 'o',
  prevHunk: 'p',
  shortcutsHelp: '?',
  toggleSidebar: 'b',
  toggleWordWrap: 'z',
};

const noop = () => {};

const dispatchKey = (type: 'keydown' | 'keyup', key: string, target: EventTarget = window) => {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    key,
  });
  target.dispatchEvent(event);
  return event;
};

test('app keyboard shortcuts route commands and respect native input and walkthrough guards', async () => {
  let deferHunkNavigation = true;
  const navigateHunks = vi.fn();
  const onFocusFileFilter = vi.fn();
  const onOpenDiffSearch = vi.fn();
  const onOpenSelectedFile = vi.fn();
  const onToggleSidebar = vi.fn();
  const onToggleWordWrap = vi.fn();
  let state: AppKeyboardShortcutsState | null = null;
  const getState = () => {
    if (!state) {
      throw new Error('Keyboard shortcuts did not render.');
    }
    return state;
  };
  await using _view = await renderReact(
    <AppKeyboardShortcutsHarness
      onState={(nextState) => (state = nextState)}
      options={{
        keymap: keyboardKeymap,
        navigateHunks,
        onFocusFileFilter,
        onOpenDiffSearch,
        onOpenSelectedFile,
        onToggleSidebar,
        onToggleWordWrap,
        shouldDeferHunkNavigation: () => deferHunkNavigation,
        sidebarCollapsed: true,
      }}
    />,
  );

  await act(async () => {
    expect(dispatchKey('keydown', 'c').defaultPrevented).toBe(true);
  });
  expect(getState().commandBarVisible).toBe(true);
  await act(async () => {
    getState().closeCommandBar();
    dispatchKey('keydown', 'b');
    dispatchKey('keydown', 'f');
    dispatchKey('keydown', 'o');
    dispatchKey('keydown', 'l');
    dispatchKey('keydown', 'n');
  });
  expect(getState().commandBarVisible).toBe(false);
  expect(onToggleSidebar).toHaveBeenCalledOnce();
  expect(onOpenDiffSearch).toHaveBeenCalledOnce();
  expect(onOpenSelectedFile).toHaveBeenCalledOnce();
  expect(onFocusFileFilter).toHaveBeenCalledOnce();
  expect(navigateHunks).not.toHaveBeenCalled();
  deferHunkNavigation = false;
  await act(async () => {
    dispatchKey('keydown', 'n');
    dispatchKey('keydown', 'p');
  });
  expect(navigateHunks.mock.calls).toEqual([[1], [-1]]);
  const input = document.createElement('input');
  document.body.append(input);
  await act(async () => {
    dispatchKey('keydown', 'z', input);
  });
  expect(onToggleWordWrap).not.toHaveBeenCalled();
  await act(async () => {
    dispatchKey('keydown', 'z');
  });
  expect(onToggleWordWrap).toHaveBeenCalledOnce();
  input.remove();
});

test('shortcut help remains visible only while its key chord is held', async () => {
  let state: AppKeyboardShortcutsState | null = null;
  const getState = () => {
    if (!state) {
      throw new Error('Keyboard shortcuts did not render.');
    }
    return state;
  };
  await using _view = await renderReact(
    <AppKeyboardShortcutsHarness
      onState={(nextState) => (state = nextState)}
      options={{
        keymap: keyboardKeymap,
        navigateHunks: noop,
        onFocusFileFilter: noop,
        onOpenDiffSearch: noop,
        onOpenSelectedFile: noop,
        onToggleSidebar: noop,
        onToggleWordWrap: noop,
        shouldDeferHunkNavigation: () => false,
        sidebarCollapsed: false,
      }}
    />,
  );

  await act(async () => {
    dispatchKey('keydown', '?');
  });
  expect(getState().shortcutsHelpVisible).toBe(true);
  await act(async () => {
    dispatchKey('keyup', '?');
  });
  expect(getState().shortcutsHelpVisible).toBe(false);
  await act(async () => {
    dispatchKey('keydown', '?');
    window.dispatchEvent(new Event('blur'));
  });
  expect(getState().shortcutsHelpVisible).toBe(false);
});
