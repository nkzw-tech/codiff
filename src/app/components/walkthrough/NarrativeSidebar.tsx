import { renderInlineMarkdown } from '../../../lib/markdown.tsx';
import {
  buildCommitModel,
  type WalkthroughOrderView,
  type WalkthroughStopView,
} from '../../../lib/narrative-walkthrough.ts';
import type { NarrativeWalkthrough } from '../../../types.ts';
import { Check, GitBranch, Path } from './icons.tsx';
import { AgentLogo, GranularityChip, PhaseIcon } from './parts.tsx';
import type { NarrativeNavigation } from './useNarrativeNavigation.ts';

const agentLabel = (agentId: 'codex' | 'claude') =>
  agentId === 'claude' ? 'Claude Code' : 'Codex';

const fileName = (path: string) => path.split('/').pop() ?? path;

function TocStop({
  current,
  onSelect,
  stop,
  visited,
}: {
  current: boolean;
  onSelect: (index: number) => void;
  stop: WalkthroughStopView;
  visited: boolean;
}) {
  const isDone = visited && !current;
  return (
    <button
      className={`wt-toc-stop${current ? ' current' : ''}${isDone ? ' visited' : ''}`}
      onClick={() => onSelect(stop.index)}
      title={stop.title ?? stop.segment.title ?? stop.segment.path}
      type="button"
    >
      <span className="wt-toc-rail">
        {isDone ? (
          <span className="wt-toc-node done">
            <Check size={8} weight="bold" />
          </span>
        ) : (
          <span className={`wt-toc-node${current ? ' current' : ''}`}>
            {current ? <span className="wt-toc-node-pulse" /> : null}
          </span>
        )}
      </span>
      <span className="wt-toc-main">
        <span className="wt-toc-title-row">
          <span className="wt-toc-num">{stop.index + 1}</span>
          <span className="wt-toc-title">
            {stop.title ?? stop.segment.title ?? stop.segment.path}
          </span>
        </span>
        <span className="wt-toc-meta">
          <span className="wt-toc-file">{fileName(stop.segment.path)}</span>
          <GranularityChip granularity={stop.segment.granularity} />
          <span className="wt-toc-count">
            <span className="added">+{stop.segment.added}</span>
            {stop.segment.deleted > 0 ? (
              <span className="deleted">−{stop.segment.deleted}</span>
            ) : null}
          </span>
        </span>
      </span>
    </button>
  );
}

