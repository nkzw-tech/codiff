import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown';
import { useState, type ReactNode } from 'react';

export function ResolvedThreadDisclosure({
  children,
  commentCount,
  focused = false,
  focusRequest = 0,
  initialExpanded = focused,
  saving = false,
}: {
  children: ReactNode;
  commentCount: number;
  focused?: boolean;
  focusRequest?: number;
  initialExpanded?: boolean;
  saving?: boolean;
}) {
  const [expansion, setExpansion] = useState({
    expanded: initialExpanded,
    focusRequest,
  });
  const expanded = focused && expansion.focusRequest !== focusRequest ? true : expansion.expanded;
  const countLabel = `${commentCount} ${commentCount === 1 ? 'comment' : 'comments'}`;

  return (
    <div className={`resolved-thread-disclosure${expanded ? ' expanded' : ''}`}>
      <button
        aria-expanded={expanded}
        className="resolved-thread-toggle"
        onClick={() =>
          setExpansion({
            expanded: !expanded,
            focusRequest,
          })
        }
        type="button"
      >
        <span className="resolved-thread-label">
          {saving ? 'Saving resolved conversation' : 'Resolved conversation'}
        </span>
        <span className="resolved-thread-count">{countLabel}</span>
        <CaretDown aria-hidden className="resolved-thread-caret" size={14} weight="bold" />
      </button>
      {expanded ? <div className="resolved-thread-content">{children}</div> : null}
    </div>
  );
}
