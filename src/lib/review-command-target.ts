import type { ChangedFile, ReviewSource } from '../types.ts';
import type { ReviewIdentity } from './app-types.ts';
import { getFileReviewIdentity } from './review-identity.ts';
import { getSourceKey } from './source.ts';

export type ReviewCommandTarget = {
  file: ChangedFile;
  reviewIdentity: ReviewIdentity;
  sourceKey: string;
};

export const createReviewCommandTarget = (
  source: ReviewSource,
  file: ChangedFile,
  reviewIdentity: ReviewIdentity = getFileReviewIdentity(file),
): ReviewCommandTarget => ({
  file,
  reviewIdentity,
  sourceKey: getSourceKey(source),
});

export const resolveReviewCommandTarget = ({
  activeTarget,
  files,
  selectedPath,
  source,
  useActiveTarget,
}: {
  activeTarget: ReviewCommandTarget | null;
  files: ReadonlyArray<ChangedFile>;
  selectedPath: string | null;
  source: ReviewSource;
  useActiveTarget: boolean;
}): ReviewCommandTarget | null => {
  const sourceKey = getSourceKey(source);
  if (useActiveTarget && activeTarget?.sourceKey === sourceKey) {
    return activeTarget;
  }

  const file = selectedPath ? files.find((candidate) => candidate.path === selectedPath) : null;
  return file ? createReviewCommandTarget(source, file) : null;
};
