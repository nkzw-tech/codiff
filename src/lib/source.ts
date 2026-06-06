import type { ReviewSource } from '../types.ts';
import type { RepositoryLoadError } from './app-types.ts';

const rangeLabel = (source: Extract<ReviewSource, { type: 'range' }>) =>
  `${source.base}${source.symmetric ? '...' : '..'}${source.head}`;

export const getSourceKey = (source: ReviewSource) =>
  source.type === 'commit'
    ? `commit:${source.ref}`
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
    : source.type === 'branch'
      ? source.ref
      : source.type === 'range'
        ? rangeLabel(source)
        : source.type === 'pull-request'
          ? source.number
            ? `PR #${source.number}`
            : 'Pull request'
          : 'Uncommitted';
