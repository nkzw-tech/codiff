/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test, vi } from 'vite-plus/test';
import { MarkdownDocumentEditor } from '../app/components/MarkdownDocumentEditor.tsx';
import type { CodiffMarkdownDocument } from '../types.ts';
import { waitFor } from './helpers/react.tsx';

const markdownDocument = {
  content: '# Plan\n\n[Reference][target]\n\n[target]: https://example.com\n',
  id: 'repository:plan.md',
  kind: 'repository',
  path: 'plan.md',
  version: 'initial-version',
} satisfies CodiffMarkdownDocument;

test('unsupported Markdown is never left in a partially editable editor', async () => {
  const saveMarkdownDocument = vi.fn();
  window.codiff = {
    onMarkdownDocumentChanged: vi.fn(() => () => {}),
    saveMarkdownDocument,
  } as unknown as Window['codiff'];

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  await using _resource = {
    async [Symbol.asyncDispose]() {
      if (root) {
        await act(async () => root?.unmount());
      }
      container.remove();
    },
  };
  await act(async () => {
    root = createRoot(container);
    root.render(<MarkdownDocumentEditor document={markdownDocument} />);
  });
  await waitFor(() => {
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
  expect(container.querySelector('[contenteditable="true"]')).toBeNull();
  expect(container.querySelector('.codiff-markdown-editor-source')?.textContent).toBe(
    markdownDocument.content,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(saveMarkdownDocument).not.toHaveBeenCalled();
});

test('standard Markdown images remain editable', async () => {
  const imageDocument = {
    ...markdownDocument,
    content: '# Plan\n\n![Diagram](diagram.png)\n',
  };
  window.codiff = {
    onMarkdownDocumentChanged: vi.fn(() => () => {}),
    saveMarkdownDocument: vi.fn(),
  } as unknown as Window['codiff'];

  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;

  await using _resource = {
    async [Symbol.asyncDispose]() {
      if (root) {
        await act(async () => root?.unmount());
      }
      container.remove();
    },
  };
  await act(async () => {
    root = createRoot(container);
    root.render(<MarkdownDocumentEditor document={imageDocument} />);
  });
  await waitFor(() => {
    expect(container.querySelector('[contenteditable="true"]')).not.toBeNull();
  });
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
