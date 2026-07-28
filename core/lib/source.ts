import type { ResolvedReviewSource, ReviewSource } from '../types.ts';
import type { RepositoryLoadError } from './app-types.ts';
import { abbreviateHomePath } from './files.ts';

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
  'branch-working-tree': {
    emptyTitle: 'No changes',
    historySource: true,
    lazyDiffContent: true,
    preloadDiffSearchContent: true,
    startInHistoryWhenEmpty: true,
    viewedFileState: true,
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

type DisplayReviewSource = ResolvedReviewSource | ReviewSource;

const getSourceCapabilities = (source: DisplayReviewSource) =>
  sourceCapabilitiesByType[source.type];

export const getSourceKey = (source: DisplayReviewSource) =>
  source.type === 'commit'
    ? `commit:${'sha' in source ? source.sha : source.ref}`
    : source.type === 'branch-diff'
      ? `branch-diff:${source.ref}:${source.baseSha}:${source.headSha}`
      : source.type === 'branch-working-tree'
        ? `branch-working-tree:${source.ref}:${source.baseSha}:${source.headSha}`
        : source.type === 'branch'
          ? `branch:${source.ref}`
          : source.type === 'range'
            ? `range:${rangeLabel(source)}`
            : source.type === 'pull-request'
              ? `pull-request:${source.provider ?? ''}:${source.host ?? ''}:${source.projectPath ?? `${source.owner ?? ''}/${source.repo ?? ''}`}#${source.number ?? source.url}`
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

export const getSourceLabel = (source: DisplayReviewSource) =>
  source.type === 'commit'
    ? getShortRef('sha' in source ? source.sha : source.ref)
    : source.type === 'branch' || source.type === 'branch-diff'
      ? `Branch vs ${source.ref}`
      : source.type === 'branch-working-tree'
        ? `Local + branch vs ${source.ref}`
        : source.type === 'range'
          ? rangeLabel(source)
          : source.type === 'pull-request'
            ? source.number
              ? `${source.provider === 'gitlab' ? 'MR' : 'PR'} #${source.number}`
              : source.provider === 'gitlab'
                ? 'Merge request'
                : 'Pull request'
            : 'Uncommitted';

export const getHistorySource = (source: DisplayReviewSource): ReviewSource | undefined =>
  getSourceCapabilities(source).historySource ? (source as ReviewSource) : undefined;

export const getRefreshSource = (source: DisplayReviewSource): ReviewSource =>
  source.type === 'commit' && 'sha' in source
    ? { ref: source.sha, type: 'commit' }
    : source.type === 'branch-working-tree'
      ? {
          ref: source.ref,
          type: 'branch-working-tree',
        }
      : (source as ReviewSource);

export const supportsLazyDiffContent = (source: DisplayReviewSource) =>
  getSourceCapabilities(source).lazyDiffContent;

export const supportsDiffSearchContentPreload = (source: DisplayReviewSource) =>
  getSourceCapabilities(source).preloadDiffSearchContent;

export const shouldStartInHistoryWhenEmpty = (source: DisplayReviewSource) =>
  getSourceCapabilities(source).startInHistoryWhenEmpty;

export const usesViewedFileState = (source: DisplayReviewSource) =>
  getSourceCapabilities(source).viewedFileState;

export const getEmptySourceTitle = (source: DisplayReviewSource) =>
  getSourceCapabilities(source).emptyTitle;

export const getEmptySourceDetail = (
  source: DisplayReviewSource,
  root: string,
): { kind: 'code' | 'text'; text: string; title?: string } =>
  source.type === 'commit'
    ? { kind: 'text', text: getShortRef('sha' in source ? source.sha : source.ref) }
    : source.type === 'branch' ||
        source.type === 'branch-diff' ||
        source.type === 'branch-working-tree'
      ? { kind: 'text', text: source.ref }
      : { kind: 'code', text: abbreviateHomePath(root), title: root };
