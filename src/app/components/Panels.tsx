import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { matchesShortcut } from '../../config/keymap.ts';
import type { CodiffKeymap } from '../../config/types.ts';
import type { RepositoryLoadError, ReviewComment } from '../../lib/app-types.ts';
import { getReloadShortcutLabel } from '../../lib/keyboard.ts';
import { buildReviewCommentsMarkdown } from '../../lib/review-comments.ts';
import type { ChangedFile, PullRequestReviewEvent } from '../../types.ts';

export function ReviewSourceLoading() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 200);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="review-source-loading loading pulse italic" role="status">
      {visible ? 'Thinking…' : null}
    </div>
  );
}

export function RepositoryChangeBanner({ visible }: { visible: boolean }) {
  const [dismissed, setDismissed] = useState(false);
  const isVisible = visible && !dismissed;

  return (
    <div aria-live="polite" className={`repository-change-banner${isVisible ? ' visible' : ''}`}>
      <span className="repository-change-banner-content">
        <span>Local changes detected,</span>
        <button
          className="repository-change-reload"
          onClick={() => window.location.reload()}
          type="button"
        >
          {getReloadShortcutLabel()} to reload.
        </button>
      </span>
      <button
        aria-label="Dismiss update banner"
        className="repository-change-dismiss"
        onClick={() => setDismissed(true)}
        title="Dismiss"
        type="button"
      >
        <span aria-hidden className="diff-search-close-icon" />
      </button>
    </div>
  );
}

export function FirstRunPanel({
  installing,
  onInstallTerminalHelper,
}: {
  installing: boolean;
  onInstallTerminalHelper: () => void;
}) {
  return (
    <>
      <strong>Open a Git repository</strong>
      <p>
        Install the terminal helper, then run{' '}
        <code className="walkthrough-inline-code">codiff</code> from a Git repository in Terminal.
      </p>
      <p>
        You can also choose <span className="empty-panel-menu-path">File → Open Folder…</span> to
        open a Git repository.
      </p>
      <div className="empty-panel-actions">
        <button disabled={installing} onClick={onInstallTerminalHelper} type="button">
          {installing ? 'Installing...' : 'Install Terminal Helper'}
        </button>
      </div>
    </>
  );
}

export function RepositoryLoadErrorPanel({ error }: { error: RepositoryLoadError }) {
  if (error.kind === 'not-a-repository') {
    return (
      <>
        <strong>No Git repository found</strong>
        <p>
          Codiff was opened outside a Git repository. Run{' '}
          <code className="walkthrough-inline-code">codiff</code> from inside a repo, or choose{' '}
          <span className="empty-panel-menu-path">File → Open Folder…</span> to open one.
        </p>
      </>
    );
  }

  return (
    <>
      <strong>Unable to read repository</strong>
      <p>{error.message}</p>
    </>
  );
}

export function CodexUnavailablePanel({ onShowFiles }: { onShowFiles: () => void }) {
  return (
    <>
      <strong>Codex CLI not found</strong>
      <p>
        Install Codex, then verify <code className="walkthrough-inline-code">codex --version</code>{' '}
        works in Terminal.
      </p>
      <p>
        Codiff checks <code className="walkthrough-inline-code">PATH</code>,{' '}
        <code className="walkthrough-inline-code">/opt/homebrew/bin/codex</code>, and{' '}
        <code className="walkthrough-inline-code">/usr/local/bin/codex</code>. It does not run shell
        startup files.
      </p>
      <p>
        If Codex is somewhere else, launch Codiff with{' '}
        <code className="walkthrough-inline-code">
          CODIFF_CODEX_PATH=/absolute/path/to/codex codiff -w
        </code>
        .
      </p>
      <div className="empty-panel-actions">
        <button onClick={onShowFiles} type="button">
          Review Files
        </button>
      </div>
    </>
  );
}

