import {
  Activity,
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  buildCommitModel,
  getStopSegments,
  isWalkthroughCommittable,
  resolveSegmentFile,
  type ResolvedSegmentFile,
  type WalkthroughOrderView,
  type WalkthroughStopView,
} from '../../../lib/narrative-walkthrough.ts';
import type { ChangedFile, NarrativeWalkthrough } from '../../../types.ts';
import { CommitView, type CommitHandler, type CommitMessageHandler } from './CommitView.tsx';
import { ArrowLeft, ArrowRight, CaretLeft, CaretRight, Check, GitBranch, Path } from './icons.tsx';
import { ImportancePill, Narration, PhaseIcon } from './parts.tsx';
import type { NarrativeNavigation } from './useNarrativeNavigation.ts';

const fileName = (path: string) => path.split('/').pop() ?? path;
const STOP_FILE_WINDOW_SIZE = 3;

const countUniqueRestFiles = (orderView: WalkthroughOrderView) =>
  new Set(orderView.rest.map((item) => item.segment.path)).size;

const stopEstimateHeight = (stop: WalkthroughStopView) => {
  const segments = getStopSegments(stop);
  const files = new Set(segments.map((segment) => segment.path)).size;
  const changedLines = segments.reduce(
    (total, segment) => total + segment.added + segment.deleted,
    0,
  );
  return Math.max(520, Math.min(1600, 260 + files * 120 + changedLines * 14));
};

const createVisibleIndexSet = (length: number, index: number) => {
  const indexes = [index].filter((item) => item >= 0 && item < length);
  return new Set(indexes);
};

const clampIndex = (value: number, length: number) => Math.max(0, Math.min(length - 1, value));

/** Renders the live diff for one changed file via the real ReviewCodeView. */
export type RenderStopDiff = (file: ChangedFile, note?: string) => ReactNode;

function DiffPager({
  count,
  index,
  label,
  onChange,
}: {
  count: number;
  index: number;
  label: string;
  onChange: (index: number) => void;
}) {
  if (count <= 1) {
    return null;
  }

  const changeIndex = (direction: -1 | 1) => onChange(clampIndex(index + direction, count));

  return (
    <div className="wt-diff-pager">
      <button
        className="wt-diff-pager-button"
        disabled={index === 0}
        onClick={() => changeIndex(-1)}
        title={`Previous ${label}`}
        type="button"
      >
        <CaretLeft size={15} />
      </button>
      <span className="wt-diff-pager-label">
        {label} {index + 1} of {count}
      </span>
      <button
        className="wt-diff-pager-button"
        disabled={index === count - 1}
        onClick={() => changeIndex(1)}
        title={`Next ${label}`}
        type="button"
      >
        <CaretRight size={15} />
      </button>
    </div>
  );
}

/** One stop's narration header above its file diff, as a block in the sequence. */
function StopBlock({
  files,
  isCurrent,
  renderStopDiff,
  showWhitespace,
  stop,
}: {
  files: ReadonlyArray<ChangedFile>;
  isCurrent: boolean;
  renderStopDiff: RenderStopDiff;
  showWhitespace: boolean;
  stop: WalkthroughStopView;
}) {
  const [fileWindowIndex, setFileWindowIndex] = useState(0);
  const renderedPaths = new Set<string>();
  const resolvedFiles: Array<{ note?: string; resolved: ResolvedSegmentFile }> = [];
  for (const segment of getStopSegments(stop)) {
    if (renderedPaths.has(segment.path)) {
      continue;
    }
    renderedPaths.add(segment.path);
    const resolved = resolveSegmentFile(segment, files, showWhitespace);
    if (resolved) {
      resolvedFiles.push({
        note: segment === stop.segment ? undefined : (segment.summary ?? segment.title),
        resolved,
      });
    }
  }
  const fileWindowCount = Math.max(1, Math.ceil(resolvedFiles.length / STOP_FILE_WINDOW_SIZE));
  const effectiveWindowIndex = clampIndex(fileWindowIndex, fileWindowCount);
  const visibleResolvedFiles = resolvedFiles.slice(
    effectiveWindowIndex * STOP_FILE_WINDOW_SIZE,
    effectiveWindowIndex * STOP_FILE_WINDOW_SIZE + STOP_FILE_WINDOW_SIZE,
  );
  return (
    <section className={`wt-stop-block${isCurrent ? ' current' : ''}`}>
      <div className="wt-stop-header">
        <div className="wt-stage-title-row">
          <h2 className="wt-stage-title">
            {stop.title ?? stop.segment.title ?? fileName(stop.segment.path)}
          </h2>
          <ImportancePill importance={stop.importance} />
        </div>
        <Narration prose={stop.body} />
      </div>
      <div className="wt-stop-diff-host">
        {visibleResolvedFiles.length > 0 ? (
          <>
            <DiffPager
              count={fileWindowCount}
              index={effectiveWindowIndex}
              label="File set"
              onChange={setFileWindowIndex}
            />
            {visibleResolvedFiles.map(({ note, resolved }) => (
              <Fragment key={resolved.file.path}>{renderStopDiff(resolved.file, note)}</Fragment>
            ))}
          </>
        ) : (
          <div className="wt-empty">These files are no longer part of the current diff.</div>
        )}
      </div>
    </section>
  );
}

