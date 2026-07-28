/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { OpenReviewSourceMenu } from '../app/components/OpenReviewSourceMenu.tsx';
import { renderReact } from './helpers/react.tsx';

test('opens the menu from the trigger and moves focus to the first action', async () => {
  await using view = await renderReact(
    <OpenReviewSourceMenu onOpen={() => {}} onOpenFolder={() => {}} />,
  );
  const trigger = getTrigger(view.container);

  expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(queryMenu()).toBeNull();

  await click(trigger);

  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  const items = getMenuItems();
  expect(items.map((item) => item.textContent)).toEqual([
    'Open PR',
    'Open Branch',
    'Open Commit',
    'Open Folder',
  ]);
  expect(document.activeElement).toBe(items[0]);
});

test('renders the open menu outside the top bar so stacking contexts cannot trap it', async () => {
  await using view = await renderReact(
    <OpenReviewSourceMenu onOpen={() => {}} onOpenFolder={() => {}} />,
  );

  await click(getTrigger(view.container));

  const menu = queryMenu();
  expect(menu).not.toBeNull();
  expect(view.container.contains(menu)).toBe(false);
  expect(menu?.parentElement).toBe(document.body);
});

test('selecting an action reports its kind and closes the menu', async () => {
  const onOpen = vi.fn();
  await using view = await renderReact(
    <OpenReviewSourceMenu onOpen={onOpen} onOpenFolder={() => {}} />,
  );

  await click(getTrigger(view.container));
  const commitItem = getMenuItems().find((item) => item.textContent === 'Open Commit');
  if (!commitItem) {
    throw new Error('Expected an Open Commit menu item.');
  }
  await click(commitItem);

  expect(onOpen).toHaveBeenCalledExactlyOnceWith('commit');
  expect(queryMenu()).toBeNull();
  expect(getTrigger(view.container).getAttribute('aria-expanded')).toBe('false');
});

test('arrow keys move through the actions and wrap around', async () => {
  await using view = await renderReact(
    <OpenReviewSourceMenu onOpen={() => {}} onOpenFolder={() => {}} />,
  );

  await click(getTrigger(view.container));
  const [pullRequest, branch, commit, folder] = getMenuItems();

  await pressKey('ArrowDown');
  expect(document.activeElement).toBe(branch);
  await pressKey('ArrowDown');
  expect(document.activeElement).toBe(commit);
  await pressKey('ArrowDown');
  expect(document.activeElement).toBe(folder);
  await pressKey('ArrowDown');
  expect(document.activeElement).toBe(pullRequest);
  await pressKey('ArrowUp');
  expect(document.activeElement).toBe(folder);
  await pressKey('Home');
  expect(document.activeElement).toBe(pullRequest);
  await pressKey('End');
  expect(document.activeElement).toBe(folder);
});

test('Escape closes the menu and returns focus to the trigger', async () => {
  await using view = await renderReact(
    <OpenReviewSourceMenu onOpen={() => {}} onOpenFolder={() => {}} />,
  );
  const trigger = getTrigger(view.container);

  await click(trigger);
  await pressKey('Escape');

  expect(queryMenu()).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('opens the folder picker from a separated menu action', async () => {
  const onOpenFolder = vi.fn();
  await using view = await renderReact(
    <OpenReviewSourceMenu onOpen={() => {}} onOpenFolder={onOpenFolder} />,
  );

  await click(getTrigger(view.container));
  expect(document.querySelector('[role="menu"] [role="separator"]')).not.toBeNull();

  const folderItem = getMenuItems().find((item) => item.textContent === 'Open Folder');
  if (!folderItem) {
    throw new Error('Expected an Open Folder menu item.');
  }
  await click(folderItem);

  expect(onOpenFolder).toHaveBeenCalledOnce();
  expect(queryMenu()).toBeNull();
});

test('Tab hands focus back to the trigger so traversal continues from the top bar', async () => {
  await using view = await renderReact(
    <OpenReviewSourceMenu onOpen={() => {}} onOpenFolder={() => {}} />,
  );
  const trigger = getTrigger(view.container);

  await click(trigger);
  await pressKey('Tab');

  expect(queryMenu()).toBeNull();
  expect(document.activeElement).toBe(trigger);

  await click(trigger);
  await pressKey('Tab', { shiftKey: true });

  expect(queryMenu()).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('clicking outside dismisses the menu without opening anything', async () => {
  const onOpen = vi.fn();
  await using view = await renderReact(
    <OpenReviewSourceMenu onOpen={onOpen} onOpenFolder={() => {}} />,
  );

  await click(getTrigger(view.container));
  await act(async () => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });

  expect(queryMenu()).toBeNull();
  expect(onOpen).not.toHaveBeenCalled();
});

function getTrigger(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>('.open-review-source-trigger');
  if (!trigger) {
    throw new Error('Expected the open review source trigger.');
  }
  return trigger;
}

function queryMenu() {
  return document.querySelector('[role="menu"]');
}

function getMenuItems() {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function pressKey(key: string, { shiftKey = false } = {}) {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key, shiftKey }),
    );
  });
}