export function DiffSearchPanel({
  activeIndex,
  focusRequest,
  keymap,
  matchCount,
  onChange,
  onClose,
  onNext,
  onPrevious,
  query,
  visible,
}: {
  activeIndex: number;
  focusRequest: number;
  keymap: CodiffKeymap;
  matchCount: number;
  onChange: (query: string) => void;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
  query: string;
  visible: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!visible) {
      return;
    }

    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [focusRequest, visible]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (matchesShortcut(event, keymap, 'closeSearch')) {
        event.preventDefault();
        onClose();
        return;
      }

      if (matchesShortcut(event, keymap, 'prevSearchMatch')) {
        event.preventDefault();
        onPrevious();
        return;
      }

      if (matchesShortcut(event, keymap, 'nextSearchMatch')) {
        event.preventDefault();
        onNext();
      }
    },
    [keymap, onClose, onNext, onPrevious],
  );

  return (
    <div className={`diff-search-panel${visible ? ' visible' : ''}`}>
      <input
        aria-label="Search diffs"
        className="diff-search-input"
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in diffs"
        ref={inputRef}
        spellCheck={false}
        type="search"
        value={query}
      />
      <span className="diff-search-count">
        {query.trim() ? (matchCount > 0 ? `${activeIndex + 1}/${matchCount}` : '0/0') : ''}
      </span>
      <button
        aria-label="Previous match"
        disabled={matchCount === 0}
        onClick={onPrevious}
        title="Previous match"
        type="button"
      >
        <span aria-hidden className="diff-search-chevron up" />
      </button>
      <button
        aria-label="Next match"
        disabled={matchCount === 0}
        onClick={onNext}
        title="Next match"
        type="button"
      >
        <span aria-hidden className="diff-search-chevron down" />
      </button>
      <button aria-label="Close search" onClick={onClose} title="Close" type="button">
        <span aria-hidden className="diff-search-close-icon" />
      </button>
    </div>
  );
}

export function CopyCommentsButton({
  comments,
  files,
  showWhitespace,
}: {
  comments: ReadonlyArray<ReviewComment>;
  files: ReadonlyArray<ChangedFile>;
  showWhitespace: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const pendingCommentCount = comments.filter(
    (comment) => !comment.isReadOnly && comment.body.trim(),
  ).length;

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    },
    [],
  );

  const copyComments = useCallback(async () => {
    const markdown = buildReviewCommentsMarkdown(files, comments, showWhitespace);
    if (!markdown) {
      return;
    }

    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    if (copiedTimerRef.current != null) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copiedTimerRef.current = null;
    }, 2000);
  }, [comments, files, showWhitespace]);

  if (pendingCommentCount === 0) {
    return null;
  }

  return (
    <button
      aria-label={`Copy ${pendingCommentCount} review ${
        pendingCommentCount === 1 ? 'comment' : 'comments'
      }`}
      className={`copy-comments-button${copied ? ' copied' : ''}`}
      onClick={() => void copyComments()}
      title="Copy review comments"
      type="button"
    >
      <span aria-hidden className={copied ? 'copy-comments-icon check' : 'copy-comments-icon'} />
    </button>
  );
}

export function PullRequestReviewButtons({
  disabled,
  onSubmitReview,
  submittingEvent,
}: {
  disabled: boolean;
  onSubmitReview: (event: PullRequestReviewEvent) => void;
  submittingEvent: PullRequestReviewEvent | null;
}) {
  return (
    <>
      <button
        aria-label="Approve pull request"
        className="review-submit-button approve"
        disabled={disabled}
        onClick={() => onSubmitReview('APPROVE')}
        title="Approve pull request"
        type="button"
      >
        <span aria-hidden className="review-submit-icon approve" />
      </button>
      <button
        aria-label="Request changes"
        className="review-submit-button request-changes"
        disabled={disabled}
        onClick={() => onSubmitReview('REQUEST_CHANGES')}
        title="Request changes"
        type="button"
      >
        <span
          aria-hidden
          className={`review-submit-icon request-changes${
            submittingEvent === 'REQUEST_CHANGES' ? ' submitting' : ''
          }`}
        />
      </button>
    </>
  );
}
