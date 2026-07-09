import type { MarkdownEditorHandle } from '@nkzw/mdx-editor';
import { frontmatterPlugin, imagePlugin } from '@nkzw/mdx-editor/core';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/ChatCircle';
import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import { ColumnsIcon as Columns } from '@phosphor-icons/react/Columns';
import { ImageBrokenIcon as ImageBroken } from '@phosphor-icons/react/ImageBroken';
import { SquareSplitVerticalIcon as SquareSplitVertical } from '@phosphor-icons/react/SquareSplitVertical';
import { XIcon as X } from '@phosphor-icons/react/X';
import {
  type CodeViewLineSelection,
  type CodeViewItem,
  type CodeViewOptions,
  type CodeViewScrollTarget,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type LineAnnotation,
  type SelectedLineRange,
} from '@pierre/diffs';
import { CodeView, type CodeViewHandle, WorkerPoolContextProvider } from '@pierre/diffs/react';
import { Copy as LucideCopy } from 'lucide-react';
import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import claudeIconUrl from '../../assets/claude.svg';
import codexIconUrl from '../../assets/codex.svg';
import opencodeIconUrl from '../../assets/opencode.svg';
import piIconUrl from '../../assets/pi.svg';
import { matchesShortcut } from '../../config/keymap.ts';
import type { CodiffDiffStyle, CodiffKeymap } from '../../config/types.ts';
import type {
  CodeViewInstance,
  CodeViewItemMetadata,
  DiffSearchMatch,
  ReviewAnnotationMetadata,
  ReviewComment,
  ReviewCommentAnnotationMetadata,
  ReviewIdentity,
  ReviewScrollBehavior,
  ReviewScrollTarget,
  WalkthroughNote,
} from '../../lib/app-types.ts';
import {
  codeViewItemMetrics,
  codeViewLayout,
  codeViewUnsafeCSS,
  DEFAULT_PADDING,
  DIFF_LINE_HEIGHT,
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
  isMarkdownFilePath,
  shouldLoadDiffSectionContents,
} from '../../lib/diff.ts';
import { getItemVersion } from '../../lib/item-version.ts';
import { isNativeInputTarget } from '../../lib/keyboard.ts';
import { sanitizeMarkdownImages } from '../../lib/markdown.tsx';
import { isGeneratedWalkthroughFile } from '../../lib/narrative-walkthrough-diff.js';
import {
  getCommentKey,
  getReviewCommentLineLabel,
  getReviewCommentsDigest,
  hasActiveTextSelection,
  isFileReviewComment,
  isInteractiveReviewEvent,
  isLineReviewComment,
  shouldDiscardReviewCommentOnEscape,
  updateStickyHeaderState,
} from '../../lib/review-comments.ts';
import { getReviewIdentity, isReviewIdentityViewed } from '../../lib/review-identity.ts';
import { applySearchHighlights } from '../../lib/search-highlights.ts';
import type {
  ChangedFile,
  CodiffPreferences,
  CommitMetadata,
  DiffImageContentRequest,
  DiffImageContentResult,
  DiffSection,
  GitIdentity,
  PullRequestExistingReviewComment,
  ReviewAuthor,
  ReviewSource,
} from '../../types.ts';
import { Gravatar } from './Gravatar.tsx';
import {
  RepositoryMarkdownEditor,
  type MarkdownDocumentEditorHandle,
} from './MarkdownDocumentEditor.tsx';
import { ReadOnlyMarkdownView } from './ReadOnlyMarkdownView.tsx';
import { DiffLineCountBadge } from './Sidebar.tsx';
import { useCopiedState } from './useCopiedState.ts';

const emptyMarkdownPreviewSectionIds = new Set<string>();
const emptyExpandedGenerated = new Set<string>();
const markdownPreviewPlugins = [
  frontmatterPlugin(),
  imagePlugin({
    disableImageResize: true,
    disableImageSettingsButton: true,
  }),
];
let markdownEditorModulePromise: Promise<{
  default: typeof import('@nkzw/mdx-editor').MarkdownEditor;
}> | null = null;
const loadMarkdownEditor = () =>
  (markdownEditorModulePromise ??= import('@nkzw/mdx-editor').then((module) => ({
    default: module.MarkdownEditor,
  })));
