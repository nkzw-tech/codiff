/**
 * @vitest-environment jsdom
 */

import { afterEach, expect, test, vi } from 'vite-plus/test';
import { applyKeyboardLayout, resetKeyboardLayout } from '../config/keyboard-layout.ts';
import type { NativeKeyboardLayout } from '../config/keyboard-layout.ts';
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

test('resolves a shifted Alt shortcut through the key that types its character', () => {
  // Arrange: German types "?" with Shift on the "ß" key, which sits at the US
  // "-" position.
  const { keydown, keymap } = createTestContext({ toggleWordWrap: 'Alt+Shift+?' });
  applyKeyboardLayout(germanLayout);

  // Act
  const matched = {
    minus: matchesShortcut(
      keydown({ altKey: true, code: 'Minus', key: '¿', shiftKey: true }),
      keymap,
      'toggleWordWrap',
    ),
    slash: matchesShortcut(
      keydown({ altKey: true, code: 'Slash', key: '¿', shiftKey: true }),
      keymap,
      'toggleWordWrap',
    ),
  };

  // Assert: the US position stays quiet.
  expect(matched).toEqual({ minus: true, slash: false });
});

test('resolves shifted letter and punctuation spellings to their own keys', () => {
  // Arrange: Dvorak types "z" on the key US keyboards label "/" and "?" on the
  // key they label "[". Resolving both through the layout keeps each spelling
  // on the key that really types it.
  const { keydown, keymap } = createTestContext({
    commandBar: 'Alt+Shift+z',
    toggleWordWrap: 'Alt+Shift+?',
  });
  applyKeyboardLayout(dvorakLayout);
  const onBracket = keydown({ altKey: true, code: 'BracketLeft', key: '¿', shiftKey: true });
  const onSlash = keydown({ altKey: true, code: 'Slash', key: '¿', shiftKey: true });

  // Act
  const matched = {
    bracketQuestion: matchesShortcut(onBracket, keymap, 'toggleWordWrap'),
    bracketZ: matchesShortcut(onBracket, keymap, 'commandBar'),
    slashQuestion: matchesShortcut(onSlash, keymap, 'toggleWordWrap'),
    slashZ: matchesShortcut(onSlash, keymap, 'commandBar'),
  };

  // Assert
  expect(matched).toEqual({
    bracketQuestion: true,
    bracketZ: false,
    slashQuestion: false,
    slashZ: true,
  });
});

test('accepts the unshifted spelling of a shifted keystroke', () => {
  // Arrange: `Shift+/` and `Shift+?` are the same keystroke on a US keyboard,
  // so both spellings describe it and both fire.
  const { keydown, keymap } = createTestContext({
    commandBar: 'Alt+Shift+/',
    toggleWordWrap: 'Alt+Shift+?',
  });
  applyKeyboardLayout(usLayout);
  const event = keydown({ altKey: true, code: 'Slash', key: '¿', shiftKey: true });

  // Act
  const matched = {
    commandBar: matchesShortcut(event, keymap, 'commandBar'),
    toggleWordWrap: matchesShortcut(event, keymap, 'toggleWordWrap'),
  };

  // Assert
  expect(matched).toEqual({ commandBar: true, toggleWordWrap: true });
});

test('matches a shifted spelling written by the key it sits on', () => {
  // Arrange: `Mod+Shift+/` names the keystroke that types "?", with and
  // without a layout to consult.
  const { keydown, keymap } = createTestContext({ diffSearch: 'Mod+Shift+/' });
  const event = keydown({ key: '?', metaKey: true, shiftKey: true });

  // Act
  const noLayout = matchesShortcut(event, keymap, 'diffSearch');
  applyKeyboardLayout(usLayout);
  const withLayout = matchesShortcut(event, keymap, 'diffSearch');

  // Assert
  expect({ noLayout, withLayout }).toEqual({ noLayout: true, withLayout: true });
});

