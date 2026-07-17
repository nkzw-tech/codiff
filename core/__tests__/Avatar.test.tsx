/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test } from 'vite-plus/test';
import { Avatar } from '../app/components/Avatar.tsx';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

test('Avatar falls back to initials when the image fails to load', async () => {
  const container = document.createElement('div');
  let root: Root | null = null;

  await using _resource = {
    async [Symbol.asyncDispose]() {
      await act(async () => root?.unmount());
    },
  };
  await act(async () => {
    root = createRoot(container);
    root.render(
      <Avatar name="Christoph Nakazawa" size="medium" url="https://example.com/avatar" />,
    );
  });
  const image = container.querySelector('img');
  expect(image?.getAttribute('src')).toBe('https://example.com/avatar');
  await act(async () => {
    image?.dispatchEvent(new Event('error', { bubbles: true }));
  });
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toBe('CN');
});

test('Avatar retries rendering when the avatar URL changes', async () => {
  const container = document.createElement('div');
  let root: Root | null = null;

  await using _resource = {
    async [Symbol.asyncDispose]() {
      await act(async () => root?.unmount());
    },
  };
  await act(async () => {
    root = createRoot(container);
    root.render(<Avatar name="Reviewer" size="medium" url="https://example.com/first" />);
  });
  await act(async () => {
    container.querySelector('img')?.dispatchEvent(new Event('error', { bubbles: true }));
  });
  expect(container.textContent).toBe('RE');
  await act(async () => {
    root?.render(<Avatar name="Reviewer" size="medium" url="https://example.com/second" />);
  });
  expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/second');
});

test('Avatar normalizes and limits initials by grapheme', async () => {
  const container = document.createElement('div');
  let root: Root | null = null;

  await using _resource = {
    async [Symbol.asyncDispose]() {
      await act(async () => root?.unmount());
    },
  };
  await act(async () => {
    root = createRoot(container);
  });
  for (const [name, initials] of [
    ['E\u0301lodie Durand', 'ÉD'],
    ['ßa', 'SS'],
    ['नमस्ते कुमार', 'नकु'],
  ]) {
    await act(async () => {
      root?.render(<Avatar name={name} size="medium" />);
    });
    expect(container.textContent).toBe(initials);
  }
});
