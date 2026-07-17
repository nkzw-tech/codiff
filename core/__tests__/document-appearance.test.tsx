/**
 * @vitest-environment jsdom
 */

import { afterEach, expect, test } from 'vite-plus/test';
import {
  getCodeFontLineHeight,
  normalizeCodeFontSizePreference,
  useDocumentAppearance,
} from '../app/hooks/useDocumentAppearance.ts';
import type { CodiffTheme } from '../types.ts';
import { renderReact } from './helpers/react.tsx';

function DocumentAppearanceHarness({
  cleanupCodeFontProperties,
  clearEmptyCodeFontFamily,
  codeFontFamily,
  codeFontSize,
  theme,
}: {
  cleanupCodeFontProperties?: boolean;
  clearEmptyCodeFontFamily?: boolean;
  codeFontFamily: string;
  codeFontSize: number;
  theme: CodiffTheme;
}) {
  useDocumentAppearance({
    cleanupCodeFontProperties,
    clearEmptyCodeFontFamily,
    codeFontFamily,
    codeFontSize,
    theme,
  });
  return null;
}

afterEach(() => {
  const root = document.documentElement;
  root.removeAttribute('data-theme');
  root.style.removeProperty('--font-diff-line-height');
  root.style.removeProperty('--font-diff-mono');
  root.style.removeProperty('--font-diff-size');
});

test('code font calculations normalize supported sizes and line heights', () => {
  expect(normalizeCodeFontSizePreference(Number.NaN)).toBe(13);
  expect(normalizeCodeFontSizePreference(9)).toBe(10);
  expect(normalizeCodeFontSizePreference(14.4)).toBe(14);
  expect(normalizeCodeFontSizePreference(40)).toBe(32);
  expect(getCodeFontLineHeight(14)).toBe(22);
});

test('document appearance manages theme and code font properties with cleanup', async () => {
  const root = document.documentElement;
  root.style.setProperty('--font-diff-mono', 'stale');
  {
    await using _view = await renderReact(
      <DocumentAppearanceHarness
        cleanupCodeFontProperties
        clearEmptyCodeFontFamily
        codeFontFamily=""
        codeFontSize={14}
        theme="dark"
      />,
    );

    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.style.getPropertyValue('--font-diff-mono')).toBe('');
    expect(root.style.getPropertyValue('--font-diff-size')).toBe('14px');
    expect(root.style.getPropertyValue('--font-diff-line-height')).toBe('22px');
  }

  expect(root.style.getPropertyValue('--font-diff-mono')).toBe('');
  expect(root.style.getPropertyValue('--font-diff-size')).toBe('');
  expect(root.style.getPropertyValue('--font-diff-line-height')).toBe('');
});

test('document appearance can preserve shared walkthrough font properties', async () => {
  const root = document.documentElement;
  root.style.setProperty('--font-diff-mono', 'existing');
  {
    await using _view = await renderReact(
      <DocumentAppearanceHarness codeFontFamily="" codeFontSize={13} theme="system" />,
    );

    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(root.style.getPropertyValue('--font-diff-mono')).toBe('existing');
    expect(root.style.getPropertyValue('--font-diff-size')).toBe('13px');
    expect(root.style.getPropertyValue('--font-diff-line-height')).toBe('20px');
  }

  expect(root.style.getPropertyValue('--font-diff-mono')).toBe('existing');
  expect(root.style.getPropertyValue('--font-diff-size')).toBe('13px');
  expect(root.style.getPropertyValue('--font-diff-line-height')).toBe('20px');
});
