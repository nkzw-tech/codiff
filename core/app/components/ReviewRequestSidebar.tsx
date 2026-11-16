import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/ArrowsClockwise';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown';
import { CircleDashedIcon as CircleDashed } from '@phosphor-icons/react/CircleDashed';
import { GitMergeIcon as GitMerge } from '@phosphor-icons/react/GitMerge';
import { GitPullRequestIcon as GitPullRequest } from '@phosphor-icons/react/GitPullRequest';
import { XCircleIcon as XCircle } from '@phosphor-icons/react/XCircle';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { matchesShortcut } from '../../config/keymap.ts';
import type { CodiffKeymap } from '../../config/types.ts';
import { isNativeInputTarget } from '../../lib/keyboard.ts';
import type {
  ReviewRequestFilter,
  ReviewRequestSort,
  ReviewRequestSummary,
  ReviewSource,
} from '../../types.ts';
import type { useReviewProjects } from '../hooks/useReviewProjects.ts';
import { useReviewRequests } from '../hooks/useReviewRequests.ts';
import { Button } from './Button.tsx';

const filters = { all: 'All states', closed: 'Closed', merged: 'Merged', open: 'Open' };
const sorts = { newest: 'Newest first', oldest: 'Oldest first', updated: 'Recently updated' };
const defaultOptions = { filter: 'open', sort: 'updated' } as const;

const readOptions = (key: string): { filter: ReviewRequestFilter; sort: ReviewRequestSort } => {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value && Object.hasOwn(filters, value.filter) && Object.hasOwn(sorts, value.sort)) {
      return value;
    }
  } catch {
    // The panel also works without storage.
  }
  return defaultOptions;
};

function Select({
  children,
  label,
  onChange,
  value,
}: {
  children: ReactNode;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="review-requests-select">
      <select
        aria-label={label}
        onChange={(event) => onChange(event.currentTarget.value)}
        value={value}
      >
        {children}
      </select>
      <CaretDown aria-hidden size={10} weight="bold" />
    </label>
  );
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });

const formatUpdatedAt = (timestamp: number) => {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes === 0) {
    return 'Just now';
  }
  if (minutes < 60) {
    return relativeTime.format(-minutes, 'minute');
  }
  if (minutes < 1440) {
    return relativeTime.format(-Math.floor(minutes / 60), 'hour');
  }
  if (minutes < 43_200) {
    return relativeTime.format(-Math.floor(minutes / 1440), 'day');
  }
  if (minutes < 525_600) {
    return relativeTime.format(-Math.floor(minutes / 43_200), 'month');
  }
  return relativeTime.format(-Math.floor(minutes / 525_600), 'year');
};

const getStatus = ({ draft, state }: ReviewRequestSummary) => {
  if (draft) {
    return { icon: CircleDashed, label: 'Draft', tone: 'draft' };
  }
  if (state === 'merged') {
    return { icon: GitMerge, label: 'Merged', tone: state };
  }
  if (state === 'closed') {
    return { icon: XCircle, label: 'Closed', tone: state };
  }
  return { icon: GitPullRequest, label: 'Open', tone: state };
};

export function ReviewRequestSidebar({
  active,
  currentSource,
  keymap,
  onSelect,
  reviewProjects,
  root,
}: {
  active: boolean;
  currentSource: ReviewSource;
  keymap: CodiffKeymap;
  onSelect: (source: ReviewRequestSummary['source']) => void;
  reviewProjects: ReturnType<typeof useReviewProjects>;
  root: string;
}) {
  const { project, projects } = reviewProjects;
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const noun = project?.provider === 'gitlab' ? 'merge requests' : 'pull requests';

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isNativeInputTarget(event.target) && matchesShortcut(event, keymap, 'fileFilter')) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, keymap]);

  return (
    <div className="review-requests-sidebar" hidden={!active}>
      <div className="sidebar-search-row">
        <input
          aria-label={`Search ${noun}`}
          className="sidebar-search"
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder={`Search ${noun}…`}
          ref={inputRef}
          spellCheck={false}
          type="search"
          value={search}
        />
      </div>
      {project ? (
        <ReviewRequestList
          active={active}
          currentUrl={currentSource.type === 'pull-request' ? currentSource.url : undefined}
          key={project.id}
          noun={noun}
          onSelect={onSelect}
          project={project}
          projectPicker={
            projects.length > 1 ? (
              <Select label="Review repository" onChange={reviewProjects.select} value={project.id}>
                {projects.map(({ host, id, path, remote }) => (
                  <option key={id} title={`${host}/${path}`} value={id}>
                    {path} ({remote})
                  </option>
                ))}
              </Select>
            ) : (
              <span
                className="review-requests-project-name"
                title={`${project.host}/${project.path}`}
              >
                {project.path}
              </span>
            )
          }
          root={root}
          search={query}
          searching={search.trim() !== query}
        />
      ) : (
        <div className="review-requests-message" role={reviewProjects.error ? 'alert' : 'status'}>
          {reviewProjects.loading ? (
            'Finding review repositories…'
          ) : reviewProjects.error ? (
            <>
              <strong>Could not read Git remotes</strong>
              <span>{reviewProjects.error}</span>
              <Button onClick={reviewProjects.retry} size="sm" type="button" variant="secondary">
                Retry
              </Button>
            </>
          ) : (
            'Add a GitHub or GitLab remote to browse reviews.'
          )}
        </div>
      )}
    </div>
  );
}

