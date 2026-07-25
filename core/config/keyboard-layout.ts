// Where each character sits on the keyboard the user is actually typing on.
//
// `Alt` shortcuts need this. macOS composes the character away when Option is
// held (Option+Z types "Ω"), so the key position is the only thing left to
// match a combo against, and which key produces "z" depends on the layout: on
// QWERTZ it is the key US keyboards label "y", on Dvorak the one they label
// "/". The Electron main process reads the layout with `native-keymap`, which
// reports what every key types plain and with Shift held and announces layout
// switches, and hands it to this cache over IPC for the synchronous matcher in
// `keymap.ts`. Outside the desktop shell (the web build, tests) no layout ever
// arrives and the matcher stays on its US tables.

export type NativeKeyboardKeyMapping = {
  value: string;
  valueIsDeadKey?: boolean;
  withShift: string;
  withShiftIsDeadKey?: boolean;
};

export type NativeKeyboardLayout = Readonly<Record<string, NativeKeyboardKeyMapping>>;

type KeyboardLayoutShell = {
  getKeyboardLayout: () => Promise<NativeKeyboardLayout | null>;
  onKeyboardLayoutChanged: (callback: (layout: NativeKeyboardLayout) => void) => () => void;
};

const letters = 'abcdefghijklmnopqrstuvwxyz';

// The keys a layout redraws, in the order a character appearing twice is
// claimed: letters, then digits, then punctuation in row order. Everything
// else (Numpad, Space, Enter, function keys) never answers for a character a
// combo can name.
const writingSystemCodes = [
  ...[...letters].map((letter) => `Key${letter.toUpperCase()}`),
  ...'1234567890'.split('').map((digit) => `Digit${digit}`),
  'Backquote',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'IntlBackslash',
  'IntlRo',
  'IntlYen',
];

// Keyed by character, so a combo naming "z" can find its key. One map per
// Shift state, because Shift moves punctuation and digits around.
let unshifted: ReadonlyMap<string, string> | null = null;
let shifted: ReadonlyMap<string, string> | null = null;
// Keyed by position, so a spelling like `Shift+/` can find the character that
// press really types.
let shiftedByCode: ReadonlyMap<string, string> | null = null;
let unsubscribe: (() => void) | null = null;
let sawPushedLayout = false;
// Bumped by every reset, so a startup read still in flight cannot land
// afterwards and put the layout back.
let generation = 0;

export const codeForCharacter = (character: string, shiftKey: boolean): string | null =>
  (shiftKey ? shifted : unshifted)?.get(character) ?? null;

export const shiftedCharacterForCode = (code: string): string | null =>
  shiftedByCode?.get(code) ?? null;

export const hasKeyboardLayout = (): boolean => unshifted !== null;

// Starts the renderer tracking the layout the desktop shell reports. Callers
// do not wait for it: until the first answer lands `hasKeyboardLayout()` is
// false and `keymap.ts` resolves combos against its US tables, which is where
// every environment without a shell stays permanently.
export const trackKeyboardLayout = (): void => {
  // The web build and the test environment have no desktop shell at all, so
  // the property is optional here no matter what the global type promises.
  const shell = (window as unknown as { codiff?: KeyboardLayoutShell }).codiff;
  if (!shell) {
    return;
  }

  if (unsubscribe === null) {
    unsubscribe = shell.onKeyboardLayoutChanged((layout) => {
      sawPushedLayout = true;
      applyKeyboardLayout(layout);
    });
  }

  const startedAt = generation;
  shell.getKeyboardLayout().then(
    (layout) => {
      // A layout pushed while this read was on the wire is newer than what the
      // read answers with, and a reset means nobody wants the answer at all.
      if (layout && !sawPushedLayout && startedAt === generation) {
        applyKeyboardLayout(layout);
      }
    },
    () => {
      // A shell that cannot answer leaves the US tables in charge.
    },
  );
};

export const applyKeyboardLayout = (layout: NativeKeyboardLayout): void => {
  const withLetters = withLatinLetters(layout);
  const nextUnshifted = new Map<string, string>();
  const nextShifted = new Map<string, string>();
  const nextShiftedByCode = new Map<string, string>();

  for (const code of writingSystemCodes) {
    const mapping = withLetters[code];
    if (mapping) {
      const value = usableCharacter(mapping.value, mapping.valueIsDeadKey);
      const withShift = usableCharacter(mapping.withShift, mapping.withShiftIsDeadKey);
      if (value !== null && !nextUnshifted.has(value)) {
        nextUnshifted.set(value, code);
      }
      if (withShift !== null) {
        if (!nextShifted.has(withShift)) {
          nextShifted.set(withShift, code);
        }
        nextShiftedByCode.set(code, withShift);
      }
    }
  }

  unshifted = nextUnshifted;
  shifted = nextShifted;
  shiftedByCode = nextShiftedByCode;
};

export const resetKeyboardLayout = (): void => {
  unshifted = null;
  shifted = null;
  shiftedByCode = null;
  sawPushedLayout = false;
  generation++;
  unsubscribe?.();
  unsubscribe = null;
};

// Latin letters at the positions US keyboards put them, for a layout that
// types none of its own.
//
// Cyrillic, Greek, Arabic and Hebrew layouts produce no Latin at all, so every
// letter shortcut would have no key to match and would silently stop working,
// including the `Alt+z` Codiff ships. Each letter replaces whatever the layout
// put on that key, in both Shift states, so one position still produces one
// character and two combo spellings can never claim the same key.
//
// It is all or nothing on purpose. Filling in one missing letter at a time
// would take a key away from a character the layout really does type there, so
// a layout that types any Latin anywhere, plain or shifted, is left exactly as
// it reported itself.
const withLatinLetters = (layout: NativeKeyboardLayout): NativeKeyboardLayout => {
  const typesLatin = Object.values(layout).some(
    (mapping) =>
      isLatinLetter(mapping.value, mapping.valueIsDeadKey) ||
      isLatinLetter(mapping.withShift, mapping.withShiftIsDeadKey),
  );
  if (typesLatin) {
    return layout;
  }

  const result: Record<string, NativeKeyboardKeyMapping> = { ...layout };
  for (const letter of letters) {
    result[`Key${letter.toUpperCase()}`] = { value: letter, withShift: letter.toUpperCase() };
  }

  return result;
};

const isLatinLetter = (value: string, isDeadKey: boolean | undefined): boolean => {
  const character = usableCharacter(value, isDeadKey);
  return character !== null && letters.includes(character);
};

// A key answers for the single printable character it types. Dead keys arm a
// composition rather than typing, named keys like Enter report empty strings,
// and matching is case-insensitive so a Shift column's "Z" answers to the
// spelling "z". A character whose lowercase form is longer than itself, like
// "İ", keeps its own spelling.
const usableCharacter = (value: string, isDeadKey: boolean | undefined): string | null => {
  if (isDeadKey || value.length !== 1) {
    return null;
  }

  const lower = value.toLowerCase();
  return lower.length === 1 ? lower : value;
};
