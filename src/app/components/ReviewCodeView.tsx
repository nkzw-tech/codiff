import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown';
import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import { ColumnsIcon as Columns } from '@phosphor-icons/react/Columns';
import { ImageBrokenIcon as ImageBroken } from '@phosphor-icons/react/ImageBroken';
import { SquareSplitVerticalIcon as SquareSplitVertical } from '@phosphor-icons/react/SquareSplitVertical';
import { XIcon as X } from '@phosphor-icons/react/X';
import {
  type CodeViewLineSelection,
  type CodeViewItem,
  type CodeViewOptions,
  type DiffLineAnnotation,
  type LineAnnotation,
} from '@pierre/diffs';
import { CodeView, type CodeViewHandle, WorkerPoolContextProvider } from '@pierre/diffs/react';
import { Copy as LucideCopy } from 'lucide-react';
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from 'react';
import codexIconUrl from '../../assets/codex.svg';
import { matchesShortcut } from '../../config/keymap.ts';
import type { CodiffDiffStyle, CodiffKeymap } from '../../config/types.ts';
import type {
  CodeViewInstance,
  CodeViewItemMetadata,
  DiffSearchMatch,
  ReviewAnnotationMetadata,
  ReviewComment,
  ReviewCommentAnnotationMetadata,
  ReviewScrollBehavior,
  ReviewScrollTarget,
  WalkthroughNote,
} from '../../lib/app-types.ts';
import {
  codeViewItemMetrics,
  codeViewLayout,
  codeViewUnsafeCSS,
  DEFAULT_PADDING,
  diffCollapsedContextThreshold,
  diffContextExpansionLineCount,
  maxWorkerThreads,
  sectionLabel,
  statusLabel,
  workerHighlighterOptions,
} from '../../lib/code-view-options.ts';
import {
  canRenderImagePreview,
  getDiffLineCountFromVisibleSections,
  getItemId,
  getMarkdownPreviewContents,
  getVisibleDiffSections,
  shouldLoadDiffSectionContents,
} from '../../lib/diff.ts';
import { getItemVersion } from '../../lib/item-version.ts';
import { renderMarkdown } from '../../lib/markdown.tsx';
import {
  getCommentKey,
  getReviewCommentLineLabel,
  getReviewCommentsDigest,
  isInteractiveReviewEvent,
  shouldDiscardReviewCommentOnEscape,
  updateStickyHeaderState,
} from '../../lib/review-comments.ts';
import { applySearchHighlights } from '../../lib/search-highlights.ts';
import type {
  ChangedFile,
  CommitMetadata,
  DiffImageContentResult,
  DiffSection,
  GitIdentity,
  PullRequestExistingReviewComment,
  ReviewSource,
} from '../../types.ts';
import { CommitDetailsPanel, type CommitDetailsFile } from './CommitDetails.tsx';
import { Gravatar } from './Gravatar.tsx';
import { DiffLineCountBadge } from './Sidebar.tsx';
import { useCopiedState } from './useCopiedState.ts';

function CopyFilePathButton({ path }: { path: string }) {
  const [copied, markCopied] = useCopiedState(1600);

  const handleClick = useCallback(
    async (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(path);
      } catch {
        return;
      }
      markCopied();
    },
    [markCopied, path],
  );

  return (
    <button
      aria-label={copied ? 'Path copied' : 'Copy file path'}
      className={`codiff-copy-path-button${copied ? ' copied' : ''}`}
      onClick={(event) => void handleClick(event)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation();
        }
      }}
      title={copied ? 'Path copied' : 'Copy file path'}
      type="button"
    >
      {copied ? (
        <Check aria-hidden className="codiff-copy-path-icon check" size={16} weight="bold" />
      ) : (
        <LucideCopy aria-hidden className="codiff-copy-path-icon" size={16} strokeWidth={2.25} />
      )}
    </button>
  );
}

function CodeViewHeader({
  isSectionLoading,
  meta,
  onLoadSection,
  onOpenFile,
  onToggleCollapsed,
  onToggleMarkdownPreview,
  onToggleViewed,
}: {
  isSectionLoading: boolean;
  meta: CodeViewItemMetadata;
  onLoadSection: (file: ChangedFile, section: DiffSection) => void;
  onOpenFile: (file: ChangedFile) => void;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean) => void;
  onToggleMarkdownPreview: (section: DiffSection) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean) => void;
}) {
  const {
    canRenderMarkdown,
    file,
    isCollapsed,
    isMarkdownPreview,
    isSelected,
    isViewed,
    lineCount,
    section,
    sectionCount,
    walkthroughNote,
  } = meta;
  const canOpenFile = file.status !== 'deleted';
  const canLoadSection = section.loadState === 'deferred' && shouldLoadDiffSectionContents(section);

  return (
    <div
      className={`codiff-file-header${walkthroughNote ? ' with-note' : ''}${
        isCollapsed ? ' collapsed' : ''
      }${isSelected ? ' selected' : ''}${isViewed ? ' viewed' : ''}`}
    >
      <div
        aria-expanded={!isCollapsed}
        aria-label={isCollapsed ? 'Expand file' : 'Collapse file'}
        className="codiff-header-toggle"
        onClick={() => onToggleCollapsed(file, isCollapsed)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggleCollapsed(file, isCollapsed);
          }
        }}
        role="button"
        tabIndex={0}
        title={isCollapsed ? 'Expand' : 'Collapse'}
      >
        <span className="codiff-chevron-box">
          <CaretDown
            aria-hidden
            className={isCollapsed ? 'codiff-chevron collapsed' : 'codiff-chevron'}
            size={16}
            weight="bold"
          />
        </span>
        <span className="codiff-file-heading">
          <span className="codiff-file-path-row">
            <span className="codiff-file-path">{file.path}</span>
            <CopyFilePathButton path={file.path} />
          </span>
          {file.oldPath ? <span className="codiff-file-old-path">{file.oldPath}</span> : null}
          {walkthroughNote ? (
            <span className="codiff-file-note">{walkthroughNote.reason}</span>
          ) : null}
        </span>
        {sectionCount > 1 ? (
          <span className={`codiff-section-badge ${section.kind}`}>
            {sectionLabel[section.kind]}
          </span>
        ) : null}
      </div>
      <DiffLineCountBadge lineCount={lineCount} />
      <div className={`codiff-status-badge ${file.status}`}>{statusLabel[file.status]}</div>
      {canRenderMarkdown ? (
        <button
          aria-pressed={isMarkdownPreview}
          className={`codiff-markdown-button${isMarkdownPreview ? ' active' : ''}`}
          onClick={() => onToggleMarkdownPreview(section)}
          title={isMarkdownPreview ? 'View as Diff' : 'View as Markdown'}
          type="button"
        >
          {isMarkdownPreview ? 'View as Diff' : 'View as Markdown'}
        </button>
      ) : null}
      {canLoadSection ? (
        <button
          className="codiff-load-button"
          disabled={isSectionLoading}
          onClick={() => onLoadSection(file, section)}
          title={isSectionLoading ? 'Loading file contents' : 'Load file contents'}
          type="button"
        >
          {isSectionLoading ? 'Loading...' : 'Load'}
        </button>
      ) : null}
      <button
        className="codiff-open-button"
        disabled={!canOpenFile}
        onClick={() => onOpenFile(file)}
        title={canOpenFile ? 'Open file in editor' : 'Deleted files cannot be opened'}
        type="button"
      >
        Open
      </button>
      <button
        aria-pressed={isViewed}
        className={`codiff-viewed-button${isViewed ? ' active' : ''}`}
        onClick={() => onToggleViewed(file, isViewed)}
        type="button"
      >
        <span aria-hidden className="codiff-viewed-checkbox">
          {isViewed ? <Check className="codiff-viewed-check" size={10} weight="bold" /> : null}
        </span>
        Viewed
      </button>
    </div>
  );
}

