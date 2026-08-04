import type { ExpansionDirections } from '@pierre/diffs';
import type { ChangedFile, DiffSection, RepositoryState, ReviewContextRequest } from '../types.ts';
import { shaForRevision } from './review-history.ts';

export type ReviewContextExpansionRegion = {
  fromEnd: number;
  fromStart: number;
};

export type ReviewContextExpansionState = ReadonlyMap<number, ReviewContextExpansionRegion>;

const emptyExpansionState = new Map<number, ReviewContextExpansionRegion>();

/** Build one exact immutable request while preserving the provider source. */
export const getReviewContextRequest = (
  source: RepositoryState['source'],
  file: ChangedFile,
  section: DiffSection,
): ReviewContextRequest | null => {
  if (!section.range) {
    return null;
  }
  try {
    return {
      baseSha: shaForRevision(section.range.base),
      filePath: file.path,
      headSha: shaForRevision(section.range.head),
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      range: section.range,
      source,
      status: file.status,
    };
  } catch {
    return null;
  }
};

export const getReviewContextExpansionState = (
  state: ReviewContextExpansionState | undefined,
  hunkIndex: number,
  direction: ExpansionDirections,
  expansionLineCount: number,
  expandAll: boolean,
): ReviewContextExpansionState => {
  const current = state?.get(hunkIndex) ?? { fromEnd: 0, fromStart: 0 };
  const amount = expandAll ? Number.POSITIVE_INFINITY : expansionLineCount;
  const next = new Map(state ?? emptyExpansionState);
  next.set(hunkIndex, {
    fromEnd:
      direction === 'down' || direction === 'both'
        ? Math.max(current.fromEnd, amount)
        : current.fromEnd,
    fromStart:
      direction === 'up' || direction === 'both'
        ? Math.max(current.fromStart, amount)
        : current.fromStart,
  });
  return next;
};

export const reviewContextExpansionDigest = (state: ReviewContextExpansionState | undefined) =>
  [...(state ?? emptyExpansionState).entries()]
    .toSorted(([firstIndex], [secondIndex]) => firstIndex - secondIndex)
    .map(([index, region]) => `${index}:${region.fromStart}:${region.fromEnd}`)
    .join('|');

export const reviewContextExpansionProjectionKey = (
  projectionKey: string,
  fileFingerprint: string,
  sectionId: string,
) => `${projectionKey}:${fileFingerprint}:${sectionId}`;
