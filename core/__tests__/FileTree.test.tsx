/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { ReviewFileTree } from '../app/components/FileTree.tsx';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

test('review file trees share selection, activation, decorations, and row styling', async () => {
  const firstFile = createChangedFile('src/first.ts', {
    fingerprint: 'first-current',
  });
  const secondFile = createChangedFile('src/second.ts', { status: 'added' });
  const onActivatePath = vi.fn();
  await using view = await renderReact(
    <ReviewFileTree
      files={[firstFile, secondFile]}
      onActivatePath={onActivatePath}
      reloadDeltaPaths={new Set([secondFile.path])}
      selectedPath={firstFile.path}
      showWhitespace={false}
      viewed={{ [firstFile.path]: firstFile.fingerprint }}
    />,
  );

  await waitFor(() => {
    const shadowRoot = view.container.querySelector('file-tree-container')?.shadowRoot;
    expect(shadowRoot?.querySelector(`[data-item-path="${firstFile.path}"]`)).not.toBeNull();
    expect(shadowRoot?.querySelector(`[data-item-path="${secondFile.path}"]`)).not.toBeNull();
  });
  const shadowRoot = view.container.querySelector('file-tree-container')?.shadowRoot;
  expect(shadowRoot).not.toBeNull();
  const firstRow = shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${firstFile.path}"]`);
  const secondRow = shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${secondFile.path}"]`);
  expect(firstRow?.hasAttribute('data-item-selected')).toBe(true);
  expect(firstRow?.querySelector("[data-item-section='decoration']")?.textContent).not.toBe('');
  expect(shadowRoot?.querySelector('style[data-codiff-viewed-rows]')?.textContent).toContain(
    `[data-item-path="${firstFile.path}"]`,
  );
  expect(
    shadowRoot?.querySelector('style[data-codiff-reload-delta-git-status]')?.textContent,
  ).toContain(`[data-item-path="${secondFile.path}"][data-item-git-status]`);
  await act(async () => secondRow?.click());
  expect(onActivatePath).toHaveBeenCalledWith(secondFile.path);
  await view.rerender(
    <ReviewFileTree
      files={[firstFile, secondFile]}
      onActivatePath={onActivatePath}
      selectedPath={secondFile.path}
      showWhitespace={false}
    />,
  );
  await waitFor(() => {
    expect(
      shadowRoot
        ?.querySelector(`[data-item-path="${secondFile.path}"]`)
        ?.getAttribute('aria-selected'),
    ).toBe('true');
  });
});
