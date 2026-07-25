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

test('pins a letter the layout never produces to its US position', async () => {
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

test('pins a digit the layout only reaches through Shift', async () => {
  // Arrange: AZERTY types "&" on the key labelled "1"; the digit needs Shift,
  // which the keyboard map does not report.
  createTestContext({ Digit1: '&', KeyA: 'q', KeyQ: 'a' });

  // Act
  await loadKeyboardLayout();

  // Assert
  expect(codeForCharacter('1')).toBe('Digit1');
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

// A keyboard whose layout arrives only when the test says so.
function createSlowTestContext() {
  let resolveLayout!: (layout: Map<string, string>) => void;

  Object.defineProperty(navigator, 'keyboard', {
    configurable: true,
    value: {
      getLayoutMap: () =>
        new Promise<Map<string, string>>((resolve) => {
          resolveLayout = resolve;
        }),
    },
  });

  return {
    reportLayout: (layout: Record<string, string>) =>
      resolveLayout(new Map(Object.entries(layout))),
  };
}

function createTestContext(initial: Record<string, string>) {
  let layout = initial;
  let readCount = 0;

  Object.defineProperty(navigator, 'keyboard', {
    configurable: true,
    value: {
      getLayoutMap: () => {
        readCount++;
        return Promise.resolve(new Map(Object.entries(layout)));
      },
    },
  });

  return {
    getReadCount: () => readCount,
    setLayout: (next: Record<string, string>) => {
      layout = next;
    },
  };
}
