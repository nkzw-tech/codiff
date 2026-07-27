/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vite-plus/test';
import { Narration } from '../app/components/walkthrough/parts.tsx';
import { renderReact } from './helpers/react.tsx';

test('preserves safe prose paragraphs', () => {
  const html = renderToStaticMarkup(
    <Narration prose={'First **contract**.\n\nSecond `consumer`.'} />,
  );

  expect(html).toContain('<p class="wt-narration-prose">First <strong>contract</strong>.</p>');
  expect(html).toContain(
    '<p class="wt-narration-prose">Second <code class="walkthrough-inline-code">consumer</code>.</p>',
  );
});

test('routes region anchors internally without opening a new window', async () => {
  const onRegionLink = vi.fn();
  const view = await renderReact(
    <Narration
      onRegionLink={onRegionLink}
      prose="Inspect the [compatibility boundary](#unit-1:r1)."
    />,
  );

  try {
    const link = view.container.querySelector<HTMLAnchorElement>('a');
    expect(link?.target).toBe('');
    await act(async () => link?.click());
    expect(onRegionLink).toHaveBeenCalledWith('unit-1:r1');
  } finally {
    await view.cleanup();
  }
});
