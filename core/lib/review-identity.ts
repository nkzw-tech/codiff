import type { ChangedFile } from '../types.ts';
import type { ReviewIdentity } from './app-types.ts';
import { getSectionWalkthroughHunks } from './narrative-walkthrough-diff.js';

export const getFileReviewIdentity = (file: ChangedFile): ReviewIdentity => ({
  fingerprint: file.fingerprint,
  key: file.path,
});

export const getWalkthroughReviewKeyPrefix = (path: string) =>
  `walkthrough:${JSON.stringify(path)}:`;

const getHunkViewedKey = (path: string, hunkId: string) =>
  `${getWalkthroughReviewKeyPrefix(path)}${JSON.stringify(hunkId)}`;

export const getSectionReviewHunkIds = (
  file: ChangedFile,
  section: ChangedFile['sections'][number],
): ReadonlyArray<string> => {
  const ids = getSectionWalkthroughHunks(file, section).map((hunk) => hunk.id);
  return ids.length > 0 ? ids : [section.id];
};

export const getWalkthroughReviewIdentity = (
  file: ChangedFile,
  hunkIds: ReadonlyArray<string>,
): ReviewIdentity => ({
  coverage: {
    allHunkIds: file.sections.flatMap((section) => getSectionReviewHunkIds(file, section)),
    file: getFileReviewIdentity(file),
    hunkIds,
  },
  fingerprint: file.fingerprint,
  key: `${getWalkthroughReviewKeyPrefix(file.path)}${JSON.stringify(hunkIds)}`,
});

export const getReviewIdentity = (
  file: ChangedFile,
  identityByPath?: ReadonlyMap<string, ReviewIdentity>,
): ReviewIdentity => identityByPath?.get(file.path) ?? getFileReviewIdentity(file);

export const isReviewIdentityViewed = (
  viewed: Readonly<Record<string, string>>,
  identity: ReviewIdentity,
): boolean => {
  const { coverage } = identity;
  return coverage
    ? viewed[coverage.file.key] === coverage.file.fingerprint ||
        (coverage.hunkIds.length > 0 &&
          coverage.hunkIds.every(
            (id) => viewed[getHunkViewedKey(coverage.file.key, id)] === coverage.file.fingerprint,
          ))
    : viewed[identity.key] === identity.fingerprint;
};

export const updateReviewIdentityViewed = (
  viewed: Readonly<Record<string, string>>,
  identity: ReviewIdentity,
  currentlyViewed: boolean,
): Record<string, string> => {
  const next = { ...viewed };
  const { coverage } = identity;
  if (coverage) {
    const { allHunkIds, file, hunkIds } = coverage;
    // Split a whole-file mark before unviewing one block so the other hunks stay viewed.
    if (viewed[file.key] === file.fingerprint) {
      for (const id of allHunkIds) {
        next[getHunkViewedKey(file.key, id)] = file.fingerprint;
      }
    }
    for (const id of hunkIds) {
      const key = getHunkViewedKey(file.key, id);
      if (currentlyViewed) {
        delete next[key];
      } else {
        next[key] = file.fingerprint;
      }
    }
    if (
      allHunkIds.length > 0 &&
      allHunkIds.every((id) => next[getHunkViewedKey(file.key, id)] === file.fingerprint)
    ) {
      next[file.key] = file.fingerprint;
    } else {
      delete next[file.key];
    }
    return next;
  }

  // A whole-file toggle replaces any partial hunk progress for that file.
  const prefix = getWalkthroughReviewKeyPrefix(identity.key);
  for (const key of Object.keys(next)) {
    if (key.startsWith(prefix)) {
      delete next[key];
    }
  }
  if (currentlyViewed) {
    delete next[identity.key];
  } else {
    next[identity.key] = identity.fingerprint;
  }
  return next;
};

export const updateReviewIdentityCollapsed = (
  collapsed: ReadonlySet<string>,
  identity: ReviewIdentity,
  currentlyCollapsed: boolean,
): Set<string> => {
  const next = new Set(collapsed);
  if (currentlyCollapsed) {
    next.delete(identity.key);
  } else {
    next.add(identity.key);
  }
  return next;
};
