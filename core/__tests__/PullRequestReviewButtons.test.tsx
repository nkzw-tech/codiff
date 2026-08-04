/**
 * @vitest-environment jsdom
 */

import { act, type KeyboardEventHandler } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { PullRequestReviewButtons } from '../app/components/Panels.tsx';
import { renderReact, setInputValue, waitFor } from './helpers/react.tsx';

vi.mock('@nkzw/mdx-editor', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    MarkdownEditor: forwardRef(function MockMarkdownEditor(
      {
        ariaLabel,
        onChange,
        onKeyDown,
        placeholder,
        readOnly,
        value,
      }: {
        ariaLabel: string;
        onChange: (value: string) => void;
        onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
        placeholder?: string;
        readOnly?: boolean;
        value: string;
      },
      ref,
    ) {
      useImperativeHandle(ref, () => ({ focus: () => {} }));
      return (
        <textarea
          aria-label={ariaLabel}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          readOnly={readOnly}
          value={value}
        />
      );
    }),
  };
});

test('provider comment reviews require inline comments or a review body', async () => {
  const onSubmitReview = vi.fn(async () => {});
  await using view = await renderReact(
    <PullRequestReviewButtons
      disabled={false}
      hasPendingComments={false}
      onSubmitReview={onSubmitReview}
    />,
  );

  const submitComments = view.container.querySelector<HTMLButtonElement>(
    '[aria-label="Submit review comments"]',
  );
  const addReviewComment = view.container.querySelector<HTMLButtonElement>(
    '[aria-label="Add review comment"]',
  );
  expect(submitComments?.disabled).toBe(true);
  expect(addReviewComment?.disabled).toBe(false);
  expect(view.container.querySelector('[aria-label="Approve review"]')).not.toBeNull();
  expect(view.container.querySelector('[aria-label="Request changes"]')).not.toBeNull();
  await act(async () => addReviewComment?.click());
  const textarea = view.container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Add review comment"]',
  );
  expect(textarea?.placeholder).toBe('Add a review comment…');
  await setInputValue(textarea!, 'Neutral review feedback.');
  const submitBody = view.container.querySelector<HTMLButtonElement>(
    '.review-submit-popover-submit.comment',
  );
  expect(submitBody?.disabled).toBe(false);
  await act(async () => submitBody?.click());
  await waitFor(() => {
    expect(onSubmitReview).toHaveBeenCalledWith('COMMENT', 'Neutral review feedback.');
    expect(view.container.querySelector('[aria-label="Comment with comment"]')).toBeNull();
  });
});

test('provider comment reviews submit pending inline comments without a body', async () => {
  const onSubmitReview = vi.fn(async () => {});
  await using view = await renderReact(
    <PullRequestReviewButtons
      disabled={false}
      hasPendingComments
      onSubmitReview={onSubmitReview}
    />,
  );

  const submitComments = view.container.querySelector<HTMLButtonElement>(
    '[aria-label="Submit review comments"]',
  );
  expect(submitComments?.disabled).toBe(false);
  await act(async () => submitComments?.click());
  expect(onSubmitReview).toHaveBeenCalledWith('COMMENT');
});

test('provider comment reviews preserve the review body after submission fails', async () => {
  const onSubmitReview = vi.fn(async () => {
    throw new Error('The provider rejected the review.');
  });
  await using view = await renderReact(
    <PullRequestReviewButtons
      disabled={false}
      hasPendingComments={false}
      onSubmitReview={onSubmitReview}
    />,
  );

  await act(async () =>
    view.container.querySelector<HTMLButtonElement>('[aria-label="Add review comment"]')?.click(),
  );
  const textarea = view.container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Add review comment"]',
  );
  await setInputValue(textarea!, 'Keep this draft.');
  await act(async () =>
    view.container
      .querySelector<HTMLButtonElement>('.review-submit-popover-submit.comment')
      ?.click(),
  );
  await waitFor(() => expect(onSubmitReview).toHaveBeenCalledOnce());
  expect(textarea?.value).toBe('Keep this draft.');
  expect(view.container.querySelector('[aria-label="Comment with comment"]')).not.toBeNull();
});

test('comment review remains available when decision reviews are provider-blocked', async () => {
  await using view = await renderReact(
    <PullRequestReviewButtons
      disabled={false}
      hasPendingComments={false}
      onSubmitReview={vi.fn()}
      reviewStatus={{
        approve: {
          disabled: true,
          reason: 'You cannot review your own pull request.',
        },
        requestChanges: {
          disabled: true,
          reason: 'You cannot review your own pull request.',
        },
      }}
    />,
  );

  expect(view.container.querySelector('[aria-label="Submit review comments"]')).not.toBeNull();
  expect(view.container.querySelector('[aria-label="Approve review"]')).toBeNull();
  expect(view.container.querySelector('[aria-label="Request changes"]')).toBeNull();
});

test('an explicitly disabled comment outcome is not actionable', async () => {
  await using view = await renderReact(
    <PullRequestReviewButtons
      disabled={false}
      hasPendingComments
      onSubmitReview={vi.fn()}
      reviewStatus={{
        comment: {
          disabled: true,
          reason: 'Neutral reviews are unavailable.',
        },
      }}
    />,
  );

  expect(view.container.querySelector('[aria-label="Submit review comments"]')).toBeNull();
  expect(view.container.querySelector('[aria-label="Add review comment"]')).toBeNull();
  expect(view.container.querySelector('[aria-label="Approve review"]')).not.toBeNull();
  expect(view.container.querySelector('[aria-label="Request changes"]')).not.toBeNull();
});
