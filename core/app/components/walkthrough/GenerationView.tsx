import { X } from './icons.tsx';
import { LogTerminal } from './LogTerminal.tsx';

/**
 * Full-pane terminal streaming the agent's output while a walkthrough is
 * generated. On success the pane is replaced by the walkthrough; on failure
 * the output stays put under the error with a dismiss control, mirroring the
 * commit log in CommitView.
 */
export function WalkthroughGenerationView({
  attempt,
  error,
  onClose,
  output,
}: {
  /** Remounts the terminal so each generation starts empty. */
  attempt: number;
  /** Failure reason; null while the generation is still running. */
  error: string | null;
  /** Cancels a running generation or dismisses a failed one. */
  onClose: () => void;
  output: string;
}) {
  const failed = error != null;
  return (
    <div className="wt-generation">
      <div className={`wt-commit-log wt-generation-log${failed ? ' failed' : ''}`}>
        <div className="wt-commit-log-head">
          <span className="wt-commit-log-title">
            {failed ? 'Walkthrough failed' : 'Generating walkthrough…'}
          </span>
          <button
            aria-label={failed ? 'Dismiss walkthrough error' : 'Cancel walkthrough generation'}
            className="wt-commit-dismiss"
            onClick={onClose}
            type="button"
          >
            <X size={14} weight="bold" />
          </button>
        </div>
        <LogTerminal className="wt-commit-log-term" key={attempt} output={output} rows={24} />
        {failed ? <div className="wt-generation-error">{error}</div> : null}
      </div>
    </div>
  );
}
