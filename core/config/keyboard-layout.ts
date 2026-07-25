// Where each character sits on the keyboard the user is actually typing on.
//
// `Alt` shortcuts need this. macOS composes the character away when Option is
// held (Option+Z types "Ω"), so the key position is the only thing left to
// match a combo against, and which key produces "z" depends on the layout: on
// QWERTZ it is the key US keyboards label "y", on Dvorak the one they label
// "/". `navigator.keyboard.getLayoutMap()` answers that, but only
// asynchronously and only for unmodified characters, so it is read here and
// cached for the synchronous matcher in `keymap.ts`.

type KeyboardLayoutSource = {
  getLayoutMap?: () => Promise<ReadonlyMap<string, string>>;
};

const letters = 'abcdefghijklmnopqrstuvwxyz';
// How long a keypress that disagrees with the layout waits before another one
// may ask for a fresh read.
const rereadInterval = 2000;

// Keyed by character, so a combo naming "z" can find its key.
let characterToCode: ReadonlyMap<string, string> | null = null;
// The layout exactly as reported, used to notice that it changed.
let codeToCharacter: ReadonlyMap<string, string> | null = null;
let reading: Promise<void> | null = null;
let watching = false;
// Bumped by every reset, so a read that was already in flight cannot land
// afterwards and put the layout back.
let generation = 0;
let lastRereadAt = Number.NEGATIVE_INFINITY;

export const codeForCharacter = (character: string): string | null =>
  characterToCode?.get(character) ?? null;

export const hasKeyboardLayout = (): boolean => characterToCode !== null;

// Starts the app tracking the layout. Callers do not wait for it: until the
// first read lands `hasKeyboardLayout()` is false and `keymap.ts` resolves
// combos against its US tables, which is where every platform without this API
// stays permanently.
export const trackKeyboardLayout = (): void => {
  if (!watching) {
    watching = true;
    window.addEventListener('focus', handleFocus);
    window.addEventListener('keydown', handleKeyDown, { capture: true, passive: true });
  }

  void loadKeyboardLayout();
};

export const loadKeyboardLayout = (): Promise<void> => {
  reading ??= readLayout().finally(() => {
    reading = null;
  });

  return reading;
};

export const resetKeyboardLayout = (): void => {
  characterToCode = null;
  codeToCharacter = null;
  reading = null;
  lastRereadAt = Number.NEGATIVE_INFINITY;
  generation++;

  if (watching) {
    watching = false;
    window.removeEventListener('focus', handleFocus);
    window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }
};

const readLayout = async (): Promise<void> => {
  const startedAt = generation;
  const keyboard = (navigator as Navigator & { keyboard?: KeyboardLayoutSource }).keyboard;
  if (!keyboard?.getLayoutMap) {
    return;
  }

  try {
    const layout = await keyboard.getLayoutMap();
    // A window with no keyboard attached to it reports zero keys, and a
    // non-secure context rejects outright. Both are missing answers rather than
    // news about the keyboard, so whatever is already known survives them; at
    // startup that is nothing, which is the same as failing outright.
    if (startedAt !== generation || layout.size === 0) {
      return;
    }

    codeToCharacter = new Map(layout);
    characterToCode = byCharacter(withLatinLetters(layout));
  } catch {
    // Platforms without the API reject too. The US tables cover them.
  }
};

// Latin letters at the positions US keyboards put them, for a layout that types
// none of its own.
//
// Cyrillic, Greek, Arabic and Hebrew layouts produce no Latin at all, so every
// letter shortcut would have no key to match and would silently stop working,
// including the `Alt+z` Codiff ships. Each letter replaces whatever the layout
// put on that key rather than being added alongside it, so one position still
// produces one character and two combo spellings can never claim the same key.
//
// It is all or nothing on purpose. Filling in individual letters would take a
// key away from a character the layout really does type there, so a layout that
// types most of the alphabet is left exactly as it reported itself. Digits get
// no such treatment at all: AZERTY reaches them only with Shift, which the
// keyboard map does not report, and while assuming the US number row would be
// right there, it would be wrong on Programmer Dvorak, which moves the digits.
// Naming the character the key actually types works on both.
//
// VS Code fills in missing letters the same way, per letter rather than all at
// once, because `native-keymap` gives it the shifted values to disambiguate.
const withLatinLetters = (layout: ReadonlyMap<string, string>): ReadonlyMap<string, string> => {
  const produced = new Set(layout.values());
  if ([...letters].some((letter) => produced.has(letter))) {
    return layout;
  }

  const result = new Map(layout);
  for (const letter of letters) {
    result.set(`Key${letter.toUpperCase()}`, letter);
  }

  return result;
};

// A layout may put one character on two keys. The first one wins so that a
// character always names a single key and the answer does not drift between
// reads.
const byCharacter = (layout: ReadonlyMap<string, string>): ReadonlyMap<string, string> => {
  const result = new Map<string, string>();

  for (const [code, character] of layout) {
    if (!result.has(character)) {
      result.set(character, code);
    }
  }

  return result;
};

const handleFocus = (): void => {
  void loadKeyboardLayout();
};

// Chromium reports no layout change event, and `navigator.keyboard` is not even
// an `EventTarget`, so switching input source has to be inferred. A keypress
// that reports a character the cached layout does not put on that key says the
// layout moved. Modifiers, dead keys and Caps Lock all report something other
// than the key's plain character, so only an unmodified press counts.
//
// Some disagreements never resolve, because remapping software can rewrite what
// a key reports without the layout knowing. Those must not turn every keystroke
// into another read, so a disagreement only asks once every `rereadInterval`.
const handleKeyDown = (event: KeyboardEvent): void => {
  if (
    codeToCharacter === null ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.key.length !== 1 ||
    event.getModifierState('CapsLock') ||
    performance.now() - lastRereadAt < rereadInterval
  ) {
    return;
  }

  const character = codeToCharacter.get(event.code);
  if (character !== undefined && character !== event.key) {
    lastRereadAt = performance.now();
    void loadKeyboardLayout();
  }
};
