/**
 * @vitest-environment jsdom
 */

import { afterEach, expect, test, vi } from 'vite-plus/test';
import {
  applyKeyboardLayout,
  codeForCharacter,
  hasKeyboardLayout,
  resetKeyboardLayout,
  shiftedCharacterForCode,
  trackKeyboardLayout,
} from '../config/keyboard-layout.ts';
import type { NativeKeyboardLayout } from '../config/keyboard-layout.ts';

afterEach(() => {
  resetKeyboardLayout();
  delete (window as { codiff?: unknown }).codiff;
});

test('resolves a character to the key position that produces it', () => {
  // Arrange: QWERTZ swaps the characters on the US "z" and "y" positions.
  const layout = { KeyY: key('z', 'Z'), KeyZ: key('y', 'Y') };

  // Act
  applyKeyboardLayout(layout);

  // Assert
  expect(codeForCharacter('z', false)).toBe('KeyY');
});

test('resolves a shifted character through the key that types it with Shift', () => {
  // Arrange: on German layouts "?" is typed with Shift on the "ß" key, which
  // sits at the US "-" position.
  const layout = { KeyQ: key('q', 'Q'), Minus: key('ß', '?') };

  // Act
  applyKeyboardLayout(layout);

  // Assert
  expect({
    plain: codeForCharacter('?', false),
    shifted: codeForCharacter('?', true),
  }).toEqual({ plain: null, shifted: 'Minus' });
});

test('matches a shifted letter by its lowercase spelling', () => {
  // Arrange: combos spell letters in lowercase, but Shift types them in
  // uppercase.
  const layout = { KeyZ: key('z', 'Z') };

  // Act
  applyKeyboardLayout(layout);

  // Assert
  expect(codeForCharacter('z', true)).toBe('KeyZ');
});

test('names the character a key produces with Shift held', () => {
  // Arrange
  const layout = { KeyZ: key('z', 'Z'), Slash: key('/', '?') };

  // Act
  applyKeyboardLayout(layout);

  // Assert
  expect({
    letter: shiftedCharacterForCode('KeyZ'),
    slash: shiftedCharacterForCode('Slash'),
    unknown: shiftedCharacterForCode('Digit1'),
  }).toEqual({ letter: 'z', slash: '?', unknown: null });
});

test('reports no layout before one has been applied', () => {
  // Assert
  expect({
    code: codeForCharacter('z', false),
    loaded: hasKeyboardLayout(),
    shifted: shiftedCharacterForCode('KeyZ'),
  }).toEqual({ code: null, loaded: false, shifted: null });
});

test('skips a position whose character is a dead key', () => {
  // Arrange: a dead key arms a composition instead of typing its character, so
  // no keypress ever reports it.
  const layout = {
    Backquote: {
      value: '`',
      valueIsDeadKey: true,
      withShift: '~',
      withShiftIsDeadKey: false,
    },
    KeyQ: key('q', 'Q'),
  };

  // Act
  applyKeyboardLayout(layout);

  // Assert
  expect({
    backquote: codeForCharacter('`', false),
    tilde: codeForCharacter('~', true),
  }).toEqual({ backquote: null, tilde: 'Backquote' });
});

test('ignores keys outside the writing system', () => {
  // Arrange: the numpad types "1" too, but `Alt+1` means the digit on the
  // number row, and Space is no way to spell a combo.
  const layout = {
    Digit1: key('1', '!'),
    KeyQ: key('q', 'Q'),
    Numpad1: key('1', '1'),
    Space: key(' ', ' '),
  };

  // Act
  applyKeyboardLayout(layout);

  // Assert
  expect(codeForCharacter('1', false)).toBe('Digit1');

  // Act: with only the numpad producing the digit, it stays unresolved.
  applyKeyboardLayout({ KeyQ: key('q', 'Q'), Numpad1: key('1', '1') });

  // Assert
  expect(codeForCharacter('1', false)).toBe(null);
});

