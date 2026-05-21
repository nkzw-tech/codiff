import type { CodiffKeymap, KeyCombo } from './types.ts';

type ParsedKeyCombo = {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
};

const isMac = () => navigator.platform.toLowerCase().includes('mac');

const parseKeyCombo = (combo: KeyCombo): ParsedKeyCombo => {
  const parts = combo.split('+').map((part) => part.trim().toLowerCase());
  const mac = isMac();

  return {
    altKey: parts.includes('alt'),
    ctrlKey: mac ? parts.includes('ctrl') : parts.includes('mod') || parts.includes('ctrl'),
    key:
      parts.find(
        (part) =>
          part !== 'mod' &&
          part !== 'ctrl' &&
          part !== 'alt' &&
          part !== 'shift' &&
          part !== 'meta',
      ) ?? '',
    metaKey: mac ? parts.includes('mod') || parts.includes('meta') : parts.includes('meta'),
    shiftKey: parts.includes('shift'),
  };
};

export const matchesShortcut = (
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
  keymap: CodiffKeymap,
  action: keyof CodiffKeymap,
): boolean => {
  const combo = keymap[action];
  const parsed = parseKeyCombo(combo);

  return (
    event.key.toLowerCase() === parsed.key &&
    event.altKey === parsed.altKey &&
    event.ctrlKey === parsed.ctrlKey &&
    event.metaKey === parsed.metaKey &&
    event.shiftKey === parsed.shiftKey
  );
};

export const getShortcutLabel = (keymap: CodiffKeymap, action: keyof CodiffKeymap): string => {
  const combo = keymap[action];
  const mac = isMac();

  return combo
    .split('+')
    .map((part) => {
      const lower = part.trim().toLowerCase();
      if (lower === 'mod') {
        return mac ? '\u2318' : 'Ctrl';
      }
      if (lower === 'shift') {
        return mac ? '\u21E7' : 'Shift';
      }
      if (lower === 'alt') {
        return mac ? '\u2325' : 'Alt';
      }
      if (lower === 'ctrl') {
        return mac ? '\u2303' : 'Ctrl';
      }
      if (lower === 'meta') {
        return mac ? '\u2318' : 'Win';
      }
      if (lower === 'enter') {
        return mac ? '\u21A9' : 'Enter';
      }
      if (lower === 'escape') {
        return 'Esc';
      }
      return part.trim().toUpperCase();
    })
    .join('+');
};
