import type { ReviewSource } from '../types.ts';
import type { RepositoryLoadError } from './app-types.ts';
import { compactPath } from './files.ts';

const rangeLabel = (source: Extract<ReviewSource, { type: 'range' }>) =>
  `${source.base}${source.symmetric ? '...' : '..'}${source.head}`;

type SourceCapabilities = {
  emptyTitle: string;
  historySource: boolean;
  lazyDiffContent: boolean;
  preloadDiffSearchContent: boolean;
  startInHistoryWhenEmpty: boolean;
  viewedFileState: boolean;
};

const sourceCapabilitiesByType = {
  branch: {
    emptyTitle: 'No branch changes',
    historySource: true,
    lazyDiffContent: true,
    preloadDiffSearchContent: true,
    startInHistoryWhenEmpty: true,
    viewedFileState: false,
  },
  'branch-diff': {
    emptyTitle: 'No branch changes',
    historySource: true,
    lazyDiffContent: true,
    preloadDiffSearchContent: true,
    startInHistoryWhenEmpty: true,
    viewedFileState: false,
  },
  commit: {
    emptyTitle: 'No changes in commit',
    historySource: false,
    lazyDiffContent: true,
    preloadDiffSearchContent: false,
    startInHistoryWhenEmpty: false,
    viewedFileState: false,
  },
  'pull-request': {
    emptyTitle: 'No pull request changes',
    historySource: true,
    lazyDiffContent: false,
    preloadDiffSearchContent: false,
    startInHistoryWhenEmpty: false,
    viewedFileState: false,
  },
  range: {
    emptyTitle: 'No changes in range',
    historySource: false,
    lazyDiffContent: true,
    preloadDiffSearchContent: false,
    startInHistoryWhenEmpty: false,
    viewedFileState: false,
  },
  'working-tree': {
    emptyTitle: 'No local changes',
    historySource: false,
    lazyDiffContent: true,
    preloadDiffSearchContent: true,
    startInHistoryWhenEmpty: true,
    viewedFileState: true,
  },
} satisfies Record<ReviewSource['type'], SourceCapabilities>;

export const getSourceCapabilities = (source: ReviewSource) =>
  sourceCapabilitiesByType[source.type];

export const getSourceKey = (source: ReviewSource) =>
  source.type === 'commit'
    ? `commit:${source.ref}`
    : source.type === 'branch-diff'
      ? `branch-diff:${source.ref}:${source.baseRef}:${source.headRef}`
      : source.type === 'branch'
        ? `branch:${source.ref}`
        : source.type === 'range'
          ? `range:${rangeLabel(source)}`
          : source.type === 'pull-request'
            ? `pull-request:${source.owner ?? ''}/${source.repo ?? ''}#${source.number ?? source.url}`
            : 'working-tree';

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const getRepositoryLoadError = (error: unknown): RepositoryLoadError => {
  const message = getErrorMessage(error);
  return /not a git repository/i.test(message)
    ? {
        kind: 'not-a-repository',
        message:
          'Codiff was opened outside a Git repository. Run `codiff` from inside a repo, or choose File → Open Folder… to open one.',
      }
    : {
        kind: 'generic',
        message,
      };
};

export const getShortRef = (ref: string) => ref.slice(0, 7);

export const getSourceLabel = (source: ReviewSource) =>
  source.type === 'commit'
    ? getShortRef(source.ref)
    : source.type === 'branch' || source.type === 'branch-diff'
      ? `Branch vs ${source.ref}`
      : source.type === 'range'
        ? rangeLabel(source)
        : source.type === 'pull-request'
          ? source.number
            ? `PR #${source.number}`
            : 'Pull request'
          : 'Uncommitted';

export const getHistorySource = (source: ReviewSource): ReviewSource | undefined =>
  getSourceCapabilities(source).historySource ? source : undefined;

export const supportsLazyDiffContent = (source: ReviewSource) =>
  getSourceCapabilities(source).lazyDiffContent;

export const supportsDiffSearchContentPreload = (source: ReviewSource) =>
  getSourceCapabilities(source).preloadDiffSearchContent;

export const shouldStartInHistoryWhenEmpty = (source: ReviewSource) =>
  getSourceCapabilities(source).startInHistoryWhenEmpty;

export const usesViewedFileState = (source: ReviewSource) =>
  getSourceCapabilities(source).viewedFileState;

export const getEmptySourceTitle = (source: ReviewSource) =>
  getSourceCapabilities(source).emptyTitle;

export const getEmptySourceDetail = (
  source: ReviewSource,
  root: string,
): { kind: 'code' | 'text'; text: string; title?: string } =>
  source.type === 'commit'
    ? { kind: 'text', text: getShortRef(source.ref) }
    : source.type === 'branch' || source.type === 'branch-diff'
      ? { kind: 'text', text: source.ref }
      : { kind: 'code', text: compactPath(root), title: root };