type RestFileView = {
  item: {
    note?: string;
    reason: string;
    segment: WalkthroughOrderView['rest'][number]['segment'];
    segmentId: string;
  };
  reason: string;
};

const flattenRestFiles = (orderView: WalkthroughOrderView): ReadonlyArray<RestFileView> =>
  orderView.restByReason.flatMap((group) =>
    group.files.map((item) => ({
      item,
      reason: group.reason,
    })),
  );

function MeasuredStop({
  children,
  index,
  onHeight,
  onRef,
}: {
  children: ReactNode;
  index: number;
  onHeight: (index: number, height: number) => void;
  onRef: (index: number, el: HTMLElement | null) => void;
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      onRef(index, el);
      setNode(el);
    },
    [index, onRef],
  );

  useLayoutEffect(() => {
    if (!node) {
      return;
    }
    const measure = () => onHeight(index, node.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [index, node, onHeight]);

  return <div ref={setRef}>{children}</div>;
}

function StopPlaceholder({
  children,
  height,
  index,
  onRef,
}: {
  children?: ReactNode;
  height: number;
  index: number;
  onRef: (index: number, el: HTMLElement | null) => void;
}) {
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      onRef(index, el);
    },
    [index, onRef],
  );

  return (
    <div aria-hidden className="wt-stop-placeholder" ref={setRef} style={{ height }}>
      {children}
    </div>
  );
}

/**
 * The whole order as one continuous scroll: every stop's narration and diff
 * stacked top-to-bottom, so the reader moves through the change hunk by hunk by
 * scrolling rather than paging file by file. The focused stop is derived from
 * scroll position (which drives the arc and "visited" ticks), and command
 * navigation jumps the requested stop back to the top.
 */
