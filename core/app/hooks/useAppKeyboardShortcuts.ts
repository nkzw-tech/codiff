import { useCallback, useEffect, useState } from 'react';
import { matchesShortcut } from '../../config/keymap.ts';
import type { CodiffKeymap } from '../../config/types.ts';
import { isNativeInputTarget } from '../../lib/keyboard.ts';

type UseAppKeyboardShortcutsOptions = {
  enabled?: boolean;
  keymap: CodiffKeymap;
  navigateHunks: (direction: 1 | -1) => void;
  onFocusFileFilter: () => void;
  onOpenDiffSearch: () => void;
  onOpenSelectedFile?: () => void;
  onToggleSidebar: () => void;
  onToggleWordWrap: () => void;
  shouldDeferHunkNavigation: () => boolean;
  sidebarCollapsed: boolean;
};

export function useAppKeyboardShortcuts({
  enabled = true,
  keymap,
  navigateHunks,
  onFocusFileFilter,
  onOpenDiffSearch,
  onOpenSelectedFile,
  onToggleSidebar,
  onToggleWordWrap,
  shouldDeferHunkNavigation,
  sidebarCollapsed,
}: UseAppKeyboardShortcutsOptions) {
  const [commandBarVisible, setCommandBarVisible] = useState(false);
  const [shortcutsHelpVisible, setShortcutsHelpVisible] = useState(false);
  const closeCommandBar = useCallback(() => setCommandBarVisible(false), []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (matchesShortcut(event, keymap, 'commandBar')) {
        event.preventDefault();
        setCommandBarVisible((current) => !current);
        return;
      }
      if (matchesShortcut(event, keymap, 'toggleSidebar')) {
        event.preventDefault();
        onToggleSidebar();
        return;
      }
      if (!isNativeInputTarget(event.target) && matchesShortcut(event, keymap, 'toggleWordWrap')) {
        event.preventDefault();
        onToggleWordWrap();
        return;
      }
      if (matchesShortcut(event, keymap, 'diffSearch')) {
        event.preventDefault();
        onOpenDiffSearch();
        return;
      }
      if (
        onOpenSelectedFile &&
        !isNativeInputTarget(event.target) &&
        matchesShortcut(event, keymap, 'openFile')
      ) {
        event.preventDefault();
        onOpenSelectedFile();
        return;
      }
      if (!isNativeInputTarget(event.target)) {
        if (
          shouldDeferHunkNavigation() &&
          (matchesShortcut(event, keymap, 'nextHunk') || matchesShortcut(event, keymap, 'prevHunk'))
        ) {
          return;
        }
        if (matchesShortcut(event, keymap, 'nextHunk')) {
          event.preventDefault();
          navigateHunks(1);
          return;
        }
        if (matchesShortcut(event, keymap, 'prevHunk')) {
          event.preventDefault();
          navigateHunks(-1);
          return;
        }
      }
      if (sidebarCollapsed && matchesShortcut(event, keymap, 'fileFilter')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onFocusFileFilter();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    enabled,
    keymap,
    navigateHunks,
    onFocusFileFilter,
    onOpenDiffSearch,
    onOpenSelectedFile,
    onToggleSidebar,
    onToggleWordWrap,
    shouldDeferHunkNavigation,
    sidebarCollapsed,
  ]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isNativeInputTarget(event.target)) {
        return;
      }
      if (matchesShortcut(event, keymap, 'shortcutsHelp')) {
        event.preventDefault();
        setShortcutsHelpVisible(true);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === '?' || event.key === '/' || event.key === 'Shift') {
        setShortcutsHelpVisible(false);
      }
    };

    const handleBlur = () => setShortcutsHelpVisible(false);

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [enabled, keymap]);

  return {
    closeCommandBar,
    commandBarVisible,
    shortcutsHelpVisible,
  };
}
