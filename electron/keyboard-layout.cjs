// @ts-check

// The keyboard layout for the renderer's shortcut matcher, read with
// `native-keymap` because Chromium reports unmodified characters only and has
// no layout change event. A failed native module load must not take the app
// down: without an answer the renderer falls back to US key positions.
//
// macOS ISO keyboards are left uncompensated on purpose. Apple historically
// swaps the Backquote and IntlBackslash virtual key codes on some ISO
// hardware, but `isISOKeyboard()` cannot say whether compensation is needed:
// on the ISO MacBook this was measured on, Chromium's own `getLayoutMap()`
// agrees exactly with native-keymap's uncompensated answer, so swapping
// whenever `isISOKeyboard()` is true would break the very keys it is meant to
// fix. VS Code ships the same uncompensated data.

/** @typedef {import('../core/config/keyboard-layout.ts').NativeKeyboardLayout} NativeKeyboardLayout */

/** @returns {NativeKeyboardLayout | null} */
const readKeyboardLayout = () => {
  const nativeKeymap = loadNativeKeymap();
  if (!nativeKeymap) {
    return null;
  }

  try {
    return normalizeKeyboardLayout(nativeKeymap.getKeyMap());
  } catch {
    return null;
  }
};

/** @param {(layout: NativeKeyboardLayout) => void} onChange */
const watchKeyboardLayout = (onChange) => {
  const nativeKeymap = loadNativeKeymap();
  if (!nativeKeymap) {
    return;
  }

  try {
    nativeKeymap.onDidChangeKeyboardLayout(() => {
      const layout = readKeyboardLayout();
      if (layout) {
        onChange(layout);
      }
    });
  } catch {
    // Without change events the layout read at startup stays in charge.
  }
};

// native-keymap catches its own load and read errors internally and answers
// with an empty array, which is a missing answer rather than a keyboard, and
// applying it would pin letters onto a keyboard that was never read.
/**
 * @param {unknown} raw
 * @returns {NativeKeyboardLayout | null}
 */
const normalizeKeyboardLayout = (raw) => {
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).length === 0
  ) {
    return null;
  }

  return /** @type {NativeKeyboardLayout} */ (raw);
};

const loadNativeKeymap = () => {
  try {
    return require('native-keymap');
  } catch {
    return null;
  }
};

module.exports = { normalizeKeyboardLayout, readKeyboardLayout, watchKeyboardLayout };
