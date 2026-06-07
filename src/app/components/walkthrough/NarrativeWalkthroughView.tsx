import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  resolveSegmentFile,
  type WalkthroughOrderView,
  type WalkthroughStopView,
} from '../../../lib/narrative-walkthrough.ts';
import type { ChangedFile, NarrativeWalkthrough, WalkthroughSegment } from '../../../types.ts';
import { CommitView, type CommitHandler, type CommitMessageHandler } from './CommitView.tsx';
import { ArrowRight, CaretLeft, CaretRight, Check, File, GitBranch, Path } from './icons.tsx';
import {
  GranularityChip,
  ImportancePill,
  Narration,
  PhaseIcon,
  WalkthroughLineCount,
} from './parts.tsx';
import type { NarrativeNavigation } from './useNarrativeNavigation.ts';

const agentLabel = (agentId: 'codex' | 'claude') =>
  agentId === 'claude' ? 'Claude Code' : 'Codex';

const statusLabel = (status: string) => status.charAt(0).toUpperCase() + status.slice(1);

const fileName = (path: string) => path.split('/').pop() ?? path;

/** Renders the live diff for one changed file via the real ReviewCodeView. */
export type RenderStopDiff = (file: ChangedFile) => ReactNode;

function StopAnchorMeta({ segment }: { segment: WalkthroughSegment }) {
  return (
    <div className="wt-stage-anchor">
      <span className="wt-anchor-path">{segment.anchor.display || segment.path}</span>
      <span className={`codiff-status-badge ${segment.status}`}>{statusLabel(segment.status)}</span>
      <GranularityChip granularity={segment.granularity} />
      <WalkthroughLineCount added={segment.added} deleted={segment.deleted} />
    </div>
  );
}

/** One stop's narration header above its file diff, as a block in the sequence. */
function StopBlock({
  agentId,
  files,
  isCurrent,
  renderStopDiff,
  showWhitespace,
  stop,
}: {
  agentId: 'codex' | 'claude';
  files: ReadonlyArray<ChangedFile>;
  isCurrent: boolean;
  renderStopDiff: RenderStopDiff;
  showWhitespace: boolean;
  stop: WalkthroughStopView;
}) {
  const resolved = resolveSegmentFile(stop.segment, files, showWhitespace);
  return (
    <section className={`wt-stop-block${isCurrent ? ' current' : ''}`}>
      <div className="wt-stop-header">
        <ImportancePill importance={stop.importance} />
        <h2 className="wt-stage-title">
          {stop.title ?? stop.segment.title ?? fileName(stop.segment.path)}
        </h2>
        <StopAnchorMeta segment={stop.segment} />
        <Narration agentId={agentId} agentLabel={agentLabel(agentId)} prose={stop.prose} />
      </div>
      <div className="wt-stop-diff-host">
        {resolved ? (
          renderStopDiff(resolved.file)
        ) : (
          <div className="wt-empty">This file is no longer part of the current diff.</div>
        )}
      </div>
    </section>
  );
}

/**
 * The whole order as one continuous scroll: every stop's narration and diff
 * stacked top-to-bottom, so the reader moves through the change hunk by hunk by
 * scrolling rather than paging file by file. The focused stop is derived from
 * scroll position (which drives the arc, count and "visited" ticks), and the arc
 * / Next / Prev / j-k smooth-scroll the requested stop back to the top.
 */
