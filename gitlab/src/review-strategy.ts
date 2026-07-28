import {
  classifyReviewCommit,
  classifyTargetComparisonReviewStructure,
  orderCommitsTopologically,
  overrideTargetComparisonReviewStructure,
  type ClassifiedReviewCommit,
  type ReviewStructureCommitInput,
  type TargetComparisonReviewClassification,
} from '@nkzw/codiff-core';
import type { GitSha, TargetComparisonReviewStructure } from '@nkzw/codiff-core/types';

/** GitLab-normalized commit fields needed by Core's review-structure classifier. */
export type GitLabReviewStructureCommitInput = {
  authoredDate: string;
  authorName: string;
  committedDate?: string;
  message: string;
  parentShas: ReadonlyArray<GitSha>;
  sha: GitSha;
  shortSha: string;
  title: string;
  webUrl?: string;
};

const toReviewStructureCommitInput = (
  commit: GitLabReviewStructureCommitInput,
): ReviewStructureCommitInput => ({
  authoredAt: commit.authoredDate,
  authorName: commit.authorName,
  message: commit.message,
  parentShas: commit.parentShas,
  sha: commit.sha,
  shortSha: commit.shortSha,
  title: commit.title,
  ...(commit.webUrl ? { webUrl: commit.webUrl } : {}),
});

export const classifyGitLabCommit = (
  commit: GitLabReviewStructureCommitInput,
): ClassifiedReviewCommit => classifyReviewCommit(toReviewStructureCommitInput(commit));

export const classifyGitLabTargetComparisonReviewStructure = (input: {
  commits: ReadonlyArray<GitLabReviewStructureCommitInput>;
  description?: string;
  title?: string;
}): TargetComparisonReviewClassification =>
  classifyTargetComparisonReviewStructure({
    commits: input.commits.map(toReviewStructureCommitInput),
    ...(input.description == null ? {} : { description: input.description }),
    ...(input.title == null ? {} : { title: input.title }),
  });

export const overrideGitLabTargetComparisonReviewStructure = (
  classification: TargetComparisonReviewClassification,
  structure: TargetComparisonReviewStructure,
  sourceCommits: ReadonlyArray<GitLabReviewStructureCommitInput> = [],
): TargetComparisonReviewClassification =>
  overrideTargetComparisonReviewStructure(
    classification,
    structure,
    sourceCommits.map(toReviewStructureCommitInput),
  );

/** Order GitLab commits from the comparison base toward its head. */
export const orderGitLabCommitsTopologically = <Commit extends GitLabReviewStructureCommitInput>(
  commits: ReadonlyArray<Commit>,
): ReadonlyArray<Commit> => {
  const projected = commits.map((commit) => ({
    authoredAt: commit.authoredDate,
    commit,
    committedAt: commit.committedDate,
    parentShas: commit.parentShas,
    sha: commit.sha,
  }));
  return orderCommitsTopologically(projected).map(({ commit }) => commit);
};
