/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { useResizableSidebar } from '../app/hooks/useResizableSidebar.ts';
import { useReviewFileState } from '../app/hooks/useReviewState.ts';
import type { ReviewIdentity } from '../lib/app-types.ts';
import { SIDEBAR_COLLAPSE_THRESHOLD } from '../lib/sidebar-width.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact } from './helpers/react.tsx';

type ReviewFileState = ReturnType<typeof useReviewFileState>;

function ReviewFileStateHarness({
  onState,
  onViewedChange,
}: {
  onState: (state: ReviewFileState) => void;
  onViewedChange?: (viewed: Record<string, string>) => void;
}) {
  const state = useReviewFileState({
    initialSelectedPath: 'src/initial.ts',
    onViewedChange,
  });
  onState(state);
  return null;
}

test('review file state keeps collapse, generated expansion, viewed state, and versions aligned', async () => {
  const stateRef: { current: ReviewFileState | null } = { current: null };
  const getState = () => {
    if (!stateRef.current) {
      throw new Error('Review file state did not render.');
    }
    return stateRef.current;
  };
  const onViewedChange = vi.fn();
  const file = { ...createChangedFile('src/generated.ts'), generated: true };
  const reviewIdentity: ReviewIdentity = {
    fingerprint: 'walkthrough-fingerprint',
    key: 'walkthrough:generated',
  };
  await using _view = await renderReact(
    <ReviewFileStateHarness
      onState={(state) => (stateRef.current = state)}
      onViewedChange={onViewedChange}
    />,
  );

  expect(getState().selectedPath).toBe('src/initial.ts');
  await act(async () => {
    getState().setCollapsed(new Set([reviewIdentity.key]));
    getState().toggleCollapsed(file, true, reviewIdentity.key);
  });
  expect(getState().collapsed.has(reviewIdentity.key)).toBe(false);
  expect(getState().expandedGenerated.has(reviewIdentity.key)).toBe(true);
  expect(getState().itemVersionByKey[reviewIdentity.key]).toBe(1);
  await act(async () => {
    getState().toggleViewed(file, false, reviewIdentity);
  });
  expect(getState().viewed).toEqual({
    [reviewIdentity.key]: reviewIdentity.fingerprint,
  });
  expect(getState().collapsed.has(reviewIdentity.key)).toBe(true);
  expect(getState().expandedGenerated.has(reviewIdentity.key)).toBe(false);
  expect(getState().itemVersionByKey[reviewIdentity.key]).toBe(2);
  expect(onViewedChange).toHaveBeenLastCalledWith({
    [reviewIdentity.key]: reviewIdentity.fingerprint,
  });
  await act(async () => {
    getState().toggleViewed(file, true, reviewIdentity);
  });
  expect(getState().viewed).toEqual({});
  expect(getState().collapsed.has(reviewIdentity.key)).toBe(false);
  expect(getState().itemVersionByKey[reviewIdentity.key]).toBe(3);
  expect(onViewedChange).toHaveBeenLastCalledWith({});
});

function ResizableSidebarHarness({
  collapseThreshold,
  onCollapse,
  onWidthCommit,
}: {
  collapseThreshold?: number;
  onCollapse?: () => void;
  onWidthCommit: (width: number) => void;
}) {
  const { resizeSidebar, sidebarWidth } = useResizableSidebar({
    collapseThreshold,
    onCollapse,
    onWidthCommit,
    readWidth: () => 292,
  });
  return (
    <div data-testid="shell">
      <div data-testid="handle" data-width={sidebarWidth} onPointerDown={resizeSidebar} />
    </div>
  );
}

const prepareResizeHandle = (container: HTMLElement) => {
  const shell = container.querySelector<HTMLElement>('[data-testid="shell"]');
  const handle = container.querySelector<HTMLElement>('[data-testid="handle"]');
  if (!shell || !handle) {
    throw new Error('Resizable sidebar did not render.');
  }

  shell.getBoundingClientRect = () =>
    ({
      bottom: 0,
      height: 0,
      left: 20,
      right: 0,
      toJSON: () => ({}),
      top: 0,
      width: 0,
      x: 20,
      y: 0,
    }) as DOMRect;
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();
  return handle;
};

test('resizable sidebars clamp drag widths and commit them on release', async () => {
  const onWidthCommit = vi.fn();
  await using view = await renderReact(<ResizableSidebarHarness onWidthCommit={onWidthCommit} />);

  const handle = prepareResizeHandle(view.container);
  await act(async () => {
    handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    handle.dispatchEvent(new MouseEvent('pointermove', { clientX: 370 }));
  });
  expect(handle.dataset.width).toBe('350');
  expect(onWidthCommit).not.toHaveBeenCalled();
  await act(async () => {
    handle.dispatchEvent(new MouseEvent('pointerup'));
  });
  expect(onWidthCommit).toHaveBeenCalledWith(350);
  expect(handle.classList.contains('dragging')).toBe(false);
  expect(document.body.style.cursor).toBe('');
});

test('resizable sidebars can collapse during a drag without committing a width', async () => {
  const onCollapse = vi.fn();
  const onWidthCommit = vi.fn();
  await using view = await renderReact(
    <ResizableSidebarHarness
      collapseThreshold={SIDEBAR_COLLAPSE_THRESHOLD}
      onCollapse={onCollapse}
      onWidthCommit={onWidthCommit}
    />,
  );

  const handle = prepareResizeHandle(view.container);
  await act(async () => {
    handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    handle.dispatchEvent(new MouseEvent('pointermove', { clientX: 50 }));
  });
  expect(onCollapse).toHaveBeenCalledOnce();
  expect(onWidthCommit).not.toHaveBeenCalled();
  expect(handle.dataset.width).toBe('292');
  expect(handle.classList.contains('dragging')).toBe(false);
});
