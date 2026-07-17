// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test, vi } from 'vite-plus/test';
import { Button, buttonVariants } from '../app/components/Button.tsx';
import { waitFor } from './helpers/react.tsx';

const reactEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const renderButton = async (element: React.ReactNode) => {
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });

  return {
    container,
    async [Symbol.asyncDispose]() {
      await act(async () => root?.unmount());
      container.remove();
    },
  };
};

test('renders reusable size and variant classes', async () => {
  await using view = await renderButton(
    <Button className="custom-button" size="icon" variant="destructive">
      Delete
    </Button>,
  );

  const button = view.container.querySelector('button');
  expect(button?.classList.contains('codiff-button')).toBe(true);
  expect(button?.classList.contains('codiff-button-size-icon')).toBe(true);
  expect(button?.classList.contains('codiff-button-destructive')).toBe(true);
  expect(button?.classList.contains('custom-button')).toBe(true);
  expect(buttonVariants({ variant: 'outline' })).toContain('codiff-button-outline');
});

test('supports rendering through a child element', async () => {
  await using view = await renderButton(
    <Button asChild variant="link">
      <a href="/review">Review</a>
    </Button>,
  );

  const link = view.container.querySelector('a');
  expect(link?.getAttribute('href')).toBe('/review');
  expect(link?.classList.contains('codiff-button')).toBe(true);
  expect(view.container.querySelector('button')).toBeNull();
});

test('runs actions in a pending transition', async () => {
  let resolveAction: (() => void) | null = null;
  const action = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveAction = resolve;
      }),
  );
  await using view = await renderButton(
    <Button action={action} pendingPlaceholder="Working…">
      Run
    </Button>,
  );

  const button = view.container.querySelector<HTMLButtonElement>('button');
  act(() => button?.click());
  await waitFor(() => {
    expect(action).toHaveBeenCalledOnce();
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-busy')).toBe('true');
    expect(button?.textContent).toBe('Working…');
  });
  await act(async () => resolveAction?.());
  await waitFor(() => {
    expect(button?.disabled).toBe(false);
    expect(button?.hasAttribute('aria-busy')).toBe(false);
    expect(button?.textContent).toBe('Run');
  });
});

test('does not run an action when onClick prevents the event', async () => {
  const action = vi.fn();
  await using view = await renderButton(
    <Button action={action} onClick={(event) => event.preventDefault()}>
      Run
    </Button>,
  );

  act(() => view.container.querySelector<HTMLButtonElement>('button')?.click());
  expect(action).not.toHaveBeenCalled();
});
