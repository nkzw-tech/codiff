import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);

const { normalizeKeyboardLayout } = require('../keyboard-layout.cjs') as {
  normalizeKeyboardLayout: (raw: unknown) => Record<string, unknown> | null;
};

test('rejects the empty array the native module returns when it fails', () => {
  // Arrange: native-keymap catches its own load and read errors internally and
  // answers with an empty array, which is a missing answer, not a keyboard.
  const raw: Array<never> = [];

  // Act
  const layout = normalizeKeyboardLayout(raw);

  // Assert
  expect(layout).toBe(null);
});

test('rejects a layout with no keys', () => {
  // Act
  const layout = normalizeKeyboardLayout({});

  // Assert
  expect(layout).toBe(null);
});

test('rejects a missing layout', () => {
  // Assert
  expect({
    missing: normalizeKeyboardLayout(null),
    undefined: normalizeKeyboardLayout(undefined),
  }).toEqual({ missing: null, undefined: null });
});

test('rejects a layout that is not an object', () => {
  // Assert
  expect(normalizeKeyboardLayout('broken')).toBe(null);
});

test('keeps a real layout untouched', () => {
  // Arrange
  const raw = {
    KeyZ: { value: 'z', valueIsDeadKey: false, withShift: 'Z', withShiftIsDeadKey: false },
  };

  // Act
  const layout = normalizeKeyboardLayout(raw);

  // Assert
  expect(layout).toBe(raw);
});