test('follows the layout when a spelling is written by its key', () => {
  // Arrange: German Shift+7 types "/", so `Mod+Shift+7` names that keystroke
  // rather than the "&" a US keyboard would put there.
  const { keydown, keymap } = createTestContext({ diffSearch: 'Mod+Shift+7' });
  applyKeyboardLayout(germanLayout);

  // Act
  const matched = {
    ampersand: matchesShortcut(
      keydown({ key: '&', metaKey: true, shiftKey: true }),
      keymap,
      'diffSearch',
    ),
    slash: matchesShortcut(
      keydown({ key: '/', metaKey: true, shiftKey: true }),
      keymap,
      'diffSearch',
    ),
  };

  // Assert
  expect(matched).toEqual({ ampersand: false, slash: true });
});

test('resolves a digit the layout reaches only through Shift to its real key', () => {
  // Arrange: AZERTY keeps "1" on the US "1" key but behind Shift, while
  // Programmer Dvorak moves it elsewhere entirely.
  const { keydown, keymap } = createTestContext({ toggleWordWrap: 'Alt+Shift+1' });
  applyKeyboardLayout(azertyLayout);

  // Act
  const azerty = matchesShortcut(
    keydown({ altKey: true, code: 'Digit1', key: '¿', shiftKey: true }),
    keymap,
    'toggleWordWrap',
  );
  applyKeyboardLayout(programmerDvorakLayout);
  const programmerDvorak = {
    movedKey: matchesShortcut(
      keydown({ altKey: true, code: 'Digit5', key: '¿', shiftKey: true }),
      keymap,
      'toggleWordWrap',
    ),
    usKey: matchesShortcut(
      keydown({ altKey: true, code: 'Digit1', key: '¿', shiftKey: true }),
      keymap,
      'toggleWordWrap',
    ),
  };

  // Assert
  expect({ azerty, ...programmerDvorak }).toEqual({
    azerty: true,
    movedKey: true,
    usKey: false,
  });
});

