import claudeIconUrl from '../../../assets/claude.svg';
import codexIconUrl from '../../../assets/codex.svg';
import { renderInlineMarkdown } from '../../../lib/markdown.tsx';
import { importanceLabel } from '../../../lib/narrative-walkthrough.ts';
import type { WalkthroughIcon, WalkthroughStop } from '../../../types.ts';
import { chapterIcons } from './icons.tsx';

export function AgentLogo({ agentId }: { agentId: 'codex' | 'claude' }) {
  return <img alt="" draggable={false} src={agentId === 'claude' ? claudeIconUrl : codexIconUrl} />;
}

export function ChapterIcon({ icon, size = 13 }: { icon: WalkthroughIcon; size?: number }) {
  const Icon = chapterIcons[icon] ?? chapterIcons.path;
  return <Icon size={size} />;
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

export function Narration({ prose }: { prose: string }) {
  return (
    <div className="wt-narration">
      <p className="wt-narration-prose">{renderInlineMarkdown(prose)}</p>
    </div>
  );
}
