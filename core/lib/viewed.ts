import type { RepositoryState } from '../types.ts';
import { getWalkthroughReviewKeyPrefix } from './review-identity.ts';
import { usesViewedFileState } from './source.ts';

const getViewedKey = (root: string) => `codiff:viewed:${root}`;

export const readViewed = (root: string): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(getViewedKey(root)) || '{}') as Record<string, string>;
  } catch {
    return {};
  }
};

export const writeViewed = (root: string, viewed: Record<string, string>) => {
  localStorage.setItem(getViewedKey(root), JSON.stringify(viewed));
};

export const readViewedForState = (
  state: RepositoryState,
  previous: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  if (usesViewedFileState(state.source)) {
    return readViewed(state.root);
  }
  if (!state.viewedFiles) {
    return { ...previous };
  }
  // GitHub owns whole-file progress; keep local partial walkthrough progress
  // only while the file is unchanged and remains unviewed on GitHub.
  const partial: Record<string, string> = {};
  for (const file of state.files) {
    if (state.viewedFiles[file.path] || previous[file.path] === file.fingerprint) {
      continue;
    }
    const prefix = getWalkthroughReviewKeyPrefix(file.path);
    for (const [key, fingerprint] of Object.entries(previous)) {
      if (key.startsWith(prefix) && fingerprint === file.fingerprint) {
        partial[key] = fingerprint;
      }
    }
  }
  return { ...partial, ...state.viewedFiles };
};
