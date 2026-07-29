// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test } from 'vite-plus/test';
import { UpdatePill, type UpdateStatus } from '../app/components/Panels.tsx';

const reactEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const renderPill = async (element: React.ReactNode) => {
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

const noop = () => {};

const status = (partial: Partial<UpdateStatus>): UpdateStatus => ({
  currentVersion: '1.9.2',
  phase: 'idle',
  ...partial,
});

const pill = (view: { container: HTMLElement }) =>
  view.container.querySelector<HTMLButtonElement>('.update-pill');

const popover = (view: { container: HTMLElement }) =>
  view.container.querySelector<HTMLElement>('.update-popover');

const openPopover = async (view: { container: HTMLElement }) => {
  await act(async () => pill(view)?.click());
  return popover(view);
};

test('renders nothing while no update is available', async () => {
  await using view = await renderPill(
    <UpdatePill
      onApply={noop}
      onDismiss={noop}
      onOpenReleasePage={noop}
      status={status({ phase: 'idle' })}
    />,
  );

  expect(pill(view)).toBeNull();
});

test('shows a compact pill when an update is available', async () => {
  await using view = await renderPill(
    <UpdatePill
      onApply={noop}
      onDismiss={noop}
      onOpenReleasePage={noop}
      status={status({ phase: 'available', version: '1.9.3' })}
    />,
  );

  expect(pill(view)?.textContent).toContain('Update available');
  expect(pill(view)?.getAttribute('aria-expanded')).toBe('false');
  expect(popover(view)).toBeNull();
});

test('opens the details popover with the version delta and actions', async () => {
  await using view = await renderPill(
    <UpdatePill
      onApply={noop}
      onDismiss={noop}
      onOpenReleasePage={noop}
      status={status({ phase: 'available', version: '1.9.3' })}
    />,
  );

  const details = await openPopover(view);

  expect(pill(view)?.getAttribute('aria-expanded')).toBe('true');
  expect(details?.textContent).toContain('v1.9.2');
  expect(details?.textContent).toContain('v1.9.3');
  expect(view.container.querySelector('.update-popover-primary')?.textContent).toContain(
    'Update now',
  );
  expect(view.container.querySelector('.update-popover-later')?.textContent).toContain('Later');
  expect(view.container.querySelector('.update-popover-skip')?.textContent).toContain(
    'Skip this version',
  );
  expect(view.container.querySelector('.update-popover-release-notes')?.textContent).toContain(
    'Release notes',
  );
});

test('applies the update from the popover and keeps it open', async () => {
  let applied = 0;
  await using view = await renderPill(
    <UpdatePill
      onApply={() => applied++}
      onDismiss={noop}
      onOpenReleasePage={noop}
      status={status({ phase: 'available', version: '1.9.3' })}
    />,
  );

  await openPopover(view);
  const update = view.container.querySelector<HTMLButtonElement>('.update-popover-primary');
  await act(async () => update?.click());

  expect(applied).toBe(1);
  expect(popover(view)).not.toBeNull();
});

test('closes the popover through Later without dismissing the version', async () => {
  let dismissed = 0;
  await using view = await renderPill(
    <UpdatePill
      onApply={noop}
      onDismiss={() => dismissed++}
      onOpenReleasePage={noop}
      status={status({ phase: 'available', version: '1.9.3' })}
    />,
  );

  await openPopover(view);
  const later = view.container.querySelector<HTMLButtonElement>('.update-popover-later');
  await act(async () => later?.click());

  expect(popover(view)).toBeNull();
  expect(pill(view)).not.toBeNull();
  expect(dismissed).toBe(0);
});

test('skips the offered version from the popover', async () => {
  let dismissed = 0;
  await using view = await renderPill(
    <UpdatePill
      onApply={noop}
      onDismiss={() => dismissed++}
      onOpenReleasePage={noop}
      status={status({ phase: 'available', version: '1.9.3' })}
    />,
  );

  await openPopover(view);
  const skip = view.container.querySelector<HTMLButtonElement>('.update-popover-skip');
  await act(async () => skip?.click());

  expect(dismissed).toBe(1);
});

test('opens the release notes from the popover', async () => {
  let opened = 0;
  await using view = await renderPill(
    <UpdatePill
      onApply={noop}
      onDismiss={noop}
      onOpenReleasePage={() => opened++}
      status={status({ phase: 'available', version: '1.9.3' })}
    />,
  );

  await openPopover(view);
  const notes = view.container.querySelector<HTMLButtonElement>('.update-popover-release-notes');
  await act(async () => notes?.click());

  expect(opened).toBe(1);
});

test('closes the popover through the corner close button without dismissing', async () => {
  let dismissed = 0;
  await using view = await renderPill(
    <UpdatePill
      onApply={noop}
      onDismiss={() => dismissed++}
      onOpenReleasePage={noop}
      status={status({ phase: 'available', version: '1.9.3' })}
    />,
  );

  expect(await openPopover(view)).not.toBeNull();
  const close = view.container.querySelector<HTMLButtonElement>('.update-popover-close');
  await act(async () => close?.click());

  expect(popover(view)).toBeNull();
  expect(pill(view)).not.toBeNull();
  expect(dismissed).toBe(0);
});

test('closes the popover with Escape', async () => {
  await using view = await renderPill(
    <UpdatePill
      onApply={noop}
      onDismiss={noop}
      onOpenReleasePage={noop}
      status={status({ phase: 'available', version: '1.9.3' })}
    />,
  );

  expect(await openPopover(view)).not.toBeNull();
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })),
  );

  expect(popover(view)).toBeNull();
});

