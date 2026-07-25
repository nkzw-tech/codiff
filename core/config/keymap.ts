import { codeForCharacter, hasKeyboardLayout, shiftedCharacterForCode } from './keyboard-layout.ts';
import type { CodiffKeymap, KeyCombo, KeyComboBinding } from './types.ts';

type ParsedKeyCombo = {
  altKey: boolean;
  code: string | null;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  // True for a combo that named its key rather than its character, like
  // `Shift+/` for the keystroke typing "?". Typed matching then requires the
  // named key too: the same character typed on a different key is a different
  // keystroke.
  requiresCode: boolean;
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
  '+': 'Equal',
  '<': 'Comma',
  '>': 'Period',
  '|': 'Backslash',
  '~': 'Backquote',
  $: 'Digit4',
};

// `KeyboardEvent.code` for the letter, digit or punctuation key a combo names,
// or null for a named key like `Enter` that no modifier rewrites.
//
// The user's own layout answers first, in the combo's own Shift state, so
// `Alt+z` follows the key that really types "z" and `Alt+Shift+?` the key
// whose Shift produces "?", wherever the layout put them. Keeping each Shift
// state inside one source means two combos can land on one key only by naming
// the same keystroke, which canonicalization has already collapsed.
const physicalCode = (key: string, shiftKey: boolean): string | null => {
  const layoutCode = codeForCharacter(key, shiftKey);
  if (layoutCode !== null) {
    return layoutCode;
  }
  // With the real layout in hand, a character it cannot type has no key to
  // match. Guessing the US position would fire the shortcut on whichever key
  // the layout put there instead, which is the bug this replaces.
  if (hasKeyboardLayout()) {
    return null;
  }
  if (/^[a-z]$/.test(key)) {
    return `Key${key.toUpperCase()}`;
  }
  if (/^[0-9]$/.test(key)) {
    return shiftKey ? null : `Digit${key}`;
  }
  return (shiftKey ? shiftedPunctuationCodes : unshiftedPunctuationCodes)[key] ?? null;
};

type ResolvedComboKey = { code: string | null; key: string; requiresCode: boolean };

// The character and key a shifted combo means, whichever of its two spellings
// it used. `Shift+?` names the character a keystroke types; `Shift+/` names
// the "/" key with Shift held, whose keystroke types "?", so both must mean
// the same keystroke or they would claim the "/" key twice.
//
// A character some key types with Shift held is always the character
// spelling, and stays on that key even when another key types it unshifted:
// Linux Russian types "/" plain on one key and with Shift on another, and
// `Shift+/` must mean the keystroke that types "/". Only a character no
// Shift ever produces is read as a key name, and it stays bound to the key it
// named, in matching too, rather than following its shifted character to
// whichever key types that character elsewhere.
//
// Reading a spelling as a key name takes a layout. Before one arrives, and
// wherever none ever does, a combo keeps meaning the character as written,
// exactly as it did before layouts were consulted at all.
const resolveComboKey = (spelled: string, shiftKey: boolean): ResolvedComboKey => {
  if (!shiftKey || spelled.length !== 1 || !hasKeyboardLayout()) {
    return { code: physicalCode(spelled, shiftKey), key: spelled, requiresCode: false };
  }

  const shiftedCode = codeForCharacter(spelled, true);
  if (shiftedCode !== null) {
    return { code: shiftedCode, key: spelled, requiresCode: false };
  }

  const unshiftedCode = codeForCharacter(spelled, false);
  const shiftedCharacter = unshiftedCode === null ? null : shiftedCharacterForCode(unshiftedCode);
  if (unshiftedCode !== null && shiftedCharacter !== null) {
    return { code: unshiftedCode, key: shiftedCharacter, requiresCode: true };
  }

  // The layout cannot type it with Shift at all; the character may still
  // arrive composed, so typed matching keeps the spelling as written.
  return { code: null, key: spelled, requiresCode: false };
};

const parseKeyCombo = (combo: KeyCombo): ParsedKeyCombo => {
  const parts = combo.split('+').map((part) => part.trim().toLowerCase());
  const mac = isMac();
  const shiftKey = parts.includes('shift');
  const { code, key, requiresCode } = resolveComboKey(
    parts.find(
      (part) =>
        part !== 'mod' && part !== 'ctrl' && part !== 'alt' && part !== 'shift' && part !== 'meta',
    ) ?? '',
    shiftKey,
  );

  return {
    altKey: parts.includes('alt'),
    code,
    ctrlKey: mac ? parts.includes('ctrl') : parts.includes('mod') || parts.includes('ctrl'),
    key,
    metaKey: mac ? parts.includes('mod') || parts.includes('meta') : parts.includes('meta'),
    requiresCode,
    shiftKey,
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

// A key-spelled combo additionally requires the key it named: two keys may
// type the same character with Shift, and `Shift+/` means only one of them.
const matchesTypedKey = (event: ShortcutEvent, parsed: ParsedKeyCombo): boolean =>
  event.key.toLowerCase() === parsed.key &&
  (!parsed.requiresCode || (parsed.code !== null && event.code === parsed.code));

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

// The key position is a last resort, read only for an Alt press on macOS whose
// character Option swallowed, and only when the character the event does report
// matches no binding at all. So a character a layout produces natively (AZERTY
// "é" on the US "2" key) can never be overruled by the key beneath it.
//
// That last condition is what makes the whole fallback safe. Telling a composed
// character apart from one a layout produces natively needs more than this
// matcher can see, so instead of guessing it only ever turns a keypress nothing
// wanted into one that fires, never takes one from a shortcut that matched.
//
// `physicalCode` resolves the position through the user's real layout, in the
// combo's own Shift state, so the key it lands on is the one the keycap
// advertises. Only the window before the layout arrives resolves against US
// positions, which on a layout that moves keys can fire an action the keycap
// does not suggest.
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
