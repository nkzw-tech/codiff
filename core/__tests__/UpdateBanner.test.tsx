// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test } from 'vite-plus/test';
import { UpdateBanner, type UpdateStatus } from '../app/components/Panels.tsx';

const reactEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const renderBanner = async (element: React.ReactNode) => {
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

const banner = (view: { container: HTMLElement }) => view.container.querySelector('.update-banner');

test('stays hidden while no update is available', async () => {
  await using view = await renderBanner(
    <UpdateBanner
      onApply={noop}
      onDismiss={noop}
      onOpenReleasePage={noop}
      status={status({ phase: 'idle' })}
    />,
  );

  expect(banner(view)?.classList.contains('visible')).toBe(false);
});

test('shows the available version with an update action', async () => {
  let applied = 0;
  await using view = await renderBanner(
    <UpdateBanner
      onApply={() => applied++}
      onDismiss={noop}
      onOpenReleasePage={noop}
      status={status({ phase: 'available', version: '1.9.3' })}
    />,
  );

  expect(banner(view)?.classList.contains('visible')).toBe(true);
  expect(banner(view)?.textContent).toContain('1.9.3');

  const update = view.container.querySelector<HTMLButtonElement>('.update-banner-action');
  await act(async () => update?.click());
  expect(applied).toBe(1);
});

test('dismisses through the close button', async () => {
  let dismissed = 0;
  await using view = await renderBanner(
    <UpdateBanner
      onApply={noop}
      onDismiss={() => dismissed++}
      onOpenReleasePage={noop}
      status={status({ phase: 'available', version: '1.9.3' })}
    />,
  );

  const dismiss = view.container.querySelector<HTMLButtonElement>('.repository-change-dismiss');
  await act(async () => dismiss?.click());
  expect(dismissed).toBe(1);
});

test('shows progress while updating without actions', async () => {
  await using view = await renderBanner(
    <UpdateBanner
      onApply={noop}
      onDismiss={noop}
      onOpenReleasePage={noop}
      status={status({ phase: 'updating', version: '1.9.3' })}
    />,
  );

  expect(banner(view)?.classList.contains('visible')).toBe(true);
  expect(banner(view)?.textContent).toContain('Updating');
  expect(view.container.querySelector('.update-banner-action')).toBeNull();
  expect(view.container.querySelector('.repository-change-dismiss')).toBeNull();
});

test('tells the user to finish a handed-off install', async () => {
  await using view = await renderBanner(
    <UpdateBanner
      onApply={noop}
      onDismiss={noop}
      onOpenReleasePage={noop}
      status={status({ phase: 'installerReady', version: '1.9.3' })}
    />,
  );

  expect(banner(view)?.textContent).toContain('installer');
});

test('offers retry and manual download after a failure', async () => {
  let applied = 0;
  let opened = 0;
  await using view = await renderBanner(
    <UpdateBanner
      onApply={() => applied++}
      onDismiss={noop}
      onOpenReleasePage={() => opened++}
      status={status({ message: 'feed unreachable', phase: 'error', version: '1.9.3' })}
    />,
  );

  expect(banner(view)?.textContent).toContain('failed');

  const retry = view.container.querySelector<HTMLButtonElement>('.update-banner-action');
  await act(async () => retry?.click());
  expect(applied).toBe(1);

  const manual = view.container.querySelector<HTMLButtonElement>('.update-banner-manual');
  await act(async () => manual?.click());
  expect(opened).toBe(1);
});