test('resolves to the first position in a fixed order when two keys produce one character', () => {
  // Arrange: the claim order is letters, digits, then punctuation in row
  // order, so the answer does not depend on how the platform happens to order
  // the map. BracketRight comes before Backslash in that order even though the
  // fixture lists it second.
  const layout = { Backslash: key('#', "'"), BracketRight: key('#', '"'), KeyQ: key('q', 'Q') };

  // Act
  applyKeyboardLayout(layout);

  // Assert
  expect(codeForCharacter('#', false)).toBe('BracketRight');
});

test('pins letters to their US positions on a layout that types no Latin', () => {
  // Arrange: a Cyrillic layout produces no Latin letters at all, so every
  // letter shortcut would otherwise be unreachable.
  const layout = { KeyA: key('ф', 'Ф'), KeyZ: key('я', 'Я') };

  // Act
  applyKeyboardLayout(layout);

  // Assert: the pin covers both Shift states, so `Alt+Shift+z` keeps working
  // too.
  expect({
    plain: codeForCharacter('z', false),
    shifted: codeForCharacter('z', true),
  }).toEqual({ plain: 'KeyZ', shifted: 'KeyZ' });
});

test('drops the character a pinned letter displaces', () => {
  // Arrange
  const layout = { KeyA: key('ф', 'Ф'), KeyZ: key('я', 'Я') };

  // Act
  applyKeyboardLayout(layout);

  // Assert: one position produces one character, so pinning "z" to the US "z"
  // key takes "я" off it rather than leaving both spellings claiming it.
  expect({
    plain: codeForCharacter('я', false),
    shifted: codeForCharacter('я', true),
  }).toEqual({ plain: null, shifted: null });
});

test('does not pin letters to US positions on a layout that types some Latin', () => {
  // Arrange: putting "a" on the US "a" key would take that key away from "b",
  // which this layout really does type there.
  const layout = { KeyA: key('b', 'B'), KeyZ: key('ż', 'Ż') };

  // Act
  applyKeyboardLayout(layout);

  // Assert
  expect({
    a: codeForCharacter('a', false),
    b: codeForCharacter('b', false),
  }).toEqual({ a: null, b: 'KeyA' });
});

test('counts Latin reached only through Shift when deciding whether to pin', () => {
  // Arrange: a layout that types "b" with Shift somewhere types Latin, so
  // pinning would displace it.
  const layout = { KeyA: key('ф', 'B') };

  // Act
  applyKeyboardLayout(layout);

  // Assert
  expect({
    b: codeForCharacter('b', true),
    z: codeForCharacter('z', false),
  }).toEqual({ b: 'KeyA', z: null });
});

test('resolves a digit the layout types only with Shift through its shifted spelling', () => {
  // Arrange: AZERTY types "&" on the key labelled "1" and reaches the digit
  // only with Shift. Putting "1" on that key unshifted would fire `Alt+1` on a
  // press that types "&".
  const layout = { Digit1: key('&', '1'), KeyQ: key('a', 'A') };

  // Act
  applyKeyboardLayout(layout);

  // Assert
  expect({
    ampersand: codeForCharacter('&', false),
    one: codeForCharacter('1', false),
    shiftedOne: codeForCharacter('1', true),
  }).toEqual({ ampersand: 'Digit1', one: null, shiftedOne: 'Digit1' });
});

test('reads the layout from the desktop shell when tracking starts', async () => {
  // Arrange
  createTestContext({ initialLayout: { KeyY: key('z', 'Z'), KeyZ: key('y', 'Y') } });

  // Act
  trackKeyboardLayout();

  // Assert
  await vi.waitFor(() => expect(hasKeyboardLayout()).toBe(true));
  expect(codeForCharacter('z', false)).toBe('KeyY');
});

test('stays without a layout when no desktop shell is present', () => {
  // Arrange: the web build and the test environment have no `window.codiff`,
  // and the matcher stays on its US tables there.

  // Act
  trackKeyboardLayout();

  // Assert
  expect(hasKeyboardLayout()).toBe(false);
});

test('keeps no layout when the shell cannot read one', async () => {
  // Arrange
  createTestContext({ failReads: true });

  // Act
  trackKeyboardLayout();
  await flush();

  // Assert
  expect(hasKeyboardLayout()).toBe(false);
});

