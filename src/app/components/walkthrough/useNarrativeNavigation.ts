import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildOrderView, resolveOrder } from '../../../lib/narrative-walkthrough.ts';
import type { NarrativeWalkthrough } from '../../../types.ts';

export type NarrativeViewMode = 'stop' | 'rest' | 'commit';

export type NarrativeNavigation = ReturnType<typeof useNarrativeNavigation>;

/** Every unique changed-file path the walkthrough touches, in segment order. */
const collectCommitPaths = (walkthrough: NarrativeWalkthrough | null): ReadonlyArray<string> => {
  if (!walkthrough) {
    return [];
  }
  const seen = new Set<string>();
  const paths: Array<string> = [];
  for (const segment of walkthrough.segments) {
    if (!seen.has(segment.path)) {
      seen.add(segment.path);
      paths.push(segment.path);
    }
  }
  return paths;
};

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
  // A nonce-tagged scroll request. The continuous sequence view watches this and
  // smooth-scrolls to `index` whenever `nonce` bumps — i.e. for command-driven
  // moves (Next/Prev, the arc, j/k), but NOT for the scroll-driven index updates
  // the view feeds back in, which would otherwise fight the user's scrolling.
  const [scrollTarget, setScrollTarget] = useState<{ index: number; nonce: number }>({
    index: 0,
    nonce: 0,
  });
  const [restFileId, setRestFileId] = useState<string | null>(null);
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => {
    const firstSegment = walkthrough
      ? resolveOrder(walkthrough)?.sequence[0]?.segmentId
      : undefined;
    return new Set(firstSegment ? [firstSegment] : []);
  });

  // Commit composer state, only meaningful when `walkthrough.commit` is present.
  // All changed files start selected; the subject seeds from the document.
  const [commitSelected, setCommitSelected] = useState<ReadonlySet<string>>(
    () => new Set(collectCommitPaths(walkthrough)),
  );
  const [commitSubject, setCommitSubject] = useState<string>(
    () => walkthrough?.commit?.subjectSeed ?? '',
  );
  const [commitBody, setCommitBody] = useState<string>(() => walkthrough?.commit?.body ?? '');
  const [commitAuto, setCommitAuto] = useState(false);

  // The useState initializers above run once, on the first render — which happens
  // before the walkthrough has loaded (App passes `null`, then sets it). Re-seed the
  // walkthrough-derived state the first time a walkthrough (or a fresh one, after a
  // source switch) arrives, so the order is active, the first stop is ticked, and the
  // commit composer opens with every file selected and the subject seeded.
  const seededFor = useRef<NarrativeWalkthrough | null>(null);
  useEffect(() => {
    if (!walkthrough || seededFor.current === walkthrough) {
      return;
    }
    seededFor.current = walkthrough;
    const order = resolveOrder(walkthrough);
    setOrderId(order?.id ?? walkthrough.defaultOrder);
    setMode('stop');
    setIndex(0);
    setScrollTarget({ index: 0, nonce: 0 });
    setRestFileId(null);
    const firstSegment = order?.sequence[0]?.segmentId;
    setVisited(new Set(firstSegment ? [firstSegment] : []));
    setCommitSelected(new Set(collectCommitPaths(walkthrough)));
    setCommitSubject(walkthrough.commit?.subjectSeed ?? '');
    setCommitBody(walkthrough.commit?.body ?? '');
    setCommitAuto(false);
  }, [walkthrough]);

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
      // Ask the sequence view to scroll this stop into view.
      setScrollTarget((current) => ({ index: clamped, nonce: current.nonce + 1 }));
    },
    [orderView, markVisited],
  );

  const goNext = useCallback(() => goStop(index + 1), [goStop, index]);
  const goPrev = useCallback(() => goStop(index - 1), [goStop, index]);

  // The continuous sequence view calls this as the reader scrolls, to keep the
  // arc, count and "visited" ticks in step with what's on screen. It updates the
  // focused stop WITHOUT issuing a scroll request, so it never fights the scroll.
  const syncIndexFromScroll = useCallback(
    (target: number) => {
      if (!orderView) {
        return;
      }
      const clamped = Math.max(0, Math.min(orderView.sequence.length - 1, target));
      setIndex((current) => (current === clamped ? current : clamped));
      markVisited(orderView.sequence[clamped]?.segmentId);
    },
    [orderView, markVisited],
  );

  const openRest = useCallback(() => {
    setMode('rest');
    setRestFileId(null);
  }, []);

  const enterCommit = useCallback(() => {
    setMode('commit');
    setRestFileId(null);
  }, []);

  const toggleCommitFile = useCallback((path: string) => {
    setCommitSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const toggleCommitGroup = useCallback((paths: ReadonlyArray<string>) => {
    setCommitSelected((current) => {
      const allOn = paths.every((path) => current.has(path));
      const next = new Set(current);
      for (const path of paths) {
        if (allOn) {
          next.delete(path);
        } else {
          next.add(path);
        }
      }
      return next;
    });
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
      setScrollTarget((current) => ({ index: 0, nonce: current.nonce + 1 }));
      setRestFileId(null);
      markVisited(
        walkthrough ? buildOrderView(walkthrough, nextOrderId)?.sequence[0]?.segmentId : undefined,
      );
    },
    [orderId, walkthrough, markVisited],
  );

  return {
    commitAuto,
    commitBody,
    commitSelected,
    commitSubject,
    enterCommit,
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
    scrollTarget,
    setCommitAuto,
    setCommitBody,
    setCommitSubject,
    switchOrder,
    syncIndexFromScroll,
    toggleCommitFile,
    toggleCommitGroup,
    visited,
  };
};
