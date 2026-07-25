/**
 * @vitest-environment jsdom
 */

import { afterEach, expect, test, vi } from 'vite-plus/test';
import { matchesShortcut } from '../config/keymap.ts';
import type { CodiffKeymap } from '../config/types.ts';

afterEach(() => {
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
  // Arrange: this pins the documented semantics. The fallback is defined in
  // terms of US key positions, so on a layout that moves keys it can fire an
  // action the label does not suggest. It only ever does so for a keypress no
  // binding matched by character, so it cannot take one from another shortcut.
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
