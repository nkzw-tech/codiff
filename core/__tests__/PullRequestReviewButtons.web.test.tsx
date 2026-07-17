// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vite-plus/test';
import { PullRequestReviewButtons } from '../app/components/Panels.tsx';

vi.mock('@nkzw/mdx-editor', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    MarkdownEditor: forwardRef(function MockMarkdownEditor(
      {
        ariaLabel,
        onChange,
        value,
      }: {
        ariaLabel: string;
        onChange: (value: string) => void;
        value: string;
      },
      ref,
    ) {
      useImperativeHandle(ref, () => ({ focus: () => {} }));
      return (
        <div
          aria-label={ariaLabel}
          contentEditable
          onInput={(event) => onChange(event.currentTarget.textContent ?? '')}
          suppressContentEditableWarning
        >
          {value}
        </div>
      );
    }),
  };
});

const reactEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
  ResizeObserver?: typeof ResizeObserver;
};
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
reactEnvironment.ResizeObserver ??= class ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
};

const renderReviewButtons = async (disabled = false) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onSubmitReview = vi.fn();

  await act(async () => {
    root.render(
      <PullRequestReviewButtons
        disabled={disabled}
        hasPendingComments={false}
        onSubmitReview={onSubmitReview}
      />,
    );
  });

  return {
    container,
    onSubmitReview,
    rerender: async (nextDisabled: boolean) => {
      await act(async () => {
        root.render(
          <PullRequestReviewButtons
            disabled={nextDisabled}
            hasPendingComments={false}
            onSubmitReview={onSubmitReview}
          />,
        );
      });
    },
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
};

const setEditorValue = (editor: HTMLElement, value: string) => {
  editor.textContent = value;
  editor.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      data: value,
      inputType: 'insertText',
    }),
  );
};

test('keeps approve and request changes as direct split-button actions', async () => {
  await using view = await renderReviewButtons();

  const approve = view.container.querySelector<HTMLButtonElement>('[aria-label="Approve review"]');
  const requestChanges = view.container.querySelector<HTMLButtonElement>(
    '[aria-label="Request changes"]',
  );
  const approveControl = approve?.closest('.review-submit-button');
  expect(approveControl?.tagName).toBe('DIV');
  expect(approveControl?.classList.contains('codiff-button')).toBe(true);
  expect(approve?.classList.contains('codiff-button')).toBe(false);
  expect(approveControl?.querySelector('.review-submit-divider')?.textContent?.trim()).toBe('|');
  await act(async () => approve?.click());
  expect(view.onSubmitReview).toHaveBeenCalledWith('APPROVE');
  await act(async () => requestChanges?.click());
  expect(view.onSubmitReview).toHaveBeenLastCalledWith('REQUEST_CHANGES');
});

test('submits MDX review comments with either review outcome', async () => {
  await using view = await renderReviewButtons();

  for (const review of [
    {
      body: 'Looks good to me.',
      commentLabel: 'Add approval comment',
      event: 'APPROVE',
      groupLabel: 'Approve with comment',
      label: 'Approve',
    },
    {
      body: 'Please address the remaining concern.',
      commentLabel: 'Add request changes comment',
      event: 'REQUEST_CHANGES',
      groupLabel: 'Request Changes with comment',
      label: 'Request Changes',
    },
  ] as const) {
    const toggle = view.container.querySelector<HTMLButtonElement>(
      `[aria-label="${review.commentLabel}"]`,
    );
    await act(async () => toggle?.click());
    const popover = view.container.querySelector<HTMLElement>(
      `[aria-label="${review.groupLabel}"]`,
    );
    const editor = popover?.querySelector<HTMLElement>(
      `[contenteditable="true"][aria-label="${review.commentLabel}"]`,
    );
    expect(popover).not.toBeNull();
    expect(editor).not.toBeNull();
    await act(async () => {
      if (editor) {
        setEditorValue(editor, review.body);
      }
    });
    const submit = [...(popover?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.trim() === review.label,
    );
    expect(submit?.disabled).toBe(false);
    await act(async () => submit?.click());
    expect(view.onSubmitReview).toHaveBeenLastCalledWith(review.event, review.body);
    expect(view.container.querySelector(`[aria-label="${review.groupLabel}"]`)).toBeNull();
  }
});

test('closes review comment popovers when the actions become disabled', async () => {
  await using view = await renderReviewButtons();

  await act(async () => {
    view.container.querySelector<HTMLButtonElement>('[aria-label="Add approval comment"]')?.click();
  });
  expect(view.container.querySelector('[aria-label="Approve with comment"]')).not.toBeNull();
  await view.rerender(true);
  expect(view.container.querySelector('[aria-label="Approve with comment"]')).toBeNull();
  await view.rerender(false);
  expect(view.container.querySelector('[aria-label="Approve with comment"]')).toBeNull();
});
