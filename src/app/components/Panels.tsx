import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown';
import { CaretUpIcon as CaretUp } from '@phosphor-icons/react/CaretUp';
import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import { XIcon as X } from '@phosphor-icons/react/X';
import { Copy as LucideCopy } from 'lucide-react';
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
import { useCopiedState } from './useCopiedState.ts';

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

export function RepositoryChangeBanner({
  onReload,
  visible,
}: {
  onReload: () => void;
  visible: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const isVisible = visible && !dismissed;

  return (
    <div aria-live="polite" className={`repository-change-banner${isVisible ? ' visible' : ''}`}>
      <span className="repository-change-banner-content">
        <span>Local changes detected,</span>
        <button className="repository-change-reload" onClick={onReload} type="button">
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
        <X aria-hidden className="diff-search-icon" size={15} weight="bold" />
      </button>
    </div>
  );
}

export function FirstRunPanel({
  codexSkillInstalled,
  codexSkillInstalling,
  installing,
  onInstallCodexSkill,
  onInstallTerminalHelper,
}: {
  codexSkillInstalled: boolean;
  codexSkillInstalling: boolean;
  installing: boolean;
  onInstallCodexSkill: () => void;
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
        {!codexSkillInstalled ? (
          <button disabled={codexSkillInstalling} onClick={onInstallCodexSkill} type="button">
            {codexSkillInstalling ? 'Installing...' : 'Install Codex Skill'}
          </button>
        ) : null}
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
        <CaretUp aria-hidden className="diff-search-icon" size={15} weight="bold" />
      </button>
      <button
        aria-label="Next match"
        disabled={matchCount === 0}
        onClick={onNext}
        title="Next match"
        type="button"
      >
        <CaretDown aria-hidden className="diff-search-icon" size={15} weight="bold" />
      </button>
      <button aria-label="Close search" onClick={onClose} title="Close" type="button">
        <X aria-hidden className="diff-search-icon" size={15} weight="bold" />
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
  const [copied, markCopied] = useCopiedState(2000);
  const pendingCommentCount = comments.filter(
    (comment) => !comment.isReadOnly && comment.body.trim(),
  ).length;

  const copyComments = useCallback(async () => {
    const markdown = buildReviewCommentsMarkdown(files, comments, showWhitespace);
    if (!markdown) {
      return;
    }

    await navigator.clipboard.writeText(markdown);
    markCopied();
  }, [comments, files, markCopied, showWhitespace]);

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
      {copied ? (
        <Check aria-hidden className="copy-comments-icon check" size={22} weight="bold" />
      ) : (
        <LucideCopy aria-hidden className="copy-comments-icon" size={21} strokeWidth={2.25} />
      )}
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
        <Check aria-hidden className="review-submit-icon approve" size={22} weight="bold" />
      </button>
      <button
        aria-label="Request changes"
        className="review-submit-button request-changes"
        disabled={disabled}
        onClick={() => onSubmitReview('REQUEST_CHANGES')}
        title="Request changes"
        type="button"
      >
        <X
          aria-hidden
          className={`review-submit-icon request-changes${
            submittingEvent === 'REQUEST_CHANGES' ? ' submitting' : ''
          }`}
          size={22}
          weight="bold"
        />
      </button>
    </>
  );
}