function SequenceScroll({
  agentId,
  files,
  navigation,
  orderView,
  renderStopDiff,
  showWhitespace,
}: {
  agentId: 'codex' | 'claude';
  files: ReadonlyArray<ChangedFile>;
  navigation: NarrativeNavigation;
  orderView: WalkthroughOrderView;
  renderStopDiff: RenderStopDiff;
  showWhitespace: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const blockRefs = useRef<Array<HTMLElement | null>>([]);
  const { scrollTarget, syncIndexFromScroll } = navigation;

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

  // Command-driven moves bump scrollTarget.nonce; bring that stop to the top.
  // Scroll-driven updates don't bump the nonce, so this never fights the reader.
  useEffect(() => {
    const container = scrollRef.current;
    const el = blockRefs.current[scrollTarget.index];
    if (!container || !el) {
      return;
    }
    container.scrollTo({
      behavior: scrollTarget.nonce === 0 ? 'instant' : 'smooth',
      top: el.offsetTop,
    });
  }, [scrollTarget]);

  return (
    <div className="wt-stop wt-sequence" ref={scrollRef}>
      {orderView.sequence.map((stop, i) => (
        <div
          key={stop.segmentId}
          ref={(el) => {
            blockRefs.current[i] = el;
          }}
        >
          <StopBlock
            agentId={agentId}
            files={files}
            isCurrent={i === navigation.index}
            renderStopDiff={renderStopDiff}
            showWhitespace={showWhitespace}
            stop={stop}
          />
        </div>
      ))}
    </div>
  );
}

function RestOverview({
  navigation,
  orderView,
}: {
  navigation: NarrativeNavigation;
  orderView: WalkthroughOrderView;
}) {
  return (
    <div className="wt-hybrid-scroll">
      <div className="wt-stage">
        <span className="wt-importance context">{orderView.order.restLabel}</span>
        <h2 className="wt-stage-title">The rest of the diff</h2>
        <p className="wt-support-overview-lead">
          {orderView.rest.length} files ·{' '}
          <span className="added">+{orderView.restTotals.added}</span>{' '}
          <span className="deleted">−{orderView.restTotals.deleted}</span> —{' '}
          {orderView.order.restBlurb}
        </p>
        {orderView.restByReason.map((group) => (
          <div className="wt-support-card-group" key={group.reason}>
            <span className="wt-support-card-reason">{group.reason}</span>
            {group.files.map((item) => (
              <button
                className="wt-support-card"
                key={item.segmentId}
                onClick={() => navigation.openRestFile(item.segmentId)}
                type="button"
              >
                <span className="wt-support-card-icon">
                  <File size={18} />
                </span>
                <span className="wt-support-card-text">
                  <span className="wt-support-card-path">{item.segment.path}</span>
                  {item.note ? <span className="wt-support-card-note">{item.note}</span> : null}
                </span>
                <span className="wt-support-card-count">
                  <span className="added">+{item.segment.added}</span>
                  {item.segment.deleted > 0 ? (
                    <span className="deleted">−{item.segment.deleted}</span>
                  ) : null}
                </span>
                <span className="wt-support-card-cta">
                  Full diff <ArrowRight size={14} />
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function FullReader({
  files,
  navigation,
  renderStopDiff,
  restItem,
  showWhitespace,
}: {
  files: ReadonlyArray<ChangedFile>;
  navigation: NarrativeNavigation;
  renderStopDiff: RenderStopDiff;
  restItem: WalkthroughOrderView['rest'][number];
  showWhitespace: boolean;
}) {
  const resolved = resolveSegmentFile(restItem.segment, files, showWhitespace);
  return (
    <div className="wt-stop">
      <div className="wt-rest-header">
        <div className="wt-full-banner">
          <span className="wt-full-banner-icon">
            <Path size={18} />
          </span>
          <div className="wt-full-banner-text">
            <strong>Outside the walkthrough · full context</strong>
            <span>
              {restItem.reason}
              {restItem.note ? ` — ${restItem.note}` : ''}
            </span>
          </div>
          <button className="wt-back" onClick={navigation.openRest} type="button">
            <CaretLeft size={15} /> Back to the rest
          </button>
        </div>
      </div>
      <div className="wt-stop-diff-host">
        {resolved ? (
          renderStopDiff(resolved.file)
        ) : (
          <div className="wt-empty">This file is no longer part of the current diff.</div>
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
  const currentIndex = navigation.mode === 'stop' ? navigation.index : -1;
  const trackRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ end: false, start: false });

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
      <button
        className="wt-arc-nav"
        disabled={navigation.mode !== 'stop' || navigation.index <= 0}
        onClick={navigation.goPrev}
        type="button"
      >
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
            <span className="wt-arc-join dashed" />
            <div className="wt-arc-chapter">
              <span className="wt-arc-chapter-label muted">{orderView.order.restLabel}</span>
              <button
                className={`wt-arc-bundle${navigation.mode === 'rest' ? ' current' : ''}`}
                onClick={navigation.openRest}
                title="Files not in the sequence"
                type="button"
              >
                +{orderView.rest.length}
              </button>
            </div>
          </>
        ) : null}
        {committable ? (
          <>
            <span className="wt-arc-join dashed" />
            <div className="wt-arc-chapter">
              <span className="wt-arc-chapter-label commit">
                <GitBranch size={13} />
                Commit
              </span>
              <button
                className={`wt-arc-node commit${navigation.mode === 'commit' ? ' current' : ''}`}
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
      <button
        className="wt-arc-nav"
        disabled={navigation.mode !== 'stop' || navigation.index >= orderView.sequence.length - 1}
        onClick={navigation.goNext}
        type="button"
      >
        <CaretRight size={16} />
      </button>
      <span className="wt-arc-count">
        {navigation.mode === 'stop'
          ? `${navigation.index + 1} / ${orderView.sequence.length}`
          : 'off path'}
      </span>
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
  const committable = walkthrough.commit != null;

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
      if (navigation.mode !== 'stop') {
        return;
      }
      const isNext = event.key === 'j' || (event.ctrlKey && event.key === 'ArrowDown');
      const isPrev = event.key === 'k' || (event.ctrlKey && event.key === 'ArrowUp');
      if (isNext) {
        event.preventDefault();
        navigation.goNext();
      } else if (isPrev) {
        event.preventDefault();
        navigation.goPrev();
      }
    },
    [navigation],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!orderView) {
    return <div className="wt-empty">This walkthrough has no readable order.</div>;
  }

  const next = orderView.sequence[navigation.index + 1];
  const restItem =
    navigation.restFileId != null
      ? orderView.rest.find((item) => item.segmentId === navigation.restFileId)
      : undefined;

  const meta =
    navigation.mode === 'commit'
      ? 'Commit · the walkthrough was the staged diff'
      : navigation.mode === 'rest'
        ? restItem
          ? `Full context · ${restItem.reason}`
          : `${orderView.rest.length} files set aside · ${orderView.order.restLabel.toLowerCase()}`
        : // The stop count is already shown in the arc strip below — avoid duplicating it.
          '';

  return (
    <div className="wt-hybrid">
      <div className="wt-big-bar">
        <div className="wt-toggle">
          {walkthrough.orders.map((order) => (
            <button
              className={order.id === navigation.orderId ? 'on' : ''}
              key={order.id}
              onClick={() => navigation.switchOrder(order.id)}
              type="button"
            >
              {order.label}
            </button>
          ))}
        </div>
        {meta ? <span className="wt-big-bar-meta">{meta}</span> : null}
      </div>

      <Arc committable={committable} navigation={navigation} orderView={orderView} />

      {navigation.mode === 'commit' ? (
        <CommitView
          branch={walkthrough.repo.branch}
          navigation={navigation}
          onCommit={onCommit}
          onUpdateMessage={onUpdateCommitMessage}
          walkthrough={walkthrough}
        />
      ) : navigation.mode === 'stop' && orderView.sequence.length > 0 ? (
        <SequenceScroll
          agentId={walkthrough.agent}
          files={files}
          navigation={navigation}
          orderView={orderView}
          renderStopDiff={renderStopDiff}
          showWhitespace={showWhitespace}
        />
      ) : navigation.mode === 'rest' && restItem ? (
        <FullReader
          files={files}
          navigation={navigation}
          renderStopDiff={renderStopDiff}
          restItem={restItem}
          showWhitespace={showWhitespace}
        />
      ) : (
        <RestOverview navigation={navigation} orderView={orderView} />
      )}

      {navigation.mode === 'commit' ? null : navigation.mode === 'stop' && next ? (
        <button className="wt-upnext" onClick={navigation.goNext} type="button">
          <span className="wt-upnext-label">Up next</span>
          <span className="wt-upnext-title">
            {next.title ?? next.segment.title ?? fileName(next.segment.path)}
          </span>
          <span className="wt-upnext-file">{fileName(next.segment.path)}</span>
          <ArrowRight size={17} />
        </button>
      ) : navigation.mode === 'stop' && committable ? (
        <button className="wt-upnext commit" onClick={navigation.enterCommit} type="button">
          <span className="wt-upnext-label">End of sequence</span>
          <span className="wt-upnext-title">Commit the change</span>
          <span className="wt-upnext-file">{navigation.commitSelected.size} files staged</span>
          <ArrowRight size={17} />
        </button>
      ) : navigation.mode === 'stop' && orderView.rest.length > 0 ? (
        <button className="wt-upnext" onClick={navigation.openRest} type="button">
          <span className="wt-upnext-label">End of sequence</span>
          <span className="wt-upnext-title">Skim the rest</span>
          <span className="wt-upnext-file">{orderView.rest.length} files</span>
          <ArrowRight size={17} />
        </button>
      ) : navigation.mode === 'rest' && committable ? (
        <button className="wt-upnext commit" onClick={navigation.enterCommit} type="button">
          <span className="wt-upnext-label">Done skimming</span>
          <span className="wt-upnext-title">Commit the change</span>
          <span className="wt-upnext-file">{navigation.commitSelected.size} files staged</span>
          <ArrowRight size={17} />
        </button>
      ) : navigation.mode === 'rest' ? (
        <button
          className="wt-upnext"
          onClick={() => navigation.goStop(navigation.index)}
          type="button"
        >
          <span className="wt-upnext-label">Back</span>
          <span className="wt-upnext-title">Return to the walkthrough</span>
          <span className="wt-upnext-file">stop {navigation.index + 1}</span>
          <ArrowRight size={17} />
        </button>
      ) : null}
    </div>
  );
}
