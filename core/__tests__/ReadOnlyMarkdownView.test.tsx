/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { MarkdownEditor } from '../app/components/LazyMarkdownEditor.tsx';
import {
  extractFencedCodeBlocks,
  normalizeReadOnlyMarkdownValue,
  ReadOnlyMarkdownView,
} from '../app/components/ReadOnlyMarkdownView.tsx';
import { MarkdownImageSourceProvider } from '../lib/markdownImageSource.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  mermaidAPI: {
    defaultConfig: { secure: [] },
    getDiagramFromText: vi.fn(async () => ({ db: {} })),
    reset: vi.fn(),
  },
  render: vi.fn(async (id: string, code: string) => ({
    diagramType: 'flowchart',
    svg: `<svg id="${id}" viewBox="0 0 200 100"><text>${code}</text></svg>`,
  })),
}));

vi.mock('mermaid', () => ({ default: mermaid }));

const renderDiagram = async (code: string) => {
  const view = await renderReact(
    <ReadOnlyMarkdownView
      ariaLabel="Markdown preview"
      className="markdown-preview"
      value={`\`\`\`mermaid\n${code}\n\`\`\`\n`}
      variant="embedded"
    />,
  );
  await waitFor(() => {
    expect(view.container.querySelector('img.codiff-mermaid-diagram')).not.toBe(null);
  });
  return view;
};

const getButton = (container: HTMLElement, label: string) => {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBe(null);
  return button!;
};

const click = (element: HTMLElement) =>
  act(async () => {
    element.click();
  });

const dispatch = (element: Element, event: Event) =>
  act(async () => {
    element.dispatchEvent(event);
  });

const getTransform = (container: HTMLElement) =>
  container.querySelector<HTMLImageElement>('img.codiff-mermaid-diagram')?.style.transform;

const pointer = (type: string, clientX: number, clientY: number, button = 0) =>
  new PointerEvent(type, {
    bubbles: true,
    button,
    cancelable: true,
    clientX,
    clientY,
    pointerId: 1,
  });

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
  expect(extractFencedCodeBlocks('```ts\nbefore\n```not-a-close\nafter\n```')).toEqual([
    'before\n```not-a-close\nafter',
  ]);
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

test('nested collapsibles copy only the code belonging to their own level', async () => {
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
        '<details><summary>Outer</summary>\n\n```\nouter before\n```\n\n<details><summary>Inner</summary>\n\n```\ninner\n```\n\n</details>\n\n```\nouter after\n```\n\n</details>'
      }
      variant="embedded"
    />,
  );

  const details = view.container.querySelectorAll('details');
  const buttons = view.container.querySelectorAll<HTMLButtonElement>('.codiff-copy-code-button');
  expect(details).toHaveLength(2);
  expect(details[0]?.contains(details[1] ?? null)).toBe(true);
  expect(buttons).toHaveLength(2);

  buttons[0]?.click();
  await waitFor(() => {
    expect(writeText).toHaveBeenLastCalledWith('outer before\n\nouter after');
  });

  buttons[1]?.click();
  await waitFor(() => {
    expect(writeText).toHaveBeenLastCalledWith('inner');
  });
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

test('ReadOnlyMarkdownView renders image sources through the host resolver', async () => {
  // jsdom never loads images, so the rendered <img> stays suspended; assert on the resolver.
  const resolveImageSource = vi.fn((source: string) => `/proxy/${source}`);

  await using _view = await renderReact(
    <MarkdownImageSourceProvider value={resolveImageSource}>
      <ReadOnlyMarkdownView
        ariaLabel="Markdown preview"
        className="markdown-preview"
        value={
          '![top](https://git.test/top.png)\n\n<details><summary>More</summary>\n\n![nested](https://git.test/nested.png)\n\n</details>'
        }
        variant="embedded"
      />
    </MarkdownImageSourceProvider>,
  );

  await waitFor(() => {
    expect(resolveImageSource).toHaveBeenCalledWith('https://git.test/top.png');
    expect(resolveImageSource).toHaveBeenCalledWith('https://git.test/nested.png');
  });
});

test('ReadOnlyMarkdownView resolves images in details summaries', async () => {
  await using view = await renderReact(
    <MarkdownImageSourceProvider value={(source) => `/proxy/${source}`}>
      <ReadOnlyMarkdownView
        ariaLabel="Markdown preview"
        className="markdown-preview"
        value={
          '<details><summary>![icon](https://git.test/icon.png)</summary>\n\nBody\n\n</details>'
        }
        variant="embedded"
      />
    </MarkdownImageSourceProvider>,
  );

  await waitFor(() => {
    expect(view.container.querySelector('summary img')?.getAttribute('src')).toBe(
      '/proxy/https://git.test/icon.png',
    );
  });
});

