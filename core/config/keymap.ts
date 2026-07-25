import type { CodiffKeymap, KeyCombo, KeyComboBinding } from './types.ts';

type ParsedKeyCombo = {
  altKey: boolean;
  code: string | null;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
};

const isMac = () => navigator.platform.toLowerCase().includes('mac');

const unshiftedPunctuationCodes: Record<string, string> = {
  '-': 'Minus',
  ',': 'Comma',
  ';': 'Semicolon',
  '.': 'Period',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '/': 'Slash',
  '\\': 'Backslash',
  '`': 'Backquote',
  '=': 'Equal',
};

const shiftedPunctuationCodes: Record<string, string> = {
  _: 'Minus',
  ':': 'Semicolon',
  '!': 'Digit1',
  '?': 'Slash',
  '"': 'Quote',
  '(': 'Digit9',
  ')': 'Digit0',
  '{': 'BracketLeft',
  '}': 'BracketRight',
  '@': 'Digit2',
  '*': 'Digit8',
  '&': 'Digit7',
  '#': 'Digit3',
  '%': 'Digit5',
  '^': 'Digit6',
  '<': 'Comma',
  '>': 'Period',
  '|': 'Backslash',
  '~': 'Backquote',
  $: 'Digit4',
};

// US-layout `KeyboardEvent.code` for the letter, digit or punctuation key a
// combo names, or null for a named key like `Enter` that no modifier rewrites.
// Combos name the resulting character, so `Shift+?` and `/` describe the same
// key; keying the lookup on the combo's own Shift state keeps at most one
// spelling able to claim each position and stops the two from colliding.
// Shifted `Equal` has no spelling at all, since `+` is the combo delimiter.
const physicalCode = (key: string, shiftKey: boolean): string | null => {
  if (/^[a-z]$/.test(key)) {
    return `Key${key.toUpperCase()}`;
  }
  if (/^[0-9]$/.test(key)) {
    return shiftKey ? null : `Digit${key}`;
  }
  return (shiftKey ? shiftedPunctuationCodes : unshiftedPunctuationCodes)[key] ?? null;
};

const parseKeyCombo = (combo: KeyCombo): ParsedKeyCombo => {
  const parts = combo.split('+').map((part) => part.trim().toLowerCase());
  const mac = isMac();
  const shiftKey = parts.includes('shift');
  const key =
    parts.find(
      (part) =>
        part !== 'mod' && part !== 'ctrl' && part !== 'alt' && part !== 'shift' && part !== 'meta',
    ) ?? '';

  return {
    altKey: parts.includes('alt'),
    code: physicalCode(key, shiftKey),
    ctrlKey: mac ? parts.includes('ctrl') : parts.includes('mod') || parts.includes('ctrl'),
    key,
    metaKey: mac ? parts.includes('mod') || parts.includes('meta') : parts.includes('meta'),
    shiftKey: parts.includes('shift'),
  };
};

const getBindingCombos = (binding: KeyComboBinding): ReadonlyArray<KeyCombo> =>
  Array.isArray(binding) ? binding : [binding as KeyCombo];

type ShortcutEvent = Pick<
  KeyboardEvent,
  'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
>;

// Necessary but not sufficient evidence that Option swallowed the character:
// it composed one outside ASCII ("Ω" for Option+z, "÷" for Option+/) or armed a
// dead key. Layouts also produce non-ASCII characters natively, which is why
// the caller additionally requires that nothing matched them. A value like
// `Unidentified` carries no key information at all and is excluded, so the
// shortcut does not match rather than guessing at a key position.
const isDeadOrNonAsciiKey = (key: string): boolean =>
  key === 'Dead' || (key.length === 1 && key.charCodeAt(0) > 0x7e);

const matchesTypedKey = (event: ShortcutEvent, parsed: ParsedKeyCombo): boolean =>
  event.key.toLowerCase() === parsed.key;

const matchesPhysicalKey = (event: ShortcutEvent, parsed: ParsedKeyCombo): boolean =>
  parsed.altKey && parsed.code !== null && event.code === parsed.code;

const matchesCombo = (
  event: ShortcutEvent,
  combo: KeyCombo,
  matchesKey: (event: ShortcutEvent, parsed: ParsedKeyCombo) => boolean,
): boolean => {
  const parsed = parseKeyCombo(combo);

  return (
    matchesKey(event, parsed) &&
    event.altKey === parsed.altKey &&
    event.ctrlKey === parsed.ctrlKey &&
    event.metaKey === parsed.metaKey &&
    event.shiftKey === parsed.shiftKey
  );
};

const matchesBinding = (
  event: ShortcutEvent,
  binding: KeyComboBinding,
  matchesKey: (event: ShortcutEvent, parsed: ParsedKeyCombo) => boolean,
): boolean => getBindingCombos(binding).some((combo) => matchesCombo(event, combo, matchesKey));

// The US key position is a last resort, read only for an Alt press on macOS
// whose character Option swallowed, and only when the character the event does
// report matches no binding at all. So a character a layout produces natively
// (AZERTY "é" on the US "2" key) can never be overruled by the key beneath it.
//
// The fallback is deliberately defined in terms of US key positions: telling a
// composed character apart from one a layout produces natively needs layout
// knowledge this matcher does not have. On a layout that moves keys it can
// therefore resolve to a position the keycap does not advertise, but only for a
// keypress that already matched nothing, never by taking one from a shortcut
// that did match.
const canFallBackToPhysicalKey = (event: ShortcutEvent, keymap: CodiffKeymap): boolean =>
  event.altKey &&
  isMac() &&
  isDeadOrNonAsciiKey(event.key) &&
  !Object.values(keymap).some((binding) => matchesBinding(event, binding, matchesTypedKey));

export const matchesShortcut = (
  event: ShortcutEvent,
  keymap: CodiffKeymap,
  action: keyof CodiffKeymap,
): boolean =>
  matchesBinding(event, keymap[action], matchesTypedKey) ||
  (canFallBackToPhysicalKey(event, keymap) &&
    matchesBinding(event, keymap[action], matchesPhysicalKey));

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