function ReviewRequestList({
  active,
  currentUrl,
  noun,
  onSelect,
  project,
  projectPicker,
  root,
  search,
  searching,
}: {
  active: boolean;
  currentUrl?: string;
  noun: string;
  onSelect: (source: ReviewRequestSummary['source']) => void;
  project: NonNullable<ReturnType<typeof useReviewProjects>['project']>;
  projectPicker: ReactNode;
  root: string;
  search: string;
  searching: boolean;
}) {
  const storageKey = `codiff.reviewRequests.${root}:${project.id}`;
  const [options, setOptions] = useState(() => readOptions(storageKey));
  const { filter, sort } = options;
  const { error, load, loading, page, retry } = useReviewRequests(
    { filter, projectId: project.id, search, sort },
    active && !searching,
  );
  const listRef = useRef<HTMLDivElement>(null);
  const entries = page?.entries ?? [];

  const changeOptions = (next: typeof options) => {
    setOptions(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // The current selection is still kept in memory.
    }
  };

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [filter, search, sort]);

  return (
    <>
      <div className="review-requests-controls">
        <div className="review-requests-project">
          {projectPicker}
          <Button
            aria-label={`Refresh ${noun}`}
            className="review-requests-refresh"
            disabled={searching || (loading && !error)}
            onClick={() => load()}
            size="icon"
            title={`Refresh ${noun}`}
            type="button"
            variant="ghost"
          >
            <ArrowsClockwise aria-hidden size={14} weight="bold" />
          </Button>
        </div>
        <div className="review-requests-filters">
          <Select
            label="Review state"
            onChange={(value) => changeOptions({ filter: value as ReviewRequestFilter, sort })}
            value={filter}
          >
            {(['open', 'merged', 'closed', 'all'] as const).map((value) => (
              <option key={value} value={value}>
                {filters[value]}
              </option>
            ))}
          </Select>
          <Select
            label="Sort reviews"
            onChange={(value) => changeOptions({ filter, sort: value as ReviewRequestSort })}
            value={sort}
          >
            {(['updated', 'newest', 'oldest'] as const).map((value) => (
              <option key={value} value={value}>
                {sorts[value]}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div
        aria-busy={loading || searching}
        aria-label={noun}
        className="history-list review-requests-list"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
            return;
          }
          const rows = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>('.review-request-row'),
          ];
          const index = rows.indexOf(event.target as HTMLButtonElement);
          const next = index + (event.key === 'ArrowDown' ? 1 : -1);
          if (index >= 0 && rows[next]) {
            event.preventDefault();
            rows[next].focus();
          }
        }}
        ref={listRef}
      >
        {entries.map((entry) => {
          const { icon: Icon, label, tone } = getStatus(entry);
          const { source, updatedAt } = entry;
          const reference = `${project.provider === 'gitlab' ? '!' : '#'}${source.number}`;
          const date = new Date(updatedAt);
          const selected = currentUrl?.toLowerCase() === source.url.toLowerCase();
          return (
            <button
              aria-current={selected || undefined}
              className={`history-entry review-request-row${selected ? ' selected' : ''}`}
              key={source.url}
              onClick={() => onSelect(source)}
              type="button"
            >
              <Icon
                aria-label={label}
                className="review-request-state"
                data-state={tone}
                role="img"
                size={15}
                weight="bold"
              />
              <span className="review-request-title" title={source.title}>
                {source.title}
              </span>
              <span className="review-request-meta">
                <span>
                  <span className="review-request-number">{reference}</span>
                  {entry.author ? ` · ${entry.author}` : ''}
                </span>
                <time dateTime={date.toISOString()} title={date.toLocaleString()}>
                  {formatUpdatedAt(updatedAt)}
                </time>
              </span>
            </button>
          );
        })}
        {error ? (
          <div className="review-requests-message" role="alert">
            <strong>Could not load {noun}</strong>
            <span>{error.replace(/^Error invoking remote method '[^']+': Error: /, '')}</span>
            <Button onClick={retry} size="sm" type="button" variant="secondary">
              Retry
            </Button>
          </div>
        ) : loading || searching ? (
          <div className="review-requests-message" role="status">
            Loading {noun}…
          </div>
        ) : entries.length === 0 ? (
          <div className="review-requests-message" role="status">
            {search ? `No matching ${noun}.` : `No ${filter === 'all' ? '' : `${filter} `}${noun}.`}
          </div>
        ) : null}
        {page?.nextCursor && !error ? (
          <Button
            className="review-requests-more"
            disabled={loading || searching}
            onClick={() => load(page.nextCursor)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Load more
          </Button>
        ) : null}
      </div>
    </>
  );
}
