import type { ChangedFile, GitFileStatus } from '../types.ts';

export const statusForTree: Record<
  GitFileStatus,
  'added' | 'deleted' | 'modified' | 'renamed' | 'untracked'
> = {
  added: 'added',
  deleted: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
  untracked: 'untracked',
};

export const fileTreeSort = (
  left: { isDirectory: boolean; path: string; segments?: ReadonlyArray<string> },
  right: { isDirectory: boolean; path: string; segments?: ReadonlyArray<string> },
) => compareTreePaths(left.path, right.path);

export const abbreviateHomePath = (path: string) =>
  path
    .replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/home\/[^/]+(?=\/|$)/, '~')
    .replace(/^[A-Za-z]:[/\\]Users[/\\][^/\\]+(?=[/\\]|$)/, '~');

/**
 * Splits a repository path into a shrinkable head and the repository's own
 * directory, so the top bar can keep the repository name visible and put the
 * ellipsis in the middle when the full path overflows.
 */
export const splitRepositoryPath = (path: string) => {
  const homePath = abbreviateHomePath(path);
  const separator = Math.max(homePath.lastIndexOf('/'), homePath.lastIndexOf('\\'));
  return separator > 0
    ? { head: homePath.slice(0, separator), tail: homePath.slice(separator) }
    : { head: '', tail: homePath };
};

function compareTreePaths(leftPath: string, rightPath: string) {
  const leftParts = leftPath.split('/');
  const rightParts = rightPath.split('/');
  const length = Math.min(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const left = leftParts[index];
    const right = rightParts[index];
    if (left === right) {
      continue;
    }

    const leftIsDirectory = index < leftParts.length - 1;
    const rightIsDirectory = index < rightParts.length - 1;
    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1;
    }

    return left.localeCompare(right);
  }

  return leftParts.length - rightParts.length;
}

export const sortFiles = (files: ReadonlyArray<ChangedFile>) =>
  [...files].sort((left, right) => compareTreePaths(left.path, right.path));

export const fuzzyMatches = (path: string, query: string) => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const normalizedPath = path.toLowerCase();
  let pathIndex = 0;
  for (const character of normalizedQuery) {
    pathIndex = normalizedPath.indexOf(character, pathIndex);
    if (pathIndex === -1) {
      return false;
    }
    pathIndex += 1;
  }
  return true;
};
