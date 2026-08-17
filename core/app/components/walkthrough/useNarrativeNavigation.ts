import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildWalkthroughView,
  getCommitSelectionPaths,
} from '../../../lib/narrative-walkthrough.ts';
import type { ChangedFile, NarrativeWalkthrough } from '../../../types.ts';

export type NarrativeViewMode = 'stop' | 'support' | 'commit';

export type NarrativeNavigation = ReturnType<typeof useNarrativeNavigation>;

const firstStopId = (walkthrough: NarrativeWalkthrough | null): string | undefined =>
  walkthrough?.chapters[0]?.stops[0]?.id;

/**
 * Shared navigation state for the narrative walkthrough, owned by App and passed
 * to both the sidebar table-of-contents and the main hybrid view.
 */
export const useNarrativeNavigation = (
  walkthrough: NarrativeWalkthrough | null,
  files: ReadonlyArray<ChangedFile>,
  resetKey = '',
) => {
  const walkthroughView = useMemo(
    () => (walkthrough ? buildWalkthroughView(walkthrough) : null),
    [walkthrough],
  );
  const commitPaths = useMemo(
    () => getCommitSelectionPaths(walkthroughView, files),
    [files, walkthroughView],
  );
  const [mode, setMode] = useState<NarrativeViewMode>('stop');
  const [index, setIndex] = useState(0);
  // One shared nonce sequence covers both stop and support scroll requests, so
  // a scroll command is identified by a single monotonically increasing number
  // and a mode change derived from scrolling can never resurface an
  // already-handled request as a new one.
  const [scrollTarget, setScrollTarget] = useState<{
    index: number;
    kind: 'stop' | 'support';
    nonce: number;
  }>({
    index: 0,
    kind: 'stop',
    nonce: 0,
  });
  const [supportVisited, setSupportVisited] = useState(false);
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => {
    const stopId = firstStopId(walkthrough);
    return new Set(stopId ? [stopId] : []);
  });

  const [commitSelected, setCommitSelected] = useState<ReadonlySet<string>>(
    () => new Set(commitPaths),
  );
  const [commitSubject, setCommitSubjectState] = useState<string>(
    () => walkthrough?.commit?.title ?? '',
  );
  const [commitBody, setCommitBodyState] = useState<string>(() => walkthrough?.commit?.body ?? '');
  const commitBodyDirtyRef = useRef(false);
  const commitPathSetRef = useRef(new Set(commitPaths));
  const commitResetKeyRef = useRef(resetKey);
  const commitSubjectDirtyRef = useRef(false);
  // Pending scroll locks remember which walkthrough they were set for, so a
  // walkthrough refresh implicitly invalidates them without a render-time
  // ref write.
  const pendingStopScrollRef = useRef<{
    index: number;
    walkthrough: NarrativeWalkthrough | null;
  } | null>(null);
  const pendingSupportScrollRef = useRef<{ walkthrough: NarrativeWalkthrough | null } | null>(null);

  const setCommitSubject = useCallback((value: string) => {
    commitSubjectDirtyRef.current = true;
    setCommitSubjectState(value);
  }, []);

  const setCommitBody = useCallback((value: string) => {
    commitBodyDirtyRef.current = true;
    setCommitBodyState(value);
  }, []);

  // Reset navigation when a new walkthrough arrives, adjusting state during
  // render rather than in an effect (see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const [seededFor, setSeededFor] = useState<NarrativeWalkthrough | null>(null);
  if (walkthrough && seededFor !== walkthrough) {
    setSeededFor(walkthrough);
    // A refresh can land while the reviewer is on the commit screen — e.g.
    // a failed commit attempt stages files, which regenerates the
    // walkthrough. Don't yank them back to the first stop (that would also
    // discard the visible commit error).
    if (mode !== 'commit') {
      setMode('stop');
      setIndex(0);
      setScrollTarget({ index: 0, kind: 'stop', nonce: 0 });
      setSupportVisited(false);
      const stopId = firstStopId(walkthrough);
      setVisited(new Set(stopId ? [stopId] : []));
    }
  }

  useEffect(() => {
    const pathSet = new Set(commitPaths);

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
      for (const path of commitPaths) {
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
  }, [commitPaths, resetKey, walkthrough]);

  const markVisited = useCallback((stopId: string | undefined) => {
    if (!stopId) {
      return;
    }
    setVisited((current) => {
      if (current.has(stopId)) {
        return current;
      }
      const next = new Set(current);
      next.add(stopId);
      return next;
    });
  }, []);

  const goStop = useCallback(
    (target: number) => {
      if (!walkthroughView) {
        return;
      }
      const clamped = Math.max(0, Math.min(walkthroughView.sequence.length - 1, target));
      setMode('stop');
      setIndex(clamped);
      markVisited(walkthroughView.sequence[clamped]?.id);
      pendingStopScrollRef.current = { index: clamped, walkthrough };
      pendingSupportScrollRef.current = null;
      setScrollTarget((current) => ({ index: clamped, kind: 'stop', nonce: current.nonce + 1 }));
    },
    [walkthrough, walkthroughView, markVisited],
  );

  const goNext = useCallback(() => goStop(index + 1), [goStop, index]);
  const goPrev = useCallback(() => goStop(index - 1), [goStop, index]);

  const syncIndexFromScroll = useCallback(
    (target: number) => {
      if (!walkthroughView) {
        return;
      }
      const clamped = Math.max(0, Math.min(walkthroughView.sequence.length - 1, target));
      const pendingSupport = pendingSupportScrollRef.current;
      if (pendingSupport) {
        if (pendingSupport.walkthrough === walkthrough) {
          return;
        }
        pendingSupportScrollRef.current = null;
      }
      const pendingStop = pendingStopScrollRef.current;
      if (pendingStop && pendingStop.walkthrough !== walkthrough) {
        pendingStopScrollRef.current = null;
      } else if (pendingStop) {
        if (pendingStop.index !== clamped) {
          return;
        }
        pendingStopScrollRef.current = null;
      }
      setMode('stop');
      setIndex((current) => (current === clamped ? current : clamped));
      markVisited(walkthroughView.sequence[clamped]?.id);
    },
    [walkthrough, walkthroughView, markVisited],
  );

  const releaseStopScrollLock = useCallback(() => {
    pendingStopScrollRef.current = null;
    pendingSupportScrollRef.current = null;
  }, []);

  const leaveStopMode = useCallback(() => {
    pendingStopScrollRef.current = null;
    pendingSupportScrollRef.current = null;
  }, []);

  const openSupport = useCallback(() => {
    leaveStopMode();
    if (walkthroughView?.sequence.length) {
      setIndex(walkthroughView.sequence.length - 1);
    }
    setMode('support');
    pendingSupportScrollRef.current = { walkthrough };
    setScrollTarget((current) => ({ ...current, kind: 'support', nonce: current.nonce + 1 }));
    setSupportVisited(true);
  }, [walkthrough, walkthroughView, leaveStopMode]);

  // Scrolling across a support block while a clicked stop is still being
  // scrolled to must not hijack the flight into support mode; the lock is
  // released when the target stop is reached or by direct user scroll input.
  const syncSupportFromScroll = useCallback(() => {
    const pendingStop = pendingStopScrollRef.current;
    if (pendingStop) {
      if (pendingStop.walkthrough === walkthrough) {
        return;
      }
      pendingStopScrollRef.current = null;
    }
    pendingSupportScrollRef.current = null;
    setMode('support');
    setSupportVisited(true);
  }, [walkthrough]);

  const enterCommit = useCallback(() => {
    leaveStopMode();
    setMode('commit');
  }, [leaveStopMode]);

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
    openSupport,
    releaseStopScrollLock,
    scrollTarget,
    setCommitBody,
    setCommitSubject,
    supportVisited,
    syncIndexFromScroll,
    syncSupportFromScroll,
    toggleCommitFile,
    toggleCommitGroup,
    visited,
    walkthroughView,
  };
};