function RestGroup({
  navigation,
  orderView,
}: {
  navigation: NarrativeNavigation;
  orderView: WalkthroughOrderView;
}) {
  if (orderView.rest.length === 0) {
    return null;
  }
  return (
    <div className="wt-support-group">
      <div className="wt-support-head">
        <span className="wt-support-head-icon">
          <Path size={14} />
        </span>
        <span className="wt-support-head-title">{orderView.order.restLabel}</span>
        <span className="wt-support-head-count">{orderView.rest.length} files</span>
      </div>
      <p className="wt-support-blurb">{orderView.order.restBlurb}</p>
      {orderView.restByReason.map((group) => (
        <div className="wt-support-reason" key={group.reason}>
          <span className="wt-support-reason-label">{group.reason}</span>
          {group.files.map((item) => (
            <button
              className={`wt-support-file${
                navigation.mode === 'rest' && navigation.restFileId === item.segmentId
                  ? ' current'
                  : ''
              }`}
              key={item.segmentId}
              onClick={() => navigation.openRestFile(item.segmentId)}
              title={item.note ?? item.segment.path}
              type="button"
            >
              <span className="wt-support-file-name">{fileName(item.segment.path)}</span>
              <span className="wt-support-file-count">
                <span className="added">+{item.segment.added}</span>
                {item.segment.deleted > 0 ? (
                  <span className="deleted">−{item.segment.deleted}</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

export function NarrativeSidebar({
  navigation,
  walkthrough,
}: {
  navigation: NarrativeNavigation;
  walkthrough: NarrativeWalkthrough;
}) {
  const { orderView } = navigation;
  if (!orderView) {
    return <div className="wt-empty">This walkthrough has no readable order.</div>;
  }

  const currentSegmentId =
    navigation.mode === 'stop' ? orderView.sequence[navigation.index]?.segmentId : null;

  const committable = walkthrough.commit != null;
  const commitModel = committable ? buildCommitModel(orderView) : null;
  const commitTotals = commitModel
    ? commitModel.files
        .filter((file) => navigation.commitSelected.has(file.path))
        .reduce(
          (sum, file) => ({ added: sum.added + file.added, deleted: sum.deleted + file.deleted }),
          { added: 0, deleted: 0 },
        )
    : null;

  return (
    <div className="walkthrough-list">
      <div className="wt-status">
        <span className="wt-status-agent">
          <AgentLogo agentId={walkthrough.agent} />
        </span>
        <div className="wt-status-text">
          <strong>{orderView.order.label}</strong>
          <span>{orderView.order.tagline}</span>
        </div>
      </div>

      <div className="wt-focus">
        <span className="wt-focus-label">Review focus</span>
        <p>{renderInlineMarkdown(walkthrough.focus)}</p>
      </div>

      <div className="wt-toc-scroll">
        {orderView.phases.map((phase) => {
          const done = phase.stops.filter(
            (stop) => navigation.visited.has(stop.segmentId) && stop.segmentId !== currentSegmentId,
          ).length;
          return (
            <div className="wt-toc-chapter" key={phase.id}>
              <div className="wt-toc-chapter-head">
                <span className="wt-toc-chapter-icon">
                  <PhaseIcon icon={phase.icon} size={15} />
                </span>
                <span className="wt-toc-chapter-title">
                  Ch {phase.n} · {phase.title}
                </span>
                <span className="wt-toc-chapter-progress">
                  {done}/{phase.stops.length}
                </span>
              </div>
              <div className="wt-toc-stops">
                {phase.stops.map((stop) => (
                  <TocStop
                    current={navigation.mode === 'stop' && stop.segmentId === currentSegmentId}
                    key={stop.segmentId}
                    onSelect={navigation.goStop}
                    stop={stop}
                    visited={navigation.visited.has(stop.segmentId)}
                  />
                ))}
              </div>
            </div>
          );
        })}
        <RestGroup navigation={navigation} orderView={orderView} />
        {committable && commitTotals ? (
          <div className="wt-toc-chapter">
            <div className="wt-toc-chapter-head">
              <span className="wt-toc-chapter-icon commit">
                <GitBranch size={15} />
              </span>
              <span className="wt-toc-chapter-title">Commit</span>
            </div>
            <button
              className={`wt-toc-stop${navigation.mode === 'commit' ? ' current' : ''}`}
              onClick={navigation.enterCommit}
              type="button"
            >
              <span className="wt-toc-rail">
                <span className={`wt-toc-node${navigation.mode === 'commit' ? ' current' : ''}`}>
                  {navigation.mode === 'commit' ? <span className="wt-toc-node-pulse" /> : null}
                </span>
              </span>
              <span className="wt-toc-main">
                <span className="wt-toc-title-row">
                  <span className="wt-toc-title">Write the commit</span>
                </span>
                <span className="wt-toc-meta">
                  <span className="wt-toc-file">
                    {navigation.commitSelected.size} file
                    {navigation.commitSelected.size === 1 ? '' : 's'}
                  </span>
                  <span className="wt-toc-count">
                    <span className="added">+{commitTotals.added}</span>
                    {commitTotals.deleted > 0 ? (
                      <span className="deleted">−{commitTotals.deleted}</span>
                    ) : null}
                  </span>
                </span>
              </span>
            </button>
          </div>
        ) : null}
      </div>

      <div className="sidebar-total-row">
        <span>
          {navigation.visited.size} of {orderView.sequence.length} stops seen
        </span>
        <span className="codiff-line-count">
          <span className="codiff-line-count-added">+{orderView.totals.added}</span>
          <span className="codiff-line-count-deleted">−{orderView.totals.deleted}</span>
        </span>
      </div>
    </div>
  );
}

export { agentLabel };
