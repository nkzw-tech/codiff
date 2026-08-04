/**
 * GitLab-facing types and adapter exports for Core's provider-neutral
 * region-aware replay comparison engine.
 */
import {
  computeLineDiff,
  computeVersionComparePreferringReplay as computePreferringReplay,
  isReplayCompareEndpoint,
  replayCompareAlgorithmVersion,
  type BlobLookup,
  type ReplayBlobBatchLookup,
  type ReplayBaseMovement,
  type ReplayBaseMovementCommit,
  type ReplayBaseRef,
  type ReplayCommentAnchor,
  type ReplayCompareFile,
  type ReplayCompareHunkClass,
  type ReplayCompareResult,
  type ReplayPatchFile,
} from '@nkzw/codiff-core';
import type { GitSha, ReviewVersionId } from '@nkzw/codiff-core/types';

export type MergeRequestVersionRef = {
  baseSha: GitSha;
  createdAt: string;
  headSha: GitSha;
  label: string;
  startSha: GitSha;
  versionId: ReviewVersionId;
};

export type VersionCompareEndpoint =
  | { kind: 'mr-base' }
  | { commentId: string; kind: 'comment-position' }
  | { baseSha: GitSha; headSha: GitSha; kind: 'diff-identity'; startSha: GitSha }
  | { headSha: GitSha; kind: 'head-sha' }
  | { kind: 'last-reviewed' }
  | { kind: 'mr-version'; versionId: ReviewVersionId };

export type VersionCompareRange = {
  from: MergeRequestVersionRef;
  paths?: ReadonlyArray<string>;
  to: MergeRequestVersionRef;
};

export type VersionCompareHunkClass = ReplayCompareHunkClass;
export type VersionCompareFile = ReplayCompareFile;
export type VersionBaseRef = ReplayBaseRef;
export type VersionBaseMovementCommit = ReplayBaseMovementCommit;
export type VersionBaseMovement = ReplayBaseMovement;
export type VersionPatchFile = ReplayPatchFile;
export type CommentAnchor = ReplayCommentAnchor & {
  position: ReplayCommentAnchor['position'] & { startSha: GitSha };
};

export type MergeRequestVersionCompare = Omit<ReplayCompareResult, 'range'> & {
  baseMovement?: VersionBaseMovement;
  range: VersionCompareRange;
};

export const versionCompareAlgorithmVersion = replayCompareAlgorithmVersion;

export { computeLineDiff };
export type { BlobLookup, ReplayBlobBatchLookup };

export const computeVersionComparePreferringReplay = async (input: {
  comments?: ReadonlyArray<CommentAnchor>;
  from: MergeRequestVersionRef;
  fromFiles: ReadonlyArray<VersionPatchFile>;
  paths?: ReadonlyArray<string>;
  readBlob: BlobLookup;
  readBlobs?: ReplayBlobBatchLookup;
  to: MergeRequestVersionRef;
  toFiles: ReadonlyArray<VersionPatchFile>;
}): Promise<MergeRequestVersionCompare> =>
  (await computePreferringReplay(input)) as unknown as MergeRequestVersionCompare;

export const isMergeRequestVersionRef = (value: unknown): value is MergeRequestVersionRef =>
  isReplayCompareEndpoint(value) && typeof (value as { startSha?: unknown }).startSha === 'string';
