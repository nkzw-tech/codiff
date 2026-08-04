# Clean-room range-diff matching

Codiff pairs commit stacks with a provider-neutral, clean-room implementation
of Git range-diff's linear-assignment behavior. This document is an
implementation contract, not a copy of Git source code.

## Inputs and canonical material

Each eligible commit has a complete immutable Commit Artifact. The matcher
builds one canonical patch representation from the author identity, commit
message, and complete textual or object/mode patch material. Commit SHAs are
not part of that material: retaining an identical SHA is separately prelocked
as the same immutable commit. A patch ID is not a pairing shortcut; it can
classify an already-selected unique pair as the same patch, but never skips the
global solve.

Incomplete, opaque, truncated, or multi-parent artifacts do not enter the
confident matrix. A uniquely plausible incomplete old/new pair may be retained
as an explicit ambiguous Evolution Unit; it cannot become a confident revised,
added, or removed classification.

## Artifact-source normalization

Native Git emits index headers and zero-context hunks, while GitLab and GitHub
return provider-shaped hunk bodies and may omit optional blob metadata. Before
matching, Core converts every complete textual file into source-neutral
changed-line runs with endpoint coordinates. Optional object IDs do not change
the identity of a textual patch; object and mode metadata remain the exact
evidence for non-textual changes and actual mode transitions.

`core/__tests__/artifact-source-conformance.test.ts` feeds equivalent native,
GitLab, and GitHub Commit Artifacts through their production normalizers. It
asserts one exact-change identity and one canonical patch material despite
their differing headers and context widths.

## Cost matrix and solver

For every eligible old/new pair, Codiff computes a line diff of their canonical
patches with three context lines. The number of resulting diff-of-diffs lines
is the pair cost. The square matrix adds dummy creation and deletion nodes at
Git's documented 60% creation factor; dummy-to-dummy edges cost zero.

`solveJonkerVolgenant` is an independently written dense
shortest-augmenting-path linear-assignment solver with deterministic row and
column tie order. It is cubic in matrix size and performs no I/O. It is not
ported, translated, linked, or derived from Git's GPL implementation, and
Codiff has no assignment-library dependency.

The primary old/new solve runs before target-base absorption. Remaining old
commits use a separate, stricter old/base assignment. This prevents later base
commits from competing with actual review-stack commits.

## Ambiguity policy

Every non-SHA selected old/new edge is audited by solving again with that edge
forbidden. If a complete alternative is within one diff line of the optimum,
all changed selected pairs are emitted as `ambiguous`; Codiff does not let
stable tie ordering invent identity. The target-base pass requires an exactly
unique alternative-free optimum for non-exact absorption.

The Core fixtures cover reordered crossing pairs, a greedy-steal shape,
inserted and removed commits, duplicate patches, near-equal optima, incomplete
evidence, deterministic ties, and the 40-by-40 budget.
`core/__tests__/range-diff-parity.test.ts` also materializes one public
synthetic stack and compares Codiff's `=`, `!`, `<`, and `>` classifications
with black-box `git range-diff` output at the default and 80% creation factors.
Production never invokes `git range-diff`; that command is a test-only
compatibility oracle.

## Provenance

The behavioral reference is the public Git range-diff algorithm documentation:
<https://git-scm.com/docs/git-range-diff#_algorithm>. The implementation was
written independently from that description. No Git source, GPL code, or
third-party assignment implementation is included in Codiff.
