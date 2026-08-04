import { useCallback, useMemo, useState } from 'react';
import {
  defaultDiffSearchFilters,
  getDiffSearchResult,
  type DiffSearchFilters,
} from '../../lib/diff-search.ts';
import { fileHasVisibleDiff } from '../../lib/diff.ts';
import { fuzzyMatches } from '../../lib/files.ts';
import type { ChangedFile } from '../../types.ts';

type UseDiffSearchOptions = {
  files: ReadonlyArray<ChangedFile>;
  fileSearchQuery: string;
  showWhitespace: boolean;
};

export function useDiffSearch({ files, fileSearchQuery, showWhitespace }: UseDiffSearchOptions) {
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [focusRequest, setFocusRequest] = useState(0);
  const [filters, setFilters] = useState<DiffSearchFilters>(defaultDiffSearchFilters);
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(false);

  const fileFilteredFiles = useMemo(
    () =>
      files.filter(
        (file) =>
          fuzzyMatches(file.path, fileSearchQuery) && fileHasVisibleDiff(file, showWhitespace),
      ),
    [fileSearchQuery, files, showWhitespace],
  );
  const results = useMemo(
    () =>
      query.trim()
        ? fileFilteredFiles
            .map((file) => getDiffSearchResult(file, showWhitespace, query, filters))
            .filter((result) => result != null)
        : [],
    [fileFilteredFiles, filters, query, showWhitespace],
  );
  const matches = useMemo(() => results.flatMap((result) => result.matches), [results]);
  const matchPathSet = useMemo(() => new Set(results.map((result) => result.file.path)), [results]);
  const visibleFiles = useMemo(
    () =>
      query.trim()
        ? fileFilteredFiles.filter((file) => matchPathSet.has(file.path))
        : fileFilteredFiles,
    [fileFilteredFiles, matchPathSet, query],
  );
  const effectiveActiveMatchIndex =
    matches.length === 0 ? 0 : Math.min(activeMatchIndex, matches.length - 1);
  const activeMatch = matches[effectiveActiveMatchIndex] ?? null;

  const openSearch = useCallback(() => {
    setVisible(true);
    setFocusRequest((current) => current + 1);
  }, []);

  const closeSearch = useCallback(() => {
    setVisible(false);
    setQuery('');
    setActiveMatchIndex(0);
  }, []);

  const updateQuery = useCallback((nextQuery: string) => {
    setQuery(nextQuery);
    setVisible(true);
    setActiveMatchIndex(0);
  }, []);

  const moveMatch = useCallback(
    (direction: 1 | -1) => {
      setVisible(true);
      setActiveMatchIndex((current) => {
        const matchCount = matches.length;
        if (matchCount === 0) {
          return 0;
        }

        return (current + direction + matchCount) % matchCount;
      });
    },
    [matches.length],
  );

  const resetSearch = useCallback(() => {
    setQuery('');
    setActiveMatchIndex(0);
  }, []);

  return {
    activeMatch,
    activeMatchIndex: effectiveActiveMatchIndex,
    closeSearch,
    fileFilteredFiles,
    filters,
    focusRequest,
    hasQuery: query.trim().length > 0,
    matches,
    matchPathSet,
    moveMatch,
    openSearch,
    query,
    resetSearch,
    updateFilters: setFilters,
    updateQuery,
    visible,
    visibleFiles,
  };
}
