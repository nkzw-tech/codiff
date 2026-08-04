import type { ChangedFile } from '../types.ts';
import type { DiffSearchMatch, DiffSearchResult } from './app-types.ts';
import { getFirstVisibleSection, getItemId, getVisibleDiffSections } from './diff.ts';

export type DiffSearchFilters = {
  additions: boolean;
  deletions: boolean;
  unchanged: boolean;
};

export const defaultDiffSearchFilters: DiffSearchFilters = {
  additions: true,
  deletions: true,
  unchanged: false,
};

const countOccurrences = (text: string, normalizedQuery: string) => {
  if (!normalizedQuery) {
    return 0;
  }

  const normalizedText = text.toLowerCase();
  let count = 0;
  let index = normalizedText.indexOf(normalizedQuery);
  while (index !== -1) {
    count += 1;
    index = normalizedText.indexOf(normalizedQuery, index + normalizedQuery.length);
  }

  return count;
};

const lineContainsQuery = (text: string | undefined, normalizedQuery: string) =>
  text != null && text.toLowerCase().includes(normalizedQuery);

export const getDiffSearchResult = (
  file: ChangedFile,
  showWhitespace: boolean,
  query: string,
  filters: DiffSearchFilters = defaultDiffSearchFilters,
): DiffSearchResult | null => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return null;
  }

  const matches: Array<DiffSearchMatch> = [];
  let matchCount = 0;
  const seenLineMatches = new Set<string>();

  const pushMatch = (match: DiffSearchMatch, occurrences: number) => {
    matchCount += occurrences;
    const key = `${match.itemId}:${match.side ?? 'header'}:${match.lineNumber ?? 'header'}`;
    if (!seenLineMatches.has(key)) {
      seenLineMatches.add(key);
      matches.push(match);
    }
  };

  const headerOccurrences =
    countOccurrences(file.path, normalizedQuery) +
    (file.oldPath ? countOccurrences(file.oldPath, normalizedQuery) : 0);

  if (headerOccurrences > 0) {
    const section = getFirstVisibleSection(file, showWhitespace);
    if (section) {
      pushMatch(
        {
          filePath: file.path,
          itemId: getItemId(section),
        },
        headerOccurrences,
      );
    }
  }

  for (const { fileDiff, section } of getVisibleDiffSections(file, showWhitespace)) {
    const itemId = getItemId(section);

    for (const hunk of fileDiff.hunks) {
      let deletionLineNumber = hunk.deletionStart;
      let additionLineNumber = hunk.additionStart;

      for (const content of hunk.hunkContent) {
        if (content.type === 'context') {
          // Search only unchanged lines that are part of the visible patch.
          // Full file contents must not make hidden context searchable.
          if (filters.unchanged) {
            for (let index = 0; index < content.lines; index += 1) {
              const line = fileDiff.additionLines[content.additionLineIndex + index];
              const occurrences = countOccurrences(line ?? '', normalizedQuery);
              if (occurrences > 0) {
                pushMatch(
                  {
                    filePath: file.path,
                    itemId,
                    lineNumber: additionLineNumber + index,
                    side: 'additions',
                  },
                  occurrences,
                );
              }
            }
          }

          deletionLineNumber += content.lines;
          additionLineNumber += content.lines;
          continue;
        }

        for (let index = 0; filters.deletions && index < content.deletions; index += 1) {
          const line = fileDiff.deletionLines[content.deletionLineIndex + index];
          const occurrences = countOccurrences(line ?? '', normalizedQuery);
          if (occurrences > 0) {
            pushMatch(
              {
                filePath: file.path,
                itemId,
                lineNumber: deletionLineNumber + index,
                side: 'deletions',
              },
              occurrences,
            );
          }
        }

        for (let index = 0; filters.additions && index < content.additions; index += 1) {
          const line = fileDiff.additionLines[content.additionLineIndex + index];
          const occurrences = countOccurrences(line ?? '', normalizedQuery);
          if (occurrences > 0) {
            pushMatch(
              {
                filePath: file.path,
                itemId,
                lineNumber: additionLineNumber + index,
                side: 'additions',
              },
              occurrences,
            );
          }
        }

        deletionLineNumber += content.deletions;
        additionLineNumber += content.additions;
      }
    }

    if (section.summary?.reason && lineContainsQuery(section.summary.reason, normalizedQuery)) {
      pushMatch(
        {
          filePath: file.path,
          itemId,
          lineNumber: 1,
          side: 'additions',
        },
        countOccurrences(section.summary.reason, normalizedQuery),
      );
    }
  }

  return matches.length > 0
    ? {
        file,
        matchCount,
        matches,
      }
    : null;
};