test('keeps no layout when the shell reports none', async () => {
  // Arrange: a platform where native-keymap fails answers with null rather
  // than a broken map.
  createTestContext({ initialLayout: null });

  // Act
  trackKeyboardLayout();
  await flush();

  // Assert
  expect(hasKeyboardLayout()).toBe(false);
});

test('applies a layout change pushed by the shell', async () => {
  // Arrange: switching input source fires a real event in the main process,
  // which pushes the fresh layout here.
  const { pushLayout } = createTestContext({ initialLayout: { KeyZ: key('z', 'Z') } });
  trackKeyboardLayout();
  await vi.waitFor(() => expect(hasKeyboardLayout()).toBe(true));

  // Act
  pushLayout({ KeyY: key('z', 'Z'), KeyZ: key('y', 'Y') });

  // Assert
  expect(codeForCharacter('z', false)).toBe('KeyY');
});

test('prefers a pushed layout over a slower startup read', async () => {
  // Arrange: a push that arrives while the startup read is on the wire is
  // newer than whatever that read answers with.
  const { pushLayout, resolveRead } = createTestContext({ deferReads: true });
  trackKeyboardLayout();

  // Act
  pushLayout({ KeyY: key('z', 'Z') });
  resolveRead({ KeyZ: key('z', 'Z') });
  await flush();

  // Assert
  expect(codeForCharacter('z', false)).toBe('KeyY');
});

test('discards a startup read that was still in flight when it was reset', async () => {
  // Arrange
  const { resolveRead } = createTestContext({ deferReads: true });
  trackKeyboardLayout();
  resetKeyboardLayout();

  // Act
  resolveRead({ KeyZ: key('z', 'Z') });
  await flush();

  // Assert
  expect(hasKeyboardLayout()).toBe(false);
});

test('stops applying layout pushes once it is reset', () => {
  // Arrange
  const { pushLayout } = createTestContext({ initialLayout: null });
  trackKeyboardLayout();
  resetKeyboardLayout();

  // Act
  pushLayout({ KeyZ: key('z', 'Z') });

  // Assert
  expect(hasKeyboardLayout()).toBe(false);
});

test('subscribes to layout pushes once no matter how often tracking starts', () => {
  // Arrange
  const { getSubscriptionCount } = createTestContext({ initialLayout: null });

  // Act
  trackKeyboardLayout();
  trackKeyboardLayout();

  // Assert
  expect(getSubscriptionCount()).toBe(1);
});

function key(value: string, withShift: string) {
  return { value, valueIsDeadKey: false, withShift, withShiftIsDeadKey: false };
}

function flush() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// A desktop shell whose layout answers arrive only when the test says so.
function createTestContext({
  deferReads = false,
  failReads = false,
  initialLayout = null,
}: {
  deferReads?: boolean;
  failReads?: boolean;
  initialLayout?: NativeKeyboardLayout | null;
} = {}) {
  const pushCallbacks: Array<(layout: NativeKeyboardLayout) => void> = [];
  const pendingReads: Array<(layout: NativeKeyboardLayout | null) => void> = [];

  (window as { codiff?: unknown }).codiff = {
    getKeyboardLayout: () => {
      if (failReads) {
        return Promise.reject(new Error('ipc failure'));
      }
      if (deferReads) {
        return new Promise<NativeKeyboardLayout | null>((resolve) => {
          pendingReads.push(resolve);
        });
      }
      return Promise.resolve(initialLayout);
    },
    onKeyboardLayoutChanged: (callback: (layout: NativeKeyboardLayout) => void) => {
      pushCallbacks.push(callback);
      return () => {
        const index = pushCallbacks.indexOf(callback);
        if (index !== -1) {
          pushCallbacks.splice(index, 1);
        }
      };
    },
  };

  return {
    getSubscriptionCount: () => pushCallbacks.length,
    pushLayout: (layout: NativeKeyboardLayout) => {
      for (const callback of pushCallbacks) {
        callback(layout);
      }
    },
    resolveRead: (layout: NativeKeyboardLayout | null) => pendingReads.shift()?.(layout),
  };
}
