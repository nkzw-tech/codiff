import type { FileTreeRowDecorationRenderer } from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { isGeneratedWalkthroughPath } from '../shared/narrative-walkthrough-diff.cjs';
import { ReviewCodeView, type ReviewDiffBlock } from './app/components/ReviewCodeView.tsx';
import { NarrativeSidebar } from './app/components/walkthrough/NarrativeSidebar.tsx';
import {
  NarrativeWalkthroughView,
  type WalkthroughBlockScrollTarget,
} from './app/components/walkthrough/NarrativeWalkthroughView.tsx';
import { useNarrativeNavigation } from './app/components/walkthrough/useNarrativeNavigation.ts';
import { createDefaultConfig } from './config/defaults.ts';
import { getAgentLabel } from './lib/app-constants.ts';
import type {
  CodeViewInstance,
  ReviewComment,
  ReviewIdentity,
  ReviewScrollTarget,
} from './lib/app-types.ts';
import { DEFAULT_PADDING } from './lib/code-view-options.ts';
import {
  fileHasVisibleDiff,
  formatTreeLineCount,
  getDiffLineCount,
  getDiffLineCountTitle,
  getFirstVisibleSection,
  getItemId,
  isMarkdownFilePath,
} from './lib/diff.ts';
import { compactPath, fileTreeSort, fuzzyMatches, sortFiles, statusForTree } from './lib/files.ts';
import { getReviewCommentsFromState } from './lib/review-comments.ts';
import {
  updateReviewIdentityCollapsed,
  updateReviewIdentityViewed,
} from './lib/review-identity.ts';
import { getSourceLabel, getSourceKey, isWorkingTreeSource } from './lib/source.ts';
import type {
  ChangedFile,
  PullRequestExistingReviewComment,
  RepositoryState,
  SharedWalkthroughSnapshot,
  WalkthroughCommitMessageResult,
  WalkthroughCommitResult,
} from './types.ts';

const emptyReviewComments: ReadonlyArray<ReviewComment> = [];
const emptyPaths = new Set<string>();
const emptyWalkthroughNotes = new Map();
const walkthroughCodeViewBottomInset = 96;
const CODE_FONT_SIZE_DEFAULT = 13;

const getCodeFontLineHeight = (size: number) => Math.round((size * 20) / 13);

const normalizeCodeFontSizePreference = (size: number) =>
  Number.isFinite(size) ? Math.min(32, Math.max(10, Math.round(size))) : CODE_FONT_SIZE_DEFAULT;

const getSnapshotReviewComments = (
  snapshot: SharedWalkthroughSnapshot,
): ReadonlyArray<ReviewComment> => {
  if (!snapshot.reviewComments?.length) {
    return emptyReviewComments;
  }

  return getReviewCommentsFromState({
    branch: snapshot.branch,
    files: snapshot.files,
    generatedAt: Date.parse(snapshot.exportedAt) || Date.now(),
    launchPath: snapshot.repository.root,
    reviewComments: snapshot.reviewComments as ReadonlyArray<PullRequestExistingReviewComment>,
    root: snapshot.repository.root,
    source: snapshot.repository.source,
  } satisfies RepositoryState);
};

const noop = () => {};

const disabledCommit = async (): Promise<WalkthroughCommitResult> => ({
  reason: 'Shared walkthroughs are read-only.',
  status: 'failed',
});

const disabledCommitMessage = async (): Promise<WalkthroughCommitMessageResult> => ({
  reason: 'Shared walkthroughs are read-only.',
  status: 'unavailable',
});

