/**
 * @vitest-environment jsdom
 */

import { expect, test, vi } from 'vite-plus/test';
import {
  extractFencedCodeBlocks,
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

test('extractFencedCodeBlocks returns the contents of each fenced block', () => {
  expect(
    extractFencedCodeBlocks('Intro.\n\n```sh\nnpm install\n```\n\nOutro.\n\n~~~\nplain\n~~~\n'),
  ).toEqual(['npm install', 'plain']);
  expect(extractFencedCodeBlocks('No code here, only `inline`.')).toEqual([]);
  expect(extractFencedCodeBlocks('````\n```\nnested fence\n```\n````')).toEqual([
    '```\nnested fence\n```',
  ]);
  expect(extractFencedCodeBlocks('```ts\nconst a = 1;\n')).toEqual(['const a = 1;']);
  expect(extractFencedCodeBlocks('```\n\n```')).toEqual([]);
});

test('ReadOnlyMarkdownView copies the code inside a collapsible block', async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });

  await using view = await renderReact(
    <ReadOnlyMarkdownView
      ariaLabel="Markdown preview"
      className="markdown-preview"
      value={
        '<details><summary>Fix in your Agent</summary>\n\nPaste this:\n\n```\nFix the issues.\n```\n\n</details>'
      }
      variant="embedded"
    />,
  );

  const button = view.container.querySelector<HTMLButtonElement>('.codiff-copy-code-button');
  expect(button).not.toBe(null);

  button?.click();

  await waitFor(() => {
    expect(writeText).toHaveBeenCalledWith('Fix the issues.');
  });
});

test('ReadOnlyMarkdownView omits the copy button for collapsibles without code', async () => {
  await using view = await renderReact(
    <ReadOnlyMarkdownView
      ariaLabel="Markdown preview"
      className="markdown-preview"
      value={'<details><summary>Notes</summary>\n\nJust prose.\n\n</details>'}
      variant="embedded"
    />,
  );

  expect(view.container.querySelector('.codiff-copy-code-button')).toBe(null);
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
