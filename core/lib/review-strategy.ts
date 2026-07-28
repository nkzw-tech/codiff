import type { GitSha, TargetComparisonReviewStructure } from '../types.ts';
import { orderReviewCommitStack, validateReviewCommitStack } from './review-commit-stack.ts';

// Provider-neutral review-structure classifier for target comparisons.

export type ClassifiedCommitRole =
  | 'chore'
  | 'docs'
  | 'feature'
  | 'fixup'
  | 'merge'
  | 'refactor'
  | 'revert'
  | 'review-response'
  | 'test'
  | 'unknown';

export type ClassifiedReviewCommit = {
  authoredAt: string;
  authorName: string;
  body: string;
  isMerge: boolean;
  parentShas: ReadonlyArray<GitSha>;
  role: ClassifiedCommitRole;
  sha: GitSha;
  shortSha: string;
  subject: string;
  webUrl?: string;
};

export type TargetComparisonReviewClassification =
  | {
      commits: ReadonlyArray<ClassifiedReviewCommit>;
      confidence: number;
      reason: 'chapter-shaped' | 'explicit-description' | 'stacked-subjects' | 'user-override';
      structure: 'commit-by-commit';
    }
  | {
      confidence: number;
      reason:
        | 'default'
        | 'explicit-whole'
        | 'fixup-style'
        | 'review-response-style'
        | 'single-commit'
        | 'too-many-commits'
        | 'user-override';
      structure: 'net-change';
    };

export type ReviewStructureCommitInput = {
  authoredAt: string;
  authorName: string;
  message: string;
  parentShas: ReadonlyArray<GitSha>;
  sha: GitSha;
  shortSha: string;
  title: string;
  webUrl?: string;
};

const explicitCommitByCommitPattern =
  /\b(?:review\s+commit(?:s)?(?:\s+by\s+commit|[- ]by[- ]commit)|please\s+review\s+each\s+commit|commit[- ]wise\s+review|stacked\s+diff|stacked\s+commits)\b/i;

const explicitWholePattern =
  /\b(?:review\s+as\s+a\s+whole|ignore\s+commits|squash\s+on\s+merge)\b/i;

const fixupSubjectPattern =
  /^(?:fixup!|squash!|amend!|wip\b|tmp\b|try\b|rework\b|review\s+feedback|pr\s+feedback|mr\s+feedback|nits?\b|typo\b|oops\b|cleanup\s+after|follow[- ]?up\b)/i;

const reviewResponseSubjectPattern =
  /^(?:address(?:ing)?\s+(?:review|comments?|feedback)|respond(?:ing)?\s+to\s+(?:review|comments?|feedback)|review\s+comments?)\b/i;

const conventionalCommitPattern =
  /^(?:feat|fix|refactor|test|docs|chore|perf|build|ci|style|revert)(?:\(.+\))?!?:/i;

const numberedStepPattern = /^(?:step\s+)?\d+[.):\-\s]/i;

const shortShaPattern = /\b[0-9a-f]{7,40}\b/gi;