function SharedFileTree({
  files,
  onActivatePath,
  selectedPath,
  showWhitespace,
}: {
  files: ReadonlyArray<ChangedFile>;
  onActivatePath: (path: string) => void;
  selectedPath: string | null;
  showWhitespace: boolean;
}) {
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const filePathSet = useMemo(() => new Set(paths), [paths]);
  const lineCountsByPath = useMemo(
    () => new Map(files.map((file) => [file.path, getDiffLineCount(file, showWhitespace)])),
    [files, showWhitespace],
  );
  const lineCountsByPathRef = useRef(lineCountsByPath);
  const renderTreeRowDecoration = useCallback<FileTreeRowDecorationRenderer>(({ item }) => {
    const lineCount = lineCountsByPathRef.current.get(item.path);
    return lineCount?.countable
      ? {
          text: formatTreeLineCount(lineCount),
          title: getDiffLineCountTitle(lineCount),
        }
      : null;
  }, []);
  const status = useMemo(
    () =>
      files.map((file) => ({
        path: file.path,
        status: statusForTree[file.status],
      })),
    [files],
  );
  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    gitStatus: status,
    initialExpansion: 'open',
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    itemHeight: 30,
    paths,
    renderRowDecoration: renderTreeRowDecoration,
    sort: fileTreeSort,
    unsafeCSS: `
      :host {
        --trees-padding-inline-override: 4px;
        color: var(--sidebar-text);
        font: 13px/1.35 var(--font-sans);
      }

      button[data-type='item'] {
        border-radius: 14px;
        corner-shape: squircle;
      }

      [data-item-section='decoration'] {
        color: var(--muted);
        font: 600 10px/1 var(--font-mono);
        letter-spacing: 0;
      }
    `,
  });

  useLayoutEffect(() => {
    lineCountsByPathRef.current = lineCountsByPath;
    if (model.getFileTreeContainer()) {
      model.render({});
    }
  }, [lineCountsByPath, model]);

  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);

  useEffect(() => {
    model.setGitStatus(status);
  }, [model, status]);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }

    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect();
    }
    model.getItem(selectedPath)?.select();
  }, [model, selectedPath]);

  const handleTreeClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      for (const target of event.nativeEvent.composedPath()) {
        if (!('getAttribute' in target) || typeof target.getAttribute !== 'function') {
          continue;
        }

        const path = target.getAttribute('data-item-path');
        if (path && filePathSet.has(path)) {
          onActivatePath(path);
          return;
        }
      }
    },
    [filePathSet, onActivatePath],
  );

  return (
    <div className="file-tree-shell">
      <FileTree className="file-tree" model={model} onClick={handleTreeClick} />
    </div>
  );
}

