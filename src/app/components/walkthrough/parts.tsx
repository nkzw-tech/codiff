import claudeIconUrl from '../../../assets/claude.svg';
import codexIconUrl from '../../../assets/codex.svg';
import { renderInlineMarkdown } from '../../../lib/markdown.tsx';
import { granularityLabel, importanceLabel } from '../../../lib/narrative-walkthrough.ts';
import type { WalkthroughIcon, WalkthroughSegment, WalkthroughStop } from '../../../types.ts';
import { phaseIcons } from './icons.tsx';

export function AgentLogo({ agentId }: { agentId: 'codex' | 'claude' }) {
  return <img alt="" draggable={false} src={agentId === 'claude' ? claudeIconUrl : codexIconUrl} />;
}

export function PhaseIcon({ icon, size = 13 }: { icon: WalkthroughIcon; size?: number }) {
  const Icon = phaseIcons[icon] ?? phaseIcons.path;
  return <Icon size={size} />;
}

export function GranularityChip({
  granularity,
}: {
  granularity: WalkthroughSegment['granularity'];
}) {
  return <span className={`wt-gran wt-gran-${granularity}`}>{granularityLabel[granularity]}</span>;
}

export function ImportancePill({ importance }: { importance: WalkthroughStop['importance'] }) {
  return <span className={`wt-importance ${importance}`}>{importanceLabel[importance]}</span>;
}

export function WalkthroughLineCount({ added, deleted }: { added: number; deleted: number }) {
  return (
    <span className="codiff-line-count">
      <span className="codiff-line-count-added">+{added}</span>
      {deleted > 0 ? <span className="codiff-line-count-deleted">−{deleted}</span> : null}
    </span>
  );
}

/** The agent's per-stop narration — visually distinct from review comments. */
export function Narration({
  agentId,
  agentLabel,
  prose,
}: {
  agentId: 'codex' | 'claude';
  agentLabel: string;
  prose: string;
}) {
  return (
    <div className="wt-narration">
      <span className="wt-narration-avatar">
        <AgentLogo agentId={agentId} />
      </span>
      <div className="wt-narration-body">
        <div className="wt-narration-meta">
          <strong>{agentLabel}</strong>
          <span>·</span>
          <span>walkthrough note</span>
        </div>
        <p className="wt-narration-prose">{renderInlineMarkdown(prose)}</p>
      </div>
    </div>
  );
}
