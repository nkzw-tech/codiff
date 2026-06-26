import type { ReviewSource } from '../types.ts';
import type { RepositoryLoadError } from './app-types.ts';
import { compactPath } from './files.ts';

const rangeLabel = (source: Extract<ReviewSource, { type: 'range' }>) =>
  `${source.base}${source.symmetric ? '...' : '..'}${source.head}`;

const arcRangeLabel = (source: Extract<ReviewSource, { type: 'arc-range' }>) =>
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
  'arc-branch': {
    emptyTitle: 'No Arc branch changes',
    historySource: true,
    lazyDiffContent: true,
    preloadDiffSearchContent: true,
    startInHistoryWhenEmpty: true,
    viewedFileState: false,
  },
  'arc-commit': {
    emptyTitle: 'No changes in Arc commit',
    historySource: false,
    lazyDiffContent: true,
    preloadDiffSearchContent: false,
    startInHistoryWhenEmpty: false,
    viewedFileState: false,
  },
  'arc-pull-request': {
    emptyTitle: 'No Arc PR changes',
    historySource: true,
    lazyDiffContent: true,
    preloadDiffSearchContent: false,
    startInHistoryWhenEmpty: false,
    viewedFileState: false,
  },
  'arc-range': {
    emptyTitle: 'No changes in Arc range',
    historySource: false,
    lazyDiffContent: true,
    preloadDiffSearchContent: false,
    startInHistoryWhenEmpty: false,
    viewedFileState: false,
  },
  'arc-working-tree': {
    emptyTitle: 'No Arc local changes',
    historySource: true,
    lazyDiffContent: true,
    preloadDiffSearchContent: true,
    startInHistoryWhenEmpty: true,
    viewedFileState: true,
  },
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
    emptyTitle: 'No review changes',
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

export const getSourceKey = (source: ReviewSource) => {
  switch (source.type) {
    case 'arc-branch':
      return `arc-branch:${source.base}`;
    case 'arc-commit':
      return `arc-commit:${source.ref}`;
    case 'arc-pull-request':
      return `arc-pull-request:${source.number}`;
    case 'arc-range':
      return `arc-range:${arcRangeLabel(source)}`;
    case 'arc-working-tree':
      return 'arc-working-tree';
    case 'branch':
      return `branch:${source.ref}`;
    case 'branch-diff':
      return `branch-diff:${source.ref}:${source.baseRef}:${source.headRef}`;
    case 'commit':
      return `commit:${source.ref}`;
    case 'pull-request':
      return `pull-request:${source.provider ?? ''}:${source.host ?? ''}:${
        source.projectPath ?? `${source.owner ?? ''}/${source.repo ?? ''}`
      }#${source.number ?? source.url}`;
    case 'range':
      return `range:${rangeLabel(source)}`;
    case 'working-tree':
      return 'working-tree';
  }
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const getRepositoryLoadError = (error: unknown): RepositoryLoadError => {
  const message = getErrorMessage(error);
  return /not a git repository/i.test(message)
    ? {
        kind: 'not-a-repository',
        message:
          'Codiff was opened outside a Git or Arc repository. Run `codiff` from inside a repo, or choose File → Open Folder… to open one.',
      }
    : {
        kind: 'generic',
        message,
      };
};

export const getShortRef = (ref: string) => ref.slice(0, 7);

export const getSourceLabel = (source: ReviewSource) => {
  switch (source.type) {
    case 'arc-branch':
      return `Arc branch vs ${source.base}`;
    case 'arc-commit':
      return `Arc commit ${getShortRef(source.ref)}`;
    case 'arc-pull-request':
      return source.title
        ? `Arc PR #${source.number}: ${source.title}`
        : `Arc PR #${source.number}`;
    case 'arc-range':
      return `Arc ${arcRangeLabel(source)}`;
    case 'arc-working-tree':
      return 'Arc local changes';
    case 'branch':
    case 'branch-diff':
      return `Branch vs ${source.ref}`;
    case 'commit':
      return getShortRef(source.ref);
    case 'pull-request':
      return source.number
        ? `${source.provider === 'gitlab' ? 'MR' : 'PR'} #${source.number}`
        : source.provider === 'gitlab'
          ? 'Merge request'
          : 'Pull request';
    case 'range':
      return rangeLabel(source);
    case 'working-tree':
      return 'Uncommitted';
  }
};

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

export const isWorkingTreeSource = (source: ReviewSource) =>
  source.type === 'working-tree' || source.type === 'arc-working-tree';

export const getEmptySourceTitle = (source: ReviewSource) =>
  getSourceCapabilities(source).emptyTitle;

export const getEmptySourceDetail = (
  source: ReviewSource,
  root: string,
): { kind: 'code' | 'text'; text: string; title?: string } =>
  source.type === 'commit'
    ? { kind: 'text', text: getShortRef(source.ref) }
    : source.type === 'arc-commit'
      ? { kind: 'text', text: getShortRef(source.ref) }
      : source.type === 'arc-pull-request'
        ? { kind: 'text', text: `#${source.number}` }
        : source.type === 'arc-range'
          ? { kind: 'text', text: arcRangeLabel(source) }
          : source.type === 'arc-branch'
            ? { kind: 'text', text: source.base }
            : source.type === 'branch' || source.type === 'branch-diff'
              ? { kind: 'text', text: source.ref }
              : { kind: 'code', text: compactPath(root), title: root };