function ReviewAvatar({
  author,
  identity,
}: {
  author?: PullRequestExistingReviewComment['author'];
  identity: GitIdentity | null;
}) {
  const label = author?.login || identity?.name || identity?.email || 'Git user';
  const avatarUrl = author?.avatarUrl || identity?.gravatarUrl;

  return <Gravatar fallback={label} size="medium" url={avatarUrl} />;
}

function CodexAvatar() {
  return (
    <img alt="" className="review-comment-avatar-codex" draggable={false} src={codexIconUrl} />
  );
}

const canAskCodexForComment = (comment: ReviewComment) =>
  !comment.isReadOnly && comment.body.trim().length > 0 && comment.codexReply?.status !== 'loading';

const canSubmitCommentToGitHub = (comment: ReviewComment) =>
  !comment.isReadOnly &&
  comment.body.trim().length > 0 &&
  comment.githubSubmit?.status !== 'submitting';

const getAddedLinesDigest = (lines: ReadonlySet<number>) =>
  lines.size > 0 ? [...lines].join(',') : '';

const formatBytes = (size: number) => {
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ['KiB', 'MiB', 'GiB'];
  let value = size / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units.at(-1)) {
      return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    }
    value /= 1024;
  }

  return `${size} B`;
};

function MarkdownPreview({
  addedLines,
  contents,
  layoutKey,
  onLayoutReady,
  sectionId,
}: {
  addedLines: ReadonlySet<number>;
  contents: string;
  layoutKey: string;
  onLayoutReady: (sectionId: string) => void;
  sectionId: string;
}) {
  useLayoutEffect(() => {
    onLayoutReady(sectionId);
  }, [layoutKey, onLayoutReady, sectionId]);

  return (
    <div className="codiff-markdown-preview">
      {renderMarkdown(contents, { addedLines, highlightCode: true })}
    </div>
  );
}

type ImagePreviewMode = 'side-by-side' | 'slider';

