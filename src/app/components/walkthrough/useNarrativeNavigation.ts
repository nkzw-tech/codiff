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
  const [scrollTarget, setScrollTarget] = useState<{ index: number; nonce: number }>({
    index: 0,
    nonce: 0,
  });
  const [supportScrollRequest, setSupportScrollRequest] = useState(0);
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
  const pendingStopScrollIndexRef = useRef<number | null>(null);
  const pendingSupportScrollRef = useRef(false);

  const setCommitSubject = useCallback((value: string) => {
    commitSubjectDirtyRef.current = true;
    setCommitSubjectState(value);
  }, []);

  const setCommitBody = useCallback((value: string) => {
    commitBodyDirtyRef.current = true;
    setCommitBodyState(value);
  }, []);

  const seededFor = useRef<NarrativeWalkthrough | null>(null);
  useEffect(() => {
    if (!walkthrough || seededFor.current === walkthrough) {
      return;
    }
    seededFor.current = walkthrough;
    setMode('stop');
    setIndex(0);
    setScrollTarget({ index: 0, nonce: 0 });
    pendingStopScrollIndexRef.current = null;
    pendingSupportScrollRef.current = false;
    setSupportScrollRequest(0);
    setSupportVisited(false);
    const stopId = firstStopId(walkthrough);
    setVisited(new Set(stopId ? [stopId] : []));
  }, [walkthrough]);

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
      pendingStopScrollIndexRef.current = clamped;
      pendingSupportScrollRef.current = false;
      setScrollTarget((current) => ({ index: clamped, nonce: current.nonce + 1 }));
    },
    [walkthroughView, markVisited],
  );

  const goNext = useCallback(() => goStop(index + 1), [goStop, index]);
  const goPrev = useCallback(() => goStop(index - 1), [goStop, index]);

  const syncIndexFromScroll = useCallback(
    (target: number) => {
      if (!walkthroughView) {
        return;
      }
      const clamped = Math.max(0, Math.min(walkthroughView.sequence.length - 1, target));
      if (pendingSupportScrollRef.current) {
        return;
      }
      const pendingStopScrollIndex = pendingStopScrollIndexRef.current;
      if (pendingStopScrollIndex != null && pendingStopScrollIndex !== clamped) {
        return;
      }
      if (pendingStopScrollIndex === clamped) {
        pendingStopScrollIndexRef.current = null;
      }
      setMode('stop');
      setIndex((current) => (current === clamped ? current : clamped));
      markVisited(walkthroughView.sequence[clamped]?.id);
    },
    [walkthroughView, markVisited],
  );

  const releaseStopScrollLock = useCallback(() => {
    pendingStopScrollIndexRef.current = null;
    pendingSupportScrollRef.current = false;
  }, []);

  const leaveStopMode = useCallback(() => {
    pendingStopScrollIndexRef.current = null;
    pendingSupportScrollRef.current = false;
  }, []);

  const openSupport = useCallback(() => {
    leaveStopMode();
    if (walkthroughView?.sequence.length) {
      setIndex(walkthroughView.sequence.length - 1);
    }
    setMode('support');
    pendingSupportScrollRef.current = true;
    setSupportScrollRequest((current) => current + 1);
    setSupportVisited(true);
  }, [walkthroughView, leaveStopMode]);

  const syncSupportFromScroll = useCallback(() => {
    pendingSupportScrollRef.current = false;
    pendingStopScrollIndexRef.current = null;
    setMode('support');
    setSupportVisited(true);
  }, []);

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
    supportScrollRequest,
    supportVisited,
    syncIndexFromScroll,
    syncSupportFromScroll,
    toggleCommitFile,
    toggleCommitGroup,
    visited,
    walkthroughView,
  };
};
