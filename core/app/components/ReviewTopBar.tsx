import { SidebarSimpleIcon as SidebarSimple } from '@phosphor-icons/react/SidebarSimple';
import type { ReactNode } from 'react';

export type ReviewModeItem<Mode extends string> = {
  ariaLabel?: string;
  icon: ReactNode;
  indicator?: ReactNode;
  label: string;
  title?: string;
  value: Mode;
};

export function ReviewTopBar<Mode extends string>({
  actions,
  context,
  leading,
  mode,
  modes,
  onModeChange,
  onToggleSidebar,
  repository,
  repositoryTooltip,
  sidebarCollapsed,
  sourceMenu,
  toggleTitle,
}: {
  actions?: ReactNode;
  context?: ReactNode;
  leading?: ReactNode;
  mode: Mode;
  modes: ReadonlyArray<ReviewModeItem<Mode>>;
  onModeChange: (mode: Mode) => void;
  onToggleSidebar: () => void;
  repository: ReactNode;
  repositoryTooltip?: string;
  sidebarCollapsed: boolean;
  sourceMenu?: ReactNode;
  toggleTitle: string;
}) {
  return (
    <header className="review-top-bar workspace-top-bar">
      <div className="review-top-bar-left">
        {leading}
        <button
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="sidebar-toggle-button"
          onClick={onToggleSidebar}
          title={toggleTitle}
          type="button"
        >
          <SidebarSimple aria-hidden size={18} weight="bold" />
        </button>
        {sourceMenu}
        <div className="review-top-bar-repository-slot" title={repositoryTooltip}>
          {repository}
        </div>
      </div>
      <div aria-label="Review mode" className="review-mode-control" role="tablist">
        {modes.map((item) => (
          <button
            aria-label={item.ariaLabel}
            aria-selected={mode === item.value}
            key={item.value}
            onClick={() => onModeChange(item.value)}
            role="tab"
            title={item.title}
            type="button"
          >
            {item.icon}
            <span className="review-mode-label">{item.label}</span>
            {item.indicator}
          </button>
        ))}
      </div>
      <div className="review-top-bar-right">
        {context ? <div className="review-top-bar-context">{context}</div> : null}
        {actions ? <div className="review-top-bar-actions">{actions}</div> : null}
      </div>
    </header>
  );
}
