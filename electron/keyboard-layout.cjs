// @ts-check

// The keyboard layout for the renderer's shortcut matcher, read with
// `native-keymap` because Chromium reports unmodified characters only and has
// no layout change event. A failed native module load must not take the app
// down: without an answer the renderer falls back to US key positions.

/** @typedef {import('../core/config/keyboard-layout.ts').NativeKeyboardLayout} NativeKeyboardLayout */

/** @returns {NativeKeyboardLayout | null} */
const readKeyboardLayout = () => {
  const nativeKeymap = loadNativeKeymap();
  if (!nativeKeymap) {
    return null;
  }

  try {
    return /** @type {NativeKeyboardLayout} */ (nativeKeymap.getKeyMap());
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

const loadNativeKeymap = () => {
  try {
    return require('native-keymap');
  } catch {
    return null;
  }
};

module.exports = { readKeyboardLayout, watchKeyboardLayout };
