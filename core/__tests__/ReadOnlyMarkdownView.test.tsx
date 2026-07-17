/**
 * @vitest-environment jsdom
 */

import { expect, test } from 'vite-plus/test';
import {
  normalizeReadOnlyMarkdownValue,
  ReadOnlyMarkdownView,
} from '../app/components/ReadOnlyMarkdownView.tsx';
import { renderReact, waitFor } from './helpers/react.tsx';

test('normalizeReadOnlyMarkdownValue collapses repeated blank lines outside fenced code', () => {
  expect(normalizeReadOnlyMarkdownValue('# Title\n\nNew paragraph.\n')).toBe(
    '# Title\n\nNew paragraph.\n',
  );
  expect(
    normalizeReadOnlyMarkdownValue(
      '\n\nFirst paragraph.\n\n\nSecond paragraph.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n\nThird paragraph.\n\n',
    ),
  ).toBe(
    'First paragraph.\n\nSecond paragraph.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nThird paragraph.',
  );
});

test('ReadOnlyMarkdownView does not render empty paragraph break blocks', async () => {
  await using view = await renderReact(
    <ReadOnlyMarkdownView
      ariaLabel="Markdown preview"
      className="markdown-preview"
      value={'\n\nFirst paragraph.\n\n\n\nSecond paragraph.\n\n  \n\nThird paragraph.\n\n'}
      variant="embedded"
    />,
  );

  await waitFor(() => {
    expect(view.container.textContent).toContain('First paragraph.');
    expect(view.container.textContent).toContain('Second paragraph.');
    expect(view.container.textContent).toContain('Third paragraph.');
  });
  expect(
    [
      ...view.container.querySelectorAll<HTMLElement>('[data-mdx-comment-block-type="paragraph"]'),
    ].some((paragraph) => !paragraph.textContent?.trim() && paragraph.querySelector('br')),
  ).toBe(false);
});
