import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vite-plus/test';
import { Narration } from '../app/components/walkthrough/parts.tsx';

test('preserves safe prose paragraphs', () => {
  const html = renderToStaticMarkup(
    <Narration prose={'First **contract**.\n\nSecond `consumer`.'} />,
  );

  expect(html).toContain('<p class="wt-narration-prose">First <strong>contract</strong>.</p>');
  expect(html).toContain(
    '<p class="wt-narration-prose">Second <code class="walkthrough-inline-code">consumer</code>.</p>',
  );
});
