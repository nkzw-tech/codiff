/**
 * @vitest-environment jsdom
 */

import { afterEach, expect, test, vi } from 'vite-plus/test';
import {
  codeForCharacter,
  hasKeyboardLayout,
  loadKeyboardLayout,
  resetKeyboardLayout,
  trackKeyboardLayout,
} from '../config/keyboard-layout.ts';

afterEach(() => {
  resetKeyboardLayout();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('resolves a character to the key position that produces it', async () => {
  // Arrange: QWERTZ swaps the characters on the US "z" and "y" positions.
  createTestContext({ KeyY: 'z', KeyZ: 'y' });

  // Act
  await loadKeyboardLayout();

  // Assert
  expect(codeForCharacter('z')).toBe('KeyY');
});

test('reports no layout before one has been read', () => {
  // Arrange
  createTestContext({ KeyZ: 'z' });

  // Act
  const layout = { code: codeForCharacter('z'), loaded: hasKeyboardLayout() };

  // Assert
  expect(layout).toEqual({ code: null, loaded: false });
});

test('reports no layout when the platform exposes no keyboard map', async () => {
  // Arrange
  Object.defineProperty(navigator, 'keyboard', { configurable: true, value: undefined });

  // Act
  await loadKeyboardLayout();

  // Assert
  expect(hasKeyboardLayout()).toBe(false);
});

test('reports no layout when the keyboard map comes back empty', async () => {
  // Arrange: a window with no keyboard attached to it reports zero keys, which
  // is an absent answer rather than a keyboard that produces nothing.
  createTestContext({});

  // Act
  await loadKeyboardLayout();

  // Assert
  expect(hasKeyboardLayout()).toBe(false);
});

test('reports no layout when reading the keyboard map fails', async () => {
  // Arrange
  Object.defineProperty(navigator, 'keyboard', {
    configurable: true,
    value: {
      getLayoutMap: () => Promise.reject(new Error('not allowed in this context')),
    },
  });

  // Act
  await loadKeyboardLayout();

  // Assert
  expect(hasKeyboardLayout()).toBe(false);
});

test('pins letters to their US positions on a layout that types no Latin', async () => {
  // Arrange: a Cyrillic layout produces no Latin letters at all, so every
  // letter shortcut would otherwise be unreachable.
  createTestContext({ KeyA: 'ф', KeyZ: 'я' });

  // Act
  await loadKeyboardLayout();

  // Assert
  expect(codeForCharacter('z')).toBe('KeyZ');
});

test('drops the character a pinned letter displaces', async () => {
  // Arrange
  createTestContext({ KeyA: 'ф', KeyZ: 'я' });

  // Act
  await loadKeyboardLayout();

  // Assert: one position produces one character, so pinning "z" to the US "z"
  // key takes "я" off it rather than leaving both spellings claiming it.
  expect(codeForCharacter('я')).toBe(null);
});

test('keeps a letter the layout produces somewhere else instead of pinning it', async () => {
  // Arrange: AZERTY moves "a" to the US "q" position, so "a" is still typed.
  createTestContext({ KeyA: 'q', KeyQ: 'a' });

  // Act
  await loadKeyboardLayout();

  // Assert
  expect(codeForCharacter('a')).toBe('KeyQ');
});

test('leaves a digit the layout cannot type unmodified unresolved', async () => {
  // Arrange: AZERTY types "&" on the key labelled "1" and reaches the digit
  // only with Shift, which the keyboard map does not report. Putting "1" on
  // that key anyway would be right on AZERTY and wrong on Programmer Dvorak,
  // which moves the digits elsewhere, and it would take "&" off the key it
  // really is on. Naming the character the key types works on both.
  createTestContext({ Digit1: '&', KeyA: 'q', KeyQ: 'a' });

  // Act
  await loadKeyboardLayout();

  // Assert
  expect({ ampersand: codeForCharacter('&'), one: codeForCharacter('1') }).toEqual({
    ampersand: 'Digit1',
    one: null,
  });
});

test('does not pin letters to US positions on a layout that types some Latin', async () => {
  // Arrange: putting "a" on the US "a" key would take that key away from "b",
  // which this layout really does type there.
  createTestContext({ KeyA: 'b', KeyZ: 'ż' });

  // Act
  await loadKeyboardLayout();

  // Assert
  expect({ a: codeForCharacter('a'), b: codeForCharacter('b') }).toEqual({
    a: null,
    b: 'KeyA',
  });
});

test('resolves to the first position when two keys produce one character', async () => {
  // Arrange
  createTestContext({ Backslash: '#', BracketRight: '#' });

  // Act
  await loadKeyboardLayout();

  // Assert
  expect(codeForCharacter('#')).toBe('Backslash');
});

test('re-reads the layout when a keypress disagrees with it', async () => {
  // Arrange: no layout change event exists, so a plain keypress reporting a
  // character the cache does not have on that key is the signal.
  const { setLayout } = createTestContext({ KeyZ: 'z' });
  trackKeyboardLayout();
  await vi.waitFor(() => expect(hasKeyboardLayout()).toBe(true));
  setLayout({ KeyY: 'z', KeyZ: 'y' });

  // Act
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', key: 'y' }));

  // Assert
  await vi.waitFor(() => expect(codeForCharacter('z')).toBe('KeyY'));
});

test('does not re-read the layout for a keypress a modifier rewrote', async () => {
  // Arrange
  const { getReadCount, setLayout } = createTestContext({ KeyZ: 'z' });
  trackKeyboardLayout();
  await vi.waitFor(() => expect(hasKeyboardLayout()).toBe(true));
  setLayout({ KeyY: 'z', KeyZ: 'y' });

  // Act: Option composes the character away, so it says nothing about the key.
  window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyZ', key: 'Ω' }));

  // Assert
  expect(getReadCount()).toBe(1);
});

test('keeps the layout it has when a re-read comes back empty', async () => {
  // Arrange: losing a good layout to one bad answer would send every shortcut
  // back to guessing at US positions, and nothing would ask again.
  const { setLayout } = createTestContext({ KeyY: 'z', KeyZ: 'y' });
  await loadKeyboardLayout();
  setLayout({});

  // Act
  await loadKeyboardLayout();

  // Assert
  expect(codeForCharacter('z')).toBe('KeyY');
});

test('keeps the layout it has when a re-read fails', async () => {
  // Arrange
  const { failReads } = createTestContext({ KeyY: 'z', KeyZ: 'y' });
  await loadKeyboardLayout();
  failReads();

  // Act
  await loadKeyboardLayout();

  // Assert
  expect(codeForCharacter('z')).toBe('KeyY');
});

test('does not re-read the layout once per keypress when it keeps disagreeing', async () => {
  // Arrange: remapping software can make the reported character disagree with
  // the layout permanently, and asking again on every keypress would never
  // resolve it.
  const { getReadCount } = createTestContext({ KeyZ: 'z' });
  trackKeyboardLayout();
  await vi.waitFor(() => expect(hasKeyboardLayout()).toBe(true));

  // Act: each press waits for the previous read to settle, so nothing is
  // coalesced and every one of them is free to ask again.
  for (let press = 0; press < 5; press++) {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', key: 'q' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // Assert: the startup read, plus one for the first press.
  expect(getReadCount()).toBe(2);
});

test('asks again on the next keypress when it has no layout at all', async () => {
  // Arrange: a window with no keyboard attached to it yet reports nothing, and
  // waiting for it to lose and regain focus is a long way back from that.
  const { setLayout } = createTestContext({});
  trackKeyboardLayout();
  await loadKeyboardLayout();
  setLayout({ KeyY: 'z', KeyZ: 'y' });

  // Act
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', key: 'y' }));

  // Assert
  await vi.waitFor(() => expect(codeForCharacter('z')).toBe('KeyY'));
});

test('asks again once the quiet period after a disagreement has passed', async () => {
  // Arrange: the quiet period stops a permanent disagreement asking on every
  // keystroke, and must not stop a later real change from being noticed.
  vi.useFakeTimers({ toFake: ['performance'] });
  const { getReadCount, setLayout } = createTestContext({ KeyZ: 'z' });
  trackKeyboardLayout();
  await loadKeyboardLayout();
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', key: 'q' }));
  await loadKeyboardLayout();
  setLayout({ KeyY: 'z', KeyZ: 'y' });

  // Act
  vi.advanceTimersByTime(2000);
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', key: 'y' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Assert
  expect({ code: codeForCharacter('z'), reads: getReadCount() }).toEqual({
    code: 'KeyY',
    reads: 3,
  });
});

test('does not start a second read while one is already in flight', async () => {
  // Arrange: a read abandoned by a reset must not hand the in-flight slot back
  // while the read that replaced it is still running.
  const { getReadCount, reportLayout } = createSlowTestContext();
  const abandoned = loadKeyboardLayout();
  resetKeyboardLayout();
  loadKeyboardLayout();

  // Act
  reportLayout({ KeyZ: 'z' });
  await abandoned;
  loadKeyboardLayout();

  // Assert
  expect(getReadCount()).toBe(2);
});

test('does not re-read the layout for a key the layout never mentions', async () => {
  // Arrange: the keyboard map covers the letter, digit and punctuation keys
  // only, so the space bar reporting a space is not a disagreement.
  const { getReadCount } = createTestContext({ KeyZ: 'z' });
  trackKeyboardLayout();
  await loadKeyboardLayout();

  // Act
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Assert
  expect(getReadCount()).toBe(1);
});

test('re-reads the layout when the window regains focus', async () => {
  // Arrange
  const { setLayout } = createTestContext({ KeyZ: 'z' });
  trackKeyboardLayout();
  await vi.waitFor(() => expect(hasKeyboardLayout()).toBe(true));
  setLayout({ KeyY: 'z', KeyZ: 'y' });

  // Act
  window.dispatchEvent(new Event('focus'));

  // Assert
  await vi.waitFor(() => expect(codeForCharacter('z')).toBe('KeyY'));
});

test('stops watching for layout changes once it is reset', async () => {
  // Arrange
  const { getReadCount } = createTestContext({ KeyZ: 'z' });
  trackKeyboardLayout();
  await vi.waitFor(() => expect(hasKeyboardLayout()).toBe(true));
  resetKeyboardLayout();

  // Act
  window.dispatchEvent(new Event('focus'));

  // Assert
  expect(getReadCount()).toBe(1);
});

test('discards a layout read that was still in flight when it was reset', async () => {
  // Arrange: reads are asynchronous, so one can land after whoever started it
  // has already given up on it.
  const { reportLayout } = createSlowTestContext();
  const pending = loadKeyboardLayout();
  resetKeyboardLayout();

  // Act
  reportLayout({ KeyZ: 'z' });
  await pending;

  // Assert
  expect(hasKeyboardLayout()).toBe(false);
});

// A keyboard whose layout arrives only when the test says so, one read at a
// time and in the order they were started.
function createSlowTestContext() {
  const waiting: Array<(layout: Map<string, string>) => void> = [];
  let readCount = 0;

  Object.defineProperty(navigator, 'keyboard', {
    configurable: true,
    value: {
      getLayoutMap: () => {
        readCount++;
        return new Promise<Map<string, string>>((resolve) => {
          waiting.push(resolve);
        });
      },
    },
  });

  return {
    getReadCount: () => readCount,
    reportLayout: (layout: Record<string, string>) =>
      waiting.shift()?.(new Map(Object.entries(layout))),
  };
}

function createTestContext(initial: Record<string, string>) {
  let layout = initial;
  let failing = false;
  let readCount = 0;

  Object.defineProperty(navigator, 'keyboard', {
    configurable: true,
    value: {
      getLayoutMap: () => {
        readCount++;
        return failing
          ? Promise.reject(new Error('not allowed in this context'))
          : Promise.resolve(new Map(Object.entries(layout)));
      },
    },
  });

  return {
    failReads: () => {
      failing = true;
    },
    getReadCount: () => readCount,
    setLayout: (next: Record<string, string>) => {
      layout = next;
    },
  };
}