const preloadMarkdownEditor = () => {
  void loadMarkdownEditor();
};
const MarkdownEditor = lazy(loadMarkdownEditor);

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
  allowViewedToggle,
  canCreateFileComment,
  isSectionLoading,
  meta,
  onCreateFileComment,
  onLoadSection,
  onOpenFile,
  onToggleCollapsed,
  onToggleMarkdownPreview,
  onToggleViewed,
  readOnly,
}: {
  allowViewedToggle: boolean;
  canCreateFileComment: boolean;
  isSectionLoading: boolean;
  meta: CodeViewItemMetadata;
  onCreateFileComment: () => void;
  onLoadSection: (file: ChangedFile, section: DiffSection) => void;
  onOpenFile?: (file: ChangedFile) => void;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean, reviewKey: string) => void;
  onToggleMarkdownPreview: (file: ChangedFile, section: DiffSection) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean, reviewIdentity: ReviewIdentity) => void;
  readOnly: boolean;
}) {
  const {
    canRenderMarkdown,
    file,
    isCollapsed,
    isMarkdownPreview,
    isSelected,
    isViewed,
    lineCount,
    reviewIdentity,
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
        onClick={() => onToggleCollapsed(file, isCollapsed, reviewIdentity.key)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggleCollapsed(file, isCollapsed, reviewIdentity.key);
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
        {isGeneratedWalkthroughFile(file) ? (
          <span className="codiff-generated-badge" title="Generated file">
            Generated
          </span>
        ) : null}
      </div>
      <DiffLineCountBadge lineCount={lineCount} />
      <div className={`codiff-status-badge ${file.status}`}>{statusLabel[file.status]}</div>
      {canCreateFileComment ? (
        <button
          className="codiff-file-comment-button"
          onClick={onCreateFileComment}
          title="Comment on file"
          type="button"
        >
          <ChatCircle aria-hidden className="codiff-file-comment-icon" size={14} weight="bold" />
          Comment
        </button>
      ) : null}
      {canRenderMarkdown ? (
        <button
          aria-pressed={isMarkdownPreview}
          className={`codiff-markdown-button${isMarkdownPreview ? ' active' : ''}`}
          onClick={() => onToggleMarkdownPreview(file, section)}
          title={isMarkdownPreview ? 'View as Diff' : 'View as Markdown'}
          type="button"
        >
          {isMarkdownPreview ? 'View as Diff' : 'View as Markdown'}
        </button>
      ) : null}
      {canLoadSection && !readOnly ? (
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
      {!readOnly && onOpenFile ? (
        <button
          className="codiff-open-button"
          disabled={!canOpenFile}
          onClick={() => onOpenFile(file)}
          title={canOpenFile ? 'Open file in editor' : 'Deleted files cannot be opened'}
          type="button"
        >
          Open
        </button>
      ) : null}
      {!readOnly || allowViewedToggle ? (
        <button
          aria-pressed={isViewed}
          className={`codiff-viewed-button${isViewed ? ' active' : ''}`}
          onClick={() => onToggleViewed(file, isViewed, reviewIdentity)}
          type="button"
        >
          <span aria-hidden className="codiff-viewed-checkbox">
            {isViewed ? <Check className="codiff-viewed-check" size={10} weight="bold" /> : null}
          </span>
          Viewed
        </button>
      ) : null}
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

function AgentAvatar({ agentId }: { agentId: 'codex' | 'claude' | 'opencode' | 'pi' }) {
  return (
    <img
      alt=""
      className="review-comment-avatar-codex"
      draggable={false}
      src={agentIconUrl(agentId)}
    />
  );
}

const agentIconUrl = (agentId: 'codex' | 'claude' | 'opencode' | 'pi') => {
  return agentId === 'pi'
    ? piIconUrl
    : agentId === 'opencode'
      ? opencodeIconUrl
      : agentId === 'claude'
        ? claudeIconUrl
        : codexIconUrl;
};

const canAskCodexForComment = (comment: ReviewComment) =>
  !comment.isReadOnly && comment.body.trim().length > 0 && comment.codexReply?.status !== 'loading';

const canSubmitComment = (comment: ReviewComment) =>
  !comment.isReadOnly &&
  comment.body.trim().length > 0 &&
  comment.remoteSubmit?.status !== 'submitting';

const withCommentBody = (comment: ReviewComment, body: string): ReviewComment =>
  comment.body === body ? comment : { ...comment, body };

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
  contents,
  editable,
  layoutKey,
  onEditorRef,
  onLayoutReady,
  path,
  sectionId,
}: {
  contents: string;
  editable: boolean;
  layoutKey: string;
  onEditorRef: (sectionId: string, editor: MarkdownDocumentEditorHandle | null) => void;
  onLayoutReady: (sectionId: string) => void;
  path: string;
  sectionId: string;
}) {
  useLayoutEffect(() => {
    onLayoutReady(sectionId);
  }, [layoutKey, onLayoutReady, sectionId]);

  return editable ? (
    <div className="codiff-markdown-preview editable">
      <RepositoryMarkdownEditor
        onHeightChange={() => onLayoutReady(sectionId)}
        path={path}
        ref={(editor) => onEditorRef(sectionId, editor)}
      />
    </div>
  ) : (
    <div className="codiff-markdown-preview">
      <ReadOnlyMarkdown
        ariaLabel={`Preview ${path}`}
        className="codiff-markdown-preview-editor"
        onHeightChange={() => onLayoutReady(sectionId)}
        value={contents}
      />
    </div>
  );
}

function ReadOnlyMarkdown({
  ariaLabel,
  className,
  density = 'document',
  onHeightChange,
  value,
  variant = 'plain',
}: {
  ariaLabel: string;
  className: string;
  density?: 'compact' | 'document';
  onHeightChange?: (height: number) => void;
  value: string;
  variant?: 'embedded' | 'plain';
}) {
  return (
    <ReadOnlyMarkdownView
      additionalPlugins={markdownPreviewPlugins}
      ariaLabel={ariaLabel}
      className={className}
      density={density}
      onHeightChange={onHeightChange}
      value={value}
      variant={variant}
    />
  );
}

const getPullRequestDescriptionLabel = (source: Extract<ReviewSource, { type: 'pull-request' }>) =>
  source.provider === 'github'
    ? 'PR description'
    : source.provider === 'gitlab'
      ? 'MR description'
      : 'Description';
type SourceDescriptionAuthor = {
  avatarUrl?: string;
  displayName: string;
  title?: string;
};
const getPullRequestDescriptionAuthor = (author: ReviewAuthor): SourceDescriptionAuthor => ({
  avatarUrl: author.avatarUrl,
  displayName: author.name || `@${author.login}`,
  title: `@${author.login}`,
});
const getCommitDescriptionAuthor = (author: CommitMetadata['author']): SourceDescriptionAuthor => ({
  avatarUrl: author.gravatarUrl,
  displayName: author.name || author.email || 'Unknown author',
  title: author.email || undefined,
});
const htmlCommentPattern = /<!--[\s\S]*?-->/g;
const stripHtmlComments = (value: string) => value.replaceAll(htmlCommentPattern, '');
type PullRequestSource = Extract<ReviewSource, { type: 'pull-request' }>;
const sourceTitleUpdateDebounceMs = 800;

function SourceDescriptionTitle({
  canEdit,
  label,
  onUpdateTitle,
  title,
}: {
  canEdit: boolean;
  label: string;
  onUpdateTitle?: (title: string) => Promise<void> | void;
  title: string;
}) {
  const [draft, setDraft] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const submittedTitleRef = useRef(title.trim());
  const titleSavePromiseRef = useRef<Promise<void>>(Promise.resolve());
  const trimmedDraft = draft.trim();

  useEffect(() => {
    if (!canEdit || !onUpdateTitle || !trimmedDraft || trimmedDraft === submittedTitleRef.current) {
      return;
    }

    const timeout = window.setTimeout(() => {
      const titleToSave = trimmedDraft;
      const save = titleSavePromiseRef.current.then(() => onUpdateTitle(titleToSave));
      titleSavePromiseRef.current = save.catch(() => {});
      void save
        .then(() => {
          submittedTitleRef.current = titleToSave;
        })
        .catch((updateError: unknown) => {
          setError(updateError instanceof Error ? updateError.message : String(updateError));
        });
    }, sourceTitleUpdateDebounceMs);
    return () => window.clearTimeout(timeout);
  }, [canEdit, onUpdateTitle, trimmedDraft]);

  if (!canEdit || !onUpdateTitle) {
    return (
      <span className={`codiff-file-path${title ? ' source-description-title' : ''}`}>
        {title || label}
      </span>
    );
  }

  return (
    <textarea
      aria-label="Edit title"
      className={`codiff-file-path source-description-title source-description-title-editor${
        error ? ' has-error' : ''
      }`}
      onBlur={() => {
        if (!trimmedDraft) {
          setDraft(title);
          setError(null);
        }
      }}
      onChange={(event: ReactChangeEvent<HTMLTextAreaElement>) => {
        setDraft(event.target.value);
        setError(null);
      }}
      onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(title);
          setError(null);
          event.currentTarget.blur();
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      rows={1}
      spellCheck
      title={error ?? undefined}
      value={draft}
      wrap="off"
    />
  );
}

// The PR/MR description is a file-style card matching commit details: the title lives in the
// card header and the description is the collapsible body.
function SourceDescriptionHeader({
  actions,
  canCollapse,
  canEditTitle,
  isCollapsed,
  label,
  onToggleCollapsed,
  onUpdateTitle,
  title,
}: {
  actions?: ReactNode;
  canCollapse: boolean;
  canEditTitle?: boolean;
  isCollapsed: boolean;
  label: string;
  onToggleCollapsed: () => void;
  onUpdateTitle?: (title: string) => Promise<void> | void;
  title: string;
}) {
  const editableTitle = canEditTitle === true && onUpdateTitle != null && title.length > 0;
  const heading = (
    <span className="codiff-file-heading">
      <span className="codiff-file-path-row">
        <SourceDescriptionTitle
          canEdit={editableTitle}
          label={label}
          onUpdateTitle={onUpdateTitle}
          title={title}
        />
      </span>
    </span>
  );

  return (
    <div
      className={`codiff-file-header codiff-source-description-header${
        isCollapsed ? ' collapsed' : ''
      }${editableTitle ? ' editable-title' : ''}`}
    >
      {canCollapse && editableTitle ? (
        <>
          <button
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? 'Expand description' : 'Collapse description'}
            className="codiff-source-description-collapse-button"
            onClick={onToggleCollapsed}
            title={isCollapsed ? 'Expand' : 'Collapse'}
            type="button"
          >
            <span className="codiff-chevron-box">
              <CaretDown
                aria-hidden
                className={isCollapsed ? 'codiff-chevron collapsed' : 'codiff-chevron'}
                size={16}
                weight="bold"
              />
            </span>
          </button>
          <div className="codiff-source-description-title-cell">{heading}</div>
        </>
      ) : canCollapse ? (
        <button
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? 'Expand description' : 'Collapse description'}
          className="codiff-header-toggle"
          onClick={onToggleCollapsed}
          title={isCollapsed ? 'Expand' : 'Collapse'}
          type="button"
        >
          <span className="codiff-chevron-box">
            <CaretDown
              aria-hidden
              className={isCollapsed ? 'codiff-chevron collapsed' : 'codiff-chevron'}
              size={16}
              weight="bold"
            />
          </span>
          {heading}
        </button>
      ) : editableTitle ? (
        <div className="codiff-source-description-title-cell">{heading}</div>
      ) : (
        <div className="codiff-header-toggle codiff-header-toggle-static">{heading}</div>
      )}
      {actions}
    </div>
  );
}

function SourceDescriptionBody({
  ariaLabel = 'Preview source description',
  author,
  canEdit,
  description,
  keymap,
  layoutKey,
  onLayoutReady,
  onUpdateDescription,
  onUploadDescriptionAsset,
}: {
  ariaLabel?: string;
  author?: SourceDescriptionAuthor;
  canEdit?: boolean;
  description: string;
  keymap?: CodiffKeymap;
  layoutKey: string;
  onLayoutReady: (layoutKey: string) => void;
  onUpdateDescription?: (body: string) => Promise<void> | void;
  onUploadDescriptionAsset?: (file: File) => Promise<string> | string;
}) {
  useLayoutEffect(() => {
    onLayoutReady(layoutKey);
  }, [layoutKey, onLayoutReady]);
  const canEditDescription = canEdit === true && onUpdateDescription != null;
  const [editDraft, setEditDraft] = useState(description);
  const [editEditorReady, setEditEditorReady] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [savedDescription, setSavedDescription] = useState<{
    body: string;
    previousDescription: string;
  } | null>(null);
  const displayedDescription =
    savedDescription != null && description === savedDescription.previousDescription
      ? savedDescription.body
      : description;
  const sanitizedDescription = useMemo(
    () => sanitizeMarkdownImages(stripHtmlComments(displayedDescription)),
    [displayedDescription],
  );
  const descriptionEditorPlugins = useMemo(
    () =>
      onUploadDescriptionAsset
        ? [
            imagePlugin({
              imageUploadHandler: (file) => Promise.resolve(onUploadDescriptionAsset(file)),
            }),
          ]
        : undefined,
    [onUploadDescriptionAsset],
  );
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const canSaveEdit =
    editing && !editSubmitting && editDraft.trim() !== displayedDescription.trim();

  const setEditorRef = useCallback(
    (editor: MarkdownEditorHandle | null) => {
      editorRef.current = editor;
      if (editor && editing) {
        requestAnimationFrame(() => {
          setEditEditorReady(true);
          editor.focus({ defaultSelection: 'rootEnd', preventScroll: true });
        });
      }
    },
    [editing],
  );

  useEffect(() => {
    if (!editing) {
      return;
    }

    requestAnimationFrame(() => {
      editorRef.current?.focus({ defaultSelection: 'rootEnd', preventScroll: true });
    });
  }, [editing]);

  const startEdit = useCallback(() => {
    if (!canEditDescription || editSubmitting) {
      return;
    }

    setEditDraft(displayedDescription);
    setEditEditorReady(false);
    setEditError(null);
    setEditing(true);
    preloadMarkdownEditor();
  }, [canEditDescription, displayedDescription, editSubmitting]);

  const cancelEdit = useCallback(() => {
    if (editSubmitting) {
      return;
    }

    setEditDraft(displayedDescription);
    setEditEditorReady(false);
    setEditError(null);
    setEditing(false);
  }, [displayedDescription, editSubmitting]);

  const saveEdit = useCallback(() => {
    const body = editDraft.trim();
    if (!canEditDescription || editSubmitting || body === displayedDescription.trim()) {
      return;
    }

    setEditError(null);
    setEditSubmitting(true);
    void Promise.resolve(onUpdateDescription(body))
      .then(() => {
        setSavedDescription({ body, previousDescription: displayedDescription });
        setEditDraft(body);
        setEditEditorReady(false);
        setEditing(false);
      })
      .catch((error: unknown) => {
        setEditError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setEditSubmitting(false));
  }, [canEditDescription, displayedDescription, editDraft, editSubmitting, onUpdateDescription]);

  const handleEditKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!keymap || !matchesShortcut(event, keymap, 'submitComment') || !canSaveEdit) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      saveEdit();
    },
    [canSaveEdit, keymap, saveEdit],
  );

  return (
    <div
      className={`source-description-comment review-comment${
        author ? '' : ' source-description-comment-anonymous'
      }`}
    >
      {author ? (
        <Gravatar fallback={author.displayName} size="medium" url={author.avatarUrl} />
      ) : null}
      <div className="review-comment-body source-description-body">
        {author || canEditDescription || editing ? (
          <div
            className={`review-comment-header read-only source-description-author-header${
              canEditDescription || editing ? ' with-comment-action' : ''
            }${!sanitizedDescription && !editing ? ' without-description' : ''}`}
          >
            <strong title={author?.title}>{author ? author.displayName : 'Description'}</strong>
            {editing ? (
              <span className="general-comment-edit-actions">
                <button
                  className="review-comment-action"
                  disabled={editSubmitting}
                  onClick={cancelEdit}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="review-comment-action"
                  disabled={!canSaveEdit}
                  onClick={saveEdit}
                  type="button"
                >
                  {editSubmitting ? 'Saving' : 'Save'}
                </button>
              </span>
            ) : canEditDescription ? (
              <button
                className="review-comment-action"
                onClick={startEdit}
                onFocus={preloadMarkdownEditor}
                onPointerEnter={preloadMarkdownEditor}
                type="button"
              >
                Edit
              </button>
            ) : null}
          </div>
        ) : null}
        {editing ? (
          <>
            <div>
              <Suspense
                fallback={
                  <ReadOnlyMarkdown
                    ariaLabel={ariaLabel}
                    className="codiff-markdown-preview-editor source-description-markdown-editor source-description-edit-preview"
                    density="compact"
                    onHeightChange={() => onLayoutReady(layoutKey)}
                    value={sanitizedDescription}
                    variant="embedded"
                  />
                }
              >
                <div
                  className={`review-comment-edit-shell source-description-edit-shell${
                    editEditorReady ? ' ready' : ' loading'
                  }`}
                >
                  {!editEditorReady ? (
                    <ReadOnlyMarkdown
                      ariaLabel={ariaLabel}
                      className="codiff-markdown-preview-editor source-description-markdown-editor source-description-edit-preview"
                      density="compact"
                      onHeightChange={() => onLayoutReady(layoutKey)}
                      value={sanitizedDescription}
                      variant="embedded"
                    />
                  ) : null}
                  <div className="review-comment-edit-editor">
                    <MarkdownEditor
                      additionalPlugins={descriptionEditorPlugins}
                      ariaLabel="Edit source description"
                      className="review-comment-markdown-editor general-comment-markdown-editor source-description-markdown-editor"
                      colorScheme="inherit"
                      contentClassName="review-comment-input general-comment-input"
                      density="compact"
                      onChange={setEditDraft}
                      onHeightChange={() => onLayoutReady(layoutKey)}
                      onKeyDown={handleEditKeyDown}
                      readOnly={editSubmitting}
                      ref={setEditorRef}
                      spellCheck
                      value={editDraft}
                      variant="embedded"
                    />
                  </div>
                </div>
              </Suspense>
            </div>
            {editError ? <div className="review-comment-error">{editError}</div> : null}
          </>
        ) : sanitizedDescription ? (
          <div className="codiff-markdown-preview source-description-markdown">
            <ReadOnlyMarkdown
              ariaLabel={ariaLabel}
              className="codiff-markdown-preview-editor source-description-markdown-editor"
              density="compact"
              onHeightChange={() => onLayoutReady(layoutKey)}
              value={sanitizedDescription}
              variant="embedded"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function PullRequestSourceDescription({
  actions,
  footer,
  keymap,
  onUpdateDescription,
  onUpdateTitle,
  onUploadDescriptionAsset,
  source,
}: {
  actions?: ReactNode;
  footer?: ReactNode;
  keymap?: CodiffKeymap;
  onUpdateDescription?: (body: string) => Promise<void> | void;
  onUpdateTitle?: (title: string) => Promise<void> | void;
  onUploadDescriptionAsset?: (file: File) => Promise<string> | string;
  source: PullRequestSource;
}) {
  const sourceDescription = source.description?.trim() ?? '';
  const sourceTitle = source.title?.trim() ?? '';
  const sourceDescriptionHasBody = sourceDescription.length > 0;
  const sourceAuthor = source.author ? getPullRequestDescriptionAuthor(source.author) : undefined;
  const canEditDescription = source.canEditDescription === true && onUpdateDescription != null;
  const canEditTitle =
    (source.canEditTitle === true || source.canEditDescription === true) && onUpdateTitle != null;
  const [collapsed, setCollapsed] = useState(false);

  if (!sourceDescription && !sourceTitle) {
    return null;
  }

  const isCollapsed = (!sourceDescriptionHasBody && !canEditDescription) || collapsed;
  const layoutKey = `source-description-panel:${source.provider ?? ''}:${source.url}:${sourceTitle}:${sourceDescription}:${source.author?.login ?? ''}:${source.author?.avatarUrl ?? ''}:${isCollapsed ? 'collapsed' : 'open'}`;

  return (
    <div className="codiff-source-description-panel">
      <SourceDescriptionHeader
        actions={actions}
        canCollapse={sourceDescriptionHasBody || canEditDescription}
        canEditTitle={canEditTitle}
        isCollapsed={isCollapsed}
        label={getPullRequestDescriptionLabel(source)}
        onToggleCollapsed={() => setCollapsed((current) => !current)}
        onUpdateTitle={onUpdateTitle}
        title={sourceTitle}
      />
      {!isCollapsed ? (
        <div className="codiff-source-description-panel-body">
          <SourceDescriptionBody
            author={sourceAuthor}
            canEdit={canEditDescription}
            description={sourceDescription}
            keymap={keymap}
            layoutKey={layoutKey}
            onLayoutReady={() => {}}
            onUpdateDescription={onUpdateDescription}
            onUploadDescriptionAsset={onUploadDescriptionAsset}
          />
          {footer ? <div className="codiff-source-description-footer">{footer}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

type ImagePreviewMode = 'side-by-side' | 'slider';

function ImageDiffPreview({
  file,
  loadImageContent,
  onLayoutReady,
  section,
  source,
}: {
  file: ChangedFile;
  loadImageContent: (request: DiffImageContentRequest) => Promise<DiffImageContentResult>;
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

    loadImageContent({
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
  }, [file.path, loadImageContent, requestKey, section.kind, source]);

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

function ReviewCommentEditor({
  agentId,
  agentLabel,
  comment,
  displayName,
  focusCommentId,
  focusEditorRef,
  identity,
  isPullRequest,
  keymap,
  onAskCodex,
  onCommentBlur,
  onCommentFocus,
  onDeleteComment,
  onHeightChange,
  onSaveCommentEdit,
  onSubmitComment,
  onUpdateComment,
}: {
  agentId: 'codex' | 'claude' | 'opencode' | 'pi';
  agentLabel: string;
  comment: ReviewComment;
  displayName: string;
  focusCommentId: string | null;
  focusEditorRef: (node: MarkdownEditorHandle | null) => void;
  identity: GitIdentity | null;
  isPullRequest: boolean;
  keymap: CodiffKeymap;
  onAskCodex?: (commentId: string) => void;
  onCommentBlur: (comment: ReviewComment, body: string) => void;
  onCommentFocus: (comment: ReviewComment) => void;
  onDeleteComment: (commentId: string) => void;
  onHeightChange: () => void;
  onSaveCommentEdit: (commentId: string, body: string) => Promise<void> | void;
  onSubmitComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, body: string) => void;
}) {
  const [editState, setEditState] = useState(() => ({
    commentId: comment.id,
    draft: comment.body,
    editing: false,
    error: null as string | null,
    submitting: false,
  }));
  const [editEditorReadyState, setEditEditorReadyState] = useState(() => ({
    commentId: comment.id,
    ready: false,
  }));
  const [savedBody, setSavedBody] = useState<{ body: string; commentId: string } | null>(null);
  const [draftState, setDraftState] = useState(() => ({
    commentBody: comment.body,
    commentId: comment.id,
    dirty: false,
    draft: comment.body,
  }));
  const effectiveDraftState =
    draftState.commentId === comment.id
      ? draftState
      : {
          commentBody: comment.body,
          commentId: comment.id,
          dirty: false,
          draft: comment.body,
        };
  const draft =
    !effectiveDraftState.dirty && effectiveDraftState.commentBody !== comment.body
      ? comment.body
      : effectiveDraftState.draft;
  const displayedBody =
    savedBody?.commentId === comment.id && comment.body !== savedBody.body
      ? savedBody.body
      : comment.body;
  const effectiveEditState =
    editState.commentId === comment.id
      ? editState
      : {
          commentId: comment.id,
          draft: displayedBody,
          editing: false,
          error: null,
          submitting: false,
        };
  const editingExistingComment = effectiveEditState.editing;
  const editDraft = effectiveEditState.draft;
  const editError = effectiveEditState.error;
  const editSubmitting = effectiveEditState.submitting;
  const editEditorReady =
    editEditorReadyState.commentId === comment.id && editEditorReadyState.ready;

  const draftComment = withCommentBody(comment, draft);
  const canAskCodex = onAskCodex != null && canAskCodexForComment(draftComment);
  const commentCanSubmit = canSubmitComment(draftComment);
  const canEditExistingComment = isPullRequest && comment.isReadOnly && comment.canEdit === true;
  const canSaveEdit =
    canEditExistingComment &&
    !editSubmitting &&
    Boolean(editDraft.trim()) &&
    editDraft.trim() !== displayedBody.trim();
  const editEditorRef = useRef<MarkdownEditorHandle | null>(null);

  const setEditEditorRef = useCallback(
    (editor: MarkdownEditorHandle | null) => {
      editEditorRef.current = editor;
      if (editor && editingExistingComment) {
        requestAnimationFrame(() => {
          setEditEditorReadyState({ commentId: comment.id, ready: true });
          editor.focus({ defaultSelection: 'rootEnd', preventScroll: true });
        });
      }
    },
    [comment.id, editingExistingComment],
  );
  const handleEditDraftChange = useCallback(
    (draft: string) => {
      setEditState((current) =>
        current.commentId === comment.id
          ? { ...current, draft }
          : {
              commentId: comment.id,
              draft,
              editing: true,
              error: null,
              submitting: false,
            },
      );
    },
    [comment.id],
  );
  const flushDraft = useCallback(() => {
    setDraftState((current) =>
      current.commentId === comment.id
        ? {
            ...current,
            commentBody: comment.body,
            dirty: false,
            draft,
          }
        : {
            commentBody: comment.body,
            commentId: comment.id,
            dirty: false,
            draft,
          },
    );
    if (!comment.isReadOnly && draft !== comment.body) {
      onUpdateComment(comment.id, draft);
    }
    return withCommentBody(comment, draft);
  }, [comment, draft, onUpdateComment]);
  const handleChange = useCallback(
    (draft: string) => {
      setDraftState((current) => ({
        commentBody: comment.body,
        commentId: comment.id,
        dirty: true,
        draft,
      }));
    },
    [comment.body, comment.id],
  );

  const handleAskCodex = useCallback(() => {
    const flushed = flushDraft();
    if (onAskCodex && canAskCodexForComment(flushed)) {
      onAskCodex(comment.id);
    }
  }, [comment.id, flushDraft, onAskCodex]);

  const handleSubmitComment = useCallback(() => {
    const flushed = flushDraft();
    if (canSubmitComment(flushed)) {
      onSubmitComment(comment.id);
    }
  }, [comment.id, flushDraft, onSubmitComment]);

  const handleStartEdit = useCallback(() => {
    if (!canEditExistingComment || editSubmitting) {
      return;
    }

    setEditState({
      commentId: comment.id,
      draft: displayedBody,
      editing: true,
      error: null,
      submitting: false,
    });
    setEditEditorReadyState({ commentId: comment.id, ready: false });
  }, [canEditExistingComment, comment.id, displayedBody, editSubmitting]);

  const handleCancelEdit = useCallback(() => {
    if (editSubmitting) {
      return;
    }

    setEditState({
      commentId: comment.id,
      draft: displayedBody,
      editing: false,
      error: null,
      submitting: false,
    });
    setEditEditorReadyState({ commentId: comment.id, ready: false });
  }, [comment.id, displayedBody, editSubmitting]);

  const handleSaveEdit = useCallback(() => {
    const body = editDraft.trim();
    if (!canEditExistingComment || !body || editSubmitting || body === displayedBody.trim()) {
      return;
    }

    setEditState({
      commentId: comment.id,
      draft: editDraft,
      editing: true,
      error: null,
      submitting: true,
    });
    void Promise.resolve(onSaveCommentEdit(comment.id, body))
      .then(() => {
        setSavedBody({ body, commentId: comment.id });
        setEditState({
          commentId: comment.id,
          draft: body,
          editing: false,
          error: null,
          submitting: false,
        });
      })
      .catch((error: unknown) => {
        setEditState({
          commentId: comment.id,
          draft: editDraft,
          editing: true,
          error: error instanceof Error ? error.message : String(error),
          submitting: false,
        });
      })
      .finally(() => {
        setEditState((current) =>
          current.commentId === comment.id && current.submitting
            ? { ...current, submitting: false }
            : current,
        );
      });
  }, [
    canEditExistingComment,
    comment.id,
    displayedBody,
    editDraft,
    editSubmitting,
    onSaveCommentEdit,
  ]);

  const handleBlur = useCallback(() => {
    onCommentBlur(flushDraft(), draft);
  }, [draft, flushDraft, onCommentBlur]);

  const handleFocus = useCallback(() => {
    onCommentFocus(draftComment);
  }, [draftComment, onCommentFocus]);

  const handleEditKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!matchesShortcut(event, keymap, 'submitComment') || !canSaveEdit) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      handleSaveEdit();
    },
    [canSaveEdit, handleSaveEdit, keymap],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (matchesShortcut(event, keymap, 'submitComment')) {
        if (isPullRequest && commentCanSubmit) {
          event.preventDefault();
          event.stopPropagation();
          handleSubmitComment();
          return;
        }

        if (!isPullRequest && canAskCodex) {
          event.preventDefault();
          event.stopPropagation();
          handleAskCodex();
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

      if (shouldDiscardReviewCommentOnEscape(draft)) {
        onDeleteComment(comment.id);
      }
    },
    [
      canAskCodex,
      commentCanSubmit,
      comment.id,
      comment.isReadOnly,
      draft,
      handleAskCodex,
      handleSubmitComment,
      isPullRequest,
      keymap,
      onDeleteComment,
    ],
  );
  const previousHeightRef = useRef<number | null>(null);
  const handleHeightChange = useCallback(
    (height: number) => {
      if (previousHeightRef.current == null) {
        previousHeightRef.current = height;
        return;
      }
      if (previousHeightRef.current !== height) {
        previousHeightRef.current = height;
        onHeightChange();
      }
    },
    [onHeightChange],
  );

  return (
    <Fragment>
      <div className="review-comment">
        <ReviewAvatar author={comment.author} identity={identity} />
        <div className="review-comment-body">
          <div
            className={`review-comment-header${
              (isPullRequest && !comment.isReadOnly) ||
              canEditExistingComment ||
              comment.canDelete ||
              editingExistingComment
                ? ' with-comment-action'
                : ''
            }${comment.isReadOnly ? ' read-only' : ''}`}
          >
            <strong>{displayName}</strong>
            {editingExistingComment ? (
              <span className="general-comment-edit-actions">
                <button
                  className="review-comment-action"
                  disabled={editSubmitting}
                  onClick={handleCancelEdit}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="review-comment-action"
                  disabled={!canSaveEdit}
                  onClick={handleSaveEdit}
                  type="button"
                >
                  {editSubmitting ? 'Saving' : 'Save'}
                </button>
              </span>
            ) : canEditExistingComment ? (
              <button
                className="review-comment-action"
                onClick={handleStartEdit}
                onFocus={preloadMarkdownEditor}
                onPointerEnter={preloadMarkdownEditor}
                type="button"
              >
                Edit
              </button>
            ) : null}
            {comment.isReadOnly && comment.canDelete ? (
              <button
                aria-label="Delete comment"
                className="review-comment-delete"
                onClick={() => onDeleteComment(comment.id)}
                title="Delete comment"
                type="button"
              >
                <X aria-hidden className="review-comment-delete-icon" size={14} weight="bold" />
              </button>
            ) : null}
            {!comment.isReadOnly && onAskCodex ? (
              <button
                className="review-comment-action"
                disabled={!canAskCodex}
                onClick={handleAskCodex}
                title={
                  canAskCodex ? `Ask ${agentLabel}` : `Write a note before asking ${agentLabel}`
                }
                type="button"
              >
                <img
                  alt=""
                  aria-hidden
                  className="review-comment-action-icon"
                  draggable={false}
                  src={agentIconUrl(agentId)}
                />
                Ask
              </button>
            ) : null}
            {isPullRequest && !comment.isReadOnly ? (
              <button
                className="review-comment-action"
                disabled={!commentCanSubmit}
                onClick={handleSubmitComment}
                title={
                  commentCanSubmit ? 'Submit review comment' : 'Write a note before commenting'
                }
                type="button"
              >
                <ChatCircle
                  aria-hidden
                  className="review-comment-action-icon"
                  size={14}
                  weight="bold"
                />
                {comment.remoteSubmit?.status === 'submitting' ? 'Sending' : 'Comment'}
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
                <X aria-hidden className="review-comment-delete-icon" size={14} weight="bold" />
              </button>
            ) : null}
          </div>
          {editingExistingComment ? (
            <>
              <Suspense
                fallback={
                  <ReadOnlyMarkdownView
                    ariaLabel={`Comment on ${comment.filePath} ${getReviewCommentLineLabel(
                      comment,
                    )}`}
                    className="review-comment-markdown-editor"
                    contentClassName="review-comment-input read-only"
                    fallback={<div className="review-comment-input read-only" />}
                    onHeightChange={handleHeightChange}
                    value={displayedBody}
                    variant="embedded"
                  />
                }
              >
                <div
                  className={`review-comment-edit-shell${editEditorReady ? ' ready' : ' loading'}`}
                >
                  {!editEditorReady ? (
                    <ReadOnlyMarkdownView
                      ariaLabel={`Comment on ${comment.filePath} ${getReviewCommentLineLabel(
                        comment,
                      )}`}
                      className="review-comment-markdown-editor review-comment-edit-preview"
                      contentClassName="review-comment-input read-only"
                      fallback={<div className="review-comment-input read-only" />}
                      onHeightChange={handleHeightChange}
                      value={displayedBody}
                      variant="embedded"
                    />
                  ) : null}
                  <div className="review-comment-edit-editor">
                    <MarkdownEditor
                      ariaLabel={`Edit comment on ${comment.filePath} ${getReviewCommentLineLabel(
                        comment,
                      )}`}
                      className="review-comment-markdown-editor"
                      colorScheme="inherit"
                      contentClassName="review-comment-input"
                      density="compact"
                      onChange={handleEditDraftChange}
                      onHeightChange={handleHeightChange}
                      onKeyDown={handleEditKeyDown}
                      readOnly={editSubmitting}
                      ref={setEditEditorRef}
                      spellCheck
                      value={editDraft}
                      variant="embedded"
                    />
                  </div>
                </div>
              </Suspense>
              {editError ? <div className="review-comment-error">{editError}</div> : null}
            </>
          ) : comment.isReadOnly ? (
            <ReadOnlyMarkdownView
              ariaLabel={`Comment on ${comment.filePath} ${getReviewCommentLineLabel(comment)}`}
              className="review-comment-markdown-editor"
              contentClassName="review-comment-input read-only"
              fallback={<div className="review-comment-input read-only" />}
              onHeightChange={handleHeightChange}
              value={displayedBody}
              variant="embedded"
            />
          ) : (
            <Suspense fallback={<div className="review-comment-input" />}>
              <MarkdownEditor
                ariaLabel={`Comment on ${comment.filePath} ${getReviewCommentLineLabel(comment)}`}
                className="review-comment-markdown-editor"
                colorScheme="inherit"
                contentClassName="review-comment-input"
                density="compact"
                onBlur={handleBlur}
                onChange={handleChange}
                onFocus={handleFocus}
                onHeightChange={handleHeightChange}
                onKeyDown={handleKeyDown}
                placeholder="Write a review comment…"
                ref={comment.id === focusCommentId ? focusEditorRef : undefined}
                spellCheck
                value={draft}
                variant="embedded"
              />
            </Suspense>
          )}
          {comment.remoteSubmit?.status === 'error' ? (
            <div className="review-comment-error">{comment.remoteSubmit.error}</div>
          ) : null}
        </div>
      </div>
      {comment.codexReply ? (
        <div className="review-comment codex">
          <AgentAvatar agentId={agentId} />
          <div className="review-comment-body codex">
            <div className="review-comment-header codex">
              <strong>{agentLabel}</strong>
            </div>
            <div
              className={`review-comment-codex-reply${
                comment.codexReply.status === 'loading' ? ' is-loading' : ''
              }${comment.codexReply.status === 'error' ? ' error' : ''}`}
            >
              {comment.codexReply.status === 'loading' ? (
                <span className="review-comment-codex-loading">Waiting for {agentLabel}…</span>
              ) : (
                <ReadOnlyMarkdown
                  ariaLabel={`${agentLabel} reply`}
                  className="review-comment-codex-reply-markdown"
                  density="compact"
                  onHeightChange={handleHeightChange}
                  value={comment.codexReply.body ?? comment.codexReply.error ?? ''}
                  variant="embedded"
                />
              )}
            </div>
          </div>
        </div>
      ) : null}
    </Fragment>
  );
}

const groupReviewCommentsByThread = (comments: ReadonlyArray<ReviewComment>) => {
  const groups: Array<{ comments: Array<ReviewComment>; key: string }> = [];
  const groupByThreadId = new Map<string, { comments: Array<ReviewComment>; key: string }>();

  for (const comment of comments) {
    if (!comment.threadId) {
      groups.push({ comments: [comment], key: comment.id });
      continue;
    }

    let group = groupByThreadId.get(comment.threadId);
    if (!group) {
      group = { comments: [], key: `thread:${comment.threadId}` };
      groupByThreadId.set(comment.threadId, group);
      groups.push(group);
    }
    group.comments.push(comment);
  }

  return groups;
};

const noopResolveThread = () => {};

function ReviewCommentThreadGroup({
  agentId,
  agentLabel,
  comments,
  focusCommentId,
  focusEditorRef,
  identity,
  isPullRequest,
  keymap,
  onAskCodex,
  onCommentBlur,
  onCommentFocus,
  onDeleteComment,
  onHeightChange,
  onReplyToThread,
  onResolveThread = noopResolveThread,
  onSaveCommentEdit,
  onSubmitComment,
  onUpdateComment,
}: {
  agentId: 'codex' | 'claude' | 'opencode' | 'pi';
  agentLabel: string;
  comments: ReadonlyArray<ReviewComment>;
  focusCommentId: string | null;
  focusEditorRef: (node: MarkdownEditorHandle | null) => void;
  identity: GitIdentity | null;
  isPullRequest: boolean;
  keymap: CodiffKeymap;
  onAskCodex?: (commentId: string) => void;
  onCommentBlur: (comment: ReviewComment, body: string) => void;
  onCommentFocus: (comment: ReviewComment) => void;
  onDeleteComment: (commentId: string) => void;
  onHeightChange: () => void;
  onReplyToThread: (threadId: string, comment: ReviewComment) => void;
  onResolveThread?: (threadId: string, resolved: boolean) => Promise<void> | void;
  onSaveCommentEdit: (commentId: string, body: string) => Promise<void> | void;
  onSubmitComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, body: string) => void;
}) {
  const [resolveState, setResolveState] = useState<{
    error: string | null;
    submitting: boolean;
    threadId: string | null;
  }>({ error: null, submitting: false, threadId: null });
  const lastComment = comments.at(-1);
  const threadId = lastComment?.threadId;
  const threadResolved = comments.some((comment) => comment.isThreadResolved === true);
  const canResolveThread =
    isPullRequest &&
    threadId != null &&
    comments.some((comment) => comment.canResolveThread === true);
  const canReplyToThread =
    isPullRequest &&
    threadId != null &&
    comments.some((comment) => comment.isReadOnly) &&
    !comments.some((comment) => !comment.isReadOnly) &&
    !comments.some((comment) => comment.canReplyThread === false) &&
    !threadResolved;
  const hasThreadActions = canReplyToThread || canResolveThread;
  const resolving = resolveState.threadId === threadId && resolveState.submitting;
  const resolveError = resolveState.threadId === threadId ? resolveState.error : null;

  const handleReply = useCallback(() => {
    if (!threadId || !lastComment) {
      return;
    }
    onReplyToThread(threadId, lastComment);
  }, [lastComment, onReplyToThread, threadId]);

  const handleResolve = useCallback(() => {
    if (!threadId || resolving) {
      return;
    }
    setResolveState({ error: null, submitting: true, threadId });
    void Promise.resolve(onResolveThread(threadId, !threadResolved))
      .then(() => setResolveState({ error: null, submitting: false, threadId }))
      .catch((error: unknown) => {
        setResolveState({
          error: error instanceof Error ? error.message : String(error),
          submitting: false,
          threadId,
        });
      });
  }, [onResolveThread, resolving, threadId, threadResolved]);

  return (
    <div className="review-comment-thread-group">
      {comments.map((comment) => {
        const displayName =
          comment.author?.name ||
          comment.author?.login ||
          identity?.name ||
          identity?.email ||
          'Git user';

        return (
          <ReviewCommentEditor
            agentId={agentId}
            agentLabel={agentLabel}
            comment={comment}
            displayName={displayName}
            focusCommentId={focusCommentId}
            focusEditorRef={focusEditorRef}
            identity={identity}
            isPullRequest={isPullRequest}
            key={comment.id}
            keymap={keymap}
            onAskCodex={onAskCodex}
            onCommentBlur={onCommentBlur}
            onCommentFocus={onCommentFocus}
            onDeleteComment={onDeleteComment}
            onHeightChange={onHeightChange}
            onSaveCommentEdit={onSaveCommentEdit}
            onSubmitComment={onSubmitComment}
            onUpdateComment={onUpdateComment}
          />
        );
      })}
      {hasThreadActions ? (
        <div className="review-comment-thread-footer">
          {resolveError ? (
            <span className="review-comment-thread-error">{resolveError}</span>
          ) : null}
          <div className="review-comment-thread-actions">
            {canReplyToThread ? (
              <button className="review-comment-action" onClick={handleReply} type="button">
                Reply
              </button>
            ) : null}
            {canResolveThread ? (
              <button
                className="review-comment-action"
                disabled={resolving}
                onClick={handleResolve}
                type="button"
              >
                {resolving ? 'Saving' : threadResolved ? 'Reopen' : 'Resolve'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReviewAnnotation({
  agentId,
  agentLabel,
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
  onHeightChange,
  onReplyToThread,
  onResolveThread = noopResolveThread,
  onSaveCommentEdit,
  onSubmitComment,
  onUpdateComment,
}: {
  agentId: 'codex' | 'claude' | 'opencode' | 'pi';
  agentLabel: string;
  annotation: DiffLineAnnotation<ReviewCommentAnnotationMetadata>;
  comments: ReadonlyArray<ReviewComment>;
  focusCommentId: string | null;
  focusCommentRequest: number;
  identity: GitIdentity | null;
  isPullRequest: boolean;
  keymap: CodiffKeymap;
  onAskCodex?: (commentId: string) => void;
  onCommentBlur: (comment: ReviewComment, body: string) => void;
  onCommentFocus: (comment: ReviewComment) => void;
  onDeleteComment: (commentId: string) => void;
  onHeightChange: () => void;
  onReplyToThread: (threadId: string, comment: ReviewComment) => void;
  onResolveThread?: (threadId: string, resolved: boolean) => Promise<void> | void;
  onSaveCommentEdit: (commentId: string, body: string) => Promise<void> | void;
  onSubmitComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, body: string) => void;
}) {
  const focusEditorRef = useRef<MarkdownEditorHandle>(null);
  const setFocusEditorRef = useCallback((node: MarkdownEditorHandle | null) => {
    focusEditorRef.current = node;
  }, []);
  const annotationComments = annotation.metadata.commentIds
    .map((commentId) => comments.find((comment) => comment.id === commentId))
    .filter((comment): comment is ReviewComment => comment != null);
  const hasFocusedComment =
    focusCommentId != null && annotationComments.some((comment) => comment.id === focusCommentId);

  useEffect(() => {
    if (hasFocusedComment) {
      focusEditorRef.current?.focus();
    }
  }, [focusCommentId, focusCommentRequest, hasFocusedComment]);

  if (annotationComments.length === 0) {
    return null;
  }
  const commentGroups = groupReviewCommentsByThread(annotationComments);

  return (
    <div className="review-comment-thread">
      {commentGroups.map((group) => (
        <ReviewCommentThreadGroup
          agentId={agentId}
          agentLabel={agentLabel}
          comments={group.comments}
          focusCommentId={focusCommentId}
          focusEditorRef={setFocusEditorRef}
          identity={identity}
          isPullRequest={isPullRequest}
          key={group.key}
          keymap={keymap}
          onAskCodex={onAskCodex}
          onCommentBlur={onCommentBlur}
          onCommentFocus={onCommentFocus}
          onDeleteComment={onDeleteComment}
          onHeightChange={onHeightChange}
          onReplyToThread={onReplyToThread}
          onResolveThread={onResolveThread}
          onSaveCommentEdit={onSaveCommentEdit}
          onSubmitComment={onSubmitComment}
          onUpdateComment={onUpdateComment}
        />
      ))}
    </div>
  );
}

const scrollTargetRetryFrameLimit = 90;

const getEffectiveScrollBehavior = (behavior: ReviewScrollBehavior) =>
  behavior === 'smooth' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? 'instant'
    : behavior;

type HunkNavigationRequest = {
  direction: 1 | -1;
  request: number;
};

// A jumpable, selectable position (a hunk or a review comment) with its
// estimated absolute Y. The dominant term is the item's real top from
// getTopForItem; only the within-item line offset is estimated, so cross-item
// ordering stays exact. `selection` is the line range highlighted while the
// anchor is the active nav target (null for collapsed/preview header anchors).
type NavAnchor = {
  itemId: string;
  key: string;
  scrollTarget: CodeViewScrollTarget;
  selection: SelectedLineRange | null;
  top: number;
};

type FileReviewDiffBlock = {
  comments?: ReadonlyArray<ReviewComment>;
  file: ChangedFile;
  fileSelected?: boolean;
  header?: ReactNode;
  headerSelected?: boolean;
  id: string;
  itemIdPrefix?: string;
  note?: string;
  reviewIdentity?: ReviewIdentity;
  selected?: boolean;
};

type HeaderReviewDiffBlock = {
  file?: undefined;
  header: ReactNode;
  headerSelected?: boolean;
  id: string;
  selected?: boolean;
};

export type ReviewDiffBlock = FileReviewDiffBlock | HeaderReviewDiffBlock;

const createFileReviewBlocks = (
  files: ReadonlyArray<ChangedFile>,
): ReadonlyArray<ReviewDiffBlock> =>
  files.map((file) => ({
    file,
    id: `file:${file.path}`,
  }));

const getBlockItemId = (block: FileReviewDiffBlock, section: DiffSection) =>
  block.itemIdPrefix ? `${block.itemIdPrefix}:${getItemId(section)}` : getItemId(section);

const getBlockHeaderItemId = (block: ReviewDiffBlock) => `${block.id}:walkthrough-header`;

const createInlineWalkthroughNote = (reason: string): WalkthroughNote => ({
  action: 'review',
  context: reason,
  groupReason: 'Walkthrough',
  groupTitle: 'Walkthrough',
  impact: 'contained',
  order: 0,
  reason,
});

const getBlockWalkthroughNote = (
  block: FileReviewDiffBlock,
  fallbackByPath: ReadonlyMap<string, WalkthroughNote>,
) => (block.note ? createInlineWalkthroughNote(block.note) : fallbackByPath.get(block.file.path));

const lineIsVisibleInFileDiff = (
  fileDiff: FileDiffMetadata,
  side: ReviewComment['side'],
  lineNumber: number,
) =>
  fileDiff.hunks.some((hunk) => {
    const hunkStart = side === 'deletions' ? hunk.deletionStart : hunk.additionStart;
    const hunkLineCount = side === 'deletions' ? hunk.deletionCount : hunk.additionCount;
    return lineNumber >= hunkStart && lineNumber < hunkStart + hunkLineCount;
  });

const reviewCommentAnchorIsVisibleInFileDiff = (
  comment: ReviewComment,
  fileDiff: FileDiffMetadata,
) =>
  !isLineReviewComment(comment) ||
  lineIsVisibleInFileDiff(fileDiff, comment.side, comment.lineNumber);

const diffSearchMatchIsVisibleInFileDiff = (match: DiffSearchMatch, fileDiff: FileDiffMetadata) => {
  if (match.lineNumber == null) {
    return true;
  }

  return match.side
    ? lineIsVisibleInFileDiff(fileDiff, match.side, match.lineNumber)
    : lineIsVisibleInFileDiff(fileDiff, 'additions', match.lineNumber) ||
        lineIsVisibleInFileDiff(fileDiff, 'deletions', match.lineNumber);
};

const dedupeReviewComments = (
  comments: ReadonlyArray<ReviewComment>,
): ReadonlyArray<ReviewComment> => {
  const deduped: Array<ReviewComment> = [];
  const seen = new Set<string>();
  for (const comment of comments) {
    if (seen.has(comment.id)) {
      continue;
    }
    seen.add(comment.id);
    deduped.push(comment);
  }
  return deduped;
};

const groupReviewCommentsBySection = (comments: ReadonlyArray<ReviewComment>) => {
  const map = new Map<string, Array<ReviewComment>>();
  for (const comment of comments) {
    const list = map.get(comment.sectionId);
    if (list) {
      list.push(comment);
    } else {
      map.set(comment.sectionId, [comment]);
    }
  }
  return map;
};

type RenderedSearchTarget = {
  fileDiff: FileDiffMetadata;
  itemId: string;
  path: string;
};

const resolveRenderedSearchMatch = (
  match: DiffSearchMatch | null,
  itemMetadata: ReadonlyMap<string, CodeViewItemMetadata>,
  searchTargetsByBaseItemId: ReadonlyMap<string, ReadonlyArray<RenderedSearchTarget>>,
): DiffSearchMatch | null => {
  if (!match) {
    return null;
  }

  if (itemMetadata.has(match.itemId)) {
    return match;
  }

  const candidates = searchTargetsByBaseItemId.get(match.itemId) ?? [];
  const candidate =
    candidates.find(
      (candidate) =>
        candidate.path === match.filePath &&
        diffSearchMatchIsVisibleInFileDiff(match, candidate.fileDiff),
    ) ??
    candidates.find((candidate) => candidate.path === match.filePath) ??
    candidates.find((candidate) => diffSearchMatchIsVisibleInFileDiff(match, candidate.fileDiff)) ??
    candidates[0];

  return candidate ? { ...match, itemId: candidate.itemId } : null;
};

// Estimate the rendered row index of a file line inside a diff item so comment
// anchors sort against hunk anchors within the same item.
const estimateRenderedLineIndex = (
  fileDiff: FileDiffMetadata,
  lineNumber: number,
  side: 'additions' | 'deletions',
  diffStyle: CodiffDiffStyle,
): number => {
  for (const hunk of fileDiff.hunks) {
    const start = side === 'deletions' ? hunk.deletionStart : hunk.additionStart;
    const count = side === 'deletions' ? hunk.deletionCount : hunk.additionCount;
    if (lineNumber < start || lineNumber >= start + count) {
      continue;
    }

    let deletionLineNumber = hunk.deletionStart;
    let additionLineNumber = hunk.additionStart;
    let splitLineIndex = hunk.splitLineStart;
    let unifiedLineIndex = hunk.unifiedLineStart;

    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        const currentLineNumber = side === 'deletions' ? deletionLineNumber : additionLineNumber;
        if (lineNumber < currentLineNumber + content.lines) {
          const difference = lineNumber - currentLineNumber;
          return (diffStyle === 'split' ? splitLineIndex : unifiedLineIndex) + difference;
        }

        deletionLineNumber += content.lines;
        additionLineNumber += content.lines;
        splitLineIndex += content.lines;
        unifiedLineIndex += content.lines;
        continue;
      }

      const sideCount = side === 'deletions' ? content.deletions : content.additions;
      const currentLineNumber = side === 'deletions' ? deletionLineNumber : additionLineNumber;
      if (lineNumber < currentLineNumber + sideCount) {
        const difference = lineNumber - currentLineNumber;
        return (
          (diffStyle === 'split'
            ? splitLineIndex
            : unifiedLineIndex + (side === 'additions' ? content.deletions : 0)) + difference
        );
      }

      deletionLineNumber += content.deletions;
      additionLineNumber += content.additions;
      splitLineIndex += Math.max(content.deletions, content.additions);
      unifiedLineIndex += content.deletions + content.additions;
    }
  }
  return 0;
};

const isInteractiveKeyboardTarget = (target: EventTarget | null) => {
  const candidate = target as
    | (EventTarget & {
        closest?: (selector: string) => Element | null;
        isContentEditable?: boolean;
      })
    | null;

  return (
    isNativeInputTarget(target) ||
    candidate?.closest?.(
      [
        'a[href]',
        'area[href]',
        'button',
        'summary',
        '[role="button"]',
        '[role="checkbox"]',
        '[role="link"]',
        '[role="menuitem"]',
        '[role="menuitemcheckbox"]',
        '[role="menuitemradio"]',
        '[role="option"]',
        '[role="radio"]',
        '[role="slider"]',
        '[role="switch"]',
        '[role="tab"]',
      ].join(', '),
    ) != null ||
    candidate?.isContentEditable === true
  );
};

// The span of changed lines in a hunk — the green/red bit, excluding the
// surrounding context — so navigating highlights just the change. Prefers the
// additions side; falls back to deletions for pure-deletion hunks.
const getHunkSelectionRange = (
  hunk: FileDiffMetadata['hunks'][number],
): SelectedLineRange | null => {
  const side: 'additions' | 'deletions' | null =
    hunk.additionLines > 0 ? 'additions' : hunk.deletionLines > 0 ? 'deletions' : null;
  if (!side) {
    return null;
  }

  let additionLine = hunk.additionStart;
  let deletionLine = hunk.deletionStart;
  let start: number | null = null;
  let end: number | null = null;

  for (const content of hunk.hunkContent) {
    if (content.type === 'context') {
      additionLine += content.lines;
      deletionLine += content.lines;
      continue;
    }

    const changed = side === 'additions' ? content.additions : content.deletions;
    if (changed > 0) {
      const blockStart = side === 'additions' ? additionLine : deletionLine;
      start = start ?? blockStart;
      end = blockStart + changed - 1;
    }
    additionLine += content.additions;
    deletionLine += content.deletions;
  }

  return start != null && end != null ? { end, endSide: side, side, start } : null;
};

const isSameSelection = (a: SelectedLineRange, b: SelectedLineRange) =>
  a.start === b.start && a.end === b.end && a.side === b.side;

export function ReviewCodeView({
  activeSearchMatch,
  agentId,
  agentLabel,
  allowViewedToggle = false,
  blocks,
  bottomInset = codeViewLayout.paddingBottom,
  collapsed,
  comments,
  commitMetadata,
  diffLineHeight = DIFF_LINE_HEIGHT,
  diffStyle,
  disableWorkerPool = false,
  expandedGenerated = emptyExpandedGenerated,
  files,
  focusCommentId,
  focusCommentRequest,
  forceExpandedPaths,
  gitIdentity,
  hunkNavigation,
  initialMarkdownPreviewSectionIds = emptyMarkdownPreviewSectionIds,
  isPullRequest,
  isReadOnly = false,
  itemVersionByKey,
  keymap,
  loadingSectionIds,
  onActiveBlockChange,
  onAskCodex,
  onCreateComment,
  onDeleteComment,
  onLoadImageContent,
  onLoadSection,
  onOpenFile,
  onRefreshMarkdown,
  onResolveThread = noopResolveThread,
  onSaveCommentEdit,
  onSelectPathFromScroll,
  onSubmitComment,
  onToggleCollapsed,
  onToggleViewed,
  onUpdateComment,
  onUpdateSourceDescription,
  onUpdateSourceTitle,
  onUploadSourceDescriptionAsset,
  reviewIdentityByPath,
  scrollTarget,
  searchQuery,
  selectedPath,
  showSourceDescription = true,
  showWhitespace,
  source,
  sourceDescriptionActions,
  sourceDescriptionFooter,
  sourceDescriptionFooterKey,
  theme = 'system',
  viewed,
  walkthroughNotes,
  wordWrap,
}: {
  activeSearchMatch: DiffSearchMatch | null;
  agentId: 'codex' | 'claude' | 'opencode' | 'pi';
  agentLabel: string;
  allowViewedToggle?: boolean;
  blocks?: ReadonlyArray<ReviewDiffBlock>;
  bottomInset?: number;
  collapsed: ReadonlySet<string>;
  comments: ReadonlyArray<ReviewComment>;
  commitMetadata: CommitMetadata | null;
  diffLineHeight?: number;
  diffStyle: CodiffDiffStyle;
  disableWorkerPool?: boolean;
  expandedGenerated?: ReadonlySet<string>;
  files: ReadonlyArray<ChangedFile>;
  focusCommentId: string | null;
  focusCommentRequest: number;
  forceExpandedPaths: ReadonlySet<string>;
  gitIdentity: GitIdentity | null;
  hunkNavigation: HunkNavigationRequest | null;
  initialMarkdownPreviewSectionIds?: ReadonlySet<string>;
  isPullRequest: boolean;
  isReadOnly?: boolean;
  itemVersionByKey: Readonly<Record<string, number>>;
  keymap: CodiffKeymap;
  loadingSectionIds: ReadonlySet<string>;
  onActiveBlockChange?: (blockId: string) => void;
  onAskCodex?: (commentId: string) => void;
  onCreateComment: (comment: Omit<ReviewComment, 'body' | 'id'>) => void;
  onDeleteComment: (commentId: string) => void;
  onLoadImageContent?: (request: DiffImageContentRequest) => Promise<DiffImageContentResult>;
  onLoadSection: (file: ChangedFile, section: DiffSection) => void;
  onOpenFile?: (file: ChangedFile) => void;
  onRefreshMarkdown?: (file: ChangedFile, section: DiffSection) => Promise<boolean>;
  onResolveThread?: (threadId: string, resolved: boolean) => Promise<void> | void;
  onSaveCommentEdit: (commentId: string, body: string) => Promise<void> | void;
  onSelectPathFromScroll: (viewer: CodeViewInstance) => void;
  onSubmitComment: (commentId: string) => void;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean, reviewKey: string) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean, reviewIdentity: ReviewIdentity) => void;
  onUpdateComment: (commentId: string, body: string) => void;
  onUpdateSourceDescription?: (body: string) => Promise<void> | void;
  onUpdateSourceTitle?: (title: string) => Promise<void> | void;
  onUploadSourceDescriptionAsset?: (file: File) => Promise<string> | string;
  reviewIdentityByPath?: ReadonlyMap<string, ReviewIdentity>;
  scrollTarget: ReviewScrollTarget | null;
  searchQuery: string;
  selectedPath: string | null;
  showSourceDescription?: boolean;
  showWhitespace: boolean;
  source: ReviewSource;
  sourceDescriptionActions?: ReactNode;
  sourceDescriptionFooter?: ReactNode;
  sourceDescriptionFooterKey?: string;
  theme?: CodiffPreferences['theme'];
  viewed: Record<string, string>;
  walkthroughNotes: ReadonlyMap<string, WalkthroughNote>;
  wordWrap: boolean;
}) {
  const codeViewRef = useRef<CodeViewHandle<ReviewAnnotationMetadata>>(null);
  const markdownEditorRefs = useRef(new Map<string, MarkdownDocumentEditorHandle>());
  const refreshingMarkdownSectionsRef = useRef(new Set<string>());
  const deferredTimersRef = useRef<Set<number>>(new Set());
  const handledScrollRequestRef = useRef<number | null>(null);
  const handledHunkNavRef = useRef<number | null>(hunkNavigation?.request ?? null);
  const emptyCommentDeleteTimersRef = useRef<Map<string, number>>(new Map());
  const highlightFrameRef = useRef<number | null>(null);
  const ignoreNextLineSelectionEndRef = useRef(false);
  const navigatedSelectionRef = useRef<CodeViewLineSelection | null>(null);
  const initialMarkdownFiles =
    files.length > 0
      ? files
      : (blocks?.map((block) => block.file).filter((file): file is ChangedFile => file != null) ??
        []);
  const initialEditableMarkdownSections =
    !isReadOnly && source.type === 'working-tree'
      ? initialMarkdownFiles.flatMap((file) => {
          const section = file.sections.at(-1);
          return file.status !== 'deleted' && isMarkdownFilePath(file.path) && section
            ? [section.id]
            : [];
        })
      : [];
  const [markdownPreviewSections, setMarkdownPreviewSections] = useState<ReadonlySet<string>>(
    () => new Set([...initialMarkdownPreviewSectionIds, ...initialEditableMarkdownSections]),
  );
  // Markdown previews render inside a CodeView item. Change the item version once after the
  // preview appears so CodeView measures the preview height instead of the placeholder height.
  const [markdownPreviewLayoutPassBySection, setMarkdownPreviewLayoutPassBySection] = useState<
    Readonly<Record<string, number>>
  >({});
  const [imagePreviewLayoutPassBySection, setImagePreviewLayoutPassBySection] = useState<
    Readonly<Record<string, number>>
  >({});
  const [commentLayoutPassByItem, setCommentLayoutPassByItem] = useState<
    Readonly<Record<string, number>>
  >({});
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const selectedLinesRef = useRef<CodeViewLineSelection | null>(null);
  const commitMessageMetadata = source.type === 'commit' ? commitMetadata : null;
  const shouldShowCommitMessage = commitMessageMetadata != null;
  const shouldShowSourceDescription = showSourceDescription && source.type === 'pull-request';
  const sourceDescription = shouldShowCommitMessage
    ? commitMessageMetadata.body.trim()
    : shouldShowSourceDescription
      ? (source.description?.trim() ?? '')
      : '';
  const sourceDescriptionHasBody = sourceDescription.length > 0;
  const sourceDescriptionHasContent = sourceDescriptionHasBody || shouldShowCommitMessage;
  const canEditSourceDescription =
    shouldShowSourceDescription &&
    source.canEditDescription === true &&
    onUpdateSourceDescription != null;
  const canEditSourceTitle =
    shouldShowSourceDescription &&
    (source.canEditTitle === true || source.canEditDescription === true) &&
    onUpdateSourceTitle != null;
  const sourceAuthor = shouldShowCommitMessage
    ? getCommitDescriptionAuthor(commitMessageMetadata.author)
    : shouldShowSourceDescription && source.author
      ? getPullRequestDescriptionAuthor(source.author)
      : undefined;
  const sourceTitle = shouldShowCommitMessage
    ? commitMessageMetadata.subject.trim() || commitMessageMetadata.shortRef
    : shouldShowSourceDescription
      ? (source.title?.trim() ?? '')
      : '';
  const sourceDescriptionItemId =
    shouldShowCommitMessage && source.type === 'commit'
      ? `commit-message:${source.ref}`
      : shouldShowSourceDescription && (sourceDescription || sourceTitle)
        ? `source-description:${source.provider ?? ''}:${source.url}`
        : null;
  const sourceDescriptionLabel = shouldShowCommitMessage
    ? 'Commit'
    : source.type === 'pull-request'
      ? getPullRequestDescriptionLabel(source)
      : '';
  const sourceDescriptionAriaLabel = shouldShowCommitMessage
    ? 'Preview commit message'
    : 'Preview source description';
  const [sourceDescriptionLayoutPass, setSourceDescriptionLayoutPass] = useState(0);
  const [collapsedSourceDescriptionItemId, setCollapsedSourceDescriptionItemId] = useState<
    string | null
  >(null);
  const sourceDescriptionCollapsed =
    (!sourceDescriptionHasContent && !canEditSourceDescription) ||
    collapsedSourceDescriptionItemId === sourceDescriptionItemId;
  const toggleSourceDescriptionCollapsed = useCallback(() => {
    setCollapsedSourceDescriptionItemId((current) =>
      current === sourceDescriptionItemId ? null : sourceDescriptionItemId,
    );
  }, [sourceDescriptionItemId]);
  const stickyHeaderFrameRef = useRef<number | null>(null);

  const reviewBlocks = useMemo(() => blocks ?? createFileReviewBlocks(files), [blocks, files]);
  const commentLookup = useMemo(() => {
    const map = new Map<string, ReviewComment>();
    for (const comment of comments) {
      map.set(comment.id, comment);
    }
    for (const block of reviewBlocks) {
      if (!block.file) {
        continue;
      }
      for (const comment of block.comments ?? []) {
        map.set(comment.id, comment);
      }
    }
    return map;
  }, [comments, reviewBlocks]);
  const renderComments = useMemo(() => [...commentLookup.values()], [commentLookup]);
  const commentsBySection = useMemo(() => groupReviewCommentsBySection(comments), [comments]);

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

  const markCommentLayoutChanged = useCallback((itemId: string) => {
    setCommentLayoutPassByItem((current) => ({
      ...current,
      [itemId]: (current[itemId] ?? 0) + 1,
    }));
  }, []);

  const markSourceDescriptionLayoutReady = useCallback((_layoutKey: string) => {
    setSourceDescriptionLayoutPass((current) => current + 1);
  }, []);

  const {
    firstItemByBlockId,
    firstItemByPath,
    itemBlockId,
    itemMetadata,
    items,
    searchTargetsByBaseItemId,
  } = useMemo(() => {
    const nextItems: Array<CodeViewItem<ReviewAnnotationMetadata>> = [];
    const nextFirstItemByBlockId = new Map<string, string>();
    const nextFirstItemByPath = new Map<string, string>();
    const nextItemBlockId = new Map<string, string>();
    const nextItemMetadata = new Map<string, CodeViewItemMetadata>();
    const nextSearchTargetsByBaseItemId = new Map<string, Array<RenderedSearchTarget>>();
    const fontLayoutKey = `line-height:${diffLineHeight}`;

    if (sourceDescriptionItemId) {
      const sourceDescriptionLayoutKey = `${sourceDescriptionItemId}:${sourceTitle}:${sourceDescription}:${sourceAuthor?.displayName ?? ''}:${sourceAuthor?.title ?? ''}:${sourceAuthor?.avatarUrl ?? ''}:${sourceDescriptionCollapsed ? 'collapsed' : 'open'}:${sourceDescriptionFooterKey ?? ''}`;
      nextItems.push({
        annotations: [
          {
            lineNumber: 1,
            metadata: {
              header: (
                <>
                  <SourceDescriptionBody
                    ariaLabel={sourceDescriptionAriaLabel}
                    author={sourceAuthor}
                    canEdit={canEditSourceDescription}
                    description={sourceDescription}
                    keymap={keymap}
                    layoutKey={sourceDescriptionLayoutKey}
                    onLayoutReady={markSourceDescriptionLayoutReady}
                    onUpdateDescription={onUpdateSourceDescription}
                    onUploadDescriptionAsset={onUploadSourceDescriptionAsset}
                  />
                  {sourceDescriptionFooter ? (
                    <div className="codiff-source-description-footer">
                      {sourceDescriptionFooter}
                    </div>
                  ) : null}
                </>
              ),
              type: 'walkthrough-header',
            },
          } satisfies LineAnnotation<ReviewAnnotationMetadata>,
        ].filter(
          () =>
            (sourceDescriptionHasContent || canEditSourceDescription) &&
            !sourceDescriptionCollapsed,
        ),
        // The header (rendered via renderCustomHeader) carries the title; the body is the
        // collapsible content.
        collapsed: sourceDescriptionCollapsed,
        file: {
          cacheKey: sourceDescriptionLayoutKey,
          contents: ' ',
          lang: 'text',
          name: shouldShowCommitMessage ? 'commit-message.md' : 'source-description.md',
        },
        id: sourceDescriptionItemId,
        type: 'file',
        version: getItemVersion(
          `${sourceDescriptionLayoutKey}:${fontLayoutKey}:${sourceDescriptionLayoutPass}`,
        ),
      });
    }

    for (const block of reviewBlocks) {
      if (block.header) {
        const headerId = getBlockHeaderItemId(block);
        nextFirstItemByBlockId.set(block.id, nextFirstItemByBlockId.get(block.id) ?? headerId);
        nextItemBlockId.set(headerId, block.id);
        nextItems.push({
          annotations: [
            {
              lineNumber: 1,
              metadata: {
                header: block.header,
                type: 'walkthrough-header',
              },
            } satisfies LineAnnotation<ReviewAnnotationMetadata>,
          ],
          collapsed: false,
          file: {
            cacheKey: `walkthrough-header:${block.id}`,
            contents: ' ',
            lang: 'text',
            name: headerId,
          },
          id: headerId,
          type: 'file',
          version: getItemVersion(
            `${block.id}:walkthrough-header:${
              (block.headerSelected ?? block.selected) === true ? 'selected' : 'idle'
            }`,
          ),
        });
      }

      if (!block.file) {
        continue;
      }

      const file = block.file;
      const reviewIdentity = block.reviewIdentity ?? getReviewIdentity(file, reviewIdentityByPath);
      const reviewKey = reviewIdentity.key;
      const isViewed = isReviewIdentityViewed(viewed, reviewIdentity);
      const isCollapsed =
        !forceExpandedPaths.has(file.path) &&
        !expandedGenerated.has(reviewKey) &&
        (collapsed.has(reviewKey) || isGeneratedWalkthroughFile(file));
      const visibleSections = getVisibleDiffSections(file, showWhitespace);
      const lineCount = getDiffLineCountFromVisibleSections(visibleSections);
      const sections = isCollapsed ? visibleSections.slice(0, 1) : visibleSections;
      const walkthroughNote = getBlockWalkthroughNote(block, walkthroughNotes);
      const blockCommentsBySection = groupReviewCommentsBySection(block.comments ?? []);

      for (const [index, { fileDiff, section }] of sections.entries()) {
        const baseItemId = getItemId(section);
        const id = getBlockItemId(block, section);
        nextItemBlockId.set(id, block.id);
        const searchTargets = nextSearchTargetsByBaseItemId.get(baseItemId) ?? [];
        searchTargets.push({ fileDiff, itemId: id, path: file.path });
        nextSearchTargetsByBaseItemId.set(baseItemId, searchTargets);
        const markdownPreview = getMarkdownPreviewContents(file, section, fileDiff);
        const canRenderImage =
          !isReadOnly && onLoadImageContent != null && canRenderImagePreview(file.path, section);
        const canRenderMarkdown = markdownPreview != null;
        const canEditMarkdown =
          canRenderMarkdown &&
          !isReadOnly &&
          source.type === 'working-tree' &&
          file.status !== 'deleted' &&
          file.sections.at(-1)?.id === section.id;
        const isMarkdownPreview = canRenderMarkdown && markdownPreviewSections.has(section.id);
        const isSelected = block.fileSelected ?? block.selected ?? selectedPath === file.path;
        const reviewVersionPrefix = `${itemVersionByKey[reviewKey] ?? 0}:${block.id}:${
          reviewIdentity.fingerprint
        }:${reviewKey}:${section.id}:${commentLayoutPassByItem[id] ?? 0}`;
        const sectionStateVersionKey = `${isCollapsed ? 'collapsed' : 'open'}:${
          isViewed ? 'viewed' : 'pending'
        }:${index}:${fontLayoutKey}:${walkthroughNote?.reason ?? ''}`;
        const annotationMap = new Map<string, DiffLineAnnotation<ReviewAnnotationMetadata>>();
        const globalSectionComments = commentsBySection.get(section.id) ?? [];
        const visibleGlobalComments = globalSectionComments.filter(
          (comment) =>
            comment.filePath === file.path &&
            reviewCommentAnchorIsVisibleInFileDiff(comment, fileDiff),
        );
        const blockSectionComments = blockCommentsBySection.get(section.id) ?? [];
        const sectionComments = dedupeReviewComments([
          ...visibleGlobalComments,
          ...blockSectionComments,
        ]);
        for (const comment of sectionComments) {
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
            const isLineComment = isLineReviewComment(comment);
            annotationMap.set(key, {
              lineNumber: isLineComment ? comment.lineNumber : 0,
              metadata: {
                commentIds: [comment.id],
                type: 'review-comment',
              },
              side: isLineComment
                ? comment.side
                : file.status === 'deleted'
                  ? 'deletions'
                  : 'additions',
            });
          }
        }
        const fileCommentAnnotations = [...annotationMap.values()].filter(
          (annotation) => annotation.lineNumber === 0,
        );

        nextItemMetadata.set(id, {
          blockId: block.id,
          canEditMarkdown,
          canRenderMarkdown,
          comments: sectionComments,
          file,
          isCollapsed,
          isMarkdownPreview,
          isSelected,
          isViewed,
          lineCount,
          reviewIdentity,
          section,
          sectionCount: file.sections.length,
          walkthroughNote,
        });
        nextFirstItemByBlockId.set(block.id, nextFirstItemByBlockId.get(block.id) ?? id);
        nextFirstItemByPath.set(file.path, nextFirstItemByPath.get(file.path) ?? id);
        if (canRenderImage) {
          nextItems.push({
            annotations: [
              ...fileCommentAnnotations,
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
              `${reviewVersionPrefix}:image:${sectionStateVersionKey}:${
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
              ...fileCommentAnnotations,
              {
                lineNumber: 1,
                metadata: {
                  addedLines: markdownPreview.addedLines,
                  contents: markdownPreview.contents,
                  editable: canEditMarkdown,
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
              `${reviewVersionPrefix}:markdown:${sectionStateVersionKey}:${
                markdownPreviewLayoutKey
              }:${markdownPreviewLayoutPassBySection[section.id] ?? 0}`,
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
            `${reviewVersionPrefix}:${sectionStateVersionKey}:${
              showWhitespace ? 'ws' : 'ignore-ws'
            }:${diffStyle}:${getReviewCommentsDigest(sectionComments)}`,
          ),
        });
      }
    }

    return {
      firstItemByBlockId: nextFirstItemByBlockId,
      firstItemByPath: nextFirstItemByPath,
      itemBlockId: nextItemBlockId,
      itemMetadata: nextItemMetadata,
      items: nextItems,
      searchTargetsByBaseItemId: nextSearchTargetsByBaseItemId,
    };
  }, [
    collapsed,
    canEditSourceDescription,
    commentLayoutPassByItem,
    commentsBySection,
    diffLineHeight,
    diffStyle,
    expandedGenerated,
    forceExpandedPaths,
    imagePreviewLayoutPassBySection,
    isReadOnly,
    itemVersionByKey,
    keymap,
    markSourceDescriptionLayoutReady,
    markdownPreviewLayoutPassBySection,
    markdownPreviewSections,
    onLoadImageContent,
    onUpdateSourceDescription,
    onUploadSourceDescriptionAsset,
    reviewBlocks,
    selectedPath,
    showWhitespace,
    sourceAuthor,
    sourceDescriptionAriaLabel,
    sourceDescription,
    sourceDescriptionCollapsed,
    sourceDescriptionFooter,
    sourceDescriptionFooterKey,
    sourceDescriptionHasContent,
    sourceDescriptionItemId,
    sourceDescriptionLayoutPass,
    sourceTitle,
    shouldShowCommitMessage,
    source.type,
    viewed,
    reviewIdentityByPath,
    walkthroughNotes,
  ]);

  const clearCommentLineHighlight = useCallback(() => {
    codeViewRef.current?.clearSelectedLines();
    navigatedSelectionRef.current = null;
    setSelectedLines(null);
  }, []);

  const resolvedActiveSearchMatch = useMemo(
    () => resolveRenderedSearchMatch(activeSearchMatch, itemMetadata, searchTargetsByBaseItemId),
    [activeSearchMatch, itemMetadata, searchTargetsByBaseItemId],
  );

  const setCodeViewSelectedLines = useCallback((selection: CodeViewLineSelection | null) => {
    if (
      selection == null ||
      navigatedSelectionRef.current == null ||
      selection.id !== navigatedSelectionRef.current.id ||
      !isSameSelection(selection.range, navigatedSelectionRef.current.range)
    ) {
      navigatedSelectionRef.current = null;
    }
    setSelectedLines(selection);
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

  const scrollFileItemToTop = useCallback((itemId: string) => {
    const handle = codeViewRef.current;
    const viewer = handle?.getInstance();
    if (!handle || !viewer || viewer.getTopForItem(itemId) == null) {
      return;
    }

    handle.scrollTo({
      behavior: 'smooth-auto',
      id: itemId,
      offset: DEFAULT_PADDING,
      type: 'item',
    });
  }, []);

  const canCreateFileComments =
    !isReadOnly && source.type === 'pull-request' && source.provider === 'gitlab';

  const createFileComment = useCallback(
    (meta: CodeViewItemMetadata, itemId: string) => {
      if (!canCreateFileComments) {
        return;
      }

      cancelPendingEmptyCommentDeletes();
      scrollFileItemToTop(itemId);
      if (meta.isCollapsed) {
        onToggleCollapsed(meta.file, true, meta.reviewIdentity.key);
      }
      if (meta.isMarkdownPreview) {
        setMarkdownPreviewSections((current) => {
          const next = new Set(current);
          next.delete(meta.section.id);
          return next;
        });
      }
      onCreateComment({
        anchor: 'file',
        filePath: meta.file.path,
        sectionId: meta.section.id,
      });
      clearCommentLineHighlight();
    },
    [
      canCreateFileComments,
      cancelPendingEmptyCommentDeletes,
      clearCommentLineHighlight,
      onCreateComment,
      onToggleCollapsed,
      scrollFileItemToTop,
    ],
  );

  const createCommentForRange = useCallback(
    (
      range: CodeViewLineSelection['range'],
      context: { item: CodeViewItem<ReviewAnnotationMetadata> },
    ) => {
      if (context.item.type !== 'diff') {
        return;
      }
      if (isReadOnly) {
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
      isReadOnly,
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
        enableGutterUtility: !isReadOnly,
        enableLineSelection: !isReadOnly,
        expandUnchanged: false,
        expansionLineCount: diffContextExpansionLineCount,
        hunkSeparators: 'line-info-basic',
        itemMetrics: codeViewItemMetrics,
        layout: {
          ...codeViewLayout,
          paddingBottom: bottomInset,
        },
        lineHoverHighlight: 'both',
        onGutterUtilityClick: (range, context) => {
          if (isReadOnly) {
            return;
          }
          ignoreNextLineSelectionEndRef.current = context.item.type === 'diff';
          createCommentForRange(range, context);
        },
        onLineClick: (line, context) => {
          if (isReadOnly) {
            return;
          }
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

          if (hasActiveTextSelection()) {
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
          if (isReadOnly) {
            return;
          }
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
          const isWalkthroughHeaderItem = context.item.id.endsWith(':walkthrough-header');
          node.classList.toggle(
            'codiff-source-description-item',
            context.item.id === sourceDescriptionItemId,
          );
          node.classList.toggle('codiff-walkthrough-header-item', isWalkthroughHeaderItem);
          node.classList.toggle('codiff-selected-item', metadata?.isSelected === true);
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
        themeType: theme,
        tokenizeMaxLength: 100_000,
        unsafeCSS: codeViewUnsafeCSS,
      }) satisfies CodeViewOptions<ReviewAnnotationMetadata>,
    [
      bottomInset,
      cancelPendingEmptyCommentDeletes,
      createCommentForRange,
      diffStyle,
      isReadOnly,
      itemMetadata,
      loadingSectionIds,
      onCreateComment,
      onLoadSection,
      sourceDescriptionItemId,
      theme,
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

  const replyToThread = useCallback(
    (threadId: string, comment: ReviewComment) => {
      clearCommentLineHighlight();
      cancelPendingEmptyCommentDeletes();
      onCreateComment({
        ...(isFileReviewComment(comment) ? { anchor: 'file' as const } : {}),
        filePath: comment.filePath,
        ...(comment.lineNumber != null ? { lineNumber: comment.lineNumber } : {}),
        sectionId: comment.sectionId,
        ...(comment.side ? { side: comment.side } : {}),
        ...(comment.startLineNumber != null ? { startLineNumber: comment.startLineNumber } : {}),
        ...(comment.startSide ? { startSide: comment.startSide } : {}),
        threadId,
      });
    },
    [cancelPendingEmptyCommentDeletes, clearCommentLineHighlight, onCreateComment],
  );

  const deleteComment = useCallback(
    (commentId: string) => {
      clearCommentLineHighlight();
      onDeleteComment(commentId);
    },
    [clearCommentLineHighlight, onDeleteComment],
  );

  const setMarkdownEditorRef = useCallback(
    (sectionId: string, editor: MarkdownDocumentEditorHandle | null) => {
      if (editor) {
        markdownEditorRefs.current.set(sectionId, editor);
      } else {
        markdownEditorRefs.current.delete(sectionId);
      }
    },
    [],
  );

  const toggleMarkdownPreview = useCallback(
    async (file: ChangedFile, section: DiffSection) => {
      clearCommentLineHighlight();
      if (
        markdownPreviewSections.has(section.id) &&
        source.type === 'working-tree' &&
        file.status !== 'deleted'
      ) {
        if (refreshingMarkdownSectionsRef.current.has(section.id)) {
          return;
        }
        refreshingMarkdownSectionsRef.current.add(section.id);
        try {
          const editor = markdownEditorRefs.current.get(section.id);
          if (editor && !(await editor.flush())) {
            return;
          }
          if (onRefreshMarkdown && !(await onRefreshMarkdown(file, section))) {
            return;
          }
        } finally {
          refreshingMarkdownSectionsRef.current.delete(section.id);
        }
      }
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
    [clearCommentLineHighlight, markdownPreviewSections, onRefreshMarkdown, source.type],
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

  useLayoutEffect(() => {
    if (!scrollTarget || handledScrollRequestRef.current === scrollTarget.request) {
      return;
    }

    const behavior = scrollTarget.behavior ?? 'instant';
    const itemId = scrollTarget.blockId
      ? firstItemByBlockId.get(scrollTarget.blockId)
      : scrollTarget.path
        ? firstItemByPath.get(scrollTarget.path)
        : null;
    if (!itemId) {
      return;
    }

    let frame: number | null = null;
    let attempts = 0;
    let canceled = false;

    const tryScroll = () => {
      if (canceled || handledScrollRequestRef.current === scrollTarget.request) {
        return;
      }

      if (requestScrollItemHeaderIntoView(itemId, behavior)) {
        handledScrollRequestRef.current = scrollTarget.request;
        return;
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
  }, [firstItemByBlockId, firstItemByPath, requestScrollItemHeaderIntoView, scrollTarget]);

  useEffect(() => {
    selectedLinesRef.current = selectedLines;
  }, [selectedLines]);

  useEffect(() => {
    if (!hunkNavigation || handledHunkNavRef.current === hunkNavigation.request) {
      return;
    }

    const handle = codeViewRef.current;
    const viewer = handle?.getInstance();
    if (!handle || !viewer) {
      return;
    }

    handledHunkNavRef.current = hunkNavigation.request;

    const headerHeight = codeViewItemMetrics.diffHeaderHeight;
    const anchors: Array<NavAnchor> = [];
    const seen = new Set<string>();
    const lineScrollTarget = (
      id: string,
      lineNumber: number,
      side: 'additions' | 'deletions',
    ): CodeViewScrollTarget => ({
      align: 'center',
      behavior: 'smooth-auto',
      id,
      lineNumber,
      offset: DEFAULT_PADDING,
      side,
      type: 'line',
    });
    const push = (anchor: NavAnchor) => {
      if (seen.has(anchor.key)) {
        return;
      }
      seen.add(anchor.key);
      anchors.push(anchor);
    };

    for (const item of items) {
      if (item.id === sourceDescriptionItemId) {
        continue;
      }

      const itemTop = viewer.getTopForItem(item.id);
      if (itemTop == null) {
        continue;
      }

      const meta = itemMetadata.get(item.id);
      // Collapsed files and non-diff previews (markdown/image) jump to the header.
      if (!meta || meta.isCollapsed || item.type !== 'diff') {
        push({
          itemId: item.id,
          key: `item:${item.id}`,
          scrollTarget: {
            align: 'start',
            behavior: 'smooth-auto',
            id: item.id,
            offset: DEFAULT_PADDING,
            type: 'item',
          },
          selection: null,
          top: itemTop,
        });
        continue;
      }

      // Collect this item's hunks and comments, then order them by rendered row
      // so navigation matches what's on screen. `items` is already in visual
      // order, so structural order (item order, then row order) is exactly
      // top-to-bottom — and stable across keypresses, unlike sorting by the
      // estimated absolute top, which shifts as items measure.
      const headerTop = itemTop + headerHeight;
      const entries: Array<{ anchor: NavAnchor; renderedIndex: number }> = [];
      const addLineEntry = (
        lineNumber: number,
        side: 'additions' | 'deletions',
        selection: SelectedLineRange,
      ) => {
        const renderedIndex = estimateRenderedLineIndex(item.fileDiff, lineNumber, side, diffStyle);
        entries.push({
          anchor: {
            itemId: item.id,
            key: `line:${item.id}:${side}:${lineNumber}`,
            scrollTarget: lineScrollTarget(item.id, lineNumber, side),
            selection,
            top: headerTop + renderedIndex * diffLineHeight,
          },
          renderedIndex,
        });
      };

      for (const hunk of item.fileDiff.hunks) {
        const selection = getHunkSelectionRange(hunk);
        const side = selection?.side ?? (hunk.additionLines > 0 ? 'additions' : 'deletions');
        const lineNumber =
          selection?.start ?? (side === 'additions' ? hunk.additionStart : hunk.deletionStart);
        addLineEntry(
          lineNumber,
          side,
          selection ?? { end: lineNumber, endSide: side, side, start: lineNumber },
        );
      }

      for (const comment of meta.comments) {
        if (!isLineReviewComment(comment)) {
          push({
            itemId: item.id,
            key: `file-comment:${item.id}:${comment.id}`,
            scrollTarget: {
              align: 'start',
              behavior: 'smooth-auto',
              id: item.id,
              offset: DEFAULT_PADDING,
              type: 'item',
            },
            selection: null,
            top: itemTop,
          });
        } else {
          addLineEntry(comment.lineNumber, comment.side, {
            end: comment.lineNumber,
            endSide: comment.side,
            side: comment.side,
            start: comment.lineNumber,
          });
        }
      }

      entries.sort((a, b) => a.renderedIndex - b.renderedIndex);
      for (const entry of entries) {
        push(entry.anchor);
      }
    }

    if (!anchors.length) {
      return;
    }

    // Treat the current line selection as the active anchor so j/k step one hunk
    // at a time from it. A selection the user made (e.g. dragging to comment)
    // won't match any anchor, so we fall back to seeding from the scroll offset.
    const current = selectedLinesRef.current;
    const activeIndex = current
      ? anchors.findIndex(
          (anchor) =>
            anchor.selection != null &&
            anchor.itemId === current.id &&
            isSameSelection(anchor.selection, current.range),
        )
      : -1;

    let targetIndex: number;
    if (activeIndex !== -1) {
      targetIndex = Math.min(
        Math.max(activeIndex + hunkNavigation.direction, 0),
        anchors.length - 1,
      );
    } else {
      const baseTop = viewer.getScrollTop() + DEFAULT_PADDING;
      const epsilon = 4;
      if (hunkNavigation.direction === 1) {
        const found = anchors.findIndex((anchor) => anchor.top > baseTop + epsilon);
        targetIndex = found === -1 ? anchors.length - 1 : found;
      } else {
        targetIndex = 0;
        for (let index = anchors.length - 1; index >= 0; index -= 1) {
          if (anchors[index].top < baseTop - epsilon) {
            targetIndex = index;
            break;
          }
        }
      }
    }

    const target = anchors[targetIndex];
    if (!target) {
      return;
    }

    if (target.selection) {
      const nextSelection = { id: target.itemId, range: target.selection };
      navigatedSelectionRef.current = nextSelection;
      setSelectedLines(nextSelection);
    } else {
      clearCommentLineHighlight();
    }
    handle.scrollTo(target.scrollTarget);
  }, [
    clearCommentLineHighlight,
    diffLineHeight,
    diffStyle,
    hunkNavigation,
    itemMetadata,
    items,
    sourceDescriptionItemId,
  ]);

  // Enter on a navigated hunk starts a review comment on its selection and moves
  // focus into the new comment input.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Enter' ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.defaultPrevented ||
        isInteractiveKeyboardTarget(event.target)
      ) {
        return;
      }

      const selection = selectedLinesRef.current;
      if (isReadOnly) {
        return;
      }
      if (
        !selection ||
        navigatedSelectionRef.current == null ||
        selection.id !== navigatedSelectionRef.current.id ||
        !isSameSelection(selection.range, navigatedSelectionRef.current.range)
      ) {
        return;
      }

      const item = items.find((candidate) => candidate.id === selection.id);
      if (!item) {
        return;
      }

      event.preventDefault();
      createCommentForRange(selection.range, { item });
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [createCommentForRange, isReadOnly, items]);

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
      applySearchHighlights(viewer.getRenderedItems(), searchQuery, resolvedActiveSearchMatch);
    });
  }, [resolvedActiveSearchMatch, searchQuery]);

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
    if (!handle || !viewer || !resolvedActiveSearchMatch) {
      return;
    }

    if (resolvedActiveSearchMatch.lineNumber == null) {
      handle.scrollTo({
        align: 'center',
        behavior: 'smooth-auto',
        id: resolvedActiveSearchMatch.itemId,
        type: 'item',
      });
    } else {
      handle.scrollTo({
        align: 'center',
        behavior: 'smooth-auto',
        id: resolvedActiveSearchMatch.itemId,
        lineNumber: resolvedActiveSearchMatch.lineNumber,
        offset: DEFAULT_PADDING,
        side: resolvedActiveSearchMatch.side,
        type: 'line',
      });
    }

    scheduleSearchHighlights();
  }, [resolvedActiveSearchMatch, scheduleSearchHighlights]);

  const renderCustomHeader = useCallback(
    (item: CodeViewItem<ReviewAnnotationMetadata>) => {
      if (item.id === sourceDescriptionItemId) {
        return (
          <SourceDescriptionHeader
            actions={sourceDescriptionActions}
            canCollapse={sourceDescription.length > 0 || canEditSourceDescription}
            canEditTitle={canEditSourceTitle}
            isCollapsed={sourceDescriptionCollapsed}
            label={sourceDescriptionLabel}
            onToggleCollapsed={toggleSourceDescriptionCollapsed}
            onUpdateTitle={onUpdateSourceTitle}
            title={sourceTitle}
          />
        );
      }

      const meta = itemMetadata.get(item.id);
      return meta ? (
        <CodeViewHeader
          allowViewedToggle={allowViewedToggle}
          canCreateFileComment={canCreateFileComments}
          isSectionLoading={loadingSectionIds.has(meta.section.id)}
          meta={meta}
          onCreateFileComment={() => createFileComment(meta, item.id)}
          onLoadSection={onLoadSection}
          onOpenFile={onOpenFile}
          onToggleCollapsed={onToggleCollapsed}
          onToggleMarkdownPreview={toggleMarkdownPreview}
          onToggleViewed={onToggleViewed}
          readOnly={isReadOnly}
        />
      ) : null;
    },
    [
      allowViewedToggle,
      canEditSourceDescription,
      canEditSourceTitle,
      canCreateFileComments,
      createFileComment,
      itemMetadata,
      isReadOnly,
      loadingSectionIds,
      onLoadSection,
      onOpenFile,
      onToggleCollapsed,
      onToggleViewed,
      onUpdateSourceTitle,
      sourceDescription,
      sourceDescriptionCollapsed,
      sourceDescriptionItemId,
      sourceDescriptionLabel,
      sourceDescriptionActions,
      sourceTitle,
      toggleSourceDescriptionCollapsed,
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
        return meta && onLoadImageContent ? (
          <ImageDiffPreview
            file={meta.file}
            loadImageContent={onLoadImageContent}
            onLayoutReady={markImagePreviewLayoutReady}
            section={meta.section}
            source={source}
          />
        ) : null;
      }

      if (annotation.metadata.type === 'markdown-preview') {
        return (
          <MarkdownPreview
            contents={annotation.metadata.contents}
            editable={annotation.metadata.editable}
            layoutKey={annotation.metadata.layoutKey}
            onEditorRef={setMarkdownEditorRef}
            onLayoutReady={markMarkdownPreviewLayoutReady}
            path={annotation.metadata.path}
            sectionId={annotation.metadata.sectionId}
          />
        );
      }

      if (annotation.metadata.type === 'walkthrough-header') {
        return annotation.metadata.header;
      }

      return (
        <ReviewAnnotation
          agentId={agentId}
          agentLabel={agentLabel}
          annotation={annotation as DiffLineAnnotation<ReviewCommentAnnotationMetadata>}
          comments={renderComments}
          focusCommentId={focusCommentId}
          focusCommentRequest={focusCommentRequest}
          identity={gitIdentity}
          isPullRequest={isPullRequest}
          keymap={keymap}
          onAskCodex={onAskCodex}
          onCommentBlur={blurComment}
          onCommentFocus={focusComment}
          onDeleteComment={deleteComment}
          onHeightChange={() => markCommentLayoutChanged(item.id)}
          onReplyToThread={replyToThread}
          onResolveThread={onResolveThread}
          onSaveCommentEdit={onSaveCommentEdit}
          onSubmitComment={onSubmitComment}
          onUpdateComment={onUpdateComment}
        />
      );
    },
    [
      agentId,
      agentLabel,
      blurComment,
      deleteComment,
      focusCommentId,
      focusCommentRequest,
      focusComment,
      gitIdentity,
      isPullRequest,
      itemMetadata,
      keymap,
      markMarkdownPreviewLayoutReady,
      markImagePreviewLayoutReady,
      markCommentLayoutChanged,
      onAskCodex,
      onLoadImageContent,
      onResolveThread,
      onSaveCommentEdit,
      onSubmitComment,
      onUpdateComment,
      renderComments,
      replyToThread,
      setMarkdownEditorRef,
      source,
    ],
  );

  const handleScroll = useCallback(
    (_scrollTop: number, viewer: CodeViewInstance) => {
      onSelectPathFromScroll(viewer);
      if (onActiveBlockChange) {
        const activationTop = viewer.getScrollTop() + DEFAULT_PADDING;
        let activeBlockId: string | null = null;
        for (const item of items) {
          const top = viewer.getTopForItem(item.id);
          if (top == null) {
            continue;
          }
          if (top > activationTop) {
            break;
          }
          activeBlockId = itemBlockId.get(item.id) ?? activeBlockId;
        }
        if (activeBlockId) {
          onActiveBlockChange(activeBlockId);
        }
      }
      scheduleSearchHighlights();
      scheduleStickyHeaderStateUpdate(viewer);
    },
    [
      itemBlockId,
      items,
      onActiveBlockChange,
      onSelectPathFromScroll,
      scheduleSearchHighlights,
      scheduleStickyHeaderStateUpdate,
    ],
  );

  const codeView = (
    <CodeView
      className="code-view"
      disableWorkerPool={disableWorkerPool}
      items={items}
      onScroll={handleScroll}
      onSelectedLinesChange={setCodeViewSelectedLines}
      options={codeViewOptions}
      ref={codeViewRef}
      renderAnnotation={renderAnnotation}
      renderCustomHeader={renderCustomHeader}
      selectedLines={isReadOnly ? null : selectedLines}
    />
  );

  return disableWorkerPool ? (
    codeView
  ) : (
    <WorkerPoolContextProvider
      highlighterOptions={workerHighlighterOptions}
      poolOptions={workerPoolOptions}
    >
      <CodeView
        className="code-view"
        disableWorkerPool={false}
        items={items}
        onScroll={handleScroll}
        onSelectedLinesChange={setCodeViewSelectedLines}
        options={codeViewOptions}
        ref={codeViewRef}
        renderAnnotation={renderAnnotation}
        renderCustomHeader={renderCustomHeader}
        selectedLines={isReadOnly ? null : selectedLines}
      />
    </WorkerPoolContextProvider>
  );
}
