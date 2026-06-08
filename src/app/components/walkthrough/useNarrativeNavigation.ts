import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildOrderView,
  collectWalkthroughSegments,
  resolveOrder,
} from '../../../lib/narrative-walkthrough.ts';
import type { ChangedFile, NarrativeWalkthrough } from '../../../types.ts';

export type NarrativeViewMode = 'stop' | 'rest' | 'commit';

export type NarrativeNavigation = ReturnType<typeof useNarrativeNavigation>;

/** Every unique path in the live tree, with walkthrough-only paths as a fallback. */
const collectCommitPaths = (
  walkthrough: NarrativeWalkthrough | null,
  files: ReadonlyArray<ChangedFile>,
): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const paths: Array<string> = [];
  for (const file of files) {
    seen.add(file.path);
    paths.push(file.path);
  }
  if (!walkthrough) {
    return paths;
  }
  for (const segment of collectWalkthroughSegments(walkthrough)) {
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
 * we're on a stop, supporting files, or commit, and which segments have been
 * visited (ticked), keyed by segment id so progress survives an order switch.
 */
export const useNarrativeNavigation = (
  walkthrough: NarrativeWalkthrough | null,
  files: ReadonlyArray<ChangedFile>,
  preferredOrderId = 'keys',
  resetKey = '',
) => {
  const [orderId, setOrderId] = useState<string>(() =>
    walkthrough ? (resolveOrder(walkthrough, preferredOrderId)?.id ?? 'walkthrough') : '',
  );
  const [mode, setMode] = useState<NarrativeViewMode>('stop');
  const [index, setIndex] = useState(0);
  const [restVisited, setRestVisited] = useState(false);
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => {
    const firstSegment = walkthrough
      ? resolveOrder(walkthrough, preferredOrderId)?.sequence[0]?.segmentIds[0]
      : undefined;
    return new Set(firstSegment ? [firstSegment] : []);
  });

  // Commit composer state, only meaningful for working-tree walkthroughs. All
  // changed files start selected; the title/body may seed from the document.
  const [commitSelected, setCommitSelected] = useState<ReadonlySet<string>>(
    () => new Set(collectCommitPaths(walkthrough, files)),
  );
  const [commitSubject, setCommitSubjectState] = useState<string>(
    () => walkthrough?.commit?.title ?? '',
  );
  const [commitBody, setCommitBodyState] = useState<string>(() => walkthrough?.commit?.body ?? '');
  const commitBodyDirtyRef = useRef(false);
  const commitPathSetRef = useRef(new Set(collectCommitPaths(walkthrough, files)));
  const commitResetKeyRef = useRef(resetKey);
  const commitSubjectDirtyRef = useRef(false);

  const setCommitSubject = useCallback((value: string) => {
    commitSubjectDirtyRef.current = true;
    setCommitSubjectState(value);
  }, []);

  const setCommitBody = useCallback((value: string) => {
    commitBodyDirtyRef.current = true;
    setCommitBodyState(value);
  }, []);

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
    const order = resolveOrder(walkthrough, preferredOrderId);
    setOrderId(order?.id ?? 'walkthrough');
    setMode('stop');
    setIndex(0);
    setRestVisited(false);
    const firstSegment = order?.sequence[0]?.segmentIds[0];
    setVisited(new Set(firstSegment ? [firstSegment] : []));
  }, [files, preferredOrderId, walkthrough]);

  useEffect(() => {
    const paths = collectCommitPaths(walkthrough, files);
    const pathSet = new Set(paths);

    if (commitResetKeyRef.current !== resetKey) {
      commitResetKeyRef.current = resetKey;
      commitPathSetRef.current = pathSet;
      commitSubjectDirtyRef.current = false;
      commitBodyDirtyRef.current = false;
      setCommitSelected(pathSet);
      setCommitSubjectState(walkthrough?.commit?.title ?? '');
      setCommitBodyState(walkthrough?.commit?.body ?? '');
      return;
    }

    const previousPathSet = commitPathSetRef.current;
    commitPathSetRef.current = pathSet;
    setCommitSelected((current) => {
      const next = new Set<string>();
      let changed = false;
      for (const path of current) {
        if (pathSet.has(path)) {
          next.add(path);
        } else {
          changed = true;
        }
      }
      for (const path of paths) {
        if (!previousPathSet.has(path)) {
          next.add(path);
          changed = true;
        }
      }
      return changed ? next : current;
    });

    if (walkthrough?.commit) {
      if (!commitSubjectDirtyRef.current) {
        setCommitSubjectState(walkthrough.commit.title ?? '');
      }
      if (!commitBodyDirtyRef.current) {
        setCommitBodyState(walkthrough.commit.body ?? '');
      }
    }
  }, [files, resetKey, walkthrough]);

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
      markVisited(orderView.sequence[clamped]?.segmentId);
    },
    [orderView, markVisited],
  );

  const goNext = useCallback(() => goStop(index + 1), [goStop, index]);
  const goPrev = useCallback(() => goStop(index - 1), [goStop, index]);

  const openRest = useCallback(() => {
    if (orderView?.sequence.length) {
      setIndex(orderView.sequence.length - 1);
    }
    setMode('rest');
    setRestVisited(true);
  }, [orderView]);

  const enterCommit = useCallback(() => {
    setMode('commit');
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

  const switchOrder = useCallback(
    (nextOrderId: string) => {
      const nextOrder = walkthrough ? resolveOrder(walkthrough, nextOrderId) : null;
      const resolvedOrderId = nextOrder?.id ?? nextOrderId;
      if (resolvedOrderId === orderId) {
        return;
      }
      setOrderId(resolvedOrderId);
      setMode('stop');
      setIndex(0);
      setRestVisited(false);
      markVisited(
        walkthrough
          ? buildOrderView(walkthrough, resolvedOrderId)?.sequence[0]?.segmentId
          : undefined,
      );
    },
    [orderId, walkthrough, markVisited],
  );

  useEffect(() => {
    if (!walkthrough) {
      return;
    }
    const resolvedOrderId = resolveOrder(walkthrough, preferredOrderId)?.id ?? preferredOrderId;
    if (resolvedOrderId === orderId) {
      return;
    }
    const frame = requestAnimationFrame(() => switchOrder(resolvedOrderId));
    return () => cancelAnimationFrame(frame);
  }, [orderId, preferredOrderId, switchOrder, walkthrough]);

  return {
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
    orderId,
    orderView,
    restVisited,
    setCommitBody,
    setCommitSubject,
    switchOrder,
    toggleCommitFile,
    toggleCommitGroup,
    visited,
  };
};
