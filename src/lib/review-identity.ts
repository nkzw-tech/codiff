import type { ChangedFile } from '../types.ts';
import type { ReviewIdentity } from './app-types.ts';

export const getFileReviewIdentity = (file: ChangedFile): ReviewIdentity => ({
  fingerprint: file.fingerprint,
  key: file.path,
});

export const getReviewIdentity = (
  file: ChangedFile,
  identityByPath?: ReadonlyMap<string, ReviewIdentity>,
): ReviewIdentity => identityByPath?.get(file.path) ?? getFileReviewIdentity(file);

export const isReviewIdentityViewed = (
  viewed: Readonly<Record<string, string>>,
  identity: ReviewIdentity,
): boolean => viewed[identity.key] === identity.fingerprint;

export const updateReviewIdentityViewed = (
  viewed: Readonly<Record<string, string>>,
  identity: ReviewIdentity,
  currentlyViewed: boolean,
): Record<string, string> => {
  if (currentlyViewed) {
    const next = { ...viewed };
    delete next[identity.key];
    return next;
  }

  return {
    ...viewed,
    [identity.key]: identity.fingerprint,
  };
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
