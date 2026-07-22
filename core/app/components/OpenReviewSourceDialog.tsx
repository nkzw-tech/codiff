import { useCallback, useState, type FormEvent } from 'react';
import type { OpenReviewSourceKind } from '../../types.ts';

const dialogCopy: Record<
  OpenReviewSourceKind,
  { description: string; label: string; placeholder: string; title: string }
> = {
  branch: {
    description: 'Compare the current working tree with a branch.',
    label: 'Branch name',
    placeholder: 'main',
    title: 'Open Branch',
  },
  commit: {
    description: 'Review a commit by SHA or revision, such as HEAD~1.',
    label: 'Commit',
    placeholder: 'HEAD~1 or a commit SHA',
    title: 'Open Commit',
  },
  'pull-request': {
    description: 'Paste a PR number or a GitHub or GitLab pull request link.',
    label: 'Pull request',
    placeholder: '#123 or https://github.com/owner/repo/pull/123',
    title: 'Open PR',
  },
};

export function OpenReviewSourceDialog({
  kind,
  onClose,
  onOpen,
}: {
  kind: OpenReviewSourceKind;
  onClose: () => void;
  onOpen: (value: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [value, setValue] = useState('');
  const copy = dialogCopy[kind];

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const source = value.trim();
      if (!source) {
        setError(`Enter a ${copy.label.toLowerCase()}.`);
        return;
      }

      setError(null);
      setSubmitting(true);
      try {
        // The parent owns source loading so palette and native-menu requests use the same path.
        await onOpen(source);
        onClose();
      } catch (error) {
        setError(error instanceof Error ? error.message : `Could not open ${copy.title}.`);
      } finally {
        setSubmitting(false);
      }
    },
    [copy.label, copy.title, onClose, onOpen, value],
  );

  return (
    <div
      className="open-review-source-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) {
          onClose();
        }
      }}
    >
      <form
        aria-describedby="open-review-source-description"
        aria-labelledby="open-review-source-title"
        aria-modal="true"
        className="open-review-source-dialog"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !submitting) {
            event.preventDefault();
            onClose();
          }
        }}
        onSubmit={handleSubmit}
        role="dialog"
      >
        <div className="open-review-source-heading">
          <h2 id="open-review-source-title">{copy.title}</h2>
          <p id="open-review-source-description">{copy.description}</p>
        </div>
        <label className="open-review-source-label" htmlFor="open-review-source-input">
          {copy.label}
        </label>
        <input
          aria-describedby={error ? 'open-review-source-error' : undefined}
          autoFocus
          className="open-review-source-input"
          disabled={submitting}
          id="open-review-source-input"
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setError(null);
          }}
          placeholder={copy.placeholder}
          spellCheck={false}
          type="text"
          value={value}
        />
        {error ? (
          <p className="open-review-source-error" id="open-review-source-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="open-review-source-actions">
          <button disabled={submitting} onClick={onClose} type="button">
            Cancel
          </button>
          <button disabled={submitting} type="submit">
            {submitting ? 'Opening…' : 'Open'}
          </button>
        </div>
      </form>
    </div>
  );
}
