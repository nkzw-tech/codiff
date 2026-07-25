/**
 * @vitest-environment jsdom
 */

import { afterEach, expect, test, vi } from 'vite-plus/test';
import { loadKeyboardLayout, resetKeyboardLayout } from '../config/keyboard-layout.ts';
import { matchesShortcut } from '../config/keymap.ts';
import type { CodiffKeymap } from '../config/types.ts';

afterEach(() => {
  resetKeyboardLayout();
  vi.restoreAllMocks();
});

test('matches an Alt shortcut on macOS where Option composes the letter away', () => {
  // Arrange
  const { keydown, keymap } = createTestContext({ platform: 'MacIntel' });

  // Act: macOS turns Option+Z into "Ω" but still reports the physical key.
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'KeyZ', key: 'Ω' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(true);
});

test('matches an Alt shortcut bound to a digit', () => {
  // Arrange
  const { keydown, keymap } = createTestContext({ toggleWordWrap: 'Alt+1' });

  // Act: Option+1 composes to "¡" on a US layout.
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'Digit1', key: '¡' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(true);
});

test('does not match an Alt shortcut when a different physical key is pressed', () => {
  // Arrange
  const { keydown, keymap } = createTestContext();

  // Act: Option+X, which composes to "≈" and must not trigger Alt+z.
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'KeyX', key: '≈' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(false);
});

