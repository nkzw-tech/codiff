import { BugIcon as Bug } from '@phosphor-icons/react/Bug';
import { FlaskIcon as Flask } from '@phosphor-icons/react/Flask';
import { GearIcon as Gear } from '@phosphor-icons/react/Gear';
import { PathIcon as Path } from '@phosphor-icons/react/Path';
import { ReadCvLogoIcon as Doc } from '@phosphor-icons/react/ReadCvLogo';
import { WrenchIcon as Wrench } from '@phosphor-icons/react/Wrench';
import type { ComponentType, MouseEvent as ReactMouseEvent } from 'react';
import { renderInlineMarkdown } from '../../../lib/markdown.tsx';
import { importanceLabel } from '../../../lib/narrative-walkthrough.ts';
import type { WalkthroughIcon, WalkthroughStop } from '../../../types.ts';

type IconProps = {
  size?: number;
  weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';
};

const chapterIcons: Record<WalkthroughIcon, ComponentType<IconProps>> = {
  beaker: Flask,
  bug: Bug,
  doc: Doc,
  flask: Flask,
  gear: Gear,
  path: Path,
  wrench: Wrench,
};

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

export function Narration({
  onRegionLink,
  prose,
}: {
  onRegionLink?: (regionId: string) => void;
  prose: string;
}) {
  const paragraphs = prose
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return (
    <div
      className="wt-narration"
      onClick={(event: ReactMouseEvent<HTMLDivElement>) => {
        const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#"]');
        if (!link || !event.currentTarget.contains(link)) {
          return;
        }
        const target = link.getAttribute('href');
        if (!target?.startsWith('#') || target.length === 1) {
          return;
        }
        event.preventDefault();
        onRegionLink?.(target.slice(1));
      }}
    >
      {(paragraphs.length > 0 ? paragraphs : [prose]).map((paragraph, index) => (
        <p className="wt-narration-prose" key={`${index}:${paragraph}`}>
          {renderInlineMarkdown(paragraph)}
        </p>
      ))}
    </div>
  );
}
