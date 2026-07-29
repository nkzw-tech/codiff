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

test('renders nothing while no update is available', async () => {
  await using view = await renderPill(
    <UpdatePill onApply={noop} status={status({ phase: 'idle' })} />,
  );

  expect(pill(view)).toBeNull();
});

test('shows a single Update button when an update is available', async () => {
  await using view = await renderPill(
    <UpdatePill onApply={noop} status={status({ phase: 'available', version: '1.9.3' })} />,
  );

  expect(pill(view)?.textContent).toContain('Update');
  expect(pill(view)?.title).toContain('1.9.2');
  expect(pill(view)?.title).toContain('1.9.3');
  expect(view.container.querySelector('.update-popover')).toBeNull();
});

test('promises a restart only when Squirrel will deliver one', async () => {
  await using view = await renderPill(
    <UpdatePill
      onApply={noop}
      status={status({ phase: 'available', strategy: 'squirrel', version: '1.9.3' })}
    />,
  );

  expect(pill(view)?.title).toContain('restarts the app');
});

test('describes the hand-off for the download strategy', async () => {
  await using view = await renderPill(
    <UpdatePill
      onApply={noop}
      status={status({ phase: 'available', strategy: 'download', version: '1.9.3' })}
    />,
  );

  expect(pill(view)?.title).toContain('opens the update');
  expect(pill(view)?.title).not.toContain('restarts');
});

test('sends the user to the download page for the manual strategy', async () => {
  await using view = await renderPill(
    <UpdatePill
      onApply={noop}
      status={status({ phase: 'available', strategy: 'manual', version: '1.9.3' })}
    />,
  );

  expect(pill(view)?.title).toContain('download page');
  expect(pill(view)?.title).not.toContain('restarts');
  expect(pill(view)?.title).not.toContain('Downloads');
});

test('promises nothing beyond the download without a known strategy', async () => {
  await using view = await renderPill(
    <UpdatePill onApply={noop} status={status({ phase: 'available', version: '1.9.3' })} />,
  );

  expect(pill(view)?.title).toContain('Downloads the update.');
  expect(pill(view)?.title).not.toContain('restarts');
  expect(pill(view)?.title).not.toContain('opens');
});

test('styles the pill like the shared buttons', async () => {
  await using view = await renderPill(
    <UpdatePill onApply={noop} status={status({ phase: 'available', version: '1.9.3' })} />,
  );

  expect(pill(view)?.className).toContain('codiff-button');
});

test('applies the update with a single click', async () => {
  let applied = 0;
  await using view = await renderPill(
    <UpdatePill
      onApply={() => applied++}
      status={status({ phase: 'available', version: '1.9.3' })}
    />,
  );

  await act(async () => pill(view)?.click());

  expect(applied).toBe(1);
  expect(view.container.querySelector('.update-popover')).toBeNull();
});

test('shows progress while updating and ignores clicks', async () => {
  let applied = 0;
  await using view = await renderPill(
    <UpdatePill
      onApply={() => applied++}
      status={status({ phase: 'updating', version: '1.9.3' })}
    />,
  );

  expect(pill(view)?.textContent).toContain('Updating');
  expect(pill(view)?.disabled).toBe(true);

  await act(async () => pill(view)?.click());

  expect(applied).toBe(0);
});

test('shows progress without a version after an error retry', async () => {
  await using view = await renderPill(
    <UpdatePill onApply={noop} status={status({ phase: 'updating' })} />,
  );

  expect(pill(view)?.textContent).toContain('Updating');
  expect(pill(view)?.textContent).not.toContain('undefined');
  expect(pill(view)?.title).not.toContain('undefined');
});

test('tells the user to finish a handed-off install', async () => {
  let applied = 0;
  await using view = await renderPill(
    <UpdatePill
      onApply={() => applied++}
      status={status({ phase: 'installerReady', version: '1.9.3' })}
    />,
  );

  expect(pill(view)?.textContent).toContain('Quit to finish update');
  expect(pill(view)?.title).toContain('installer');
  expect(pill(view)?.disabled).toBe(true);

  await act(async () => pill(view)?.click());

  expect(applied).toBe(0);
});

test('retries a failed update with a single click', async () => {
  let applied = 0;
  await using view = await renderPill(
    <UpdatePill
      onApply={() => applied++}
      status={status({ message: 'feed unreachable', phase: 'error', version: '1.9.3' })}
    />,
  );

  expect(pill(view)?.textContent).toContain('Update failed');
  expect(pill(view)?.textContent).toContain('Try again');
  expect(pill(view)?.title).toContain('feed unreachable');

  await act(async () => pill(view)?.click());

  expect(applied).toBe(1);
});
