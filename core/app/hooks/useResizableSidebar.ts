import { useCallback, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { clampSidebarWidth } from '../../lib/sidebar-width.ts';

type UseResizableSidebarOptions = {
  collapseThreshold?: number;
  onCollapse?: () => void;
  onWidthCommit: (width: number) => void;
  position: 'left' | 'right';
  readWidth: () => number;
};

export function useResizableSidebar({
  collapseThreshold,
  onCollapse,
  onWidthCommit,
  position,
  readWidth,
}: UseResizableSidebarOptions) {
  const [sidebarWidth, setSidebarWidth] = useState(readWidth);

  const resizeSidebar = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();

      const handle = event.currentTarget;
      const shell = handle.parentElement;
      if (!shell) {
        return;
      }

      const shellRect = shell.getBoundingClientRect();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      let collapsed = false;

      const cleanup = () => {
        handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener('pointermove', handleMove);
        handle.removeEventListener('pointerup', handleEnd);
        handle.removeEventListener('pointercancel', handleEnd);
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
      };

      const handleMove = (moveEvent: PointerEvent) => {
        const rawWidth =
          position === 'right'
            ? shellRect.right - moveEvent.clientX
            : moveEvent.clientX - shellRect.left;
        if (collapseThreshold != null && rawWidth < collapseThreshold) {
          collapsed = true;
          onCollapse?.();
          cleanup();
          return;
        }
        setSidebarWidth(clampSidebarWidth(rawWidth));
      };

      const handleEnd = () => {
        cleanup();
        if (!collapsed) {
          setSidebarWidth((width) => {
            onWidthCommit(width);
            return width;
          });
        }
      };

      handle.addEventListener('pointermove', handleMove);
      handle.addEventListener('pointerup', handleEnd);
      handle.addEventListener('pointercancel', handleEnd);
    },
    [collapseThreshold, onCollapse, onWidthCommit, position],
  );

  return { resizeSidebar, sidebarWidth };
}
