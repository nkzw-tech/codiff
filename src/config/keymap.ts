import type { CodiffKeymap, KeyCombo, KeyComboBinding } from './types.ts';

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

const getBindingCombos = (binding: KeyComboBinding): ReadonlyArray<KeyCombo> =>
  Array.isArray(binding) ? binding : [binding as KeyCombo];

const matchesKeyCombo = (
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
  combo: KeyCombo,
): boolean => {
  const parsed = parseKeyCombo(combo);

  return (
    event.key.toLowerCase() === parsed.key &&
    event.altKey === parsed.altKey &&
    event.ctrlKey === parsed.ctrlKey &&
    event.metaKey === parsed.metaKey &&
    event.shiftKey === parsed.shiftKey
  );
};

export const matchesShortcut = (
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
  keymap: CodiffKeymap,
  action: keyof CodiffKeymap,
): boolean => getBindingCombos(keymap[action]).some((combo) => matchesKeyCombo(event, combo));

export const getShortcutLabel = (keymap: CodiffKeymap, action: keyof CodiffKeymap): string => {
  // Show the primary combo when an action has alias bindings.
  const combo = getBindingCombos(keymap[action])[0] ?? '';
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
      if (lower === 'arrowup') {
        return '↑';
      }
      if (lower === 'arrowdown') {
        return '↓';
      }
      if (lower === 'arrowleft') {
        return '←';
      }
      if (lower === 'arrowright') {
        return '→';
      }
      return part.trim().toUpperCase();
    })
    .join('+');
};
