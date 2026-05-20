import {
  type CodeViewLineSelection,
  type CodeViewItem,
  type CodeViewOptions,
  type DiffLineAnnotation,
  type LineAnnotation,
} from '@pierre/diffs';
import { CodeView, type CodeViewHandle, WorkerPoolContextProvider } from '@pierre/diffs/react';
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import codexIconUrl from '../../assets/codex.svg';
import type {
  CodeViewInstance,
  CodeViewItemMetadata,
  DiffSearchMatch,
  ReviewAnnotationMetadata,
  ReviewComment,
  ReviewCommentAnnotationMetadata,
  WalkthroughNote,
} from '../../lib/app-types.ts';
import {
  codeViewItemMetrics,
  codeViewItemMetricsWithWalkthrough,
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
  getDiffLineCountFromVisibleSections,
  getItemId,
  getMarkdownPreviewContents,
  getVisibleDiffSections,
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
  DiffSection,
  GitIdentity,
  PullRequestExistingReviewComment,
} from '../../types.ts';
import { DiffLineCountBadge } from './Sidebar.tsx';

function CopyFilePathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    },
    [],
  );

  const handleClick = useCallback(
    async (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      await navigator.clipboard.writeText(path);
      setCopied(true);
      if (copiedTimerRef.current != null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copiedTimerRef.current = null;
      }, 1600);
    },
    [path],
  );

  return (
    <button
      aria-label={copied ? 'Path copied' : 'Copy file path'}
      className={`codiff-copy-path-button${copied ? ' copied' : ''}`}
      onClick={(event) => void handleClick(event)}
      title={copied ? 'Path copied' : 'Copy file path'}
      type="button"
    >
      <span
        aria-hidden
        className={copied ? 'codiff-copy-path-icon check' : 'codiff-copy-path-icon'}
      />
    </button>
  );
}

