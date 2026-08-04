# @nkzw/codiff-core

Reusable code diffing primitives from Codiff.

## Example

```tsx
import type { SharedWalkthroughSnapshot } from '@nkzw/codiff-core';
import { ReviewSurface } from '@nkzw/codiff-core/react';
import '@nkzw/codiff-core/styles.css';

export function Review({ snapshot }: { snapshot: SharedWalkthroughSnapshot }) {
  return <ReviewSurface snapshot={snapshot} />;
}
```

## Review identity

`codiff main` is a selector. After Git resolves it, the stored source keeps
the exact 40-character commit SHA that was read, not the string `main`. A
GitHub PR or GitLab MR number is also not a commit: the same PR can point at
a new head tomorrow.

`GitSha` is only a full object id. Branch names, tags, bookmarks, and PR/MR
numbers stay ordinary strings. A `Revision` carries a SHA only when it is a
commit. The working copy and index have no SHA.

`RepositoryHistory.entries` is a newest-first navigation feed. Review commit
stacks are parent-before-child values: parents come first, and a non-empty
stack ends at the declared head.

## Commit diffs

A merge commit `M` with parents `A` and `B` has two different diffs: `M` vs
`A`, and `M` vs `B`. Reads and in-flight maps key that work by
`commitSha:parentSha` (`M:A`, `M:B`). A root commit uses `M:root`.

Asking GitHub for `requestedBase...head` may return a different
`merge_base_commit`. Dedupe the in-flight read by the pair we asked for, and
record the effective base GitHub actually used on the returned range and
stack.

Core owns these contracts and request-local reuse. Provider packages normalize
wire data; hosts retain authentication, process spawning, persistence, and
other I/O policy.

## Target Comparison plans

Target Comparison classifiers choose either `net-change` or `commit-by-commit`.
Ordinary commit units retain their Git SHA identity, and resolved target plans
never contain Evolution Units.

## Version Comparison plans

Version Comparison plans choose either `complete-comparison` or
`commit-evolution`. Review versions use `versionId`, `fromVersionId`, and
`toVersionId`; Evolution Units carry `unitId` and never reuse commit SHA or
version identity. Aggregate comparison and evolution state load independently
so hosts can present immutable comparison evidence before classification is
ready.
