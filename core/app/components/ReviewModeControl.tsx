import type { ReactNode } from 'react';

export type ReviewModeItem<Mode extends string> = {
  ariaLabel?: string;
  icon: ReactNode;
  indicator?: ReactNode;
  label: string;
  title?: string;
  value: Mode;
};

export function ReviewModeControl<Mode extends string>({
  mode,
  modes,
  onModeChange,
}: {
  mode: Mode;
  modes: ReadonlyArray<ReviewModeItem<Mode>>;
  onModeChange: (mode: Mode) => void;
}) {
  return (
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
  );
}
