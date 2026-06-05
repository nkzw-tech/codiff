import { useCallback, useMemo, useState } from 'react';
import { buildOrderView, resolveOrder } from '../../../lib/narrative-walkthrough.ts';
import type { NarrativeWalkthrough } from '../../../types.ts';

export type NarrativeViewMode = 'stop' | 'rest';

export type NarrativeNavigation = ReturnType<typeof useNarrativeNavigation>;

/**
 * Shared navigation state for the narrative walkthrough, owned by App and passed
 * to both the sidebar table-of-contents and the main hybrid view so a click in
 * either moves both. State: the active order, the focused stop index, whether
 * we're on a stop or in "the rest" (and which rest file), and which segments
 * have been visited (ticked), keyed by segment id so progress survives an order
 * switch.
 */
export const useNarrativeNavigation = (walkthrough: NarrativeWalkthrough | null) => {
  const [orderId, setOrderId] = useState<string>(() =>
    walkthrough ? (resolveOrder(walkthrough)?.id ?? walkthrough.defaultOrder) : '',
  );
  const [mode, setMode] = useState<NarrativeViewMode>('stop');
  const [index, setIndex] = useState(0);
  const [restFileId, setRestFileId] = useState<string | null>(null);
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => {
    const firstSegment = walkthrough
      ? resolveOrder(walkthrough)?.sequence[0]?.segmentId
      : undefined;
    return new Set(firstSegment ? [firstSegment] : []);
  });

  const orderView = useMemo(
    () => (walkthrough ? buildOrderView(walkthrough, orderId) : null),
    [walkthrough, orderId],
  );

  const markVisited = useCallback((segmentId: string | undefined) => {
    if (!segmentId) {
      return;
    }
    setVisited((current) => {
      if (current.has(segmentId)) {
        return current;
      }
      const next = new Set(current);
      next.add(segmentId);
      return next;
    });
  }, []);

  const goStop = useCallback(
    (target: number) => {
      if (!orderView) {
        return;
      }
      const clamped = Math.max(0, Math.min(orderView.sequence.length - 1, target));
      setMode('stop');
      setIndex(clamped);
      setRestFileId(null);
      markVisited(orderView.sequence[clamped]?.segmentId);
    },
    [orderView, markVisited],
  );

  const goNext = useCallback(() => goStop(index + 1), [goStop, index]);
  const goPrev = useCallback(() => goStop(index - 1), [goStop, index]);

  const openRest = useCallback(() => {
    setMode('rest');
    setRestFileId(null);
  }, []);

  const openRestFile = useCallback((segmentId: string) => {
    setMode('rest');
    setRestFileId(segmentId);
  }, []);

  const switchOrder = useCallback(
    (nextOrderId: string) => {
      if (nextOrderId === orderId) {
        return;
      }
      setOrderId(nextOrderId);
      setMode('stop');
      setIndex(0);
      setRestFileId(null);
      markVisited(
        walkthrough ? buildOrderView(walkthrough, nextOrderId)?.sequence[0]?.segmentId : undefined,
      );
    },
    [orderId, walkthrough, markVisited],
  );

  return {
    goNext,
    goPrev,
    goStop,
    index,
    mode,
    openRest,
    openRestFile,
    orderId,
    orderView,
    restFileId,
    switchOrder,
    visited,
  };
};