const classifyCommitRole = (
  subject: string,
  parentShas: ReadonlyArray<GitSha>,
): ClassifiedCommitRole => {
  if (parentShas.length > 1 || /^merge\b/i.test(subject)) {
    return 'merge';
  }
  if (fixupSubjectPattern.test(subject)) {
    return 'fixup';
  }
  if (reviewResponseSubjectPattern.test(subject)) {
    return 'review-response';
  }
  if (/^revert\b/i.test(subject) || subject.startsWith('Revert "')) {
    return 'revert';
  }
  if (/^(?:test|tests?)(?:\b|[:(\s])/i.test(subject) || /^test(?:\(.+\))?!?:/i.test(subject)) {
    return 'test';
  }
  if (/^(?:docs?)(?:\b|[:(\s])/i.test(subject) || /^docs?(?:\(.+\))?!?:/i.test(subject)) {
    return 'docs';
  }
  if (/^refactor(?:\b|[:(\s])/i.test(subject) || /^refactor(?:\(.+\))?!?:/i.test(subject)) {
    return 'refactor';
  }
  if (/^(?:chore|build|ci)(?:\b|[:(\s])/i.test(subject)) {
    return 'chore';
  }
  if (
    /^(?:feat|feature|add|implement)(?:\b|[:(\s])/i.test(subject) ||
    /^feat(?:\(.+\))?!?:/i.test(subject)
  ) {
    return 'feature';
  }
  return 'unknown';
};

const splitMessage = (message: string, title: string) => {
  const normalized = message.trim() || title.trim();
  const [subjectLine = title.trim() || 'Commit', ...rest] = normalized.split('\n');
  return {
    body: rest.join('\n').trim(),
    subject: subjectLine.trim() || title.trim() || 'Commit',
  };
};

export const classifyReviewCommit = (
  commit: ReviewStructureCommitInput,
): ClassifiedReviewCommit => {
  const { body, subject } = splitMessage(commit.message, commit.title);
  const role = classifyCommitRole(subject, commit.parentShas);
  return {
    authoredAt: commit.authoredAt,
    authorName: commit.authorName,
    body,
    isMerge: role === 'merge' || commit.parentShas.length > 1,
    parentShas: commit.parentShas,
    role,
    sha: commit.sha,
    shortSha: commit.shortSha || commit.sha.slice(0, 8),
    subject,
    ...(commit.webUrl ? { webUrl: commit.webUrl } : {}),
  };
};

/** @deprecated Use `orderReviewCommitStack` for the explicit stack contract. */
export const orderCommitsTopologically = orderReviewCommitStack;

const descriptionListsCommits = (
  description: string,
  commits: ReadonlyArray<ClassifiedReviewCommit>,
) => {
  if (!description.trim() || commits.length < 2) {
    return false;
  }
  const shortShas = new Set(commits.map((commit) => commit.shortSha.toLowerCase()));
  const fullShas = new Set(commits.map((commit) => commit.sha.toLowerCase()));
  const matches = description.toLowerCase().match(shortShaPattern) ?? [];
  const matched = new Set(
    matches.filter(
      (value) =>
        shortShas.has(value) ||
        fullShas.has(value) ||
        [...fullShas].some((sha) => sha.startsWith(value)),
    ),
  );
  if (matched.size >= 2) {
    return true;
  }
  const numberedLines = description
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => numberedStepPattern.test(line));
  if (numberedLines.length < 2) {
    return false;
  }
  const subjectHits = numberedLines.filter((line) =>
    commits.some((commit) =>
      line.toLowerCase().includes(commit.subject.toLowerCase().slice(0, 24)),
    ),
  ).length;
  return subjectHits >= 2;
};

const looksChapterShaped = (commits: ReadonlyArray<ClassifiedReviewCommit>) => {
  if (commits.length < 2) {
    return false;
  }
  const intentional = commits.filter(
    (commit) =>
      commit.role === 'feature' ||
      commit.role === 'refactor' ||
      commit.role === 'test' ||
      commit.role === 'docs' ||
      conventionalCommitPattern.test(commit.subject) ||
      numberedStepPattern.test(commit.subject),
  );
  const uniqueSubjects = new Set(commits.map((commit) => commit.subject.toLowerCase()));
  // Provider commit subjects are often descriptive without using Conventional
  // Commits. Treat a short, distinct, non-fixup history as chapter-shaped too.
  return (
    uniqueSubjects.size >= 2 &&
    (intentional.length >= Math.ceil(commits.length * 0.5) ||
      uniqueSubjects.size === commits.length)
  );
};

export const classifyTargetComparisonReviewStructure = (input: {
  commits: ReadonlyArray<ReviewStructureCommitInput>;
  description?: string;
  title?: string;
}): TargetComparisonReviewClassification => {
  validateReviewCommitStack(input.commits);
  const classified = input.commits.map(classifyReviewCommit);
  const nonMerge = classified.filter((commit) => !commit.isMerge);
  const text = `${input.title ?? ''}\n${input.description ?? ''}`;
  const fixupDensity =
    nonMerge.filter((commit) => commit.role === 'fixup' || commit.role === 'review-response')
      .length / Math.max(nonMerge.length, 1);

  if (explicitWholePattern.test(text) && !explicitCommitByCommitPattern.test(text)) {
    return { confidence: 0.95, reason: 'explicit-whole', structure: 'net-change' };
  }
  if (explicitCommitByCommitPattern.test(text) || descriptionListsCommits(text, nonMerge)) {
    return {
      commits: nonMerge,
      confidence: 0.95,
      reason: 'explicit-description',
      structure: 'commit-by-commit',
    };
  }
  if (nonMerge.length <= 1) {
    return { confidence: 0.99, reason: 'single-commit', structure: 'net-change' };
  }
  if (fixupDensity >= 0.4) {
    const reviewResponseOnly =
      nonMerge.filter((commit) => commit.role === 'review-response').length /
        Math.max(nonMerge.length, 1) >=
      0.4;
    return {
      confidence: 0.85,
      reason: reviewResponseOnly ? 'review-response-style' : 'fixup-style',
      structure: 'net-change',
    };
  }
  if (nonMerge.length > 20) {
    return { confidence: 0.7, reason: 'too-many-commits', structure: 'net-change' };
  }
  if (looksChapterShaped(nonMerge)) {
    return {
      commits: nonMerge,
      confidence: 0.75,
      reason: conventionalCommitPattern.test(nonMerge[0]?.subject ?? '')
        ? 'stacked-subjects'
        : 'chapter-shaped',
      structure: 'commit-by-commit',
    };
  }
  return { confidence: 0.55, reason: 'default', structure: 'net-change' };
};

export const overrideTargetComparisonReviewStructure = (
  classification: TargetComparisonReviewClassification,
  structure: TargetComparisonReviewStructure,
  sourceCommits: ReadonlyArray<ReviewStructureCommitInput> = [],
): TargetComparisonReviewClassification => {
  validateReviewCommitStack(sourceCommits);
  if (structure === 'net-change') {
    return {
      confidence: 1,
      reason: 'user-override',
      structure: 'net-change',
    };
  }
  const commits =
    classification.structure === 'commit-by-commit'
      ? classification.commits
      : sourceCommits.map(classifyReviewCommit).filter((commit) => !commit.isMerge);
  return {
    commits,
    confidence: 1,
    reason: 'user-override',
    structure: 'commit-by-commit',
  };
};
