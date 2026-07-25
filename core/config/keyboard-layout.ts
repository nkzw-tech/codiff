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
const digits = '0123456789';

// Keyed by character, so a combo naming "z" can find its key.
let characterToCode: ReadonlyMap<string, string> | null = null;
// The layout exactly as reported, used to notice that it changed.
let codeToCharacter: ReadonlyMap<string, string> | null = null;
let reading: Promise<void> | null = null;
let watching = false;

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

  if (watching) {
    watching = false;
    window.removeEventListener('focus', handleFocus);
    window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }
};

const readLayout = async (): Promise<void> => {
  const keyboard = (navigator as Navigator & { keyboard?: KeyboardLayoutSource }).keyboard;
  if (!keyboard?.getLayoutMap) {
    clearLayout();
    return;
  }

  try {
    const layout = await keyboard.getLayoutMap();
    // A window with no keyboard attached to it reports zero keys. That is a
    // missing answer, not a keyboard that produces nothing, so keep waiting for
    // a real one instead of caching it.
    if (layout.size === 0) {
      clearLayout();
      return;
    }

    codeToCharacter = new Map(layout);
    characterToCode = byCharacter(withLatinFallbacks(layout));
  } catch {
    // Platforms without the API and non-secure contexts reject. The US tables
    // cover both.
    clearLayout();
  }
};

const clearLayout = (): void => {
  characterToCode = null;
  codeToCharacter = null;
};

// Latin letters and digits every layout can reach, at the position US
// keyboards put them.
//
// A Cyrillic, Greek, Arabic or Hebrew layout produces no Latin letters, which
// would leave every letter shortcut with no key to match and silently dead.
// Digits are a milder version of the same problem: AZERTY types them only with
// Shift held, and the keyboard map reports unmodified characters only.
//
// Each missing character replaces whatever the layout put on that key rather
// than being added alongside it, so one position still produces one character
// and two combo spellings can never claim the same key. VS Code does the same
// thing with the richer per-key data `native-keymap` gives it.
const withLatinFallbacks = (layout: ReadonlyMap<string, string>): Map<string, string> => {
  const produced = new Set(layout.values());
  const result = new Map(layout);

  for (const letter of letters) {
    if (!produced.has(letter)) {
      result.set(`Key${letter.toUpperCase()}`, letter);
    }
  }
  for (const digit of digits) {
    if (!produced.has(digit)) {
      result.set(`Digit${digit}`, digit);
    }
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
// that reports a character the cached layout does not put on that key is proof
// the layout moved. Modifiers, dead keys and Caps Lock all report something
// other than the key's plain character, so only an unmodified press counts.
const handleKeyDown = (event: KeyboardEvent): void => {
  if (
    codeToCharacter === null ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.key.length !== 1 ||
    event.getModifierState('CapsLock')
  ) {
    return;
  }

  const character = codeToCharacter.get(event.code);
  if (character !== undefined && character !== event.key) {
    void loadKeyboardLayout();
  }
};