export function SharedWalkthroughApp({ snapshot }: { snapshot: SharedWalkthroughSnapshot }) {
  const sharedWalkthrough = useMemo(
    () => ({
      ...snapshot.walkthrough,
      commit: undefined,
    }),
    [snapshot.walkthrough],
  );
  const navigation = useNarrativeNavigation(
    sharedWalkthrough,
    snapshot.files,
    `${snapshot.repository.root}:${getSourceKey(snapshot.repository.source)}`,
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [itemVersionByKey, setItemVersionByKey] = useState<Record<string, number>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(
    () => snapshot.files[0]?.path ?? null,
  );
  const [sidebarMode, setSidebarMode] = useState<'tree' | 'walkthrough'>('walkthrough');
  const [treeScrollTarget, setTreeScrollTarget] = useState<ReviewScrollTarget | null>(null);
  const [viewed, setViewed] = useState<Record<string, string>>({});
  const reviewComments = useMemo(() => getSnapshotReviewComments(snapshot), [snapshot]);
  const visibleFiles = useMemo(
    () =>
      sortFiles(snapshot.files).filter(
        (file) =>
          fuzzyMatches(file.path, fileSearchQuery) &&
          fileHasVisibleDiff(file, snapshot.preferences.showWhitespace),
      ),
    [fileSearchQuery, snapshot.files, snapshot.preferences.showWhitespace],
  );
  const visibleSelectedPath =
    selectedPath && visibleFiles.some((file) => file.path === selectedPath)
      ? selectedPath
      : (visibleFiles[0]?.path ?? null);
  const initialMarkdownPreviewSectionIds = useMemo(() => {
    const nonGeneratedFiles = snapshot.files.filter(
      (file) => !isGeneratedWalkthroughPath(file.path),
    );
    if (
      nonGeneratedFiles.length === 0 ||
      !nonGeneratedFiles.every((file) => isMarkdownFilePath(file.path))
    ) {
      return emptyPaths;
    }

    return new Set(
      snapshot.files
        .filter((file) => isMarkdownFilePath(file.path))
        .flatMap((file) => file.sections.map((section) => section.id)),
    );
  }, [snapshot.files]);

  useEffect(() => {
    const root = document.documentElement;
    if (snapshot.preferences.theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', snapshot.preferences.theme);
    }
  }, [snapshot.preferences.theme]);

  useEffect(() => {
    const root = document.documentElement;
    const codeFontFamily = snapshot.preferences.codeFontFamily.trim();
    const codeFontSize = normalizeCodeFontSizePreference(snapshot.preferences.codeFontSize);

    if (codeFontFamily) {
      root.style.setProperty('--font-diff-mono', `${JSON.stringify(codeFontFamily)}, monospace`);
    }

    root.style.setProperty('--font-diff-size', `${codeFontSize}px`);
    root.style.setProperty('--font-diff-line-height', `${getCodeFontLineHeight(codeFontSize)}px`);
  }, [snapshot.preferences.codeFontFamily, snapshot.preferences.codeFontSize]);

  const bumpItemVersion = useCallback((key: string) => {
    setItemVersionByKey((current) => ({
      ...current,
      [key]: (current[key] ?? 0) + 1,
    }));
  }, []);

  const toggleCollapsed = useCallback(
    (_file: ChangedFile, isCollapsed: boolean, reviewKey: string) => {
      setCollapsed((current) => {
        const next = new Set(current);
        if (isCollapsed) {
          next.delete(reviewKey);
        } else {
          next.add(reviewKey);
        }
        return next;
      });
      bumpItemVersion(reviewKey);
    },
    [bumpItemVersion],
  );
  const toggleViewed = useCallback(
    (_file: ChangedFile, isViewed: boolean, reviewIdentity: ReviewIdentity) => {
      setViewed((current) => updateReviewIdentityViewed(current, reviewIdentity, isViewed));
      setCollapsed((current) => updateReviewIdentityCollapsed(current, reviewIdentity, isViewed));
      bumpItemVersion(reviewIdentity.key);
    },
    [bumpItemVersion],
  );
  const activateTreePath = useCallback((path: string) => {
    setSelectedPath(path);
    setTreeScrollTarget((current) => ({
      behavior: 'smooth',
      path,
      request: (current?.request ?? 0) + 1,
    }));
  }, []);
  const updateSelectedPathFromScroll = useCallback(
    (viewer: CodeViewInstance) => {
      if (visibleFiles.length === 0) {
        return;
      }

      const activationTop = viewer.getScrollTop() + DEFAULT_PADDING;
      let nextPath = visibleFiles[0]?.path ?? null;
      let nextDistance = Number.NEGATIVE_INFINITY;

      for (const file of visibleFiles) {
        const section = getFirstVisibleSection(file, snapshot.preferences.showWhitespace);
        const itemTop = section ? viewer.getTopForItem(getItemId(section)) : undefined;
        if (itemTop == null) {
          continue;
        }

        const distance = itemTop - activationTop;
        if (distance <= 0 && distance > nextDistance) {
          nextDistance = distance;
          nextPath = file.path;
        }
      }

      if (nextPath) {
        setSelectedPath((current) => (current === nextPath ? current : nextPath));
      }
    },
    [snapshot.preferences.showWhitespace, visibleFiles],
  );

  const diffLineHeight = getCodeFontLineHeight(
    normalizeCodeFontSizePreference(snapshot.preferences.codeFontSize),
  );
  const commonReviewProps = {
    activeSearchMatch: null,
    agentId: snapshot.walkthrough.agent,
    agentLabel: getAgentLabel(snapshot.walkthrough.agent),
    collapsed,
    comments: reviewComments,
    commitMetadata: null,
    diffLineHeight,
    diffStyle: snapshot.preferences.diffStyle,
    disableWorkerPool: true,
    focusCommentId: null,
    focusCommentRequest: 0,
    gitIdentity: null,
    hunkNavigation: null,
    initialMarkdownPreviewSectionIds,
    isPullRequest:
      snapshot.repository.source.type === 'pull-request' ||
      snapshot.repository.source.type === 'arc-pull-request',
    isReadOnly: true,
    itemVersionByKey,
    keymap: createDefaultConfig().keymap,
    loadingSectionIds: new Set<string>(),
    onAskCodex: noop,
    onCreateComment: noop,
    onDeleteComment: noop,
    onLoadSection: noop,
    onOpenFile: noop,
    onSelectPathFromScroll: noop,
    onSubmitComment: noop,
    onToggleCollapsed: toggleCollapsed,
    onToggleViewed: toggleViewed,
    onUpdateComment: noop,
    searchQuery: '',
    showWhitespace: snapshot.preferences.showWhitespace,
    source: snapshot.repository.source,
    viewed,
    wordWrap: snapshot.preferences.wordWrap,
  };

  const renderWalkthroughDiffBlocks = (
    blocks: ReadonlyArray<ReviewDiffBlock>,
    blockScrollTarget: WalkthroughBlockScrollTarget | null,
    onActiveBlockChange: (blockId: string) => void,
  ) => (
    <div className="wt-stop wt-diff-surface">
      <ReviewCodeView
        {...commonReviewProps}
        allowViewedToggle
        blocks={blocks}
        bottomInset={walkthroughCodeViewBottomInset}
        files={[]}
        forceExpandedPaths={new Set()}
        onActiveBlockChange={onActiveBlockChange}
        scrollTarget={blockScrollTarget}
        selectedPath={null}
        walkthroughNotes={emptyWalkthroughNotes}
      />
    </div>
  );

  const sourceLabel = isWorkingTreeSource(snapshot.repository.source)
    ? ''
    : ` · ${getSourceLabel(snapshot.repository.source)}`;
  const rootLabel = `${compactPath(snapshot.repository.root)}${snapshot.branch ? ` (${snapshot.branch})` : ''}`;

  return (
    <div
      className="app-shell share-shell"
      style={{ gridTemplateColumns: '292px 0 minmax(0, 1fr)' }}
    >
      <aside className="squircle sidebar">
        <div className="sidebar-header">
          <div className="sidebar-path-row">
            <div className="sidebar-path" title={snapshot.repository.root}>
              {rootLabel}
              {sourceLabel}
            </div>
          </div>
        </div>
        <div className="sidebar-search-row">
          <input
            aria-label="Filter changed files"
            className="sidebar-search"
            onChange={(event) => setFileSearchQuery(event.currentTarget.value)}
            placeholder="Filter files"
            spellCheck={false}
            type="search"
            value={fileSearchQuery}
          />
        </div>
        <div aria-label="Review order" className="sidebar-mode-toggle" role="tablist">
          <button
            aria-selected={sidebarMode === 'tree'}
            onClick={() => setSidebarMode('tree')}
            role="tab"
            type="button"
          >
            Tree
          </button>
          <button
            aria-selected={sidebarMode === 'walkthrough'}
            onClick={() => setSidebarMode('walkthrough')}
            role="tab"
            type="button"
          >
            Walkthrough
          </button>
        </div>
        {sidebarMode === 'tree' ? (
          <SharedFileTree
            files={visibleFiles}
            onActivatePath={activateTreePath}
            selectedPath={visibleSelectedPath}
            showWhitespace={snapshot.preferences.showWhitespace}
          />
        ) : (
          <NarrativeSidebar
            allowCommit={false}
            files={visibleFiles}
            navigation={navigation}
            showWhitespace={snapshot.preferences.showWhitespace}
            walkthrough={sharedWalkthrough}
          />
        )}
      </aside>
      <div aria-hidden className="sidebar-resizer" />
      <main className="review">
        {sidebarMode === 'tree' ? (
          visibleFiles.length === 0 ? (
            <div className="empty-state">
              <div className="empty-panel squircle">
                <strong>No matching files</strong>
                <span>{fileSearchQuery}</span>
              </div>
            </div>
          ) : (
            <ReviewCodeView
              {...commonReviewProps}
              allowViewedToggle
              files={visibleFiles}
              forceExpandedPaths={emptyPaths}
              onSelectPathFromScroll={updateSelectedPathFromScroll}
              scrollTarget={treeScrollTarget}
              selectedPath={visibleSelectedPath}
              walkthroughNotes={emptyWalkthroughNotes}
            />
          )
        ) : (
          <NarrativeWalkthroughView
            allowCommit={false}
            files={snapshot.files}
            navigation={navigation}
            onActiveReviewTargetChange={noop}
            onCommit={disabledCommit}
            onUpdateCommitMessage={disabledCommitMessage}
            renderDiffBlocks={renderWalkthroughDiffBlocks}
            showWhitespace={snapshot.preferences.showWhitespace}
            walkthrough={sharedWalkthrough}
          />
        )}
      </main>
    </div>
  );
}
