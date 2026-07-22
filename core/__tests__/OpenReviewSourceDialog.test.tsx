/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { OpenReviewSourceDialog } from '../app/components/OpenReviewSourceDialog.tsx';
import { renderReact, setInputValue, waitFor } from './helpers/react.tsx';

test('submits a trimmed pull request number and closes the dialog', async () => {
  const onClose = vi.fn();
  const onOpen = vi.fn().mockResolvedValue(undefined);
  await using view = await renderReact(
    <OpenReviewSourceDialog kind="pull-request" onClose={onClose} onOpen={onOpen} />,
  );

  const input = view.container.querySelector<HTMLInputElement>('#open-review-source-input');
  const form = view.container.querySelector('form');
  if (!input || !form) {
    throw new Error('Expected the open review source form.');
  }

  await setInputValue(input, '  #42  ');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('#42'));
  expect(onClose).toHaveBeenCalledOnce();
});

test('keeps the dialog open and explains when no source is entered', async () => {
  const onClose = vi.fn();
  const onOpen = vi.fn();
  await using view = await renderReact(
    <OpenReviewSourceDialog kind="branch" onClose={onClose} onOpen={onOpen} />,
  );

  const form = view.container.querySelector('form');
  if (!form) {
    throw new Error('Expected the open review source form.');
  }

  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

  expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('Enter a branch name.');
  expect(onOpen).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});
