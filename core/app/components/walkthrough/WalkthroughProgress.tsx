import { useEffect, useState } from 'react';
import type { WalkthroughGenerationProgress, WalkthroughProgressPhase } from '../../../types.ts';

export const walkthroughResponseLabels = [
  'Building walkthrough…',
  'Composing walkthrough…',
  'Writing walkthrough…',
  'Assembling walkthrough…',
  'Creating walkthrough…',
  'Producing walkthrough…',
] as const;

export const nextWalkthroughResponseLabelIndex = (current: number) =>
  (current + 1) % walkthroughResponseLabels.length;

const TIMER_THRESHOLD_SECONDS = 3;

const unitStatusLabel = (
  status: NonNullable<WalkthroughGenerationProgress['units']>[number]['status'],
) => {
  switch (status) {
    case 'ready':
      return 'done';
    case 'generating':
      return 'generating';
    case 'preparing':
      return 'preparing';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
};

export function WalkthroughProgress({
  detail,
  label: labelOverride,
  phase,
  progress,
  responseLabelIndex,
  stageRevision,
}: {
  detail?: string | null;
  label?: string;
  phase: WalkthroughProgressPhase | null;
  progress?: WalkthroughGenerationProgress | null;
  responseLabelIndex: number;
  stageRevision: number;
}) {
  const [timerState, setTimerState] = useState({ elapsedSeconds: 0, stageRevision });

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setTimerState({
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        stageRevision,
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [stageRevision]);

  const elapsedSeconds = timerState.stageRevision === stageRevision ? timerState.elapsedSeconds : 0;
  const showTimer = elapsedSeconds >= TIMER_THRESHOLD_SECONDS;
  const label =
    labelOverride ??
    (phase === 'agent-generation'
      ? 'Analyzing changes…'
      : phase === 'response-received'
        ? walkthroughResponseLabels[Math.abs(responseLabelIndex) % walkthroughResponseLabels.length]
        : 'Generating walkthrough…');
  const summary = progress?.summary ?? detail ?? null;
  const units = progress?.units ?? [];
  const counts =
    progress?.total != null
      ? `${progress.completed ?? units.filter((unit) => unit.status === 'ready').length}/${progress.total}`
      : null;

  return (
    <span aria-live="polite" className="walkthrough-progress" role="status">
      <span className="walkthrough-progress-copy">
        <span className="walkthrough-progress-heading">
          <span className="walkthrough-progress-label">
            {label}
            {counts ? ` · ${counts}` : ''}
            {summary ? ` · ${summary}` : ''}
          </span>
          <time
            aria-hidden={!showTimer}
            className={`walkthrough-progress-timer${showTimer ? ' visible' : ''}`}
            dateTime={`PT${elapsedSeconds}S`}
          >
            {showTimer ? `${elapsedSeconds}s` : '0s'}
          </time>
        </span>
        {units.length > 0 ? (
          <ul className="walkthrough-progress-units">
            {units.map((unit) => (
              <li
                className={`walkthrough-progress-unit is-${unit.status}`}
                key={unit.id}
                title={unit.detail ?? unit.label}
              >
                <span className="walkthrough-progress-unit-status">
                  {unitStatusLabel(unit.status)}
                </span>
                <span className="walkthrough-progress-unit-label">{unit.label}</span>
                {unit.status === 'failed' && unit.detail ? (
                  <span className="walkthrough-progress-unit-detail">{unit.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </span>
    </span>
  );
}