function SequenceScroll({
  files,
  navigation,
  orderView,
  renderStopDiff,
  showWhitespace,
}: {
  files: ReadonlyArray<ChangedFile>;
  navigation: NarrativeNavigation;
  orderView: WalkthroughOrderView;
  renderStopDiff: RenderStopDiff;
  showWhitespace: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const blockRefs = useRef<Array<HTMLElement | null>>([]);
  const commandScrollIgnoreUntilRef = useRef(0);
  const { scrollTarget, syncIndexFromScroll } = navigation;
  const [heightBySegment, setHeightBySegment] = useState<Readonly<Record<string, number>>>({});
  const visibleIndexes = createVisibleIndexSet(orderView.sequence.length, navigation.index);

  const getStopHeight = useCallback(
    (stop: WalkthroughStopView) => heightBySegment[stop.segmentId] ?? stopEstimateHeight(stop),
    [heightBySegment],
  );

  const setBlockRef = useCallback((index: number, el: HTMLElement | null) => {
    blockRefs.current[index] = el;
  }, []);

  const updateStopHeight = useCallback(
    (index: number, height: number) => {
      const stop = orderView.sequence[index];
      if (!stop || height <= 0) {
        return;
      }
      setHeightBySegment((current) =>
        current[stop.segmentId] != null && Math.abs(current[stop.segmentId] - height) < 1
          ? current
          : { ...current, [stop.segmentId]: height },
      );
    },
    [orderView],
  );

  useEffect(() => {
    blockRefs.current = blockRefs.current.slice(0, orderView.sequence.length);
  }, [orderView.sequence.length]);

  // Derive the focused stop from scroll: it's the last block whose top has
  // crossed an activation line a little below the top of the viewport.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const activation = container.scrollTop + 140;
      let current = 0;
      for (let i = 0; i < blockRefs.current.length; i += 1) {
        const el = blockRefs.current[i];
        if (!el) {
          continue;
        }
        if (el.offsetTop <= activation) {
          current = i;
        } else {
          break;
        }
      }
      syncIndexFromScroll(current);
    };
    const onScroll = () => {
      if (performance.now() < commandScrollIgnoreUntilRef.current) {
        return;
      }
      if (!frame) {
        frame = requestAnimationFrame(measure);
      }
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (frame) {
        cancelAnimationFrame(frame);
      }
    };
  }, [syncIndexFromScroll]);

  // Command-driven moves bump scrollTarget.nonce; bring that stop to the top
  // instantly. Smooth scrolling makes the active stop walk through every
  // intermediate item because scroll position is the source of truth while the
  // animation is in flight.
  useEffect(() => {
    const container = scrollRef.current;
    const el = blockRefs.current[scrollTarget.index];
    if (!container || !el) {
      return;
    }
    commandScrollIgnoreUntilRef.current = performance.now() + 80;
    container.scrollTo({
      behavior: 'instant',
      top: el.offsetTop,
    });
  }, [scrollTarget]);

  return (
    <div className="wt-stop wt-sequence" ref={scrollRef}>
      {orderView.sequence.map((stop, i) => {
        const isVisible = visibleIndexes.has(i);
        if (isVisible) {
          return (
            <MeasuredStop
              index={i}
              key={stop.segmentId}
              onHeight={updateStopHeight}
              onRef={setBlockRef}
            >
              <Activity mode="visible" name={`walkthrough-stop-${i + 1}`}>
                <StopBlock
                  files={files}
                  isCurrent={i === navigation.index}
                  renderStopDiff={renderStopDiff}
                  showWhitespace={showWhitespace}
                  stop={stop}
                />
              </Activity>
            </MeasuredStop>
          );
        }

        return (
          <StopPlaceholder
            height={getStopHeight(stop)}
            index={i}
            key={stop.segmentId}
            onRef={setBlockRef}
          />
        );
      })}
    </div>
  );
}

function RestOverview({
  files,
  orderView,
  renderStopDiff,
  showWhitespace,
}: {
  files: ReadonlyArray<ChangedFile>;
  orderView: WalkthroughOrderView;
  renderStopDiff: RenderStopDiff;
  showWhitespace: boolean;
}) {
  const restFiles = flattenRestFiles(orderView);
  const [activeIndex, setActiveIndex] = useState(0);
  const effectiveIndex = clampIndex(activeIndex, restFiles.length || 1);
  const active = restFiles[effectiveIndex] ?? null;
  const resolved = active ? resolveSegmentFile(active.item.segment, files, showWhitespace) : null;

  return (
    <div className="wt-stop">
      <div className="wt-stop-header">
        <div className="wt-stage-title-row">
          <h2 className="wt-stage-title">{orderView.order.restLabel || 'Supporting files'}</h2>
        </div>
        {orderView.order.restBlurb ? <Narration prose={orderView.order.restBlurb} /> : null}
      </div>
      <div className="wt-support-diffs">
        <DiffPager
          count={restFiles.length}
          index={effectiveIndex}
          label="Support file"
          onChange={setActiveIndex}
        />
        {active ? (
          <section className="wt-support-diff" key={active.item.segmentId}>
            <div className="wt-stop-diff-host">
              {resolved ? (
                renderStopDiff(resolved.file, active.item.note ?? active.reason)
              ) : (
                <div className="wt-empty">This file is no longer part of the current diff.</div>
              )}
            </div>
          </section>
        ) : (
          <div className="wt-empty">These files are no longer part of the current diff.</div>
        )}
      </div>
    </div>
  );
}

