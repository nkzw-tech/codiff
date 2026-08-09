/**
 * @vitest-environment jsdom
 */

import { expect, test } from 'vite-plus/test';
import { CopyCommentsButton } from '../app/components/Panels.tsx';
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