function ImageDiffPreview({
  file,
  onLayoutReady,
  section,
  source,
}: {
  file: ChangedFile;
  onLayoutReady: (sectionId: string) => void;
  section: DiffSection;
  source: ReviewSource;
}) {
  const loadingResult: DiffImageContentResult = {
    reason: 'Loading image...',
    status: 'unavailable',
  };
  const requestKey = `${file.fingerprint}:${section.id}:${JSON.stringify(source)}`;
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const [mode, setMode] = useState<ImagePreviewMode>('slider');
  const sliderStageRef = useRef<HTMLDivElement>(null);
  const [loadState, setLoadState] = useState<{
    requestKey: string | null;
    result: DiffImageContentResult;
  }>({
    requestKey: null,
    result: loadingResult,
  });
  const [split, setSplit] = useState(50);
  const result = loadState.requestKey === requestKey ? loadState.result : loadingResult;

  const updateSplitFromClientX = useCallback((clientX: number) => {
    const stage = sliderStageRef.current;
    if (!stage) {
      return;
    }

    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }

    setSplit(Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)));
  }, []);

  const handleDividerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      updateSplitFromClientX(event.clientX);
    },
    [updateSplitFromClientX],
  );

  const handleDividerPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        updateSplitFromClientX(event.clientX);
      }
    },
    [updateSplitFromClientX],
  );

  const handleDividerPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleDividerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      setSplit((current) => Math.max(0, current - (event.shiftKey ? 10 : 2)));
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      setSplit((current) => Math.min(100, current + (event.shiftKey ? 10 : 2)));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSplit(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setSplit(100);
    }
  }, []);

  useEffect(() => {
    let canceled = false;
    const activeRequestKey = requestKey;

    window.codiff
      .getDiffImageContent({
        kind: section.kind,
        path: file.path,
        source,
      })
      .then((nextResult) => {
        if (!canceled) {
          setLoadState({
            requestKey: activeRequestKey,
            result: nextResult,
          });
        }
      })
      .catch(() => {
        if (!canceled) {
          setLoadState({
            requestKey: activeRequestKey,
            result: {
              reason: 'Codiff could not load this image.',
              status: 'unavailable',
            },
          });
        }
      });

    return () => {
      canceled = true;
    };
  }, [file.path, requestKey, section.kind, source]);

  useEffect(() => {
    onLayoutReady(section.id);
  }, [mode, onLayoutReady, result.status, section.id]);

  const handleImageLoad = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      const { naturalHeight, naturalWidth } = event.currentTarget;
      if (naturalHeight > 0 && naturalWidth > 0) {
        setAspectRatio(naturalWidth / naturalHeight);
      }
      onLayoutReady(section.id);
    },
    [onLayoutReady, section.id],
  );

  if (result.status === 'unavailable') {
    return (
      <div className="codiff-image-preview codiff-image-preview-message">
        <ImageBroken aria-hidden size={22} weight="duotone" />
        <span>{result.reason}</span>
      </div>
    );
  }

  const { newImage, oldImage } = result;
  const canCompare = Boolean(oldImage && newImage);
  const effectiveMode = canCompare ? mode : 'side-by-side';
  const stageStyle =
    effectiveMode === 'slider'
      ? ({
          '--codiff-image-split': `${split}%`,
          ...(aspectRatio ? { aspectRatio } : {}),
        } as CSSProperties)
      : undefined;

  return (
    <div className="codiff-image-preview">
      <div className="codiff-image-preview-toolbar">
        <span className="codiff-image-preview-title">Image</span>
        {canCompare ? (
          <div className="codiff-image-preview-mode" role="group">
            <button
              aria-label="Slider image comparison"
              aria-pressed={effectiveMode === 'slider'}
              className={effectiveMode === 'slider' ? 'active' : ''}
              onClick={() => setMode('slider')}
              title="Slider"
              type="button"
            >
              <SquareSplitVertical aria-hidden size={16} weight="bold" />
            </button>
            <button
              aria-label="Side-by-side image view"
              aria-pressed={effectiveMode === 'side-by-side'}
              className={effectiveMode === 'side-by-side' ? 'active' : ''}
              onClick={() => setMode('side-by-side')}
              title="Side-by-side"
              type="button"
            >
              <Columns aria-hidden size={16} weight="bold" />
            </button>
          </div>
        ) : null}
      </div>
      {effectiveMode === 'slider' && oldImage && newImage ? (
        <div className="codiff-image-slider">
          <div className="codiff-image-slider-stage" ref={sliderStageRef} style={stageStyle}>
            <img
              alt={`Old ${file.path}`}
              draggable={false}
              onLoad={handleImageLoad}
              src={oldImage.dataUrl}
            />
            <img
              alt={`New ${file.path}`}
              className="codiff-image-slider-new"
              draggable={false}
              onLoad={handleImageLoad}
              src={newImage.dataUrl}
            />
            <div
              aria-label="Image comparison split"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={Math.round(split)}
              className="codiff-image-slider-divider"
              onKeyDown={handleDividerKeyDown}
              onPointerCancel={handleDividerPointerUp}
              onPointerDown={handleDividerPointerDown}
              onPointerMove={handleDividerPointerMove}
              onPointerUp={handleDividerPointerUp}
              role="slider"
              tabIndex={0}
            />
          </div>
        </div>
      ) : (
        <div className="codiff-image-grid">
          {oldImage ? (
            <figure>
              <div className="codiff-image-frame">
                <img
                  alt={`Old ${file.path}`}
                  draggable={false}
                  onLoad={handleImageLoad}
                  src={oldImage.dataUrl}
                />
              </div>
              <figcaption>
                <span>Old</span>
                <span>{formatBytes(oldImage.size)}</span>
              </figcaption>
            </figure>
          ) : null}
          {newImage ? (
            <figure>
              <div className="codiff-image-frame">
                <img
                  alt={`New ${file.path}`}
                  draggable={false}
                  onLoad={handleImageLoad}
                  src={newImage.dataUrl}
                />
              </div>
              <figcaption>
                <span>New</span>
                <span>{formatBytes(newImage.size)}</span>
              </figcaption>
            </figure>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ReviewAnnotation({
  annotation,
  comments,
  focusCommentId,
  focusCommentRequest,
  identity,
  isPullRequest,
  keymap,
  onAskCodex,
  onCommentBlur,
  onCommentFocus,
  onDeleteComment,
  onSubmitComment,
  onUpdateComment,
}: {
  annotation: DiffLineAnnotation<ReviewCommentAnnotationMetadata>;
  comments: ReadonlyArray<ReviewComment>;
  focusCommentId: string | null;
  focusCommentRequest: number;
  identity: GitIdentity | null;
  isPullRequest: boolean;
  keymap: CodiffKeymap;
  onAskCodex: (commentId: string) => void;
  onCommentBlur: (comment: ReviewComment, body: string) => void;
  onCommentFocus: (comment: ReviewComment) => void;
  onDeleteComment: (commentId: string) => void;
  onSubmitComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, body: string) => void;
}) {
  const focusTextareaRef = useRef<HTMLTextAreaElement>(null);
  const annotationComments = annotation.metadata.commentIds
    .map((commentId) => comments.find((comment) => comment.id === commentId))
    .filter((comment): comment is ReviewComment => comment != null);
  const hasFocusedComment =
    focusCommentId != null && annotationComments.some((comment) => comment.id === focusCommentId);

  useEffect(() => {
    if (hasFocusedComment) {
      focusTextareaRef.current?.focus();
    }
  }, [focusCommentId, focusCommentRequest, hasFocusedComment]);

  const handleCommentKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>, comment: ReviewComment) => {
      if (matchesShortcut(event, keymap, 'submitComment')) {
        if (isPullRequest && canSubmitCommentToGitHub(comment)) {
          event.preventDefault();
          event.stopPropagation();
          onSubmitComment(comment.id);
          return;
        }

        if (!isPullRequest && canAskCodexForComment(comment)) {
          event.preventDefault();
          event.stopPropagation();
          onAskCodex(comment.id);
        }
        return;
      }

      if (!matchesShortcut(event, keymap, 'discardComment')) {
        return;
      }

      if (comment.isReadOnly) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (shouldDiscardReviewCommentOnEscape(comment.body)) {
        onDeleteComment(comment.id);
      }
    },
    [isPullRequest, keymap, onAskCodex, onDeleteComment, onSubmitComment],
  );

  if (annotationComments.length === 0) {
    return null;
  }

  return (
    <div className="review-comment-thread">
      {annotationComments.map((comment) => {
        const canAskCodex = canAskCodexForComment(comment);
        const canSubmitComment = canSubmitCommentToGitHub(comment);
        const displayName =
          comment.author?.login || identity?.name || identity?.email || 'Git user';

        return (
          <Fragment key={comment.id}>
            <div className="review-comment">
              <ReviewAvatar author={comment.author} identity={identity} />
              <div className="review-comment-body">
                <div
                  className={`review-comment-header${
                    isPullRequest && !comment.isReadOnly ? ' with-comment-action' : ''
                  }${comment.isReadOnly ? ' read-only' : ''}`}
                >
                  <strong>{displayName}</strong>
                  <span>{getReviewCommentLineLabel(comment)}</span>
                  {!comment.isReadOnly ? (
                    <button
                      className="review-comment-action"
                      disabled={!canAskCodex}
                      onClick={() => onAskCodex(comment.id)}
                      title={canAskCodex ? 'Ask Codex' : 'Write a note before asking Codex'}
                      type="button"
                    >
                      Ask
                    </button>
                  ) : null}
                  {isPullRequest && !comment.isReadOnly ? (
                    <button
                      className="review-comment-action"
                      disabled={!canSubmitComment}
                      onClick={() => onSubmitComment(comment.id)}
                      title={
                        canSubmitComment
                          ? 'Submit comment to GitHub'
                          : 'Write a note before commenting'
                      }
                      type="button"
                    >
                      {comment.githubSubmit?.status === 'submitting' ? 'Sending' : 'Comment'}
                    </button>
                  ) : null}
                  {!comment.isReadOnly ? (
                    <button
                      aria-label="Delete comment"
                      className="review-comment-delete"
                      onClick={() => onDeleteComment(comment.id)}
                      title="Delete comment"
                      type="button"
                    >
                      <X
                        aria-hidden
                        className="review-comment-delete-icon"
                        size={14}
                        weight="bold"
                      />
                    </button>
                  ) : null}
                </div>
                <textarea
                  aria-label={`Comment on ${comment.filePath} ${getReviewCommentLineLabel(comment)}`}
                  className={`review-comment-input${comment.isReadOnly ? ' read-only' : ''}`}
                  onBlur={(event) => onCommentBlur(comment, event.currentTarget.value)}
                  onChange={(event) => onUpdateComment(comment.id, event.currentTarget.value)}
                  onFocus={() => onCommentFocus(comment)}
                  onKeyDown={(event) => handleCommentKeyDown(event, comment)}
                  placeholder="Write a review comment…"
                  readOnly={comment.isReadOnly}
                  ref={comment.id === focusCommentId ? focusTextareaRef : undefined}
                  rows={3}
                  spellCheck
                  value={comment.body}
                />
                {comment.githubSubmit?.status === 'error' ? (
                  <div className="review-comment-error">{comment.githubSubmit.error}</div>
                ) : null}
              </div>
            </div>
            {comment.codexReply ? (
              <div className="review-comment codex">
                <CodexAvatar />
                <div className="review-comment-body codex">
                  <div className="review-comment-header codex">
                    <strong>Codex</strong>
                  </div>
                  <div
                    className={`review-comment-codex-reply${
                      comment.codexReply.status === 'loading' ? ' is-loading' : ''
                    }${comment.codexReply.status === 'error' ? ' error' : ''}`}
                  >
                    {comment.codexReply.status === 'loading' ? (
                      <span className="review-comment-codex-loading">Waiting for Codex…</span>
                    ) : (
                      renderMarkdown(comment.codexReply.body ?? comment.codexReply.error ?? '')
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}

const scrollTargetRetryFrameLimit = 90;
// Render commit details as a CodeView item so scrolling treats the panel like the diffs.
const commitDetailsFileName = '__codiff_commit_details__';

// Build an id from commit details that can change the panel height. When the panel first appears,
// we change only layoutPass to make CodeView measure again; this id still means "same content."
const getCommitDetailsContentKey = (metadata: CommitMetadata) =>
  [
    metadata.ref,
    metadata.refs.join('\u0000'),
    metadata.stats.files,
    metadata.stats.additions,
    metadata.stats.deletions,
    metadata.stats.renamedFiles,
    metadata.stats.binaryFiles,
  ].join('\u0001');

const getCommitDetailsVersionKey = (
  metadata: CommitMetadata,
  layoutPass: number,
  navigationKey: string,
) => [getCommitDetailsContentKey(metadata), layoutPass, navigationKey].join('\u0001');

function isScrollTargetRendered(viewer: CodeViewInstance, itemId: string) {
  return viewer.getRenderedItems().some((item) => item.id === itemId);
}

const getEffectiveScrollBehavior = (behavior: ReviewScrollBehavior) =>
  behavior === 'smooth' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? 'instant'
    : behavior;

export function ReviewCodeView({
  activeSearchMatch,
  collapsed,
  comments,
  commitMetadata,
  diffStyle,
  files,
  focusCommentId,
  focusCommentRequest,
  forceExpandedPaths,
  gitIdentity,
  isPullRequest,
  itemVersionByPath,
  keymap,
  loadingSectionIds,
  onAskCodex,
  onCreateComment,
  onDeleteComment,
  onLoadSection,
  onOpenFile,
  onSelectPathFromScroll,
  onSubmitComment,
  onToggleCollapsed,
  onToggleViewed,
  onUpdateComment,
  scrollTarget,
  searchQuery,
  selectedPath,
  showWhitespace,
  source,
  viewed,
  walkthroughNotes,
  wordWrap,
}: {
  activeSearchMatch: DiffSearchMatch | null;
  collapsed: ReadonlySet<string>;
  comments: ReadonlyArray<ReviewComment>;
  commitMetadata: CommitMetadata | null;
  diffStyle: CodiffDiffStyle;
  files: ReadonlyArray<ChangedFile>;
  focusCommentId: string | null;
  focusCommentRequest: number;
  forceExpandedPaths: ReadonlySet<string>;
  gitIdentity: GitIdentity | null;
  isPullRequest: boolean;
  itemVersionByPath: Readonly<Record<string, number>>;
  keymap: CodiffKeymap;
  loadingSectionIds: ReadonlySet<string>;
  onAskCodex: (commentId: string) => void;
  onCreateComment: (comment: Omit<ReviewComment, 'body' | 'id'>) => void;
  onDeleteComment: (commentId: string) => void;
  onLoadSection: (file: ChangedFile, section: DiffSection) => void;
  onOpenFile: (file: ChangedFile) => void;
  onSelectPathFromScroll: (viewer: CodeViewInstance) => void;
  onSubmitComment: (commentId: string) => void;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean) => void;
  onUpdateComment: (commentId: string, body: string) => void;
  scrollTarget: ReviewScrollTarget | null;
  searchQuery: string;
  selectedPath: string | null;
  showWhitespace: boolean;
  source: ReviewSource;
  viewed: Record<string, string>;
  walkthroughNotes: ReadonlyMap<string, WalkthroughNote>;
  wordWrap: boolean;
}) {
  const codeViewRef = useRef<CodeViewHandle<ReviewAnnotationMetadata>>(null);
  const deferredTimersRef = useRef<Set<number>>(new Set());
  const handledScrollRequestRef = useRef<number | null>(null);
  const measuredCommitDetailsLayoutKeyRef = useRef<string | null>(null);
  const emptyCommentDeleteTimersRef = useRef<Map<string, number>>(new Map());
  const highlightFrameRef = useRef<number | null>(null);
  const ignoreNextLineSelectionEndRef = useRef(false);
  const [markdownPreviewSections, setMarkdownPreviewSections] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Markdown previews render inside a CodeView item. Change the item version once after the
  // preview appears so CodeView measures the preview height instead of the placeholder height.
  const [markdownPreviewLayoutPassBySection, setMarkdownPreviewLayoutPassBySection] = useState<
    Readonly<Record<string, number>>
  >({});
  const [imagePreviewLayoutPassBySection, setImagePreviewLayoutPassBySection] = useState<
    Readonly<Record<string, number>>
  >({});
  const [commitDetailsLayoutPass, setCommitDetailsLayoutPass] = useState(0);
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const commitRef = source.type === 'commit' ? source.ref : null;
  const commitDetailsItemId = commitRef ? `commit-details:${commitRef}` : null;
  const stickyHeaderFrameRef = useRef<number | null>(null);
  const commentsBySection = useMemo(() => {
    const map = new Map<string, Array<ReviewComment>>();
    for (const comment of comments) {
      const list = map.get(comment.sectionId) ?? [];
      list.push(comment);
      map.set(comment.sectionId, list);
    }
    return map;
  }, [comments]);

  const markMarkdownPreviewLayoutReady = useCallback((sectionId: string) => {
    setMarkdownPreviewLayoutPassBySection((current) => ({
      ...current,
      [sectionId]: (current[sectionId] ?? 0) + 1,
    }));
  }, []);

  const markImagePreviewLayoutReady = useCallback((sectionId: string) => {
    setImagePreviewLayoutPassBySection((current) => ({
      ...current,
      [sectionId]: (current[sectionId] ?? 0) + 1,
    }));
  }, []);

  const markCommitDetailsLayoutReady = useCallback((layoutKey: string) => {
    // After the panel appears, ask CodeView to measure it once. Repeated renders of the same
    // commit details should not change the item version again.
    if (measuredCommitDetailsLayoutKeyRef.current === layoutKey) {
      return;
    }

    measuredCommitDetailsLayoutKeyRef.current = layoutKey;
    setCommitDetailsLayoutPass((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!commitDetailsItemId || !commitMetadata) {
      measuredCommitDetailsLayoutKeyRef.current = null;
    }
  }, [commitDetailsItemId, commitMetadata]);

  const { commitDetailsFiles, firstItemByPath, itemMetadata, items } = useMemo(() => {
    const nextItems: Array<CodeViewItem<ReviewAnnotationMetadata>> = [];
    const nextFirstItemByPath = new Map<string, string>();
    const nextItemMetadata = new Map<string, CodeViewItemMetadata>();

    for (const file of files) {
      const isViewed = viewed[file.path] === file.fingerprint;
      const isCollapsed = collapsed.has(file.path) && !forceExpandedPaths.has(file.path);
      const visibleSections = getVisibleDiffSections(file, showWhitespace);
      const lineCount = getDiffLineCountFromVisibleSections(visibleSections);
      const sections = isCollapsed ? visibleSections.slice(0, 1) : visibleSections;

      for (const [index, { fileDiff, section }] of sections.entries()) {
        const id = getItemId(section);
        const markdownPreview = getMarkdownPreviewContents(file, section, fileDiff);
        const canRenderImage = canRenderImagePreview(file.path, section);
        const canRenderMarkdown = markdownPreview != null;
        const isMarkdownPreview = canRenderMarkdown && markdownPreviewSections.has(section.id);
        const annotationMap = new Map<string, DiffLineAnnotation<ReviewAnnotationMetadata>>();
        for (const comment of commentsBySection.get(section.id) ?? []) {
          const key = getCommentKey(comment);
          const existing = annotationMap.get(key);
          if (existing && existing.metadata.type === 'review-comment') {
            annotationMap.set(key, {
              ...existing,
              metadata: {
                commentIds: [...existing.metadata.commentIds, comment.id],
                type: 'review-comment',
              },
            });
          } else {
            annotationMap.set(key, {
              lineNumber: comment.lineNumber,
              metadata: {
                commentIds: [comment.id],
                type: 'review-comment',
              },
              side: comment.side,
            });
          }
        }

        nextItemMetadata.set(id, {
          canRenderMarkdown,
          file,
          isCollapsed,
          isMarkdownPreview,
          isSelected: selectedPath === file.path,
          isViewed,
          lineCount,
          section,
          sectionCount: file.sections.length,
          walkthroughNote: walkthroughNotes.get(file.path),
        });
        nextFirstItemByPath.set(file.path, nextFirstItemByPath.get(file.path) ?? id);
        if (canRenderImage) {
          nextItems.push({
            annotations: [
              {
                lineNumber: 1,
                metadata: {
                  path: file.path,
                  sectionId: section.id,
                  type: 'image-preview',
                },
              } satisfies LineAnnotation<ReviewAnnotationMetadata>,
            ],
            collapsed: isCollapsed,
            file: {
              cacheKey: `image-preview:${file.fingerprint}:${section.id}`,
              contents: ' ',
              lang: 'text',
              name: file.path,
            },
            id,
            type: 'file',
            version: getItemVersion(
              `${itemVersionByPath[file.path] ?? 0}:${file.fingerprint}:${section.id}:image:${
                isCollapsed ? 'collapsed' : 'open'
              }:${isViewed ? 'viewed' : 'pending'}:${index}:${
                selectedPath === file.path ? 'selected' : 'idle'
              }:${walkthroughNotes.get(file.path)?.reason ?? ''}:${
                imagePreviewLayoutPassBySection[section.id] ?? 0
              }`,
            ),
          });
          continue;
        }
        if (isMarkdownPreview) {
          const markdownPreviewAddedLinesDigest = getAddedLinesDigest(markdownPreview.addedLines);
          const markdownPreviewLayoutKey = `${section.id}:${markdownPreview.contents.length}:${markdownPreviewAddedLinesDigest}`;
          nextItems.push({
            annotations: [
              {
                lineNumber: 1,
                metadata: {
                  addedLines: markdownPreview.addedLines,
                  contents: markdownPreview.contents,
                  layoutKey: markdownPreviewLayoutKey,
                  path: file.path,
                  sectionId: section.id,
                  type: 'markdown-preview',
                },
              } satisfies LineAnnotation<ReviewAnnotationMetadata>,
            ],
            collapsed: isCollapsed,
            file: {
              cacheKey: `markdown-preview:${section.newFile?.cacheKey ?? file.fingerprint}:${
                markdownPreview.contents.length
              }:${markdownPreviewAddedLinesDigest}`,
              contents: ' ',
              lang: 'text',
              name: file.path,
            },
            id,
            type: 'file',
            version: getItemVersion(
              `${itemVersionByPath[file.path] ?? 0}:${file.fingerprint}:${section.id}:markdown:${
                isCollapsed ? 'collapsed' : 'open'
              }:${isViewed ? 'viewed' : 'pending'}:${index}:${
                selectedPath === file.path ? 'selected' : 'idle'
              }:${walkthroughNotes.get(file.path)?.reason ?? ''}:${markdownPreviewLayoutKey}:${
                markdownPreviewLayoutPassBySection[section.id] ?? 0
              }`,
            ),
          });
          continue;
        }
        nextItems.push({
          annotations: [...annotationMap.values()],
          collapsed: isCollapsed,
          fileDiff,
          id,
          type: 'diff',
          version: getItemVersion(
            `${itemVersionByPath[file.path] ?? 0}:${file.fingerprint}:${section.id}:${
              isCollapsed ? 'collapsed' : 'open'
            }:${isViewed ? 'viewed' : 'pending'}:${index}:${
              selectedPath === file.path ? 'selected' : 'idle'
            }:${walkthroughNotes.get(file.path)?.reason ?? ''}:${
              showWhitespace ? 'ws' : 'ignore-ws'
            }:${diffStyle}:${getReviewCommentsDigest(commentsBySection.get(section.id) ?? [])}`,
          ),
        });
      }
    }

    // Keep all commit files visible, but only rows with rendered diff items can navigate.
    const nextCommitDetailsFiles: ReadonlyArray<CommitDetailsFile> = commitMetadata
      ? commitMetadata.files.map((file) => ({
          ...file,
          destinationItemId: nextFirstItemByPath.get(file.path) ?? null,
        }))
      : [];

    if (commitMetadata && commitDetailsItemId) {
      const navigationKey = nextCommitDetailsFiles
        .map(
          (file) => `${file.oldPath ?? ''}\u0000${file.path}\u0000${file.destinationItemId ?? ''}`,
        )
        .join('\u0001');
      nextItems.unshift({
        annotations: [
          {
            lineNumber: 1,
            metadata: {
              metadata: commitMetadata,
              type: 'commit-details',
            },
          } satisfies LineAnnotation<ReviewAnnotationMetadata>,
        ],
        file: {
          cacheKey: `${commitDetailsItemId}:${commitMetadata.ref}`,
          contents: ' ',
          lang: 'text',
          name: commitDetailsFileName,
        },
        id: commitDetailsItemId,
        type: 'file',
        version: getItemVersion(
          getCommitDetailsVersionKey(commitMetadata, commitDetailsLayoutPass, navigationKey),
        ),
      });
    }

    return {
      commitDetailsFiles: nextCommitDetailsFiles,
      firstItemByPath: nextFirstItemByPath,
      itemMetadata: nextItemMetadata,
      items: nextItems,
    };
  }, [
    collapsed,
    commitDetailsItemId,
    commitDetailsLayoutPass,
    commitMetadata,
    commentsBySection,
    diffStyle,
    files,
    forceExpandedPaths,
    imagePreviewLayoutPassBySection,
    itemVersionByPath,
    markdownPreviewLayoutPassBySection,
    markdownPreviewSections,
    selectedPath,
    showWhitespace,
    viewed,
    walkthroughNotes,
  ]);

  const clearCommentLineHighlight = useCallback(() => {
    codeViewRef.current?.clearSelectedLines();
    setSelectedLines(null);
  }, []);

  const deferCommentLineHighlightClear = useCallback(() => {
    const timer = window.setTimeout(() => {
      deferredTimersRef.current.delete(timer);
      clearCommentLineHighlight();
    }, 0);
    deferredTimersRef.current.add(timer);
  }, [clearCommentLineHighlight]);

  const cancelPendingEmptyCommentDeletes = useCallback(() => {
    for (const timer of emptyCommentDeleteTimersRef.current.values()) {
      window.clearTimeout(timer);
      deferredTimersRef.current.delete(timer);
    }
    emptyCommentDeleteTimersRef.current.clear();
  }, []);

  const createCommentForRange = useCallback(
    (
      range: CodeViewLineSelection['range'],
      context: { item: CodeViewItem<ReviewAnnotationMetadata> },
    ) => {
      if (context.item.type !== 'diff') {
        return;
      }

      const meta = itemMetadata.get(context.item.id);
      if (!meta || meta.isCollapsed) {
        return;
      }

      const startSide = range.side ?? range.endSide ?? 'additions';
      const endSide = range.endSide ?? startSide;
      if (startSide !== endSide) {
        window.alert('Review comments cannot span added and deleted lines.');
        return;
      }

      const start = Math.min(range.start, range.end);
      const end = Math.max(range.start, range.end);
      cancelPendingEmptyCommentDeletes();
      onCreateComment({
        filePath: meta.file.path,
        lineNumber: end,
        sectionId: meta.section.id,
        side: endSide,
        ...(end !== start ? { startLineNumber: start } : {}),
      });
      deferCommentLineHighlightClear();
    },
    [
      cancelPendingEmptyCommentDeletes,
      deferCommentLineHighlightClear,
      itemMetadata,
      onCreateComment,
    ],
  );

  const codeViewOptions: CodeViewOptions<ReviewAnnotationMetadata> = useMemo(
    () =>
      ({
        collapsedContextThreshold: diffCollapsedContextThreshold,
        diffIndicators: 'bars',
        diffStyle,
        enableGutterUtility: true,
        enableLineSelection: true,
        expandUnchanged: false,
        expansionLineCount: diffContextExpansionLineCount,
        hunkSeparators: 'line-info-basic',
        itemMetrics: codeViewItemMetrics,
        layout: codeViewLayout,
        lineHoverHighlight: 'both',
        onGutterUtilityClick: (range, context) => {
          ignoreNextLineSelectionEndRef.current = context.item.type === 'diff';
          createCommentForRange(range, context);
        },
        onLineClick: (line, context) => {
          if (isInteractiveReviewEvent(line.event)) {
            return;
          }

          const meta = itemMetadata.get(context.item.id);
          if (!meta || meta.isCollapsed) {
            return;
          }

          if (
            meta.section.loadState === 'deferred' &&
            shouldLoadDiffSectionContents(meta.section)
          ) {
            onLoadSection(meta.file, meta.section);
            return;
          }

          const side = 'annotationSide' in line ? line.annotationSide : null;
          if (!side) {
            return;
          }

          cancelPendingEmptyCommentDeletes();
          onCreateComment({
            filePath: meta.file.path,
            lineNumber: line.lineNumber,
            sectionId: meta.section.id,
            side,
          });
        },
        onLineSelectionEnd: (range, context) => {
          if (ignoreNextLineSelectionEndRef.current) {
            ignoreNextLineSelectionEndRef.current = false;
            return;
          }

          if (!range) {
            return;
          }

          createCommentForRange(range, context);
        },
        onPostRender: (node, _instance, _phase, context) => {
          const metadata = itemMetadata.get(context.item.id);
          node.classList.toggle(
            'codiff-commit-details-item',
            context.item.id === commitDetailsItemId,
          );
          node.classList.toggle(
            'codiff-markdown-preview-item',
            metadata?.isMarkdownPreview === true,
          );
          node.classList.toggle(
            'codiff-image-preview-item',
            context.item.type === 'file' &&
              Boolean(metadata && canRenderImagePreview(metadata.file.path, metadata.section)),
          );
          node.classList.toggle(
            'codiff-loadable-summary-item',
            metadata?.section.loadState === 'deferred' &&
              shouldLoadDiffSectionContents(metadata.section),
          );
          node.classList.toggle(
            'codiff-loading-summary-item',
            Boolean(metadata && loadingSectionIds.has(metadata.section.id)),
          );
        },
        overflow: wordWrap ? 'wrap' : 'scroll',
        stickyHeaders: true,
        theme: {
          dark: 'Dunkel',
          light: 'Licht',
        },
        themeType: 'system',
        tokenizeMaxLength: 100_000,
        unsafeCSS: codeViewUnsafeCSS,
      }) satisfies CodeViewOptions<ReviewAnnotationMetadata>,
    [
      cancelPendingEmptyCommentDeletes,
      commitDetailsItemId,
      createCommentForRange,
      diffStyle,
      itemMetadata,
      loadingSectionIds,
      onCreateComment,
      onLoadSection,
      wordWrap,
    ],
  );

  const focusComment = useCallback((comment: ReviewComment) => {
    const timer = emptyCommentDeleteTimersRef.current.get(comment.id);
    if (timer == null) {
      return;
    }

    window.clearTimeout(timer);
    deferredTimersRef.current.delete(timer);
    emptyCommentDeleteTimersRef.current.delete(comment.id);
  }, []);

  const blurComment = useCallback(
    (comment: ReviewComment, body: string) => {
      clearCommentLineHighlight();
      if (!comment.isReadOnly && body.trim().length === 0) {
        const existingTimer = emptyCommentDeleteTimersRef.current.get(comment.id);
        if (existingTimer != null) {
          window.clearTimeout(existingTimer);
          deferredTimersRef.current.delete(existingTimer);
        }

        const timer = window.setTimeout(() => {
          deferredTimersRef.current.delete(timer);
          emptyCommentDeleteTimersRef.current.delete(comment.id);
          onDeleteComment(comment.id);
        }, 120);
        deferredTimersRef.current.add(timer);
        emptyCommentDeleteTimersRef.current.set(comment.id, timer);
      }
    },
    [clearCommentLineHighlight, onDeleteComment],
  );

  const deleteComment = useCallback(
    (commentId: string) => {
      clearCommentLineHighlight();
      onDeleteComment(commentId);
    },
    [clearCommentLineHighlight, onDeleteComment],
  );

  const toggleMarkdownPreview = useCallback(
    (section: DiffSection) => {
      clearCommentLineHighlight();
      setMarkdownPreviewSections((current) => {
        const next = new Set(current);
        if (next.has(section.id)) {
          next.delete(section.id);
        } else {
          next.add(section.id);
        }
        return next;
      });
    },
    [clearCommentLineHighlight],
  );

  const workerPoolOptions = useMemo(
    () => ({
      poolSize: Math.min(
        maxWorkerThreads,
        Math.max(1, navigator.hardwareConcurrency || maxWorkerThreads),
      ),
      workerFactory: () =>
        new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), {
          type: 'module',
        }),
    }),
    [],
  );

  const requestScrollItemHeaderIntoView = useCallback(
    (itemId: string, behavior: ReviewScrollBehavior = 'instant') => {
      const handle = codeViewRef.current;
      const viewer = handle?.getInstance();
      if (!handle || !viewer || viewer.getTopForItem(itemId) == null) {
        return false;
      }

      handle.scrollTo({
        behavior: getEffectiveScrollBehavior(behavior),
        id: itemId,
        offset: DEFAULT_PADDING,
        type: 'item',
      });

      return true;
    },
    [],
  );

  const scrollToCommitDetailsDestination = useCallback(
    (itemId: string) => {
      requestScrollItemHeaderIntoView(itemId, 'smooth');
    },
    [requestScrollItemHeaderIntoView],
  );

  useLayoutEffect(() => {
    if (!scrollTarget || handledScrollRequestRef.current === scrollTarget.request) {
      return;
    }

    const behavior = scrollTarget.behavior ?? 'instant';
    const itemId = firstItemByPath.get(scrollTarget.path);
    if (!itemId) {
      return;
    }

    let frame: number | null = null;
    let attempts = 0;
    let canceled = false;
    let requested = false;

    const tryScroll = () => {
      if (canceled || handledScrollRequestRef.current === scrollTarget.request) {
        return;
      }

      const viewer = codeViewRef.current?.getInstance();
      if (requested && viewer && isScrollTargetRendered(viewer, itemId)) {
        handledScrollRequestRef.current = scrollTarget.request;
        return;
      }

      if (
        (behavior === 'instant' || !requested) &&
        requestScrollItemHeaderIntoView(itemId, behavior)
      ) {
        requested = true;
      }

      if (attempts < scrollTargetRetryFrameLimit) {
        attempts += 1;
        frame = window.requestAnimationFrame(tryScroll);
      }
    };

    tryScroll();

    return () => {
      canceled = true;
      if (frame != null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [firstItemByPath, requestScrollItemHeaderIntoView, scrollTarget]);

  const scheduleSearchHighlights = useCallback(() => {
    const viewer = codeViewRef.current?.getInstance();
    if (!viewer) {
      return;
    }

    if (highlightFrameRef.current != null) {
      window.cancelAnimationFrame(highlightFrameRef.current);
    }

    highlightFrameRef.current = window.requestAnimationFrame(() => {
      highlightFrameRef.current = null;
      applySearchHighlights(viewer.getRenderedItems(), searchQuery, activeSearchMatch);
    });
  }, [activeSearchMatch, searchQuery]);

  const scheduleStickyHeaderStateUpdate = useCallback((viewer?: CodeViewInstance) => {
    const nextViewer = viewer ?? codeViewRef.current?.getInstance();
    if (!nextViewer) {
      return;
    }

    if (stickyHeaderFrameRef.current != null) {
      window.cancelAnimationFrame(stickyHeaderFrameRef.current);
    }

    stickyHeaderFrameRef.current = window.requestAnimationFrame(() => {
      stickyHeaderFrameRef.current = null;
      updateStickyHeaderState(nextViewer);
    });
  }, []);

  useEffect(
    () => () => {
      for (const timer of deferredTimersRef.current) {
        window.clearTimeout(timer);
      }
      deferredTimersRef.current.clear();
      emptyCommentDeleteTimersRef.current.clear();
      if (highlightFrameRef.current != null) {
        window.cancelAnimationFrame(highlightFrameRef.current);
      }
      if (stickyHeaderFrameRef.current != null) {
        window.cancelAnimationFrame(stickyHeaderFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    scheduleSearchHighlights();
    scheduleStickyHeaderStateUpdate();
  }, [items, scheduleSearchHighlights, scheduleStickyHeaderStateUpdate]);

  useEffect(() => {
    const handle = codeViewRef.current;
    const viewer = handle?.getInstance();
    if (!handle || !viewer || !activeSearchMatch) {
      return;
    }

    if (activeSearchMatch.lineNumber == null) {
      handle.scrollTo({
        align: 'center',
        behavior: 'smooth-auto',
        id: activeSearchMatch.itemId,
        type: 'item',
      });
    } else {
      handle.scrollTo({
        align: 'center',
        behavior: 'smooth-auto',
        id: activeSearchMatch.itemId,
        lineNumber: activeSearchMatch.lineNumber,
        offset: DEFAULT_PADDING,
        side: activeSearchMatch.side,
        type: 'line',
      });
    }

    scheduleSearchHighlights();
  }, [activeSearchMatch, scheduleSearchHighlights]);

  const renderCustomHeader = useCallback(
    (item: CodeViewItem<ReviewAnnotationMetadata>) => {
      if (item.id === commitDetailsItemId) {
        return null;
      }

      const meta = itemMetadata.get(item.id);
      return meta ? (
        <CodeViewHeader
          isSectionLoading={loadingSectionIds.has(meta.section.id)}
          meta={meta}
          onLoadSection={onLoadSection}
          onOpenFile={onOpenFile}
          onToggleCollapsed={onToggleCollapsed}
          onToggleMarkdownPreview={toggleMarkdownPreview}
          onToggleViewed={onToggleViewed}
        />
      ) : null;
    },
    [
      commitDetailsItemId,
      itemMetadata,
      loadingSectionIds,
      onLoadSection,
      onOpenFile,
      onToggleCollapsed,
      onToggleViewed,
      toggleMarkdownPreview,
    ],
  );

  const renderAnnotation = useCallback(
    (
      annotation:
        | DiffLineAnnotation<ReviewAnnotationMetadata>
        | LineAnnotation<ReviewAnnotationMetadata>,
      item: CodeViewItem<ReviewAnnotationMetadata>,
    ) => {
      if (annotation.metadata.type === 'image-preview') {
        const meta = itemMetadata.get(item.id);
        return meta ? (
          <ImageDiffPreview
            file={meta.file}
            onLayoutReady={markImagePreviewLayoutReady}
            section={meta.section}
            source={source}
          />
        ) : null;
      }

      if (annotation.metadata.type === 'markdown-preview') {
        return (
          <MarkdownPreview
            addedLines={annotation.metadata.addedLines}
            contents={annotation.metadata.contents}
            layoutKey={annotation.metadata.layoutKey}
            onLayoutReady={markMarkdownPreviewLayoutReady}
            sectionId={annotation.metadata.sectionId}
          />
        );
      }

      if (annotation.metadata.type === 'commit-details') {
        return (
          <CommitDetailsPanel
            files={commitDetailsFiles}
            layoutKey={getCommitDetailsContentKey(annotation.metadata.metadata)}
            metadata={annotation.metadata.metadata}
            onLayoutReady={markCommitDetailsLayoutReady}
            onSelectFileDestination={scrollToCommitDetailsDestination}
          />
        );
      }

      return item.type === 'diff' ? (
        <ReviewAnnotation
          annotation={annotation as DiffLineAnnotation<ReviewCommentAnnotationMetadata>}
          comments={comments}
          focusCommentId={focusCommentId}
          focusCommentRequest={focusCommentRequest}
          identity={gitIdentity}
          isPullRequest={isPullRequest}
          keymap={keymap}
          onAskCodex={onAskCodex}
          onCommentBlur={blurComment}
          onCommentFocus={focusComment}
          onDeleteComment={deleteComment}
          onSubmitComment={onSubmitComment}
          onUpdateComment={onUpdateComment}
        />
      ) : null;
    },
    [
      comments,
      blurComment,
      commitDetailsFiles,
      deleteComment,
      focusCommentId,
      focusCommentRequest,
      focusComment,
      gitIdentity,
      isPullRequest,
      itemMetadata,
      keymap,
      markCommitDetailsLayoutReady,
      markMarkdownPreviewLayoutReady,
      markImagePreviewLayoutReady,
      onAskCodex,
      onSubmitComment,
      onUpdateComment,
      scrollToCommitDetailsDestination,
      source,
    ],
  );

  const handleScroll = useCallback(
    (_scrollTop: number, viewer: CodeViewInstance) => {
      onSelectPathFromScroll(viewer);
      scheduleSearchHighlights();
      scheduleStickyHeaderStateUpdate(viewer);
    },
    [onSelectPathFromScroll, scheduleSearchHighlights, scheduleStickyHeaderStateUpdate],
  );

  return (
    <WorkerPoolContextProvider
      highlighterOptions={workerHighlighterOptions}
      poolOptions={workerPoolOptions}
    >
      <CodeView
        className="code-view"
        items={items}
        onScroll={handleScroll}
        onSelectedLinesChange={setSelectedLines}
        options={codeViewOptions}
        ref={codeViewRef}
        renderAnnotation={renderAnnotation}
        renderCustomHeader={renderCustomHeader}
        selectedLines={selectedLines}
      />
    </WorkerPoolContextProvider>
  );
}
