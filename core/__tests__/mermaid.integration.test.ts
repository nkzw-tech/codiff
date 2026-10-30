/**
 * @vitest-environment jsdom
 */

import mermaid from 'mermaid';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { getCachedMermaidDiagram, renderMermaidDiagram } from '../lib/mermaid.ts';

afterEach(() => vi.restoreAllMocks());

test('the real Mermaid parser rejects image nodes before rendering and keeps the queue usable', async () => {
  // Keep the real parser and configuration; drawing requires browser SVG layout APIs.
  const render = vi.spyOn(mermaid, 'render').mockResolvedValue({
    diagramType: 'flowchart',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"></svg>',
  });
  const image = vi.spyOn(window, 'Image');

  for (const metadata of [
    'img: "https://example.com/slow.png"',
    String.raw`"\u0069mg": "https://example.com/escaped.png"`,
    'img: "data:image/png;base64,iVBORw0KGgo="',
  ]) {
    const code = `flowchart TD\nA@{${metadata}, label: "Image"}`;
    await expect(renderMermaidDiagram(code, 'default')).rejects.toThrow(
      'Images are not supported in Mermaid diagrams',
    );
    expect(getCachedMermaidDiagram(code, 'default')).toBe(null);
  }
  expect(render).not.toHaveBeenCalled();
  expect(image).not.toHaveBeenCalled();

  await expect(
    renderMermaidDiagram('flowchart TD\nqueue-->continues', 'default'),
  ).resolves.toMatchObject({ height: 100, width: 200 });
  expect(render).toHaveBeenCalledTimes(1);
});

test('real Mermaid configuration keeps HTML labels disabled against frontmatter and init overrides', async () => {
  vi.spyOn(mermaid, 'render').mockResolvedValue({
    diagramType: 'flowchart',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"></svg>',
  });
  await renderMermaidDiagram('flowchart TD\ninitialize-->security', 'dark');

  for (const directive of [
    '---\nconfig:\n  htmlLabels: true\n  flowchart:\n    htmlLabels: true\n  securityLevel: loose\n  secure: []\n---',
    '%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}, "securityLevel": "loose", "secure": []}}%%',
  ]) {
    await mermaid.parse(`${directive}\nflowchart TD\nA["One<br/>Two"]-->B`);
    const config = mermaid.mermaidAPI.getConfig();
    expect(config.htmlLabels).toBe(false);
    expect(config.flowchart?.htmlLabels).not.toBe(true);
    expect(config.securityLevel).toBe('strict');
    expect(config.secure).toContain('htmlLabels');
    expect(config.secure).toContain('securityLevel');
  }
});
