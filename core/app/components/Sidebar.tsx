import type { FileTreeRowDecorationRenderer } from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type MouseEvent,
  type RefObject,
} from 'react';
import { matchesShortcut } from '../../config/keymap.ts';
import type { CodiffKeymap } from '../../config/types.ts';
import type {
  DiffLineCount,
  PullRequestSource,
  SidebarMode,
  WalkthroughError,
} from '../../lib/app-types.ts';
import {
  formatLineCountNumber,
  formatTreeLineCount,
  getDiffLineCount,
  getDiffLineCountTitle,
  getTotalDiffLineCount,
} from '../../lib/diff.ts';
import { fileTreeSort, statusForTree } from '../../lib/files.ts';
import { isNativeInputTarget } from '../../lib/keyboard.ts';
import { getShortRef, getSourceKey } from '../../lib/source.ts';
import type { ChangedFile, HistoryEntry, NarrativeWalkthrough, ReviewSource } from '../../types.ts';
import { Gravatar } from './Gravatar.tsx';
import { NarrativeSidebar } from './walkthrough/NarrativeSidebar.tsx';
import type { NarrativeNavigation } from './walkthrough/useNarrativeNavigation.ts';

export function Sidebar({
  branchSource,
  commitFiles,
  commitViewOpen,
  currentSource,
  files,
  historyEntries,
  historyHasMore,
  historyLoading,
  keymap,
  mode,
  narrativeNavigation,
  narrativeWalkthrough,
  onActivatePath,
  onLoadMoreHistory,
  onModeChange,
  onSearchQueryChange,
  onSelectPath,
  onSelectSource,
  onShareWalkthrough,
  onToggleCommitView,
  pullRequestSource,
  reloadDeltaPaths,
  searchQuery,
  selectedPath,
  shareWalkthroughDisabled,
  showWhitespace,
  viewed,
  walkthroughError,
  walkthroughLoading,
  walkthroughUnread,
}: {
  branchSource: Extract<ReviewSource, { type: 'branch-diff' }> | null;
  commitFiles: ReadonlyArray<ChangedFile>;
  commitViewOpen: boolean;
  currentSource: ReviewSource;
  files: ReadonlyArray<ChangedFile>;
  historyEntries: ReadonlyArray<HistoryEntry>;
  historyHasMore: boolean;
  historyLoading: boolean;
  keymap: CodiffKeymap;
  mode: SidebarMode;
  narrativeNavigation: NarrativeNavigation;
  narrativeWalkthrough: NarrativeWalkthrough | null;
  onActivatePath: (path: string) => void;
  onLoadMoreHistory: () => void;
  onModeChange: (mode: SidebarMode) => void;
  onSearchQueryChange: (query: string) => void;
  onSelectPath: (path: string) => void;
  onSelectSource: (source: ReviewSource) => void;
  onShareWalkthrough?: () => void;
  onToggleCommitView: () => void;
  pullRequestSource: PullRequestSource | null;
  reloadDeltaPaths: ReadonlySet<string>;
  searchQuery: string;
  selectedPath: string | null;
  shareWalkthroughDisabled?: boolean;
  showWhitespace: boolean;
  viewed: Record<string, string>;
  walkthroughError: WalkthroughError | null;
  walkthroughLoading: boolean;
  walkthroughUnread: boolean;
}) {
  const allowSelectionScroll = useRef(false);
  const allowSelectionScrollTimer = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const treeHostRef = useRef<HTMLDivElement>(null);
  const suppressSelectionChange = useRef(false);
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const filePathSet = useMemo(() => new Set(paths), [paths]);
  const lineCountsByPath = useMemo(
    () => new Map(files.map((file) => [file.path, getDiffLineCount(file, showWhitespace)])),
    [files, showWhitespace],
  );
  const totalLineCount = useMemo(
    () => getTotalDiffLineCount(lineCountsByPath.values()),
    [lineCountsByPath],
  );
  const showTotalLineCount = mode !== 'history' && totalLineCount.countable;
  const showCommitButton =
    mode === 'tree' && currentSource.type === 'working-tree' && commitFiles.length > 0;
  const showFooter = showTotalLineCount || showCommitButton;
  const lineCountsByPathRef = useRef(lineCountsByPath);
  const reloadDeltaGitStatusCSS = useMemo(
    () => getReloadDeltaGitStatusCSS(reloadDeltaPaths),
    [reloadDeltaPaths],
  );
  const viewedRowCSS = useMemo(() => getViewedRowCSS(files, viewed), [files, viewed]);
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
    onSelectionChange: (paths) => {
      if (suppressSelectionChange.current) {
        return;
      }

      if (!allowSelectionScroll.current) {
        return;
      }
      allowSelectionScroll.current = false;
      if (allowSelectionScrollTimer.current != null) {
        window.clearTimeout(allowSelectionScrollTimer.current);
        allowSelectionScrollTimer.current = null;
      }

      const path = paths.at(-1);
      if (path) {
        onSelectPath(path);
      }
    },
    paths,
    renderRowDecoration: renderTreeRowDecoration,
    sort: fileTreeSort,
    unsafeCSS: `
      :host {
        --trees-bg-override: transparent;
        --trees-bg-muted-override: var(--hover-wash);
        --trees-border-color-override: var(--sidebar-border);
        --trees-fg-muted-override: var(--muted);
        --trees-fg-override: var(--sidebar-text);
        --trees-focus-ring-color-override: var(--tree-selection-focus);
        --trees-padding-inline-override: 4px;
        --trees-search-bg-override: rgb(127 127 127 / 0.1);
        --trees-search-fg-override: var(--sidebar-text);
        --trees-selected-bg-override: color-mix(in srgb, var(--tree-selection-bg) 46%, transparent);
        --trees-selected-fg-override: var(--sidebar-text);
        --trees-selected-focused-border-color-override: color-mix(in srgb, var(--tree-selection-focus) 42%, transparent);
        --truncate-marker-background-color: transparent;
        color-scheme: var(--codiff-tree-color-scheme, light dark);
        color: var(--sidebar-text);
        font: 13px/1.35 var(--font-sans);
      }

      button[data-type='item'] {
        background-color: transparent;
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

  useTreeShadowStyle(treeHostRef, reloadDeltaGitStatusStyleAttribute, reloadDeltaGitStatusCSS);
  useTreeShadowStyle(treeHostRef, viewedRowStyleAttribute, viewedRowCSS);

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

  const scrollPathIntoView = useCallback(
    (path: string) => {
      model.focusPath(path);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const host = treeHostRef.current?.querySelector('file-tree-container');
          const row = Array.from(
            host?.shadowRoot?.querySelectorAll<HTMLElement>('[data-item-path]') ?? [],
          ).find((element) => element.getAttribute('data-item-path') === path);
          row?.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          });
        });
      });
    },
    [model],
  );

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

  useEffect(
    () => () => {
      if (allowSelectionScrollTimer.current != null) {
        window.clearTimeout(allowSelectionScrollTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isNativeInputTarget(event.target) && matchesShortcut(event, keymap, 'fileFilter')) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [keymap]);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }

    const selectedPaths = model.getSelectedPaths();
    if (selectedPaths.length === 1 && selectedPaths[0] === selectedPath) {
      return;
    }

    suppressSelectionChange.current = true;
    for (const path of selectedPaths) {
      model.getItem(path)?.deselect();
    }
    model.getItem(selectedPath)?.select();
    requestAnimationFrame(() => scrollPathIntoView(selectedPath));
    window.setTimeout(() => {
      suppressSelectionChange.current = false;
    }, 0);
  }, [model, scrollPathIntoView, selectedPath]);

  return (
    <>
      <div className="sidebar-search-row">
        <input
          aria-label="Filter changed files"
          className="sidebar-search"
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          placeholder={mode === 'history' ? 'Filter history' : 'Filter files'}
          ref={searchInputRef}
          spellCheck={false}
          type="search"
          value={searchQuery}
        />
      </div>
      <div aria-label="Review order" className="sidebar-mode-toggle" role="tablist">
        <button
          aria-selected={mode === 'tree'}
          onClick={() => onModeChange('tree')}
          role="tab"
          type="button"
        >
          Tree
        </button>
        <button
          aria-selected={mode === 'walkthrough'}
          onClick={() => onModeChange('walkthrough')}
          role="tab"
          type="button"
        >
          <span>Walkthrough</span>
          {walkthroughUnread ? <span aria-hidden className="sidebar-tab-dot" /> : null}
        </button>
        <button
          aria-selected={mode === 'history'}
          onClick={() => onModeChange('history')}
          role="tab"
          type="button"
        >
          History
        </button>
      </div>
      {mode === 'history' ? (
        <HistorySidebar
          branchSource={branchSource}
          currentSource={currentSource}
          entries={historyEntries}
          hasMore={historyHasMore}
          loading={historyLoading}
          onLoadMore={onLoadMoreHistory}
          onSelectSource={onSelectSource}
          pullRequestSource={pullRequestSource}
          searchQuery={searchQuery}
        />
      ) : mode === 'walkthrough' && narrativeWalkthrough ? (
        <NarrativeSidebar
          changedPaths={reloadDeltaPaths}
          files={commitFiles}
          navigation={narrativeNavigation}
          onShareWalkthrough={onShareWalkthrough}
          shareWalkthroughDisabled={shareWalkthroughDisabled}
          showWhitespace={showWhitespace}
          walkthrough={narrativeWalkthrough}
        />
      ) : mode === 'walkthrough' ? (
        <>
          {walkthroughLoading ? (
            <div className="sidebar-walkthrough-status-shell">
              <div className="sidebar-walkthrough-status codex">
                <strong>Generating walkthrough…</strong>
              </div>
            </div>
          ) : walkthroughError ? (
            <div className="sidebar-walkthrough-status" title={walkthroughError.reason}>
              <strong>Walkthrough unavailable</strong>
              <span>{walkthroughError.reason}</span>
            </div>
          ) : null}
        </>
      ) : (
        <div className="file-tree-shell" ref={treeHostRef}>
          <FileTree className="file-tree" model={model} onClick={handleTreeClick} />
        </div>
      )}
      {showFooter ? (
        <div className="sidebar-total-row">
          <span className="sidebar-total-summary">
            {showTotalLineCount ? (
              <>
                <span>Total:</span>
                <DiffLineCountBadge
                  ariaLabelPrefix="Total change"
                  className="sidebar-total-line-count"
                  lineCount={totalLineCount}
                />
              </>
            ) : null}
          </span>
          {showCommitButton ? (
            <button
              aria-label={commitViewOpen ? 'Show file tree' : 'Open commit view'}
              className="codiff-open-button sidebar-commit-button"
              onClick={onToggleCommitView}
              type="button"
            >
              {commitViewOpen ? 'Tree' : 'Commit'}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

const escapeCSSString = (value: string) =>
  value
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('\n', String.raw`\a `)
    .replaceAll('\r', String.raw`\d `)
    .replaceAll('\f', String.raw`\c `)
    .replaceAll('"', String.raw`\"`);

const getReloadDeltaGitStatusCSS = (paths: ReadonlySet<string>) =>
  [...paths]
    .map(
      (path) => `
        [data-item-path="${escapeCSSString(path)}"][data-item-git-status] > [data-item-section='git'] {
          color: var(--sidebar-ref);
        }
      `,
    )
    .join('\n');

const getViewedRowCSS = (files: ReadonlyArray<ChangedFile>, viewed: Record<string, string>) =>
  getViewedRowCSSFromSelectors(
    files
      .filter((file) => viewed[file.path] === file.fingerprint)
      .map((file) => `[data-item-path="${escapeCSSString(file.path)}"]`),
  );

const getViewedRowCSSFromSelectors = (selectors: ReadonlyArray<string>) => {
  if (selectors.length === 0) {
    return '';
  }

  const rowContent = selectors
    .flatMap((selector) => [
      `${selector} > [data-item-section='icon']`,
      `${selector} > [data-item-section='icon'] > :where(:not([data-icon-name='file-tree-icon-chevron']))`,
      `${selector} > [data-item-section='content']`,
      `${selector} > [data-item-section='decoration']`,
      `${selector} > [data-item-section='git']`,
    ])
    .join(',\n');

  return `
    ${rowContent} {
      color: var(--muted);
    }
  `;
};

const reloadDeltaGitStatusStyleAttribute = 'data-codiff-reload-delta-git-status';
const viewedRowStyleAttribute = 'data-codiff-viewed-rows';

const useTreeShadowStyle = (
  treeHostRef: RefObject<HTMLElement | null>,
  styleAttribute: string,
  css: string,
) => {
  useEffect(() => {
    // Tree unsafeCSS is constructor-time; keep dynamic row styling in a shadow style tag.
    if (syncTreeShadowStyle(treeHostRef.current, styleAttribute, css)) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      syncTreeShadowStyle(treeHostRef.current, styleAttribute, css);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [css, styleAttribute, treeHostRef]);
};

const syncTreeShadowStyle = (treeHost: HTMLElement | null, styleAttribute: string, css: string) => {
  const shadowRoot = treeHost?.querySelector('file-tree-container')?.shadowRoot;
  if (!shadowRoot) {
    return false;
  }

  const existingStyle = shadowRoot.querySelector<HTMLStyleElement>(`style[${styleAttribute}]`);
  if (css.length === 0) {
    existingStyle?.remove();
    return true;
  }

  const style = existingStyle ?? document.createElement('style');
  style.setAttribute(styleAttribute, '');
  style.textContent = css;
  if (!existingStyle) {
    shadowRoot.append(style);
  }
  return true;
};

const shortDate = (timestamp: number) => {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months}mo ago`;
  }
  return `${Math.floor(months / 12)}y ago`;
};

function HistorySidebar({
  branchSource,
  currentSource,
  entries,
  hasMore,
  loading,
  onLoadMore,
  onSelectSource,
  pullRequestSource,
  searchQuery,
}: {
  branchSource: Extract<ReviewSource, { type: 'branch-diff' }> | null;
  currentSource: ReviewSource;
  entries: ReadonlyArray<HistoryEntry>;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onSelectSource: (source: ReviewSource) => void;
  pullRequestSource: PullRequestSource | null;
  searchQuery: string;
}) {
  const currentSourceKey = getSourceKey(currentSource);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => {
    const commitRows = entries.map((entry) => ({
      author: entry.author,
      committedAt: entry.committedAt,
      gravatarUrl: entry.gravatarUrl,
      key: `commit:${entry.ref}`,
      kind: 'entry' as const,
      ref: entry.ref,
      scope: entry.scope,
      source: { ref: entry.ref, type: 'commit' } satisfies ReviewSource,
      subject: entry.subject,
    }));
    const matchesQuery = (row: (typeof commitRows)[number]) =>
      !normalizedQuery ||
      row.subject.toLowerCase().includes(normalizedQuery) ||
      row.ref.toLowerCase().includes(normalizedQuery) ||
      row.author.toLowerCase().includes(normalizedQuery);

    if (pullRequestSource) {
      const hasScopedRows = commitRows.some((row) => row.scope != null);
      const pullRequestRows = commitRows
        .filter((row) => (hasScopedRows ? row.scope === 'pull-request' : row.scope == null))
        .filter(matchesQuery);
      const baseRows = hasScopedRows
        ? commitRows.filter((row) => row.scope === 'base').filter(matchesQuery)
        : [];
      return [
        !normalizedQuery
          ? {
              author: null,
              committedAt: null,
              gravatarUrl: undefined,
              key: getSourceKey(pullRequestSource),
              kind: 'entry' as const,
              ref: pullRequestSource.number ? `PR #${pullRequestSource.number}` : 'PR',
              source: pullRequestSource satisfies ReviewSource,
              subject: pullRequestSource.title || 'Pull Request',
            }
          : null,
        {
          key: 'history-section:pull-request',
          kind: 'section' as const,
          label: hasScopedRows ? 'Review commits' : 'Branch history',
        },
        ...pullRequestRows,
        { key: 'history-section:base', kind: 'section' as const, label: 'Base history' },
        ...baseRows,
      ].filter((row): row is NonNullable<typeof row> => row != null);
    }

    if (branchSource) {
      const localRows = commitRows.filter(matchesQuery);
      return [
        !normalizedQuery
          ? {
              key: 'history-section:review-scope',
              kind: 'section' as const,
              label: 'Review scope',
            }
          : null,
        !normalizedQuery
          ? {
              author: null,
              committedAt: null,
              gravatarUrl: undefined,
              key: 'working-tree',
              kind: 'entry' as const,
              ref: '',
              source: { type: 'working-tree' } satisfies ReviewSource,
              subject: 'Uncommitted changes',
            }
          : null,
        !normalizedQuery
          ? {
              author: null,
              committedAt: null,
              gravatarUrl: undefined,
              key: getSourceKey(branchSource),
              kind: 'entry' as const,
              ref: 'branch',
              source: branchSource satisfies ReviewSource,
              subject: `Branch diff vs ${branchSource.ref}`,
            }
          : null,
        localRows.length > 0
          ? {
              key: 'history-section:branch',
              kind: 'section' as const,
              label: 'Branch history',
            }
          : null,
        ...localRows,
      ].filter((row): row is NonNullable<typeof row> => row != null);
    }

    const localRows = commitRows.filter(matchesQuery);
    return [
      !normalizedQuery
        ? {
            author: null,
            committedAt: null,
            gravatarUrl: undefined,
            key: 'working-tree',
            kind: 'entry' as const,
            ref: '',
            source: { type: 'working-tree' } satisfies ReviewSource,
            subject: 'Uncommitted changes',
          }
        : null,
      ...localRows,
    ].filter((row): row is NonNullable<typeof row> => row != null);
  }, [branchSource, entries, normalizedQuery, pullRequestSource]);
  const maybeLoadMore = useCallback(() => {
    const element = listRef.current;
    if (!element || loading || !hasMore || normalizedQuery) {
      return;
    }

    if (element.scrollHeight - element.scrollTop - element.clientHeight < 120) {
      onLoadMore();
    }
  }, [hasMore, loading, normalizedQuery, onLoadMore]);

  return (
    <div className="history-list" onScroll={maybeLoadMore} ref={listRef}>
      {rows.map((row) => {
        if (row.kind === 'section') {
          return (
            <div className="history-section" key={row.key}>
              {row.label}
            </div>
          );
        }

        const selected = row.key === currentSourceKey;
        const hasMetadata = Boolean(row.author && row.committedAt);
        return (
          <button
            className={`history-entry${selected ? ' selected' : ''}${hasMetadata ? ' with-metadata' : ''}`}
            key={row.key}
            onClick={() => onSelectSource(row.source)}
            title={row.subject}
            type="button"
          >
            <span className="history-entry-ref">
              {row.source.type === 'commit'
                ? getShortRef(row.source.ref)
                : row.source.type === 'pull-request' || row.source.type === 'branch-diff'
                  ? row.ref
                  : 'local'}
            </span>
            <span className="history-entry-subject">{row.subject}</span>
            {hasMetadata ? (
              <span className="history-entry-meta">
                <span className="history-entry-author">
                  <Gravatar fallback={row.author || '?'} size="small" url={row.gravatarUrl} />
                  <span>{row.author}</span>
                </span>
                <span>{shortDate(row.committedAt || 0)}</span>
              </span>
            ) : null}
          </button>
        );
      })}
      {loading ? (
        <div className="history-loading">
          <span>Loading history…</span>
        </div>
      ) : null}
    </div>
  );
}

export function DiffLineCountBadge({
  ariaLabelPrefix,
  className = 'codiff-line-count',
  lineCount,
}: {
  ariaLabelPrefix?: string;
  className?: string;
  lineCount: DiffLineCount;
}) {
  if (!lineCount.countable) {
    return null;
  }

  const title = getDiffLineCountTitle(lineCount);

  return (
    <span
      aria-label={ariaLabelPrefix ? `${ariaLabelPrefix}: ${title}` : title}
      className={className}
      title={ariaLabelPrefix ? `${ariaLabelPrefix}: ${title}` : title}
    >
      <span className="codiff-line-count-added">+{formatLineCountNumber(lineCount.additions)}</span>
      <span className="codiff-line-count-deleted">
        -{formatLineCountNumber(lineCount.deletions)}
      </span>
    </span>
  );
}
