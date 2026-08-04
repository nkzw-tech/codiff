/**
 * Re-export forge-neutral commit-stack evolution from Core.
 * GitLab hosts consume the same provider-neutral evidence and matcher contract.
 */
export {
  attributeRebaseOverlaps,
  createCommitFingerprint,
  matchVersionCommitStacks,
  recommendVersionWalkthroughStructure,
  scoreBaseCommitAsRebaseOverlap,
  toCommitArtifact,
  toVersionCommitSummary,
  versionCommitEvidenceConcurrency,
  versionCommitEvolutionAlgorithmVersion,
  versionCommitFingerprintAlgorithmVersion,
  versionCommitStackLimit,
  type ArtifactFile,
  type CommitAssignmentDiagnostics,
  type CommitArtifact,
  type CommitFingerprint,
  type CommitStackEvolution,
  type CommitStackEvolutionRange,
  type CommitStackMatchDiagnostics,
  type DiffEndpointRef,
  type VersionCommitEvolutionUnit,
  type VersionCommitMatchKind,
  type VersionCommitSummary,
  type VersionRebaseOverlapCommit,
  type ReviewArtifactProject,
  type ReviewArtifactProvenance,
} from '@nkzw/codiff-core';
