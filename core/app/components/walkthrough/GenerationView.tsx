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
  onDismiss,
  output,
}: {
  /** Remounts the terminal so each generation starts empty. */
  attempt: number;
  /** Failure reason; null while the generation is still running. */
  error: string | null;
  onDismiss: () => void;
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
          {failed ? (
            <button
              aria-label="Dismiss walkthrough error"
              className="wt-commit-dismiss"
              onClick={onDismiss}
              type="button"
            >
              <X size={14} weight="bold" />
            </button>
          ) : null}
        </div>
        <LogTerminal className="wt-commit-log-term" key={attempt} output={output} rows={24} />
        {failed ? <div className="wt-generation-error">{error}</div> : null}
      </div>
    </div>
  );
}
