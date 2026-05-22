import type { FileTreeRowDecorationRenderer } from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { matchesShortcut } from '../../config/keymap.ts';
import type { CodiffKeymap } from '../../config/types.ts';
import type {
  DiffLineCount,
  PullRequestSource,
  SidebarMode,
  WalkthroughError,
  WalkthroughNote,
} from '../../lib/app-types.ts';
import {
  formatLineCountNumber,
  formatTreeLineCount,
  getDiffLineCount,
  getDiffLineCountTitle,
} from '../../lib/diff.ts';
import { fileTreeSort, statusForTree } from '../../lib/files.ts';
import { isNativeInputTarget } from '../../lib/keyboard.ts';
import { renderInlineMarkdown } from '../../lib/markdown.tsx';
import { getShortRef, getSourceKey } from '../../lib/source.ts';
import { walkthroughActionLabel, walkthroughImpactLabel } from '../../lib/walkthrough.ts';
import type { ChangedFile, HistoryEntry, ReviewSource, Walkthrough } from '../../types.ts';
import { Gravatar } from './Gravatar.tsx';

export function Sidebar({
  currentSource,
  files,
  historyEntries,
  historyHasMore,
  historyLoading,
  keymap,
  mode,
  onActivatePath,
  onLoadMoreHistory,
  onModeChange,
  onSearchQueryChange,
  onSelectPath,
  onSelectSource,
  pullRequestSource,
  searchQuery,
  selectedPath,
  showWhitespace,
  walkthroughAvailable,
  walkthroughError,
  walkthroughLoading,
  walkthroughNotes,
  walkthroughSummary,
  walkthroughUnread,
}: {
  currentSource: ReviewSource;
  files: ReadonlyArray<ChangedFile>;
  historyEntries: ReadonlyArray<HistoryEntry>;
  historyHasMore: boolean;
  historyLoading: boolean;
  keymap: CodiffKeymap;
  mode: SidebarMode;
  onActivatePath: (path: string) => void;
  onLoadMoreHistory: () => void;
  onModeChange: (mode: SidebarMode) => void;
  onSearchQueryChange: (query: string) => void;
  onSelectPath: (path: string) => void;
  onSelectSource: (source: ReviewSource) => void;
  pullRequestSource: PullRequestSource | null;
  searchQuery: string;
  selectedPath: string | null;
  showWhitespace: boolean;
  walkthroughAvailable: boolean;
  walkthroughError: WalkthroughError | null;
  walkthroughLoading: boolean;
  walkthroughNotes: ReadonlyMap<string, WalkthroughNote>;
  walkthroughSummary: Walkthrough['summary'] | null;
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

  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);

  useEffect(() => {
    lineCountsByPathRef.current = lineCountsByPath;
  }, [lineCountsByPath]);

  useEffect(() => {
    model.setGitStatus(status);
  }, [lineCountsByPath, model, status]);

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
          currentSource={currentSource}
          entries={historyEntries}
          hasMore={historyHasMore}
          loading={historyLoading}
          onLoadMore={onLoadMoreHistory}
          onSelectSource={onSelectSource}
          pullRequestSource={pullRequestSource}
          searchQuery={searchQuery}
        />
      ) : mode === 'walkthrough' && walkthroughAvailable ? (
        <WalkthroughSidebar
          files={files}
          onActivatePath={onActivatePath}
          selectedPath={selectedPath}
          showWhitespace={showWhitespace}
          walkthroughNotes={walkthroughNotes}
          walkthroughSummary={walkthroughSummary}
        />
      ) : mode === 'walkthrough' ? (
        <>
          {walkthroughLoading ? (
            <div className="sidebar-walkthrough-status-shell">
              <div className="sidebar-walkthrough-status codex">
                <strong>Waiting on Codex…</strong>
              </div>
            </div>
          ) : walkthroughError ? (
            <div className="sidebar-walkthrough-status" title={walkthroughError.reason}>
              <strong>Walkthrough unavailable</strong>
              <span>{walkthroughError.reason}</span>
            </div>
          ) : null}
          {!walkthroughLoading ? (
            <div className="file-tree-shell" ref={treeHostRef}>
              <FileTree className="file-tree" model={model} onClick={handleTreeClick} />
            </div>
          ) : null}
        </>
      ) : (
        <div className="file-tree-shell" ref={treeHostRef}>
          <FileTree className="file-tree" model={model} onClick={handleTreeClick} />
        </div>
      )}
    </>
  );
}

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
  currentSource,
  entries,
  hasMore,
  loading,
  onLoadMore,
  onSelectSource,
  pullRequestSource,
  searchQuery,
}: {
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
  const rows = useMemo(
    () =>
      [
        pullRequestSource
          ? {
              author: null,
              committedAt: null,
              gravatarUrl: undefined,
              key: getSourceKey(pullRequestSource),
              ref: pullRequestSource.number ? `PR #${pullRequestSource.number}` : 'PR',
              source: pullRequestSource satisfies ReviewSource,
              subject: pullRequestSource.title || 'Pull Request',
            }
          : null,
        {
          author: null,
          committedAt: null,
          gravatarUrl: undefined,
          key: 'working-tree',
          ref: '',
          source: { type: 'working-tree' } satisfies ReviewSource,
          subject: 'Uncommitted',
        },
        ...entries.map((entry) => ({
          author: entry.author,
          committedAt: entry.committedAt,
          gravatarUrl: entry.gravatarUrl,
          key: `commit:${entry.ref}`,
          ref: entry.ref,
          source: { ref: entry.ref, type: 'commit' } satisfies ReviewSource,
          subject: entry.subject,
        })),
      ].filter((row): row is NonNullable<typeof row> => row != null),
    [entries, pullRequestSource],
  );
  const visibleRows = useMemo(
    () =>
      normalizedQuery
        ? rows.filter(
            (row) =>
              row.subject.toLowerCase().includes(normalizedQuery) ||
              row.ref.toLowerCase().includes(normalizedQuery),
          )
        : rows,
    [normalizedQuery, rows],
  );
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
      {visibleRows.map((row) => {
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
                : row.source.type === 'pull-request'
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

function WalkthroughSidebar({
  files,
  onActivatePath,
  selectedPath,
  showWhitespace,
  walkthroughNotes,
  walkthroughSummary,
}: {
  files: ReadonlyArray<ChangedFile>;
  onActivatePath: (path: string) => void;
  selectedPath: string | null;
  showWhitespace: boolean;
  walkthroughNotes: ReadonlyMap<string, WalkthroughNote>;
  walkthroughSummary: Walkthrough['summary'] | null;
}) {
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const groups = useMemo(() => {
    const nextGroups: Array<{
      files: Array<{ file: ChangedFile; note?: WalkthroughNote }>;
      key: string;
      reason: string;
      title: string;
    }> = [];
    const groupsByTitle = new Map<string, (typeof nextGroups)[number]>();

    for (const file of files) {
      const note = walkthroughNotes.get(file.path);
      const title = note?.groupTitle ?? 'Other changed files';
      const reason = note?.groupReason ?? 'Review after the primary walkthrough.';
      const key = `${title}:${reason}`;
      let group = groupsByTitle.get(key);

      if (!group) {
        group = {
          files: [],
          key,
          reason,
          title,
        };
        groupsByTitle.set(key, group);
        nextGroups.push(group);
      }

      group.files.push({ file, note });
    }

    return nextGroups;
  }, [files, walkthroughNotes]);
  const toggleGroupCollapsed = useCallback((key: string) => {
    setCollapsedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  return (
    <div className="walkthrough-list">
      {walkthroughSummary ? (
        <div className="walkthrough-summary">
          <strong>Review Focus</strong>
          <span>{renderInlineMarkdown(walkthroughSummary.focus)}</span>
          <span>{renderInlineMarkdown(walkthroughSummary.skim)}</span>
        </div>
      ) : null}
      {groups.map((group) => {
        const collapsed = collapsedGroupKeys.has(group.key);
        return (
          <section className={`walkthrough-group${collapsed ? ' collapsed' : ''}`} key={group.key}>
            <button
              aria-expanded={!collapsed}
              className="walkthrough-group-header"
              onClick={() => toggleGroupCollapsed(group.key)}
              title={`${group.title}. ${group.reason}`}
              type="button"
            >
              <span className="walkthrough-group-title-row">
                <ChevronDown
                  aria-hidden
                  className="walkthrough-group-chevron"
                  size={14}
                  strokeWidth={2.4}
                />
                <span className="walkthrough-group-title">{group.title}</span>
                <span className="walkthrough-group-count">{group.files.length}</span>
              </span>
              <small>{renderInlineMarkdown(group.reason)}</small>
            </button>
            {collapsed
              ? null
              : group.files.map(({ file, note }) => {
                  const lineCount = getDiffLineCount(file, showWhitespace);
                  return (
                    <button
                      className={`walkthrough-file${selectedPath === file.path ? ' selected' : ''}`}
                      key={file.path}
                      onClick={() => onActivatePath(file.path)}
                      title={note?.reason ?? file.path}
                      type="button"
                    >
                      <span className="walkthrough-file-title">
                        <span className="walkthrough-file-path">{file.path}</span>
                        <DiffLineCountBadge
                          className="walkthrough-line-count"
                          lineCount={lineCount}
                        />
                      </span>
                      {note ? (
                        <span className="walkthrough-file-meta">
                          {walkthroughImpactLabel[note.impact]} ·{' '}
                          {walkthroughActionLabel[note.action]}
                        </span>
                      ) : null}
                      <span className="walkthrough-file-reason">
                        {renderInlineMarkdown(
                          note?.context ?? note?.reason ?? 'Review this changed file.',
                        )}
                      </span>
                    </button>
                  );
                })}
          </section>
        );
      })}
    </div>
  );
}

export function DiffLineCountBadge({
  className = 'codiff-line-count',
  lineCount,
}: {
  className?: string;
  lineCount: DiffLineCount;
}) {
  if (!lineCount.countable) {
    return null;
  }

  return (
    <span
      aria-label={getDiffLineCountTitle(lineCount)}
      className={className}
      title={getDiffLineCountTitle(lineCount)}
    >
      <span className="codiff-line-count-added">+{formatLineCountNumber(lineCount.additions)}</span>
      <span className="codiff-line-count-deleted">
        -{formatLineCountNumber(lineCount.deletions)}
      </span>
    </span>
  );
}