test('ReadOnlyMarkdownView renders mermaid fences as diagram images', async () => {
  await using view = await renderReact(
    <ReadOnlyMarkdownView
      ariaLabel="Markdown preview"
      className="markdown-preview"
      value={'Intro.\n\n```mermaid\nflowchart TD\nview-->image\n```\n\n```ts\nconst a = 1;\n```\n'}
      variant="embedded"
    />,
  );

  await waitFor(() => {
    const image = view.container.querySelector<HTMLImageElement>('img.codiff-mermaid-diagram');
    expect(image?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(decodeURIComponent(image?.getAttribute('src') ?? '')).toContain('view-->image');
    expect(image?.getAttribute('width')).toBe('200');
    expect(image?.getAttribute('height')).toBe('100');
  });
  expect(view.container.querySelector('.cm-content')?.textContent).toContain('const a = 1;');
  expect(view.container.textContent).not.toContain('flowchart TD');
});

test('ReadOnlyMarkdownView renders mermaid fences inside collapsibles', async () => {
  await using view = await renderReact(
    <ReadOnlyMarkdownView
      ariaLabel="Markdown preview"
      className="markdown-preview"
      value={
        '<details open><summary>Diagram</summary>\n\n```Mermaid\nflowchart TD\ndetails-->image\n```\n\n</details>'
      }
      variant="embedded"
    />,
  );

  await waitFor(() => {
    expect(view.container.querySelector('details img.codiff-mermaid-diagram')).not.toBe(null);
  });
});

test('ReadOnlyMarkdownView shows the code and an error note when a diagram fails', async () => {
  mermaid.render.mockRejectedValueOnce(new Error('Parse error'));

  await using view = await renderReact(
    <ReadOnlyMarkdownView
      ariaLabel="Markdown preview"
      className="markdown-preview"
      value={'```mermaid\nflowchart TD\nbroken-->\n```\n'}
      variant="embedded"
    />,
  );

  await waitFor(() => {
    expect(view.container.querySelector('.codiff-mermaid-error')?.textContent).toBe(
      'Unable to render Mermaid diagram',
    );
  });
  expect(view.container.querySelector('.cm-content')?.textContent).toContain('broken-->');
  expect(view.container.querySelector('img.codiff-mermaid-diagram')).toBe(null);
  expect(view.container.querySelector('.codiff-mermaid-control')).toBe(null);
});

test('ReadOnlyMarkdownView falls back to source when the SVG image cannot be decoded', async () => {
  await using view = await renderDiagram('flowchart TD\ndecode-->failure');
  const image = view.container.querySelector('img.codiff-mermaid-diagram')!;

  await dispatch(image, new Event('error'));
  await waitFor(() => {
    expect(view.container.querySelector('.codiff-mermaid-error')?.textContent).toBe(
      'Unable to render Mermaid diagram',
    );
  });
  expect(view.container.querySelector('.cm-content')?.textContent).toContain('decode-->failure');
  expect(view.container.querySelector('img.codiff-mermaid-diagram')).toBe(null);

  // A cached result must not replace the fallback, and another diagram must still work.
  await view.rerender(
    <ReadOnlyMarkdownView
      ariaLabel="Markdown preview"
      className="markdown-preview"
      value={'```mermaid\nflowchart TD\ndecode-->recovered\n```\n'}
      variant="embedded"
    />,
  );
  await waitFor(() => {
    expect(view.container.querySelector('img.codiff-mermaid-diagram')).not.toBe(null);
  });
  expect(view.container.querySelector('.codiff-mermaid-error')).toBe(null);
});

test('editable Markdown editors keep mermaid fences as code', async () => {
  mermaid.render.mockClear();

  await using view = await renderReact(
    <MarkdownEditor
      ariaLabel="Edit comment"
      value={'```mermaid\nflowchart TD\neditable-->code\n```\n'}
      variant="embedded"
    />,
  );

  await waitFor(() => {
    expect(view.container.querySelector('.cm-content')?.textContent).toContain('editable-->code');
  });
  expect(view.container.querySelector('img.codiff-mermaid-diagram')).toBe(null);
  expect(mermaid.render).not.toHaveBeenCalled();
});

test("rendered diagrams offer GitHub's zoom and pan controls plus source and copy", async () => {
  await using view = await renderDiagram('flowchart TD\ncontrols-->listed');

  for (const label of [
    'Zoom in',
    'Zoom out',
    'Reset view',
    'Pan up',
    'Pan down',
    'Pan left',
    'Pan right',
    'Show source',
    'Copy code',
  ]) {
    getButton(view.container, label);
  }
  expect(getTransform(view.container)).toBe('translate(0px, 0px) scale(1)');
});

test('diagram buttons zoom, pan, and reset the view', async () => {
  await using view = await renderDiagram('flowchart TD\nbuttons-->move');
  const { container } = view;

  await click(getButton(container, 'Zoom in'));
  expect(getTransform(container)).toBe('translate(0px, 0px) scale(1.25)');
  await click(getButton(container, 'Reset view'));
  await click(getButton(container, 'Zoom out'));
  expect(getTransform(container)).toBe('translate(0px, 0px) scale(0.8)');
  await click(getButton(container, 'Reset view'));

  await click(getButton(container, 'Pan up'));
  expect(getTransform(container)).toBe('translate(0px, 100px) scale(1)');
  await click(getButton(container, 'Pan left'));
  expect(getTransform(container)).toBe('translate(100px, 100px) scale(1)');
  await click(getButton(container, 'Pan down'));
  expect(getTransform(container)).toBe('translate(100px, 0px) scale(1)');
  await click(getButton(container, 'Pan right'));
  await click(getButton(container, 'Pan right'));
  expect(getTransform(container)).toBe('translate(-100px, 0px) scale(1)');

  await click(getButton(container, 'Reset view'));
  expect(getTransform(container)).toBe('translate(0px, 0px) scale(1)');
});

test('modifier scrolling zooms the diagram while plain scrolling is left alone', async () => {
  await using view = await renderDiagram('flowchart TD\nwheel-->zoom');
  const viewport = view.container.querySelector('.codiff-mermaid-viewport')!;

  const plain = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -500 });
  await dispatch(viewport, plain);
  expect(plain.defaultPrevented).toBe(false);
  expect(getTransform(view.container)).toBe('translate(0px, 0px) scale(1)');

  const command = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaY: -500,
    metaKey: true,
  });
  await dispatch(viewport, command);
  expect(command.defaultPrevented).toBe(true);
  expect(getTransform(view.container)).toBe('translate(0px, 0px) scale(2)');

  const pinch = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    deltaY: 50,
  });
  await dispatch(viewport, pinch);
  expect(pinch.defaultPrevented).toBe(true);
  expect(getTransform(view.container)).toBe('translate(0px, 0px) scale(1)');
});