test('shows progress while updating without offering actions', async () => {
  await using view = await renderPill(
    <UpdatePill
      onApply={noop}
      onDismiss={noop}
      onOpenReleasePage={noop}
      status={status({ phase: 'updating', version: '1.9.3' })}
    />,
  );

  expect(pill(view)?.textContent).toContain('Updating');

  await openPopover(view);

  expect(popover(view)?.textContent).toContain('1.9.3');
  expect(view.container.querySelector('.update-popover-primary')).toBeNull();
  expect(view.container.querySelector('.update-popover-skip')).toBeNull();
});

test('shows progress without a version after an error retry', async () => {
  await using view = await renderPill(
    <UpdatePill
      onApply={noop}
      onDismiss={noop}
      onOpenReleasePage={noop}
      status={status({ phase: 'updating' })}
    />,
  );

  expect(pill(view)?.textContent).toContain('Updating');
  expect(pill(view)?.textContent).not.toContain('undefined');

  await openPopover(view);

  expect(popover(view)?.textContent).not.toContain('undefined');
});

test('tells the user to finish a handed-off install', async () => {
  await using view = await renderPill(
    <UpdatePill
      onApply={noop}
      onDismiss={noop}
      onOpenReleasePage={noop}
      status={status({ phase: 'installerReady', version: '1.9.3' })}
    />,
  );

  expect(pill(view)?.textContent).toContain('Quit to finish update');

  await openPopover(view);

  expect(popover(view)?.textContent).toContain('installer');
});

test('offers retry and manual download after a failure', async () => {
  let applied = 0;
  let opened = 0;
  await using view = await renderPill(
    <UpdatePill
      onApply={() => applied++}
      onDismiss={noop}
      onOpenReleasePage={() => opened++}
      status={status({ message: 'feed unreachable', phase: 'error', version: '1.9.3' })}
    />,
  );

  expect(pill(view)?.textContent).toContain('Update failed');

  await openPopover(view);

  expect(popover(view)?.textContent).toContain('feed unreachable');

  const retry = view.container.querySelector<HTMLButtonElement>('.update-popover-primary');
  await act(async () => retry?.click());
  expect(applied).toBe(1);

  const manual = view.container.querySelector<HTMLButtonElement>('.update-popover-manual');
  await act(async () => manual?.click());
  expect(opened).toBe(1);
});