test('gives the combo delimiter character a spelling through Shift+=', () => {
  // Arrange: `+` separates the parts of a combo, so the keystroke that types
  // it can only be named by the key it sits on.
  const { keydown, keymap } = createTestContext({ toggleWordWrap: 'Alt+Shift+=' });
  const event = keydown({ altKey: true, code: 'Equal', key: '±', shiftKey: true });

  // Act
  const noLayout = matchesShortcut(event, keymap, 'toggleWordWrap');
  applyKeyboardLayout(usLayout);
  const withLayout = matchesShortcut(event, keymap, 'toggleWordWrap');

  // Assert
  expect({ noLayout, withLayout }).toEqual({ noLayout: true, withLayout: true });
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

test('treats a shifted digit and the character it types as one chord', () => {
  // Arrange: on a US keyboard Shift+1 and "!" are the same keystroke, so both
  // spellings describe it and both fire.
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
  expect(matched).toEqual({ commandBar: true, toggleWordWrap: true });
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

test('resolves an Alt shortcut to the key that produces its character on this layout', () => {
  // Arrange: QWERTZ types "z" on the key US keyboards label "y".
  const { keydown, keymap } = createTestContext();
  withKeyboardLayout({ KeyY: 'z', KeyZ: 'y' });

  // Act
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'KeyY', key: 'Ω' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(true);
});

test('does not resolve an Alt shortcut to the US position on a layout that moved it', () => {
  // Arrange
  const { keydown, keymap } = createTestContext();
  withKeyboardLayout({ KeyY: 'z', KeyZ: 'y' });

  // Act: this key types "y" on QWERTZ, so it must not toggle word wrap.
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'KeyZ', key: 'Ω' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(false);
});

test('resolves an Alt shortcut to a punctuation key when the layout puts a letter there', () => {
  // Arrange: Dvorak types "z" on the key US keyboards label "/".
  const { keydown, keymap } = createTestContext();
  withKeyboardLayout({ KeyZ: ';', Slash: 'z' });

  // Act
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'Slash', key: '÷' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(true);
});

test('resolves a letter shortcut to its US position on a layout that types no Latin', () => {
  // Arrange
  const { keydown, keymap } = createTestContext();
  withKeyboardLayout({ KeyA: 'ф', KeyZ: 'я' });

  // Act
  const matched = matchesShortcut(
    keydown({ altKey: true, code: 'KeyZ', key: 'Ω' }),
    keymap,
    'toggleWordWrap',
  );

  // Assert
  expect(matched).toBe(true);
});

test('does not fire an Alt shortcut whose character the layout cannot type', () => {
  // Arrange: German types "-" where US keyboards have "/", and reaches "/"
  // only through Shift. Falling back to the US position would fire this on the
  // key that types "-", which already answers to `Alt+-`.
  const { keydown, keymap } = createTestContext({ toggleWordWrap: 'Alt+/' });
  withKeyboardLayout({ Minus: 'ß', Slash: '-' });

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

test('never lets two shortcut combos claim the same keystroke unless they spell it both ways', () => {
  // Arrange: one keystroke must answer to at most one combo, or a single
  // keypress fires two actions and which one wins is down to the order the app
  // happens to check them in. The only exception is deliberate: with Shift
  // held, a key's own character and the character Shift makes it type are two
  // spellings of the same keystroke, like `Shift+/` and `Shift+?`.
  const collisions: Array<string> = [];

  for (const [name, layout] of Object.entries(keyboardLayouts)) {
    resetKeyboardLayout();
    if (layout !== null) {
      applyKeyboardLayout(layout);
    }

    // Act
    for (const shiftKey of [false, true]) {
      const claimedBy = new Map<string, string>();
      for (const spelling of comboSpellings) {
        const code = resolvePhysicalKey(spelling, shiftKey);
        const previous = code === null ? undefined : claimedBy.get(code);
        if (
          code !== null &&
          previous !== undefined &&
          !describesOneKeystroke(previous, spelling, code, shiftKey, layout)
        ) {
          collisions.push(`${name}: "${previous}" and "${spelling}" both claim ${code}`);
        } else if (code !== null && previous === undefined) {
          claimedBy.set(code, spelling);
        }
      }
    }
  }

  // Assert
  expect(collisions).toEqual([]);
});

test('resolves every combo to a key that really types its character', () => {
  // Arrange: a combo landing on a key that types something else is the bug all
  // of this replaces, so every resolved position is checked against what the
  // layout says that keystroke produces. Layouts that pin Latin letters are
  // covered by their own tests, since pinning moves letters on purpose.
  const wrongKeys: Array<string> = [];

  for (const [name, layout] of Object.entries(keyboardLayouts)) {
    if (layout !== null && name !== 'russian') {
      resetKeyboardLayout();
      applyKeyboardLayout(layout);

      // Act
      for (const shiftKey of [false, true]) {
        for (const spelling of comboSpellings) {
          const code = resolvePhysicalKey(spelling, shiftKey);
          if (code !== null) {
            const mapping = layout[code];
            const typed = mapping
              ? shiftKey
                ? [mapping.withShift.toLowerCase(), mapping.value.toLowerCase()]
                : [mapping.value.toLowerCase()]
              : [];
            if (!typed.includes(spelling)) {
              collect(wrongKeys, name, spelling, shiftKey, code, typed);
            }
          }
        }
      }
    }
  }

  // Assert
  expect(wrongKeys).toEqual([]);
});

function collect(
  wrongKeys: Array<string>,
  name: string,
  spelling: string,
  shiftKey: boolean,
  code: string,
  typed: ReadonlyArray<string>,
) {
  wrongKeys.push(
    `${name}: "${spelling}"${shiftKey ? ' with Shift' : ''} landed on ${code}, which types "${typed.join('", "')}"`,
  );
}

// Two spellings may share a keystroke only when the layout says they describe
// the same one: the key's own character named alongside the character Shift
// makes it type. Without a layout the US pairs answer.
function describesOneKeystroke(
  a: string,
  b: string,
  code: string,
  shiftKey: boolean,
  layout: NativeKeyboardLayout | null,
): boolean {
  if (!shiftKey) {
    return false;
  }
  if (layout === null) {
    return usShiftPairs[a] === b || usShiftPairs[b] === a;
  }

  const mapping = layout[code];
  if (!mapping) {
    return false;
  }

  const spellings = [mapping.value.toLowerCase(), mapping.withShift.toLowerCase()];
  return spellings.includes(a) && spellings.includes(b);
}

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

function withKeyboardLayout(layout: Record<string, string>) {
  applyKeyboardLayout(
    Object.fromEntries(
      Object.entries(layout).map(([code, value]) => [code, { value, withShift: '' }]),
    ),
  );
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

// The US pairing of a key's plain character with the one Shift makes it type,
// as an independent check on what the tables in `keymap.ts` encode.
const usShiftPairs: Record<string, string> = {
  '-': '_',
  ',': '<',
  ';': ':',
  '.': '>',
  "'": '"',
  '[': '{',
  ']': '}',
  '/': '?',
  '\\': '|',
  '`': '~',
  '=': '+',
  '0': ')',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
};

// Approximations of real layouts, accurate in the ways that matter here: which
// keys move, which characters need Shift, and which layouts produce no Latin.
// Each row pairs the plain characters with the ones Shift produces, running
// left to right across `keyRows`.
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

const usLayout = layoutFromRows([
  ['`1234567890-=', '~!@#$%^&*()_+'],
  ['qwertyuiop[]\\', 'QWERTYUIOP{}|'],
  ["asdfghjkl;'", 'ASDFGHJKL:"'],
  ['zxcvbnm,./', 'ZXCVBNM<>?'],
]);

const germanLayout = layoutFromRows([
  ['^1234567890ß´', '°!"§$%&/()=?`'],
  ['qwertzuiopü+#', "QWERTZUIOPÜ*'"],
  ['asdfghjklöä', 'ASDFGHJKLÖÄ'],
  ['yxcvbnm,.-', 'YXCVBNM;:_'],
]);

const azertyLayout = layoutFromRows([
  ['@&é"\'(§è!çà)-', '#1234567890°_'],
  ['azertyuiop^$`', 'AZERTYUIOP¨*£'],
  ['qsdfghjklmù', 'QSDFGHJKLM%'],
  ['wxcvbn,;:!', 'WXCVBN?./§'],
]);

const dvorakLayout = layoutFromRows([
  ['`1234567890[]', '~!@#$%^&*(){}'],
  ["',.pyfgcrl/=\\", '"<>PYFGCRL?+|'],
  ['aoeuidhtns-', 'AOEUIDHTNS_'],
  [';qjkxbmwvz', ':QJKXBMWVZ'],
]);

// Puts symbols on the number row and reaches the digits through Shift in an
// order of its own, so assuming the US number row would resolve them to the
// wrong keys.
const programmerDvorakLayout = layoutFromRows([
  ['$&[{}(=*)+]!#', '~%7531902468`'],
  [';,.pyfgcrl/@\\', ':<>PYFGCRL?^|'],
  ['aoeuidhtns-', 'AOEUIDHTNS_'],
  ["'qjkxbmwvz", '"QJKXBMWVZ'],
]);

// Types most of the alphabet but not all of it, which is where filling in the
// missing letters one at a time would take a key from one that is there.
const partialLatinLayout = layoutFromRows([
  ['`1234567890-=', '~!@#$%^&*()_+'],
  ['ąwertyuiop[]\\', 'ĄWERTYUIOP{}|'],
  ["asdfghjkl;'", 'ASDFGHJKL:"'],
  ['zxcvbnm,./', 'ZXCVBNM<>?'],
]);

const russianLayout = layoutFromRows([
  [']1234567890-=', '[!"№;%:?*()_+'],
  ['йцукенгшщзхъё', 'ЙЦУКЕНГШЩЗХЪЁ'],
  ['фывапролджэ', 'ФЫВАПРОЛДЖЭ'],
  ['ячсмитьбю.', 'ЯЧСМИТЬБЮ,'],
]);

const keyboardLayouts: Record<string, NativeKeyboardLayout | null> = {
  azerty: azertyLayout,
  dvorak: dvorakLayout,
  german: germanLayout,
  none: null,
  partialLatin: partialLatinLayout,
  programmerDvorak: programmerDvorakLayout,
  russian: russianLayout,
  us: usLayout,
};

function layoutFromRows(
  rows: ReadonlyArray<readonly [string, string]>,
): Record<string, { value: string; withShift: string }> {
  const layout: Record<string, { value: string; withShift: string }> = {};

  rows.forEach(([plain, shifted], index) => {
    const codes = keyRows[index];
    const shiftedCharacters = [...shifted];
    [...plain].forEach((character, position) => {
      layout[codes[position]] = {
        value: character,
        withShift: shiftedCharacters[position] ?? '',
      };
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