function Arc({
  committable,
  navigation,
  orderView,
}: {
  committable: boolean;
  navigation: NarrativeNavigation;
  orderView: WalkthroughOrderView;
}) {
  const currentIndex =
    navigation.mode === 'stop'
      ? navigation.index
      : navigation.mode === 'rest'
        ? orderView.sequence.length
        : -1;
  const trackRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ end: false, start: false });
  const goArcNext = useCallback(() => {
    if (navigation.mode === 'stop') {
      if (navigation.index < orderView.sequence.length - 1) {
        navigation.goNext();
      } else if (orderView.rest.length > 0) {
        navigation.openRest();
      } else if (committable) {
        navigation.enterCommit();
      }
    } else if (navigation.mode === 'rest' && committable) {
      navigation.enterCommit();
    }
  }, [committable, navigation, orderView]);
  const goArcPrev = useCallback(() => {
    if (navigation.mode === 'stop') {
      navigation.goPrev();
    } else if (navigation.mode === 'rest') {
      navigation.goStop(orderView.sequence.length - 1);
    } else if (navigation.mode === 'commit') {
      if (orderView.rest.length > 0) {
        navigation.openRest();
      } else {
        navigation.goStop(orderView.sequence.length - 1);
      }
    }
  }, [navigation, orderView]);
  const canGoPrev =
    navigation.mode === 'stop'
      ? navigation.index > 0
      : navigation.mode === 'rest'
        ? orderView.sequence.length > 0
        : navigation.mode === 'commit' && orderView.sequence.length > 0;
  const canGoNext =
    navigation.mode === 'stop'
      ? navigation.index < orderView.sequence.length - 1 || orderView.rest.length > 0 || committable
      : navigation.mode === 'rest' && committable;

  // The arc never shows a scrollbar; instead it fades the side that has more.
  const updateOverflow = useCallback(() => {
    const el = trackRef.current;
    if (!el) {
      return;
    }
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
    setOverflow((current) =>
      current.start === start && current.end === end ? current : { end, start },
    );
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) {
      return;
    }
    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(el);
    el.addEventListener('scroll', updateOverflow, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', updateOverflow);
    };
  }, [updateOverflow]);

  // Keep the focused node in view as Prev/Next moves it, without a scrollbar.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) {
      return;
    }
    const node = el.querySelector<HTMLElement>('.wt-arc-node.current, .wt-arc-bundle.current');
    if (node) {
      const nodeRect = node.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      el.scrollBy({
        left: nodeRect.left + nodeRect.width / 2 - (elRect.left + elRect.width / 2),
      });
    }
    const timer = window.setTimeout(updateOverflow, 220);
    return () => window.clearTimeout(timer);
  }, [currentIndex, navigation.mode, orderView.order.id, updateOverflow]);

  return (
    <div className="wt-arc">
      <button className="wt-arc-nav" disabled={!canGoPrev} onClick={goArcPrev} type="button">
        <CaretLeft size={16} />
      </button>
      <div
        className={`wt-arc-track${overflow.start ? ' overflow-start' : ''}${
          overflow.end ? ' overflow-end' : ''
        }`}
        ref={trackRef}
      >
        {orderView.phases.map((phase, phaseIndex) => (
          <Fragment key={phase.id}>
            {phaseIndex > 0 ? <span className="wt-arc-join" /> : null}
            <div className="wt-arc-chapter">
              <span className="wt-arc-chapter-label">
                <PhaseIcon icon={phase.icon} size={13} />
                {phase.title}
              </span>
              <div className="wt-arc-nodes">
                {phase.stops.map((stop) => {
                  const state =
                    stop.index === currentIndex
                      ? 'current'
                      : navigation.visited.has(stop.segmentId)
                        ? 'visited'
                        : 'upcoming';
                  return (
                    <button
                      className={`wt-arc-node ${state}`}
                      key={stop.segmentId}
                      onClick={() => navigation.goStop(stop.index)}
                      title={stop.title ?? stop.segment.title ?? stop.segment.path}
                      type="button"
                    >
                      {state === 'visited' ? (
                        <Check size={12} weight="bold" />
                      ) : (
                        <span>{stop.index + 1}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </Fragment>
        ))}
        {orderView.rest.length > 0 ? (
          <>
            <span className="wt-arc-join" />
            <div className="wt-arc-chapter rest">
              <span className="wt-arc-chapter-label">
                <Path size={13} />
                {orderView.order.restLabel}
              </span>
              <button
                className={`wt-arc-bundle ${
                  navigation.mode === 'rest'
                    ? 'current'
                    : navigation.restVisited
                      ? 'visited'
                      : 'upcoming'
                }`}
                onClick={navigation.openRest}
                title="Review supporting files"
                type="button"
              >
                <span>{orderView.sequence.length + 1}</span>
              </button>
            </div>
          </>
        ) : null}
        {committable ? (
          <>
            <span className="wt-arc-join dashed" />
            <div className="wt-arc-chapter">
              <span className="wt-arc-chapter-label">
                <GitBranch size={13} />
                Commit
              </span>
              <button
                className={`wt-arc-node${navigation.mode === 'commit' ? ' current' : ''}`}
                onClick={navigation.enterCommit}
                title="Commit the staged change"
                type="button"
              >
                <GitBranch size={13} />
              </button>
            </div>
          </>
        ) : null}
      </div>
      <button className="wt-arc-nav" disabled={!canGoNext} onClick={goArcNext} type="button">
        <CaretRight size={16} />
      </button>
    </div>
  );
}

export function NarrativeWalkthroughView({
  files,
  navigation,
  onCommit,
  onUpdateCommitMessage,
  renderStopDiff,
  showWhitespace,
  walkthrough,
}: {
  files: ReadonlyArray<ChangedFile>;
  navigation: NarrativeNavigation;
  onCommit: CommitHandler;
  onUpdateCommitMessage: CommitMessageHandler;
  renderStopDiff: RenderStopDiff;
  showWhitespace: boolean;
  walkthrough: NarrativeWalkthrough;
}) {
  const { orderView } = navigation;
  const committable = isWalkthroughCommittable(walkthrough);

  // j/k and Ctrl+↑/↓ move between stops, matching the prototype and Codiff's
  // hunk navigation. Ignore while typing into a comment or input.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))
      ) {
        return;
      }
      if (!orderView) {
        return;
      }
      const isNext = event.key === 'j' || (event.ctrlKey && event.key === 'ArrowDown');
      const isPrev = event.key === 'k' || (event.ctrlKey && event.key === 'ArrowUp');
      if (isNext) {
        event.preventDefault();
        if (navigation.mode === 'stop') {
          if (navigation.index < orderView.sequence.length - 1) {
            navigation.goNext();
          } else if (orderView.rest.length > 0) {
            navigation.openRest();
          } else if (committable) {
            navigation.enterCommit();
          }
        } else if (navigation.mode === 'rest' && committable) {
          navigation.enterCommit();
        }
      } else if (isPrev) {
        event.preventDefault();
        if (navigation.mode === 'stop') {
          navigation.goPrev();
        } else if (navigation.mode === 'rest') {
          navigation.goStop(navigation.index);
        } else if (navigation.mode === 'commit') {
          if (orderView.rest.length > 0) {
            navigation.openRest();
          } else {
            navigation.goStop(navigation.index);
          }
        }
      }
    },
    [committable, navigation, orderView],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!orderView) {
    return <div className="wt-empty">This walkthrough has no readable order.</div>;
  }

  const next = orderView.sequence[navigation.index + 1];
  const restFileCount = countUniqueRestFiles(orderView);
  const allStopsVisited =
    orderView.sequence.length > 0 &&
    orderView.sequence.every((stop) => navigation.visited.has(stop.segmentId)) &&
    (orderView.rest.length === 0 || navigation.restVisited);
  const totalSteps = orderView.sequence.length + (orderView.rest.length > 0 ? 1 : 0);
  const completionAction = allStopsVisited
    ? committable
      ? {
          onClick: navigation.enterCommit,
          title: 'Commit the change',
        }
      : {
          file: `${totalSteps} chapters`,
          onClick: null,
          title: 'All chapters reviewed',
        }
    : null;

  return (
    <div className="wt-hybrid">
      <Arc committable={committable} navigation={navigation} orderView={orderView} />

      {navigation.mode === 'commit' ? (
        <CommitView
          branch={walkthrough.repo.branch}
          draft={navigation}
          model={buildCommitModel(orderView, files)}
          onCommit={onCommit}
          onUpdateMessage={onUpdateCommitMessage}
        />
      ) : navigation.mode === 'stop' && orderView.sequence.length > 0 ? (
        <SequenceScroll
          files={files}
          navigation={navigation}
          orderView={orderView}
          renderStopDiff={renderStopDiff}
          showWhitespace={showWhitespace}
        />
      ) : (
        <RestOverview
          files={files}
          orderView={orderView}
          renderStopDiff={renderStopDiff}
          showWhitespace={showWhitespace}
        />
      )}

      {navigation.mode === 'commit' ? null : completionAction ? (
        <button
          className="wt-upnext complete"
          disabled={!completionAction.onClick}
          onClick={completionAction.onClick ?? undefined}
          type="button"
        >
          <span className="wt-upnext-action">
            <span className="wt-upnext-main">
              <span className="wt-upnext-label">Walkthrough complete:</span>{' '}
              <span className="wt-upnext-title">{completionAction.title}</span>
            </span>
            {'file' in completionAction ? (
              <span className="wt-upnext-file">{completionAction.file}</span>
            ) : null}
            <span className="wt-upnext-complete-check">
              <Check size={12} weight="bold" />
            </span>
          </span>
        </button>
      ) : navigation.mode === 'stop' && next ? (
        <button className="wt-upnext" onClick={navigation.goNext} type="button">
          <span className="wt-upnext-action">
            <span className="wt-upnext-main">
              <span className="wt-upnext-label">Next:</span>{' '}
              <span className="wt-upnext-title">
                {next.title ?? next.segment.title ?? fileName(next.segment.path)}
              </span>
            </span>
            <span className="wt-upnext-file">{fileName(next.segment.path)}</span>
            <ArrowRight size={17} />
          </span>
        </button>
      ) : navigation.mode === 'stop' && orderView.rest.length > 0 ? (
        <button className="wt-upnext" onClick={navigation.openRest} type="button">
          <span className="wt-upnext-action">
            <span className="wt-upnext-main">
              <span className="wt-upnext-label">Next:</span>{' '}
              <span className="wt-upnext-title">{orderView.order.restLabel}</span>
            </span>
            <span className="wt-upnext-file">
              {restFileCount} file{restFileCount === 1 ? '' : 's'}
            </span>
            <ArrowRight size={17} />
          </span>
        </button>
      ) : navigation.mode === 'stop' && committable ? (
        <button className="wt-upnext commit" onClick={navigation.enterCommit} type="button">
          <span className="wt-upnext-action">
            <span className="wt-upnext-main">
              <span className="wt-upnext-label">End of sequence:</span>{' '}
              <span className="wt-upnext-title">Commit the change</span>
            </span>
            <ArrowRight size={17} />
          </span>
        </button>
      ) : navigation.mode === 'rest' && committable ? (
        <button className="wt-upnext commit" onClick={navigation.enterCommit} type="button">
          <span className="wt-upnext-action">
            <span className="wt-upnext-main">
              <span className="wt-upnext-label">Done skimming:</span>{' '}
              <span className="wt-upnext-title">Commit the change</span>
            </span>
            <ArrowRight size={17} />
          </span>
        </button>
      ) : navigation.mode === 'rest' ? (
        <button
          className="wt-upnext"
          onClick={() => navigation.goStop(navigation.index)}
          type="button"
        >
          <span className="wt-upnext-action">
            <ArrowLeft className="wt-upnext-back-icon" size={17} />
            <span className="wt-upnext-main">
              <span className="wt-upnext-label">Previous:</span>{' '}
              <span className="wt-upnext-title">
                {orderView.sequence[navigation.index]?.title ??
                  orderView.sequence[navigation.index]?.segment.title ??
                  fileName(orderView.sequence[navigation.index]?.segment.path ?? '')}
              </span>
            </span>
            <span className="wt-upnext-file">Chapter {navigation.index + 1}</span>
          </span>
        </button>
      ) : null}
    </div>
  );
}
