/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test } from 'vite-plus/test';
import { Gravatar } from '../app/components/Gravatar.tsx';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

test('Gravatar falls back to the initial when the image fails to load', async () => {
  const container = document.createElement('div');
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<Gravatar fallback="Reviewer" size="medium" url="https://example.com/avatar" />);
    });

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://example.com/avatar');

    await act(async () => {
      image?.dispatchEvent(new Event('error', { bubbles: true }));
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('R');
  } finally {
    await act(async () => root?.unmount());
  }
});

test('Gravatar retries rendering when the avatar URL changes', async () => {
  const container = document.createElement('div');
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<Gravatar fallback="Reviewer" size="medium" url="https://example.com/first" />);
    });

    await act(async () => {
      container.querySelector('img')?.dispatchEvent(new Event('error', { bubbles: true }));
    });

    expect(container.textContent).toBe('R');

    await act(async () => {
      root?.render(<Gravatar fallback="Reviewer" size="medium" url="https://example.com/second" />);
    });

    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/second');
  } finally {
    await act(async () => root?.unmount());
  }
});