test('dragging pans the diagram and double-clicking resets it', async () => {
  await using view = await renderDiagram('flowchart TD\ndrag-->pan');
  const viewport = view.container.querySelector('.codiff-mermaid-viewport')!;
  await dispatch(viewport, pointer('pointerdown', 10, 10, 2));
  await dispatch(viewport, pointer('pointermove', 40, 30));
  expect(getTransform(view.container)).toBe('translate(0px, 0px) scale(1)');

  await dispatch(viewport, pointer('pointerdown', 10, 10));
  await dispatch(viewport, pointer('pointermove', 25, 20));
  await dispatch(viewport, pointer('pointermove', 40, 30));
  await dispatch(viewport, pointer('pointerup', 40, 30));
  await dispatch(viewport, pointer('pointermove', 90, 90));
  expect(getTransform(view.container)).toBe('translate(30px, 20px) scale(1)');

  await dispatch(viewport, new MouseEvent('dblclick', { bubbles: true }));
  expect(getTransform(view.container)).toBe('translate(0px, 0px) scale(1)');
});

test('diagrams copy their Mermaid code and toggle to the source', async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  await using view = await renderDiagram('flowchart TD\ncopy-->source');
  const { container } = view;

  await click(getButton(container, 'Copy code'));
  await waitFor(() => {
    expect(writeText).toHaveBeenCalledWith('flowchart TD\ncopy-->source');
  });

  await click(getButton(container, 'Show source'));
  await waitFor(() => {
    expect(container.querySelector('.codiff-mermaid-source .cm-content')?.textContent).toContain(
      'copy-->source',
    );
  });
  expect(container.querySelector('img.codiff-mermaid-diagram')).toBe(null);
  getButton(container, 'Copy code');

  await click(getButton(container, 'Show diagram'));
  expect(container.querySelector('img.codiff-mermaid-diagram')).not.toBe(null);
  expect(container.querySelector('.codiff-mermaid-source')).toBe(null);
});
