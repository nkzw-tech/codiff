import { MarkdownEditor, type MarkdownEditorHandle } from '@nkzw/mdx-editor';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown';
import { CaretUpIcon as CaretUp } from '@phosphor-icons/react/CaretUp';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/ChatCircle';
import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/CheckCircle';
import { PowerIcon as Power } from '@phosphor-icons/react/Power';
import { SealQuestionIcon as SealQuestion } from '@phosphor-icons/react/SealQuestion';
import { WarningOctagonIcon as WarningOctagon } from '@phosphor-icons/react/WarningOctagon';
import { XIcon as X } from '@phosphor-icons/react/X';
import { Copy as LucideCopy } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { matchesShortcut } from '../../config/keymap.ts';
import type { CodiffKeymap } from '../../config/types.ts';
import type { RepositoryLoadError, ReviewComment } from '../../lib/app-types.ts';
import { buildReviewCommentsMarkdown } from '../../lib/review-comments.ts';
import type {
  ChangedFile,
  PullRequestMergeOptions,
  PullRequestMergeState,
  PullRequestReviewEvent,
  PullRequestReviewStatus,
} from '../../types.ts';
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
  onRefresh,
  visible,
}: {
  onRefresh: () => void;
  visible: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  // Re-arm the dismiss latch once the current change is refreshed away, so the
  // banner comes back for the next change instead of staying dismissed forever.
  if (!visible && dismissed) {
    setDismissed(false);
  }
  const isVisible = visible && !dismissed;

  return (
    <div aria-live="polite" className={`repository-change-banner${isVisible ? ' visible' : ''}`}>
      <span className="repository-change-banner-content">
        <span>Local changes detected,</span>
        <button className="repository-change-reload" onClick={onRefresh} type="button">
          refresh to see them.
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

export function WalkthroughOutdatedBanner({
  onDismiss,
  reason,
}: {
  onDismiss: () => void;
  reason: string | null;
}) {
  const isVisible = reason != null;

  return (
    <div
      aria-live="polite"
      className={`walkthrough-outdated-banner${isVisible ? ' visible' : ''}`}
      role="status"
    >
      <span className="walkthrough-outdated-banner-content">
        <strong>Walkthrough out of date.</strong>
        <span>{reason ?? ''} Showing history instead.</span>
      </span>
      <button
        aria-label="Dismiss walkthrough banner"
        className="repository-change-dismiss"
        onClick={onDismiss}
        title="Dismiss"
        type="button"
      >
        <X aria-hidden className="diff-search-icon" size={15} weight="bold" />
      </button>
    </div>
  );
}

export function FirstRunPanel({
  agentSkillInstalled,
  agentSkillInstalling,
  agentSkillLabel,
  installing,
  onInstallAgentSkill,
  onInstallTerminalHelper,
}: {
  agentSkillInstalled: boolean;
  agentSkillInstalling: boolean;
  agentSkillLabel: string;
  installing: boolean;
  onInstallAgentSkill: () => void;
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
        {!agentSkillInstalled ? (
          <button disabled={agentSkillInstalling} onClick={onInstallAgentSkill} type="button">
            {agentSkillInstalling ? 'Installing...' : `Install ${agentSkillLabel}`}
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

export function AgentUnavailablePanel({
  agentLabel,
  onShowFiles,
  reason,
  title,
}: {
  agentLabel: string;
  onShowFiles: () => void;
  reason?: string;
  title?: string;
}) {
  return (
    <>
      <strong>{title ?? `${agentLabel} CLI not found`}</strong>
      <p>
        {reason ??
          `Install ${agentLabel} and verify its CLI works in Terminal, then try the walkthrough again.`}
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
  reviewCommentsPrefix,
  showWhitespace,
}: {
  comments: ReadonlyArray<ReviewComment>;
  files: ReadonlyArray<ChangedFile>;
  reviewCommentsPrefix: string;
  showWhitespace: boolean;
}) {
  const [copied, markCopied] = useCopiedState(2000);
  const pendingCommentCount = comments.filter(
    (comment) => !comment.isReadOnly && comment.body.trim(),
  ).length;

  const copyComments = useCallback(async () => {
    const markdown = buildReviewCommentsMarkdown(
      files,
      comments,
      showWhitespace,
      reviewCommentsPrefix,
    );
    if (!markdown) {
      return;
    }

    await navigator.clipboard.writeText(markdown);
    markCopied();
  }, [comments, files, markCopied, reviewCommentsPrefix, showWhitespace]);

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

const getPullRequestReviewActionStatus = (
  reviewStatus: PullRequestReviewStatus | undefined,
  event: PullRequestReviewEvent,
) =>
  event === 'APPROVE'
    ? reviewStatus?.approve
    : event === 'COMMENT'
      ? reviewStatus?.comment
      : reviewStatus?.requestChanges;

export const isPullRequestReviewActionDisabled = (
  reviewStatus: PullRequestReviewStatus | undefined,
  event: PullRequestReviewEvent,
) => getPullRequestReviewActionStatus(reviewStatus, event)?.disabled === true;

const getPullRequestReviewActionTitle = (
  reviewStatus: PullRequestReviewStatus | undefined,
  event: PullRequestReviewEvent,
  fallback: string,
) => getPullRequestReviewActionStatus(reviewStatus, event)?.reason ?? fallback;

export function PullRequestReviewAction({
  disabled,
  event,
  hasPendingComments = false,
  icon,
  label,
  onSubmitReview,
  title,
}: {
  disabled: boolean;
  event: PullRequestReviewEvent;
  hasPendingComments?: boolean;
  icon: ReactNode;
  label: string;
  onSubmitReview: (event: PullRequestReviewEvent, body?: string) => Promise<void> | void;
  title: string;
}) {
  const [body, setBody] = useState('');
  const [open, setOpen] = useState(false);
  const [previousDisabled, setPreviousDisabled] = useState(disabled);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const trimmedBody = body.trim();
  const isApprove = event === 'APPROVE';
  const isComment = event === 'COMMENT';
  const variant = isApprove ? 'approve' : isComment ? 'comment' : 'request-changes';
  const actionLabel = isApprove
    ? 'Approve review'
    : isComment
      ? 'Submit review comments'
      : 'Request changes';
  const commentLabel = isApprove
    ? 'Add approval comment'
    : isComment
      ? 'Add review comment'
      : 'Add request changes comment';
  const placeholder = isApprove
    ? 'Add an approval comment…'
    : isComment
      ? 'Add a review comment…'
      : 'Add a change request comment…';
  const primaryDisabled = disabled || (isComment && !hasPendingComments);

  useEffect(() => {
    if (!open) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      editorRef.current?.focus({ defaultSelection: 'rootEnd', preventScroll: true });
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      // oxlint-disable-next-line @nkzw/no-instanceof
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open]);

  if (disabled !== previousDisabled) {
    setPreviousDisabled(disabled);
    if (disabled) {
      setOpen(false);
    }
  }

  const submitWithComment = useCallback(() => {
    if (disabled || !trimmedBody) {
      return;
    }
    void Promise.resolve(onSubmitReview(event, trimmedBody))
      .then(() => {
        setBody('');
        setOpen(false);
      })
      .catch(() => {});
  }, [disabled, event, onSubmitReview, trimmedBody]);

  const submitWithoutComment = useCallback(() => {
    if (primaryDisabled) {
      return;
    }
    setOpen(false);
    void Promise.resolve(onSubmitReview(event)).catch(() => {});
  }, [event, onSubmitReview, primaryDisabled]);

  const handleEditorKeyDown = useCallback(
    (keyboardEvent: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        keyboardEvent.key !== 'Enter' ||
        (!keyboardEvent.metaKey && !keyboardEvent.ctrlKey) ||
        !trimmedBody
      ) {
        return;
      }
      keyboardEvent.preventDefault();
      keyboardEvent.stopPropagation();
      submitWithComment();
    },
    [submitWithComment, trimmedBody],
  );

  return (
    <div className="review-submit-action" ref={rootRef}>
      <div
        className={`codiff-open-button review-submit-button ${variant}`}
        data-disabled={disabled || undefined}
      >
        <button
          aria-label={actionLabel}
          className="review-submit-primary"
          disabled={primaryDisabled}
          onClick={submitWithoutComment}
          title={
            isComment && !hasPendingComments
              ? 'Add an inline comment or write a review comment from the menu'
              : title
          }
          type="button"
        >
          {icon}
          <span>{label}</span>
        </button>
        <span aria-hidden className="review-submit-divider">
          |
        </span>
        <button
          aria-controls={popoverId}
          aria-expanded={open}
          aria-label={commentLabel}
          className="review-submit-toggle"
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          title={commentLabel}
          type="button"
        >
          <CaretDown
            aria-hidden
            className={`review-submit-chevron${open ? ' expanded' : ''}`}
            size={13}
            weight="bold"
          />
        </button>
      </div>
      {open ? (
        <div
          aria-label={`${label} with comment`}
          className="review-submit-popover"
          id={popoverId}
          role="group"
        >
          <MarkdownEditor
            ariaLabel={commentLabel}
            className="review-comment-markdown-editor review-submit-popover-editor"
            colorScheme="inherit"
            contentClassName="review-comment-input general-comment-input"
            density="compact"
            onChange={setBody}
            onKeyDown={handleEditorKeyDown}
            placeholder={placeholder}
            readOnly={disabled}
            ref={editorRef}
            spellCheck
            value={body}
            variant="embedded"
          />
          <div className="review-submit-popover-footer">
            <button
              className={`codiff-open-button review-submit-popover-submit ${variant}`}
              disabled={disabled || !trimmedBody}
              onClick={submitWithComment}
              type="button"
            >
              {icon}
              <span>{label}</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PullRequestReviewButtons({
  children,
  disabled,
  hasPendingComments,
  onClosePullRequest,
  onSubmitReview,
  reviewStatus,
  showCommentReview = false,
}: {
  children?: ReactNode;
  disabled: boolean;
  hasPendingComments: boolean;
  onClosePullRequest?: () => void;
  onSubmitReview: (event: PullRequestReviewEvent, body?: string) => Promise<void> | void;
  reviewStatus?: PullRequestReviewStatus;
  showCommentReview?: boolean;
}) {
  const approveBlocked = isPullRequestReviewActionDisabled(reviewStatus, 'APPROVE');
  const commentBlocked = isPullRequestReviewActionDisabled(reviewStatus, 'COMMENT');
  const requestChangesBlocked = isPullRequestReviewActionDisabled(reviewStatus, 'REQUEST_CHANGES');
  const closeStatus = reviewStatus?.close;
  const closeVisible = onClosePullRequest && closeStatus && closeStatus.disabled !== true;
  const commentVisible = showCommentReview && !commentBlocked;
  const hasReviewActions =
    commentVisible || !approveBlocked || !requestChangesBlocked || closeVisible;
  if (!hasReviewActions && !children) {
    return null;
  }

  return (
    <div
      aria-label={hasReviewActions ? 'Pull request review actions' : 'Pull request status'}
      className="source-description-review-actions"
    >
      {children}
      {commentVisible ? (
        <PullRequestReviewAction
          disabled={disabled}
          event="COMMENT"
          hasPendingComments={hasPendingComments}
          icon={
            <ChatCircle
              aria-hidden
              className="review-submit-icon comment"
              size={15}
              weight="bold"
            />
          }
          label="Comment"
          onSubmitReview={onSubmitReview}
          title={getPullRequestReviewActionTitle(reviewStatus, 'COMMENT', 'Submit review comments')}
        />
      ) : null}
      {!approveBlocked ? (
        <PullRequestReviewAction
          disabled={disabled}
          event="APPROVE"
          icon={
            <Check aria-hidden className="review-submit-icon approve" size={15} weight="bold" />
          }
          label="Approve"
          onSubmitReview={onSubmitReview}
          title={getPullRequestReviewActionTitle(reviewStatus, 'APPROVE', 'Approve review')}
        />
      ) : null}
      {!requestChangesBlocked ? (
        <PullRequestReviewAction
          disabled={disabled}
          event="REQUEST_CHANGES"
          icon={
            <SealQuestion
              aria-hidden
              className="review-submit-icon request-changes"
              size={15}
              weight="bold"
            />
          }
          label="Request Changes"
          onSubmitReview={onSubmitReview}
          title={getPullRequestReviewActionTitle(
            reviewStatus,
            'REQUEST_CHANGES',
            'Request changes',
          )}
        />
      ) : null}
      {closeVisible ? (
        <button
          aria-label="Close merge request"
          className="codiff-open-button review-submit-button close"
          disabled={disabled}
          onClick={onClosePullRequest}
          title={closeStatus.reason ?? 'Close merge request'}
          type="button"
        >
          <Power aria-hidden className="review-submit-icon close" size={15} weight="bold" />
          <span>Close</span>
        </button>
      ) : null}
    </div>
  );
}

export const isTerminalPullRequestMergeState = (mergeState: PullRequestMergeState) =>
  mergeState.status === 'closed' || mergeState.status === 'merged';

export function PullRequestMergeStatusBadge({ mergeState }: { mergeState: PullRequestMergeState }) {
  if (!isTerminalPullRequestMergeState(mergeState)) {
    return null;
  }

  return (
    <span
      className="codiff-status-badge pull-request-merge-status-badge"
      data-status={mergeState.status}
      title={mergeState.reason ?? mergeState.statusLabel}
    >
      {mergeState.status === 'merged' ? (
        <CheckCircle aria-hidden size={14} weight="fill" />
      ) : (
        <X aria-hidden size={14} weight="bold" />
      )}
      <span>{mergeState.statusLabel}</span>
    </span>
  );
}

const mergeCheckTitle = (check: PullRequestMergeState['checks'][number]) =>
  [check.label, check.detail].filter(Boolean).join(': ');

const MergeRequirementIcon = ({
  status,
}: {
  status: PullRequestMergeState['checks'][number]['status'];
}) =>
  status === 'success' ? (
    <CheckCircle
      aria-hidden
      className="pull-request-merge-requirement-icon success"
      size={16}
      weight="fill"
    />
  ) : (
    <WarningOctagon
      aria-hidden
      className="pull-request-merge-requirement-icon failed"
      size={16}
      weight="fill"
    />
  );

const getMergePrimaryLabel = (mergeState: PullRequestMergeState) => {
  if (mergeState.canMerge) {
    return 'Merge';
  }
  if (mergeState.canSetAutoMerge) {
    return 'Auto-Merge';
  }
  return 'Cannot Merge';
};

export function PullRequestMergeControls({
  disabled,
  isPending = false,
  mergeState,
  onCancelAutoMerge,
  onMergePullRequest,
}: {
  disabled: boolean;
  isPending?: boolean;
  mergeState: PullRequestMergeState;
  onCancelAutoMerge?: () => Promise<void> | void;
  onMergePullRequest?: (
    options: PullRequestMergeOptions & { autoMerge: boolean },
  ) => Promise<void> | void;
}) {
  const optionsKey = `${mergeState.sha}:${String(mergeState.options.removeSourceBranch)}:${String(mergeState.options.squash)}`;
  const defaultOptions = {
    key: optionsKey,
    removeSourceBranch: mergeState.options.removeSourceBranch,
    squash: mergeState.options.squash,
  };
  const [selectedOptions, setSelectedOptions] = useState(defaultOptions);
  const currentOptions = selectedOptions.key === optionsKey ? selectedOptions : defaultOptions;
  const { removeSourceBranch, squash } = currentOptions;

  const primaryActionDisabled =
    disabled || !onMergePullRequest || (!mergeState.canMerge && !mergeState.canSetAutoMerge);
  const cancelDisabled = disabled || !onCancelAutoMerge || !mergeState.canCancelAutoMerge;
  const primaryLabel = getMergePrimaryLabel(mergeState);
  const primaryTitle =
    mergeState.reason ??
    (mergeState.canMerge
      ? 'Merge this merge request'
      : mergeState.canSetAutoMerge
        ? 'Merge this merge request when GitLab checks pass'
        : primaryLabel);
  const submitMerge = () => {
    if (primaryActionDisabled || !onMergePullRequest) {
      return;
    }
    void Promise.resolve(
      onMergePullRequest({
        autoMerge: !mergeState.canMerge && mergeState.canSetAutoMerge,
        removeSourceBranch,
        squash,
      }),
    );
  };
  const cancelAutoMerge = () => {
    if (cancelDisabled || !onCancelAutoMerge) {
      return;
    }
    void Promise.resolve(onCancelAutoMerge());
  };
  const pendingLabel = <em>Thinking…</em>;
  if (isTerminalPullRequestMergeState(mergeState)) {
    return null;
  }

  return (
    <section
      aria-label="Merge status"
      className="review-comment-body source-description-body pull-request-merge-panel"
      data-status={mergeState.status}
    >
      <div className="review-comment-header read-only pull-request-merge-summary">
        <strong>{mergeState.statusLabel}</strong>
      </div>
      <div className="pull-request-merge-content">
        <div className="pull-request-merge-state">
          <div className="pull-request-merge-requirements">
            {mergeState.checks.map((check) => {
              const content = (
                <span className="pull-request-merge-requirement-content">
                  <MergeRequirementIcon status={check.status} />
                  <span className="pull-request-merge-requirement-text">{check.label}</span>
                </span>
              );
              return (
                <span
                  className="pull-request-merge-requirement"
                  data-status={check.status}
                  key={`${check.label}:${check.status}`}
                  title={mergeCheckTitle(check)}
                >
                  {check.url ? (
                    <a href={check.url} rel="noreferrer" target="_blank">
                      {content}
                    </a>
                  ) : (
                    content
                  )}
                </span>
              );
            })}
          </div>
        </div>
        <div className="pull-request-merge-controls">
          <div className="pull-request-merge-options">
            <label className="pull-request-merge-option">
              <input
                checked={squash}
                className="pull-request-merge-input"
                disabled={disabled}
                onChange={(event) =>
                  setSelectedOptions({
                    ...currentOptions,
                    squash: event.currentTarget.checked,
                  })
                }
                type="checkbox"
              />
              <span aria-hidden className="codiff-viewed-checkbox">
                {squash ? <Check className="codiff-viewed-check" size={11} weight="bold" /> : null}
              </span>
              <span>Squash commits</span>
            </label>
            <label className="pull-request-merge-option">
              <input
                checked={removeSourceBranch}
                className="pull-request-merge-input"
                disabled={disabled || mergeState.forceRemoveSourceBranch}
                onChange={(event) =>
                  setSelectedOptions({
                    ...currentOptions,
                    removeSourceBranch: event.currentTarget.checked,
                  })
                }
                type="checkbox"
              />
              <span aria-hidden className="codiff-viewed-checkbox">
                {removeSourceBranch ? (
                  <Check className="codiff-viewed-check" size={11} weight="bold" />
                ) : null}
              </span>
              <span>Delete source branch</span>
            </label>
          </div>
          <div className="pull-request-merge-actions">
            {mergeState.autoMergeEnabled ? (
              <button
                className="codiff-open-button pull-request-merge-button cancel"
                disabled={cancelDisabled}
                onClick={cancelAutoMerge}
                title={
                  mergeState.canCancelAutoMerge ? 'Cancel GitLab auto-merge' : mergeState.reason
                }
                type="button"
              >
                {isPending ? pendingLabel : 'Cancel Auto-Merge'}
              </button>
            ) : (
              <button
                className="codiff-open-button pull-request-merge-button primary"
                disabled={primaryActionDisabled}
                onClick={submitMerge}
                title={primaryTitle}
                type="button"
              >
                {isPending ? pendingLabel : primaryLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
