import type { GitSha, ReviewCommitSummary } from '../types.ts';

/**
 * A proposed change ordered from its external base toward its review head.
 * Every included parent precedes its child.
 */
export type ReviewCommitStack<Commit extends ReviewCommitStackItem = ReviewCommitSummary> =
  ReadonlyArray<Commit>;

export type ReviewCommitStackItem = {
  authoredAt?: string;
  authoredDate?: string;
  committedAt?: number | string;
  parentShas: ReadonlyArray<GitSha>;
  sha: GitSha;
};

const commitTime = (commit: ReviewCommitStackItem) => {
  const value = commit.committedAt ?? commit.authoredAt ?? commit.authoredDate;
  const parsed = typeof value === 'number' ? value : value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

const compareReadyCommits = (first: ReviewCommitStackItem, second: ReviewCommitStackItem) =>
  commitTime(first) - commitTime(second) || first.sha.localeCompare(second.sha);

const indexCommitGraph = <Commit extends ReviewCommitStackItem>(commits: ReadonlyArray<Commit>) => {
  const bySha = new Map<GitSha, Commit>();
  for (const commit of commits) {
    if (bySha.has(commit.sha)) {
      throw new Error(`Review commit stack contains duplicate SHA ${commit.sha}.`);
    }
    bySha.set(commit.sha, commit);
  }
  return bySha;
};

/**
 * Project provider or Git output into the canonical parent-before-child stack.
 * Parents outside the supplied set are valid external roots.
 */
export const orderReviewCommitStack = <Commit extends ReviewCommitStackItem>(
  commits: ReadonlyArray<Commit>,
): ReviewCommitStack<Commit> => {
  const bySha = indexCommitGraph(commits);
  const children = new Map<GitSha, Array<GitSha>>();
  const remainingParents = new Map<GitSha, number>();
  for (const commit of commits) {
    const includedParents = commit.parentShas.filter((parentSha) => bySha.has(parentSha));
    remainingParents.set(commit.sha, includedParents.length);
    for (const parentSha of includedParents) {
      const childShas = children.get(parentSha) ?? [];
      childShas.push(commit.sha);
      children.set(parentSha, childShas);
    }
  }

  const ready = commits
    .filter((commit) => remainingParents.get(commit.sha) === 0)
    .toSorted(compareReadyCommits);
  const ordered: Array<Commit> = [];
  while (ready.length > 0) {
    const commit = ready.shift()!;
    ordered.push(commit);
    for (const childSha of children.get(commit.sha) ?? []) {
      const remaining = (remainingParents.get(childSha) ?? 1) - 1;
      remainingParents.set(childSha, remaining);
      if (remaining === 0) {
        ready.push(bySha.get(childSha)!);
        ready.sort(compareReadyCommits);
      }
    }
  }

  if (ordered.length !== commits.length) {
    throw new Error('Review commit stack contains a cycle.');
  }
  return ordered;
};

/** Assert that an existing stack already obeys the canonical ordering contract. */
export const validateReviewCommitStack = <Commit extends ReviewCommitStackItem>(
  commits: ReadonlyArray<Commit>,
): ReviewCommitStack<Commit> => {
  const ordered = orderReviewCommitStack(commits);
  for (let index = 0; index < commits.length; index += 1) {
    if (ordered[index]!.sha !== commits[index]!.sha) {
      throw new Error(`Review commit stack is not parent-before-child at ${commits[index]!.sha}.`);
    }
  }
  return commits;
};

const reachableCommitShas = <Commit extends ReviewCommitStackItem>(
  bySha: ReadonlyMap<GitSha, Commit>,
  startSha: GitSha,
) => {
  const reachable = new Set<GitSha>();
  const pending = [startSha];
  while (pending.length > 0) {
    const sha = pending.pop()!;
    if (reachable.has(sha)) {
      continue;
    }
    reachable.add(sha);
    for (const parentSha of bySha.get(sha)?.parentShas ?? []) {
      if (bySha.has(parentSha)) {
        pending.push(parentSha);
      }
    }
  }
  return reachable;
};

/** Whether `ancestorSha` is equal to or an ancestor of `descendantSha`. */
export const isReviewCommitAncestor = <Commit extends ReviewCommitStackItem>(
  commits: ReadonlyArray<Commit>,
  ancestorSha: GitSha,
  descendantSha: GitSha,
) => {
  const bySha = indexCommitGraph(validateReviewCommitStack(commits));
  if (!bySha.has(ancestorSha) || !bySha.has(descendantSha)) {
    return false;
  }
  return reachableCommitShas(bySha, descendantSha).has(ancestorSha);
};

export type ReviewCommitRange<Commit extends ReviewCommitStackItem = ReviewCommitSummary> = {
  baseSha: GitSha;
  from: Commit;
  headSha: GitSha;
  members: ReviewCommitStack<Commit>;
  to: Commit;
};

/**
 * Validate and materialize `first-parent(From)..To` from a canonical stack.
 * Membership follows Git reachability rather than a visual index slice.
 */
export const reviewCommitRange = <Commit extends ReviewCommitStackItem>(
  commits: ReadonlyArray<Commit>,
  fromSha: GitSha,
  toSha: GitSha,
): ReviewCommitRange<Commit> => {
  const stack = validateReviewCommitStack(commits);
  const bySha = indexCommitGraph(stack);
  const from = bySha.get(fromSha);
  const to = bySha.get(toSha);
  if (!from || !to) {
    throw new Error('Review commit range endpoints must both exist in the commit stack.');
  }
  if (!reachableCommitShas(bySha, toSha).has(fromSha)) {
    throw new Error('Review commit range From must be an ancestor of To.');
  }
  const baseSha = from.parentShas[0];
  if (!baseSha) {
    throw new Error('Review commit range From has no resolvable first parent.');
  }

  const headAncestors = reachableCommitShas(bySha, toSha);
  const baseAncestors = bySha.has(baseSha)
    ? reachableCommitShas(bySha, baseSha)
    : new Set<GitSha>();
  return {
    baseSha,
    from,
    headSha: toSha,
    members: stack.filter(
      (commit) => headAncestors.has(commit.sha) && !baseAncestors.has(commit.sha),
    ),
    to,
  };
};
