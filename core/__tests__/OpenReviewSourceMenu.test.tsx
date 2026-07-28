/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { OpenReviewSourceMenu } from '../app/components/OpenReviewSourceMenu.tsx';
import { renderReact } from './helpers/react.tsx';

test('opens the menu from the trigger and moves focus to the first action', async () => {
  await using view = await renderReact(<OpenReviewSourceMenu onOpen={() => {}} />);
  const trigger = getTrigger(view.container);

  expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(view.container.querySelector('[role="menu"]')).toBeNull();

  await click(trigger);

  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  const items = getMenuItems(view.container);
  expect(items.map((item) => item.textContent)).toEqual(['Open PR', 'Open Branch', 'Open Commit']);
  expect(document.activeElement).toBe(items[0]);
});

test('selecting an action reports its kind and closes the menu', async () => {
  const onOpen = vi.fn();
  await using view = await renderReact(<OpenReviewSourceMenu onOpen={onOpen} />);

  await click(getTrigger(view.container));
  const commitItem = getMenuItems(view.container).find(
    (item) => item.textContent === 'Open Commit',
  );
  if (!commitItem) {
    throw new Error('Expected an Open Commit menu item.');
  }
  await click(commitItem);

  expect(onOpen).toHaveBeenCalledExactlyOnceWith('commit');
  expect(view.container.querySelector('[role="menu"]')).toBeNull();
  expect(getTrigger(view.container).getAttribute('aria-expanded')).toBe('false');
});

test('arrow keys move through the actions and wrap around', async () => {
  await using view = await renderReact(<OpenReviewSourceMenu onOpen={() => {}} />);

  await click(getTrigger(view.container));
  const [pullRequest, branch, commit] = getMenuItems(view.container);

  await pressKey('ArrowDown');
  expect(document.activeElement).toBe(branch);
  await pressKey('ArrowDown');
  expect(document.activeElement).toBe(commit);
  await pressKey('ArrowDown');
  expect(document.activeElement).toBe(pullRequest);
  await pressKey('ArrowUp');
  expect(document.activeElement).toBe(commit);
  await pressKey('Home');
  expect(document.activeElement).toBe(pullRequest);
  await pressKey('End');
  expect(document.activeElement).toBe(commit);
});

test('Escape closes the menu and returns focus to the trigger', async () => {
  await using view = await renderReact(<OpenReviewSourceMenu onOpen={() => {}} />);
  const trigger = getTrigger(view.container);

  await click(trigger);
  await pressKey('Escape');

  expect(view.container.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('clicking outside dismisses the menu without opening anything', async () => {
  const onOpen = vi.fn();
  await using view = await renderReact(<OpenReviewSourceMenu onOpen={onOpen} />);

  await click(getTrigger(view.container));
  await act(async () => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });

  expect(view.container.querySelector('[role="menu"]')).toBeNull();
  expect(onOpen).not.toHaveBeenCalled();
});

function getTrigger(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>('.open-review-source-trigger');
  if (!trigger) {
    throw new Error('Expected the open review source trigger.');
  }
  return trigger;
}

function getMenuItems(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function pressKey(key: string) {
  await act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
  });
}