test('does not match an Alt shortcut bound to a named key against a press with no code', () => {
  // Arrange: `Enter` has no physical-key fallback, so an event that reports no
  // code must not be treated as an empty-for-empty match.
  const { keydown, keymap } = createTestContext({ toggleWordWrap: 'Alt+Enter' });

  // Act
  const matched = matchesShortcut(
    keydown({ altKey: true, code: '', key: 'œ' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(false);
});

test('does not let one keypress match two different Alt shortcuts', () => {
  // Arrange: on QWERTZ the key at the US "z" position is labelled "y", and
  // Windows does not compose the character away.
  const { keydown, keymap } = createTestContext({
    commandBar: 'Alt+z',
    platform: 'Win32',
    toggleSidebar: 'Alt+y',
  });
  const event = keydown({ altKey: true, code: 'KeyZ', key: 'y' });

  // Act
  const matched = {
    commandBar: matchesShortcut(event, keymap, 'commandBar'),
    toggleSidebar: matchesShortcut(event, keymap, 'toggleSidebar'),
  };

  // Assert: the character the user typed wins; the US key position does not.
  expect(matched).toEqual({ commandBar: false, toggleSidebar: true });
});

test('lets a layout character win over the US key position it sits on', () => {
  // Arrange: AZERTY produces "é" natively at the US "2" position, so the
  // character is real input rather than something Option composed away.
  const { keydown, keymap } = createTestContext({ commandBar: 'Alt+2', toggleSidebar: 'Alt+é' });
  const event = keydown({ altKey: true, code: 'Digit2', key: 'é' });

  // Act
  const matched = {
    commandBar: matchesShortcut(event, keymap, 'commandBar'),
    toggleSidebar: matchesShortcut(event, keymap, 'toggleSidebar'),
  };

  // Assert
  expect(matched).toEqual({ commandBar: false, toggleSidebar: true });
});

test('does not fall back to the US key position on platforms that never compose', () => {
  // Arrange
  const { keydown, keymap } = createTestContext({ platform: 'Win32' });

  // Act
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'KeyZ', key: 'Ω' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(false);
});

test('fails closed when the event reports no usable key', () => {
  // Arrange
  const { keydown, keymap } = createTestContext();

  // Act
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'KeyZ', key: 'Unidentified' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(false);
});

test('matches an Alt shortcut bound to shifted punctuation', () => {
  // Arrange: the shipped `Shift+?` default shows combos name the resulting
  // character, not the unshifted one.
  const { keydown, keymap } = createTestContext({ toggleWordWrap: 'Alt+Shift+?' });

  // Act
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'Slash', key: '¿', shiftKey: true }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(true);
});

test('does not let shifted and unshifted punctuation on one key collide', () => {
  // Arrange: "?" and "/" share the US Slash key, so only the spelling whose
  // Shift state the combo declares may claim that position.
  const { keydown, keymap } = createTestContext({ commandBar: 'Alt+?', toggleWordWrap: 'Alt+/' });
  const event = keydown({ altKey: true, code: 'Slash', key: '÷' });

  // Act
  const matched = {
    commandBar: matchesShortcut(event, keymap, 'commandBar'),
    toggleWordWrap: matchesShortcut(event, keymap, 'toggleWordWrap'),
  };

  // Assert
  expect(matched).toEqual({ commandBar: false, toggleWordWrap: true });
});

test('does not let a shifted digit collide with the digit sharing its key', () => {
  // Arrange
  const { keydown, keymap } = createTestContext({
    commandBar: 'Alt+Shift+1',
    toggleWordWrap: 'Alt+Shift+!',
  });
  const event = keydown({ altKey: true, code: 'Digit1', key: '⁄', shiftKey: true });

  // Act
  const matched = {
    commandBar: matchesShortcut(event, keymap, 'commandBar'),
    toggleWordWrap: matchesShortcut(event, keymap, 'toggleWordWrap'),
  };

  // Assert
  expect(matched).toEqual({ commandBar: false, toggleWordWrap: true });
});

test('lets a binding on the composed character itself suppress the position fallback', () => {
  // Arrange: binding the composed character is exotic, but if someone does it
  // that binding owns the keypress and the position fallback stays out of it.
  const { keydown, keymap } = createTestContext({
    closeSearch: 'Alt+ω',
    toggleWordWrap: 'Alt+z',
  });
  const event = keydown({ altKey: true, code: 'KeyZ', key: 'ω' });

  // Act
  const matched = {
    closeSearch: matchesShortcut(event, keymap, 'closeSearch'),
    toggleWordWrap: matchesShortcut(event, keymap, 'toggleWordWrap'),
  };

  // Assert
  expect(matched).toEqual({ closeSearch: true, toggleWordWrap: false });
});

test('resolves a swallowed character to the US key position when nothing else claims it', () => {
  // Arrange: with no layout read yet, the fallback is defined in terms of US
  // key positions, so on a layout that moves keys it can fire an action the
  // label does not suggest. It only ever does so for a keypress no binding
  // matched by character, so it cannot take one from another shortcut.
  const { keydown, keymap } = createTestContext({ toggleWordWrap: 'Alt+2' });

  // Act
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'Digit2', key: '™' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(true);
});

test('matches an Alt shortcut on the typed character when the physical key differs', () => {
  // Arrange: a layout where the character "z" sits on the US "y" position.
  const { keydown, keymap } = createTestContext({ platform: 'Win32' });

  // Act
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'KeyY', key: 'z' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(true);
});

test('matches an Alt shortcut bound to punctuation that Option composes away', () => {
  // Arrange
  const { keydown, keymap } = createTestContext({ toggleWordWrap: 'Alt+/' });

  // Act: Option+/ composes to "÷" on a US layout.
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'Slash', key: '÷' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(true);
});

test('matches a non-Alt shortcut on the character the layout produces', () => {
  // Arrange
  const { keydown, keymap } = createTestContext();

  // Act
  const matched = matchesShortcut(
    keydown({ code: 'KeyF', key: 'f', metaKey: true }),
    keymap,
    'diffSearch',
  );

  // Assert
  expect(matched).toBe(true);
});

test('does not fall back to the physical key for shortcuts without Alt', () => {
  // Arrange: on a remapped layout the character, not the key position, wins.
  const { keydown, keymap } = createTestContext();

  // Act
  const matched = matchesShortcut(
    keydown({ code: 'KeyF', key: 'ç', metaKey: true }),
    keymap,
    'diffSearch',
  );

  // Assert
  expect(matched).toBe(false);
});

test('resolves an Alt shortcut to the key that produces its character on this layout', async () => {
  // Arrange: QWERTZ types "z" on the key US keyboards label "y".
  const { keydown, keymap } = createTestContext();
  await withKeyboardLayout({ KeyY: 'z', KeyZ: 'y' });

  // Act
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'KeyY', key: 'Ω' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(true);
});

test('does not resolve an Alt shortcut to the US position on a layout that moved it', async () => {
  // Arrange
  const { keydown, keymap } = createTestContext();
  await withKeyboardLayout({ KeyY: 'z', KeyZ: 'y' });

  // Act: this key types "y" on QWERTZ, so it must not toggle word wrap.
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'KeyZ', key: 'Ω' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(false);
});

test('resolves an Alt shortcut to a punctuation key when the layout puts a letter there', async () => {
  // Arrange: Dvorak types "z" on the key US keyboards label "/".
  const { keydown, keymap } = createTestContext();
  await withKeyboardLayout({ KeyZ: ';', Slash: 'z' });

  // Act
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'Slash', key: '÷' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(true);
});

test('keeps shifted Alt shortcuts on US key positions', async () => {
  // Arrange: the keyboard map reports unmodified characters only, so a shifted
  // spelling has no layout answer. Resolving "z" through the layout and "?"
  // through the US table would otherwise put both on Dvorak's Slash key.
  const { keydown, keymap } = createTestContext({
    commandBar: 'Alt+Shift+z',
    toggleWordWrap: 'Alt+Shift+?',
  });
  await withKeyboardLayout({ KeyZ: ';', Slash: 'z' });
  const event = keydown({ altKey: true, code: 'Slash', key: '¿', shiftKey: true });

  // Act
  const matched = {
    commandBar: matchesShortcut(event, keymap, 'commandBar'),
    toggleWordWrap: matchesShortcut(event, keymap, 'toggleWordWrap'),
  };

  // Assert
  expect(matched).toEqual({ commandBar: false, toggleWordWrap: true });
});

test('resolves a letter shortcut to its US position on a layout that types no Latin', async () => {
  // Arrange
  const { keydown, keymap } = createTestContext();
  await withKeyboardLayout({ KeyA: 'ф', KeyZ: 'я' });

  // Act
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'KeyZ', key: 'Ω' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(true);
});

test('does not fire an Alt shortcut whose character the layout cannot type', async () => {
  // Arrange: German types "-" where US keyboards have "/", and reaches "/"
  // only through Shift. Falling back to the US position would fire this on the
  // key that types "-", which already answers to `Alt+-`.
  const { keydown, keymap } = createTestContext({ toggleWordWrap: 'Alt+/' });
  await withKeyboardLayout({ Minus: 'ß', Slash: '-' });

  // Act
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'Slash', key: '÷' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(false);
});

test('falls back to the US position while no layout has been read', () => {
  // Arrange: the layout arrives asynchronously, so every keypress before it
  // lands resolves the way it did before layouts were consulted at all.
  const { keydown, keymap } = createTestContext();

  // Act
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'KeyZ', key: 'Ω' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(true);
});

test('never lets two shortcut combos claim the same key', async () => {
  // Arrange: one key must answer to at most one spelling, or a single keypress
  // fires two actions and which one wins is down to the order the app happens
  // to check them in. Resolution has three sources, and this walks every
  // spelling through all of them on layouts that move keys in different ways.
  const collisions: Array<string> = [];

  for (const [name, layout] of Object.entries(keyboardLayouts)) {
    resetKeyboardLayout();
    if (layout !== null) {
      await withKeyboardLayout(layout);
    }

    // Act
    for (const shiftKey of [false, true]) {
      const claimedBy = new Map<string, string>();
      for (const spelling of comboSpellings) {
        const code = resolvePhysicalKey(spelling, shiftKey);
        const previous = code === null ? undefined : claimedBy.get(code);
        if (code !== null && previous !== undefined) {
          collisions.push(`${name}: "${previous}" and "${spelling}" both claim ${code}`);
        } else if (code !== null) {
          claimedBy.set(code, spelling);
        }
      }
    }
  }

  // Assert
  expect(collisions).toEqual([]);
});

// The key a combo resolves to, found by pressing every key in turn. The event
// reports a character no spelling names, so only the key position can match it.
function resolvePhysicalKey(spelling: string, shiftKey: boolean): string | null {
  const { keydown, keymap } = createTestContext({
    toggleWordWrap: `Alt+${shiftKey ? 'Shift+' : ''}${spelling}`,
  });

  return (
    candidateCodes.find((code) =>
      matchesShortcut(
        keydown({ altKey: true, code, key: unmatchableCharacter, shiftKey }),
        keymap,
        'toggleWordWrap',
      ),
    ) ?? null
  );
}

function createTestContext({
  platform = 'MacIntel',
  ...overrides
}: { platform?: string } & Partial<CodiffKeymap> = {}) {
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue(platform);

  const keymap = {
    closeSearch: 'Escape',
    commandBar: 'Mod+Shift+p',
    diffSearch: 'Mod+f',
    discardComment: 'Escape',
    fileFilter: 'Mod+p',
    nextHunk: ['Ctrl+ArrowDown', 'j'],
    nextSearchMatch: 'Enter',
    openFile: 'Mod+k',
    prevHunk: ['Ctrl+ArrowUp', 'k'],
    prevSearchMatch: 'Shift+Enter',
    shortcutsHelp: 'Shift+?',
    submitComment: 'Mod+Enter',
    toggleSidebar: 'Mod+Shift+b',
    toggleWordWrap: 'Alt+z',
    ...overrides,
  } satisfies CodiffKeymap;

  return { keydown, keymap };
}

async function withKeyboardLayout(layout: Record<string, string>) {
  Object.defineProperty(navigator, 'keyboard', {
    configurable: true,
    value: { getLayoutMap: () => Promise.resolve(new Map(Object.entries(layout))) },
  });

  await loadKeyboardLayout();
}

// A character from the Unicode private use area: no keyboard produces it and no
// shortcut can name it.
const unmatchableCharacter = '\uE000';

const candidateCodes = [
  ...'abcdefghijklmnopqrstuvwxyz'.split('').map((letter) => `Key${letter.toUpperCase()}`),
  ...'0123456789'.split('').map((digit) => `Digit${digit}`),
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
];

// Every character a combo can name, so a spelling added to the punctuation
// tables later is covered without touching this list. `+` separates the parts
// of a combo and space is trimmed away, so neither can be named, and combos are
// lowercased when parsed, so `Alt+A` is another way to write `Alt+a` rather
// than a second spelling that could collide with it.
const comboSpellings = Array.from({ length: 0x7e - 0x21 + 1 }, (_, index) =>
  String.fromCharCode(0x21 + index),
)
  .filter((character) => character !== '+' && !/^[A-Z]$/.test(character))
  .concat(['é', 'ü', 'ß', 'я', 'ω']);

// Approximations of real layouts, accurate in the ways that matter here: which
// keys move, which characters need Shift, and which layouts produce no Latin.
// Each row runs left to right across `keyRows`.
const keyRows = [
  ['Backquote', ...'1234567890'.split('').map((digit) => `Digit${digit}`), 'Minus', 'Equal'],
  [
    ...'qwertyuiop'.split('').map((l) => `Key${l.toUpperCase()}`),
    'BracketLeft',
    'BracketRight',
    'Backslash',
  ],
  [...'asdfghjkl'.split('').map((l) => `Key${l.toUpperCase()}`), 'Semicolon', 'Quote'],
  [...'zxcvbnm'.split('').map((l) => `Key${l.toUpperCase()}`), 'Comma', 'Period', 'Slash'],
];

const keyboardLayouts: Record<string, Record<string, string> | null> = {
  azerty: layoutFromRows(['@&é"\'(§è!çà)-', 'azertyuiop^$`', 'qsdfghjklmù', 'wxcvbn,;:!']),
  dvorak: layoutFromRows(['`1234567890[]', "',.pyfgcrl/=\\", 'aoeuidhtns-', ';qjkxbmwvz']),
  german: layoutFromRows(['^1234567890ß´', 'qwertzuiopü+#', 'asdfghjklöä', 'yxcvbnm,.-']),
  none: null,
  // Types most of the alphabet but not all of it, which is where filling in the
  // missing letters one at a time would take a key from one that is there.
  partialLatin: layoutFromRows(['`1234567890-=', 'ąwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./']),
  // Puts symbols on the number row and reaches the digits through Shift, so
  // assuming the US number row would resolve them to the wrong keys.
  programmerDvorak: layoutFromRows([
    '$&[{}(=*)+]!#',
    ';,.pyfgcrl/@\\',
    'aoeuidhtns-',
    "'qjkxbmwvz",
  ]),
  russian: layoutFromRows([']1234567890-=', 'йцукенгшщзхъё', 'фывапролджэ', 'ячсмитьбю.']),
  us: layoutFromRows(['`1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./']),
};

function layoutFromRows(rows: ReadonlyArray<string>): Record<string, string> {
  const layout: Record<string, string> = {};

  rows.forEach((row, index) => {
    const codes = keyRows[index];
    [...row].forEach((character, position) => {
      layout[codes[position]] = character;
    });
  });

  return layout;
}

function keydown({
  altKey = false,
  code = '',
  ctrlKey = false,
  key,
  metaKey = false,
  shiftKey = false,
}: {
  altKey?: boolean;
  code?: string;
  ctrlKey?: boolean;
  key: string;
  metaKey?: boolean;
  shiftKey?: boolean;
}) {
  return new KeyboardEvent('keydown', { altKey, code, ctrlKey, key, metaKey, shiftKey });
}
