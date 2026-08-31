/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { CopyCommentsButton, SendFeedbackButton } from '../app/components/Panels.tsx';
import type { ReviewComment } from '../lib/app-types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact } from './helpers/react.tsx';

const file = createChangedFile('src/app.ts');

const createReviewComment = (comment: Partial<ReviewComment>) =>
  ({
    body: 'Rename this helper.',
    filePath: file.path,
    id: 'comment-1',
    lineNumber: 1,
    sectionId: file.sections[0].id,
    side: 'additions',
    ...comment,
  }) satisfies ReviewComment;

test('stays visible but disabled until a comment with a body exists', async () => {
  await using app = await renderReact(
    <CopyCommentsButton
      comments={[
        createReviewComment({ body: '   ' }),
        createReviewComment({ id: 'comment-2', isReadOnly: true }),
      ]}
      files={[file]}
      reviewCommentsPrefix=""
      showWhitespace={false}
    />,
  );

  const button = app.container.querySelector<HTMLButtonElement>('.copy-comments-button');
  expect(button).not.toBeNull();
  expect(button?.disabled).toBe(true);
  expect(button?.getAttribute('aria-label')).toBe(
    'Copy review comments as markdown, no comments yet',
  );
  expect(button?.querySelector('.copy-comments-count')?.textContent).toBe('0');
});

test('enables itself once a comment has a body', async () => {
  await using app = await renderReact(
    <CopyCommentsButton
      comments={[createReviewComment({})]}
      files={[file]}
      reviewCommentsPrefix=""
      showWhitespace={false}
    />,
  );

  const button = app.container.querySelector<HTMLButtonElement>('.copy-comments-button');
  expect(button?.disabled).toBe(false);
  expect(button?.getAttribute('aria-label')).toBe('Copy 1 review comment');
});

test('shows the pending comment count next to the copy icon', async () => {
  await using app = await renderReact(
    <CopyCommentsButton
      comments={[createReviewComment({}), createReviewComment({ id: 'comment-2' })]}
      files={[file]}
      reviewCommentsPrefix=""
      showWhitespace={false}
    />,
  );

  const button = app.container.querySelector<HTMLButtonElement>('.copy-comments-button');
  expect(button?.getAttribute('aria-label')).toBe('Copy 2 review comments');
  expect(button?.getAttribute('title')).toBe('Copy review comments as markdown');
  expect(button?.querySelector('.copy-comments-count')?.textContent).toBe('2');
  expect(button?.querySelector('.copy-comments-icon')).not.toBeNull();
});

test('send feedback stays disabled until feedback exists', async () => {
  await using app = await renderReact(<SendFeedbackButton count={0} onSend={vi.fn()} />);

  const button = app.container.querySelector<HTMLButtonElement>('.send-feedback-button');
  expect(button?.disabled).toBe(true);
  expect(button?.textContent).toContain('Send feedback');
  expect(button?.textContent).toContain('0');
});

test('send feedback shows the pending comment count', async () => {
  await using app = await renderReact(<SendFeedbackButton count={2} onSend={vi.fn()} />);

  const button = app.container.querySelector<HTMLButtonElement>('.send-feedback-button');
  expect(button?.disabled).toBe(false);
  expect(button?.textContent).toContain('Send feedback');
  expect(button?.textContent).toContain('2');
});

test('send feedback ignores duplicate clicks while submission is pending', async () => {
  let resolveSend: (() => void) | undefined;
  const onSend = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSend = resolve;
      }),
  );
  await using app = await renderReact(<SendFeedbackButton count={1} onSend={onSend} />);
  const button = app.container.querySelector<HTMLButtonElement>('.send-feedback-button');

  await act(async () => {
    button?.click();
    button?.click();
  });
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(button?.disabled).toBe(true);
  expect(button?.textContent).toContain('Sending...');

  await act(async () => resolveSend?.());
  expect(button?.disabled).toBe(false);
});

test('send feedback reports failures and can be retried', async () => {
  const onSend = vi.fn(async () => {
    throw new Error('Could not send feedback.');
  });
  await using app = await renderReact(<SendFeedbackButton count={1} onSend={onSend} />);
  const button = app.container.querySelector<HTMLButtonElement>('.send-feedback-button');

  await act(async () => button?.click());

  expect(app.container.querySelector('[role="alert"]')?.textContent).toBe(
    'Could not send feedback.',
  );
  expect(button?.disabled).toBe(false);
  expect(button?.textContent).toContain('Send feedback');
});
