export type WalkthroughFileError = {
  path: string;
  reason: string;
};

export function WalkthroughFileErrorDialog({
  error,
  onDismiss,
}: {
  error: WalkthroughFileError | null;
  onDismiss: () => void;
}) {
  if (!error) {
    return null;
  }

  return (
    <div className="walkthrough-error-overlay" onClick={onDismiss}>
      <div
        aria-labelledby="walkthrough-error-title"
        className="walkthrough-error"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="walkthrough-error-header">
          <span className="walkthrough-error-title" id="walkthrough-error-title">
            Walkthrough file not loaded
          </span>
          <button
            aria-label="Dismiss"
            className="walkthrough-error-close"
            onClick={onDismiss}
            type="button"
          >
            ×
          </button>
        </div>
        <p className="walkthrough-error-text">
          Codiff opened with a pre-authored walkthrough file, but could not display it. The diff
          below is unchanged — only the guided narrative is missing.
        </p>
        <code className="walkthrough-error-path" title={error.path}>
          {error.path}
        </code>
        <p className="walkthrough-error-reason">{error.reason}</p>
        <div className="walkthrough-error-actions">
          <button className="codiff-open-button" onClick={onDismiss} type="button">
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
