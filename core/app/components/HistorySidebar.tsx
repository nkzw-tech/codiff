import { useCallback, useMemo, useRef } from 'react';
import type { PullRequestSource } from '../../lib/app-types.ts';
import { getShortRef, getSourceKey } from '../../lib/source.ts';
import type { HistoryEntry, ReviewSource } from '../../types.ts';
import { Avatar } from './Avatar.tsx';

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

export function HistorySidebar({
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
              key: 'working-tree',
              kind: 'entry' as const,
              ref: 'local',
              source: { type: 'working-tree' } satisfies ReviewSource,
              subject: 'Uncommitted changes',
            }
          : null,
        !normalizedQuery
          ? {
              author: null,
              committedAt: null,
              gravatarUrl: undefined,
              key: getSourceKey(pullRequestSource),
              kind: 'entry' as const,
              ref:
                pullRequestSource.provider === 'gitlab'
                  ? `MR !${pullRequestSource.number ?? ''}`
                  : `PR #${pullRequestSource.number ?? ''}`,
              source: pullRequestSource satisfies ReviewSource,
              subject:
                pullRequestSource.title ||
                (pullRequestSource.provider === 'gitlab' ? 'Merge Request' : 'Pull Request'),
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
              key: getSourceKey({
                baseRef: branchSource.baseRef,
                headRef: branchSource.headRef,
                ref: branchSource.ref,
                type: 'branch-working-tree',
              }),
              kind: 'entry' as const,
              ref: 'branch+',
              source: {
                baseRef: branchSource.baseRef,
                headRef: branchSource.headRef,
                ref: branchSource.ref,
                type: 'branch-working-tree',
              } satisfies ReviewSource,
              subject: `All changes vs ${branchSource.ref}`,
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
              subject: `Committed only vs ${branchSource.ref}`,
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
                : row.source.type === 'pull-request' ||
                    row.source.type === 'branch-diff' ||
                    row.source.type === 'branch-working-tree'
                  ? row.ref
                  : 'local'}
            </span>
            <span className="history-entry-subject">{row.subject}</span>
            {hasMetadata ? (
              <span className="history-entry-meta">
                <span className="history-entry-author">
                  <Avatar name={row.author || '?'} size="small" url={row.gravatarUrl} />
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