function CodeViewHeader({
  meta,
  onOpenFile,
  onToggleCollapsed,
  onToggleMarkdownPreview,
  onToggleViewed,
}: {
  meta: CodeViewItemMetadata;
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
          <span className={isCollapsed ? 'codiff-chevron collapsed' : 'codiff-chevron'} />
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
        <span aria-hidden className="codiff-viewed-checkbox" />
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

  return avatarUrl ? (
    <img alt="" className="review-comment-avatar" draggable={false} src={avatarUrl} />
  ) : (
    <span aria-hidden className="review-comment-avatar fallback">
      {label.trim()[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

function CodexAvatar() {
  return (
    <img alt="" className="review-comment-avatar codex" draggable={false} src={codexIconUrl} />
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

function ReviewAnnotation({
  annotation,
  comments,
  focusCommentId,
  focusCommentRequest,
  identity,
  isPullRequest,
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
      if (event.key === 'Enter' && event.metaKey && !event.shiftKey) {
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

      if (event.key !== 'Escape') {
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
    [isPullRequest, onAskCodex, onDeleteComment, onSubmitComment],
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
                      <span aria-hidden className="review-comment-delete-icon" />
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

export function ReviewCodeView({
  activeSearchMatch,
  collapsed,
  comments,
  files,
  focusCommentId,
  focusCommentRequest,
  forceExpandedPaths,
  gitIdentity,
  isPullRequest,
  itemVersionByPath,
  onAskCodex,
  onCreateComment,
  onDeleteComment,
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
  viewed,
  walkthroughNotes,
}: {
  activeSearchMatch: DiffSearchMatch | null;
  collapsed: ReadonlySet<string>;
  comments: ReadonlyArray<ReviewComment>;
  files: ReadonlyArray<ChangedFile>;
  focusCommentId: string | null;
  focusCommentRequest: number;
  forceExpandedPaths: ReadonlySet<string>;
  gitIdentity: GitIdentity | null;
  isPullRequest: boolean;
  itemVersionByPath: Readonly<Record<string, number>>;
  onAskCodex: (commentId: string) => void;
  onCreateComment: (comment: Omit<ReviewComment, 'body' | 'id'>) => void;
  onDeleteComment: (commentId: string) => void;
  onOpenFile: (file: ChangedFile) => void;
  onSelectPathFromScroll: (viewer: CodeViewInstance) => void;
  onSubmitComment: (commentId: string) => void;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean) => void;
  onUpdateComment: (commentId: string, body: string) => void;
  scrollTarget: { path: string; request: number } | null;
  searchQuery: string;
  selectedPath: string | null;
  showWhitespace: boolean;
  viewed: Record<string, string>;
  walkthroughNotes: ReadonlyMap<string, WalkthroughNote>;
}) {
  const codeViewRef = useRef<CodeViewHandle<ReviewAnnotationMetadata>>(null);
  const deferredTimersRef = useRef<Set<number>>(new Set());
  const handledScrollRequestRef = useRef<number | null>(null);
  const emptyCommentDeleteTimersRef = useRef<Map<string, number>>(new Map());
  const highlightFrameRef = useRef<number | null>(null);
  const ignoreNextLineSelectionEndRef = useRef(false);
  const [markdownPreviewSections, setMarkdownPreviewSections] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Markdown preview content is rendered through a CodeView annotation portal.
  // Bump the item version once the portal DOM exists so CodeView measures the real preview height.
  const [markdownPreviewLayoutPassBySection, setMarkdownPreviewLayoutPassBySection] = useState<
    Readonly<Record<string, number>>
  >({});
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
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

  const { firstItemByPath, itemMetadata, items } = useMemo(() => {
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
            }:${getReviewCommentsDigest(commentsBySection.get(section.id) ?? [])}`,
          ),
        });
      }
    }

    return {
      firstItemByPath: nextFirstItemByPath,
      itemMetadata: nextItemMetadata,
      items: nextItems,
    };
  }, [
    collapsed,
    commentsBySection,
    files,
    forceExpandedPaths,
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
        window.alert('Review comments cannot span both sides of a split diff.');
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
        diffStyle: 'split',
        enableGutterUtility: true,
        enableLineSelection: true,
        expandUnchanged: false,
        expansionLineCount: diffContextExpansionLineCount,
        hunkSeparators: 'line-info-basic',
        itemMetrics:
          walkthroughNotes.size > 0 ? codeViewItemMetricsWithWalkthrough : codeViewItemMetrics,
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
        onPostRender: (node, _instance, context) => {
          node.classList.toggle(
            'codiff-markdown-preview-item',
            itemMetadata.get(context.item.id)?.isMarkdownPreview === true,
          );
        },
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
      createCommentForRange,
      itemMetadata,
      onCreateComment,
      walkthroughNotes.size,
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

  const scrollItemHeaderIntoView = useCallback((itemId: string) => {
    const handle = codeViewRef.current;
    const viewer = handle?.getInstance();
    if (!handle || !viewer || viewer.getTopForItem(itemId) == null) {
      return false;
    }

    handle.scrollTo({
      behavior: 'instant',
      id: itemId,
      offset: DEFAULT_PADDING,
      type: 'item',
    });

    return true;
  }, []);

  useEffect(() => {
    if (!scrollTarget || handledScrollRequestRef.current === scrollTarget.request) {
      return;
    }

    let frame: number | null = null;
    let attempts = 0;
    let canceled = false;

    const tryScroll = () => {
      if (canceled || handledScrollRequestRef.current === scrollTarget.request) {
        return;
      }

      const itemId = firstItemByPath.get(scrollTarget.path);
      if (itemId && scrollItemHeaderIntoView(itemId)) {
        handledScrollRequestRef.current = scrollTarget.request;
        return;
      }

      if (attempts < 6) {
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
  }, [firstItemByPath, scrollItemHeaderIntoView, scrollTarget]);

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
      const meta = itemMetadata.get(item.id);
      return meta ? (
        <CodeViewHeader
          meta={meta}
          onOpenFile={onOpenFile}
          onToggleCollapsed={onToggleCollapsed}
          onToggleMarkdownPreview={toggleMarkdownPreview}
          onToggleViewed={onToggleViewed}
        />
      ) : null;
    },
    [itemMetadata, onOpenFile, onToggleCollapsed, onToggleViewed, toggleMarkdownPreview],
  );

  const renderAnnotation = useCallback(
    (
      annotation:
        | DiffLineAnnotation<ReviewAnnotationMetadata>
        | LineAnnotation<ReviewAnnotationMetadata>,
      item: CodeViewItem<ReviewAnnotationMetadata>,
    ) => {
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

      return item.type === 'diff' ? (
        <ReviewAnnotation
          annotation={annotation as DiffLineAnnotation<ReviewCommentAnnotationMetadata>}
          comments={comments}
          focusCommentId={focusCommentId}
          focusCommentRequest={focusCommentRequest}
          identity={gitIdentity}
          isPullRequest={isPullRequest}
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
      deleteComment,
      focusCommentId,
      focusCommentRequest,
      focusComment,
      gitIdentity,
      isPullRequest,
      markMarkdownPreviewLayoutReady,
      onAskCodex,
      onSubmitComment,
      onUpdateComment,
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
