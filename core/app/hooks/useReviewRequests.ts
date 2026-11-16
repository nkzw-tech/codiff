import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewRequestListQuery, ReviewRequestPage } from '../../types.ts';

type CachedPage = ReviewRequestPage & { loadedAt: number; pages: number };
type ListResult = { error?: string; loading?: boolean; page?: CachedPage; retryCursor?: string };

export function useReviewRequests(query: Omit<ReviewRequestListQuery, 'cursor'>, active: boolean) {
  const { filter, projectId, search, sort } = query;
  const key = JSON.stringify([projectId, filter, search, sort]);
  const [results, setResults] = useState<ReadonlyMap<string, ListResult>>(() => new Map());
  const result = results.get(key);
  const latestResults = useRef(results);
  const pending = useRef(new Set<string>());

  const load = useCallback(
    (cursor?: string) => {
      if (!projectId || pending.current.has(key)) {
        return;
      }
      pending.current.add(key);
      const previousPage = latestResults.current.get(key)?.page;
      const update = (next: ListResult) => {
        const updated = new Map(latestResults.current);
        updated.delete(key);
        updated.set(key, next);
        if (updated.size > 16) {
          const oldest = updated.keys().next().value;
          if (oldest != null) {
            updated.delete(oldest);
          }
        }
        latestResults.current = updated;
        setResults(updated);
      };
      update({ loading: true, page: previousPage });
      void window.codiff.listReviewRequests({ cursor, filter, projectId, search, sort }).then(
        (page) => {
          pending.current.delete(key);
          const entries = new Map(
            (cursor ? (previousPage?.entries ?? []) : []).map((entry) => [entry.source.url, entry]),
          );
          for (const entry of page.entries) {
            entries.set(entry.source.url, entry);
          }
          update({
            page: {
              entries: [...entries.values()],
              loadedAt: Date.now(),
              nextCursor: page.nextCursor,
              pages: cursor ? (previousPage?.pages ?? 0) + 1 : 1,
            },
          });
        },
        (error: unknown) => {
          pending.current.delete(key);
          update({
            error: error instanceof Error ? error.message : String(error),
            page: previousPage,
            retryCursor: cursor,
          });
        },
      );
    },
    [filter, key, projectId, search, setResults, sort],
  );

  useEffect(() => {
    if (!active) {
      return;
    }
    const cached = latestResults.current.get(key);
    // Refresh a stale first page without resetting a longer list on tab changes.
    if (!cached || (cached.page?.pages === 1 && Date.now() - cached.page.loadedAt > 60_000)) {
      load();
    }
  }, [active, key, load]);

  return {
    error: result?.error,
    load,
    loading: !result || result.loading === true,
    page: result?.page,
    retry: () => load(result?.retryCursor),
  };
}
