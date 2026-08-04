# Region-aware version comparison

Status: Implemented in Core and Codiff Desktop. The PLAN-owned Codiff Web
revisions are not present in this checkout, so their host integration remains
outside this implementation.

## Selected moved-block policy

Codiff uses **Conflict-only anchors**. The regional replay algorithm is
`region-aware-replay-v1:conflict-only-anchors`: only canonical unchanged
mapping proves a clean internal location. Text that merely reappears at one or
more different locations is not treated as identity, so it bounds an explicit
Replay-Conflict Region instead of silently replaying cleanly. Provider-backed
file identity may establish a path rename, but it does not make a text-only
within-file move clean.

Codiff should review a rerolled change without making target-base movement look
like author movement. A revised file remains one contiguous review surface,
but its comparison semantics vary by replay provenance: exact replay evolution
in regions that replay cleanly, and an explicitly paired old/current patch only
where replay actually conflicts.

## Endpoint model

For two review versions, define four immutable endpoint snapshots and three
derived changes:

- **Earlier Base**: the target snapshot used by the earlier review version
- **Earlier HEAD**: the exact earlier code the reviewer saw
- **Later Base**: the target snapshot used by the later review version
- **Later HEAD**: the current proposal the reviewer must approve
- **Prior Patch**: Earlier Base -> Earlier HEAD
- **Target-Base Movement**: Earlier Base -> Later Base
- **Current Patch**: Later Base -> Later HEAD
- **Expected Replay**: the exact result of applying the Prior Patch to the
  Later Base wherever that application is unambiguous

An ordinary Earlier HEAD -> Later HEAD diff is not a version comparison when
the base moved. It contains both author changes and Target-Base Movement. That
diff is useful only as diagnostic evidence; it must not be a reviewer-visible
fallback.

The intended display is:

| Region                 | Primary comparison                              | Additional display                                    |
| ---------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| Replay-Clean Region    | Expected Replay -> Later HEAD                   | None                                                  |
| Replay-Conflict Region | Later Base -> Later HEAD, clipped to the region | Nested Prior Patch for the contributing earlier edits |

This is not a file-level choice. One file may contain many Replay-Clean Regions
and several Replay-Conflict Regions.

## Reviewer invariants

1. A target-base-only edit may appear as unchanged context, but never as an
   added or removed row in a Replay-Clean Region.
2. Every changed row in a Replay-Clean Region must come from Expected Replay ->
   Later HEAD.
3. Every changed row in the primary view of a Replay-Conflict Region must come
   from Later Base -> Later HEAD.
4. The nested prior-reviewed annotation for a conflict must come from
   Earlier Base -> Earlier HEAD; it must not be an Earlier HEAD -> Later HEAD
   diff or a reconstruction from approximate patch text.
5. One failed Edit Block must not switch the rest of its file to a HEAD
   comparison.
6. Multiple interacting failed Edit Blocks may be coalesced into one conflict
   region, but unrelated clean edits remain replay-clean.
7. If exact materialization is unavailable, Codiff reports that region as
   incomplete. It does not silently substitute direct-HEAD or approximate
   output.
8. A Replay-Conflict Region may contain zero, one, or many Current Patch edits.
   Their inclusion proves coordinate overlap, not shared intent.

The practical test for base-noise exclusion is simple: if a line changed only
because the Earlier Base became the Later Base, and the later review did not
modify it, the line must not be colored red or green in the
version-comparison view.

## Materialization pipeline

Blob-free execution is an optimization, not an invariant. Artifact patches can
avoid blob reads only when their completeness and coverage prove that they
would produce the same exact projection as endpoint blobs.

1. Resolve path identity across renames. Gather all available Prior Patch,
   Target-Base Movement, and Current Patch artifacts plus the endpoint object
   identities for every revised path in the comparison batch.
2. Build an artifact-only proof plan. For every needed Edit Block, mapping
   anchor, context row, and replay input, record whether complete artifact
   evidence already proves its exact content and coordinates.
3. Union the object identities for every unresolved endpoint across the whole
   batch. Bulk-read that deduplicated set through the Artifact Source. Native
   Git, GitLab, and GitHub may use different bounded backends, but comparison
   code issues one bulk operation and never creates a serial per-file request
   waterfall.
4. Construct exact Prior Patch, Target-Base Movement, and Current Patch edit
   scripts. Reuse complete artifacts; use the bulk-loaded blobs only for the
   unresolved evidence identified by the proof plan.
5. Map every Prior Patch Edit Block through Target-Base Movement. Record its
   earlier ranges, later-base locus when trustworthy, produced Expected Replay
   range when one exists, line provenance, and replay outcome.
6. Accept an edit as replay-clean when it applies exactly at its canonical
   mapped locus, or when the Later Base already contains its exact postimage
   there. Text anchors may bound a conflict, but they never establish an
   internal moved-block identity under the conflict-only-anchor policy.
7. Retain the Later Base/Later HEAD range mapping for every Current Patch Edit
   Block. Use it to locate the later side of conflict regions and map stable
   context into the Later HEAD.
8. Turn failed replay edits into Replay-Conflict Regions, close those regions
   over every indivisible edit operation they touch, and take the ordered
   complement as Replay-Clean Regions.
9. Diff each Replay-Clean Region as Expected Replay -> Later HEAD. Conflict
   boundaries are hard barriers: a diff matcher may not align text across one
   and accidentally attribute conflict content to a clean region.
10. Produce one ordered review projection carrying comparison provenance and
    real endpoint coordinates for every region. Rendering consumes this
    projection; it does not infer region semantics from colored patch text.
11. In whole-version mode, present the UI only after the exact projections for
    the selected comparison are ready. Reuse, batching, caching, and
    cancellation remain mandatory; progressive per-file hydration does not.

### Exact replay result

The Core projection records structured per-edit outcomes and line provenance.
Its contract is conceptually:

```ts
type ReplayEditResult =
  | {
      kind: 'applied';
      earlierBaseRange: LineRange;
      earlierHeadRange: LineRange;
      laterBaseRange: LineRange;
      expectedRange: LineRange;
      provenance: ReadonlyArray<ReplayLineOrigin>;
    }
  | {
      kind: 'absorbed';
      earlierBaseRange: LineRange;
      earlierHeadRange: LineRange;
      laterBaseRange: LineRange;
      expectedRange: LineRange;
      provenance: ReadonlyArray<ReplayLineOrigin>;
    }
  | {
      kind: 'conflict';
      earlierBaseRange: LineRange;
      earlierHeadRange: LineRange;
      laterBaseRange?: LineRange;
      scope: 'region' | 'file';
      reason: 'ambiguous-anchor' | 'context-mismatch' | 'missing-anchor' | 'overlapping-edit';
    };
```

Replay continues after a failed Edit Block when later edits can still be
located unambiguously, preserving later clean regions and retaining explicit
conflict holes for earlier failures.

### Exact replay contract

Codiff should define conservative, provider-neutral three-way semantics over
the Earlier Base, Earlier HEAD, and Later Base. Native Git may be an optimized
backend only when its normalized result is equivalent to that contract.

- An unchanged mapped preimage produces `applied` and exact Expected Replay
  text.
- An exact Prior Patch postimage already present at the mapped Later Base locus
  produces `absorbed`; Expected Replay is a no-op there.
- Overlapping non-identical Prior Patch and Target-Base Movement operations
  produce a conflict unless a deterministic three-way merge proves one result.
- Text anchors, including a unique textual match, can bound a conflict but
  cannot prove a moved locus. Only canonical unchanged mapping establishes a
  clean internal location.
- A conservative extra conflict is acceptable. A false clean result is not,
  because it can suppress reviewer-visible code.

## Building conflict regions

A failed Edit Block identifies an earlier patch range and, sometimes, a
trustworthy location on the Later Base. Its visible conflict region is built as
follows:

1. Start with the failed edit's consumed/produced Prior Patch ranges and its
   mapped Later Base span.
2. Include every Current Patch Edit Block whose Later Base range intersects
   that span. For insertion-only edits, intersection includes the insertion
   boundary.
3. Close the region over every Prior Patch, Target-Base Movement, and Current
   Patch operation crossed by the expanded span. Repeat until no indivisible
   operation crosses a boundary.
4. Expand both sides to the nearest stable context anchors that are exact and
   unique in their respective endpoint pair. Context length is a rendering
   choice; anchor identity, not a fixed three-line window, defines the region.
5. Coalesce regions whose expanded spans overlap or whose current edits form
   one indivisible diff block.
6. Preserve the union of contributing Prior Patch edits so the nested
   prior-reviewed annotation contains exactly the earlier change involved in
   the conflict.

The collected Current Patch edits are affected edits, not inferred
corresponding edits. The set may be empty, singular, or plural, and coordinate
intersection makes no claim about shared intent.

If the failed edit has no trustworthy target location, Codiff expands to the
smallest scope bounded by exact anchors. That scope may be the entire file.
Codiff may show a file-wide Conflict Review Pair, but it still does not compare
Earlier HEAD -> Later HEAD.

## Constructing replay-clean regions

Replay-Clean Regions are not merely Current Patch edits that happen to lie
outside a conflict. They are the complement of the conflict barriers in the
exact Expected Replay and Later HEAD coordinate maps.

For each clean region:

1. Materialize its left side from Expected Replay, which already contains the
   Later Base plus every cleanly applied Prior Patch edit.
2. Materialize its right side from the Later HEAD using the Current Patch
   mapping and the stable anchors bounding the region.
3. Compute an ordinary two-way diff for only those bounded values.
4. Suppress an empty result. This is how a cleanly replayed, unchanged earlier
   patch disappears instead of being reported as a false positive revision.

Because the Later Base is present on both sides, Target-Base Movement cancels.
A later edit to content introduced by the Later Base is still reviewable: it
differs between Expected Replay and the Later HEAD and therefore appears as an
author change. An absorbed Prior Patch edit is also replay-clean: Expected
Replay is the unchanged Later Base at that locus.

## Contiguous rendering

The UI presents one logical file, in file order, rather than one card per
region. The right side always uses real Later HEAD coordinates. Each left-side
row carries explicit provenance:

- Expected Replay coordinates in Replay-Clean Regions
- real Later Base coordinates in Replay-Conflict Regions

Codiff must not label Expected Replay rows as if they were lines from an
actual commit. If one global left line-number sequence would be misleading,
the renderer should expose region provenance or suppress synthetic numbers
rather than inventing source coordinates.

Replay-Conflict Regions use the display prototyped in the local design demo:

- the main contiguous file shows the Current Patch in the affected region;
- a Pierre custom line annotation is anchored immediately after the conflict
  region;
- the annotation embeds a nested ordinary diff for the Prior Patch;
- split mode uses paired annotations on one aligned row so the nested left and
  right sides remain aligned; unified mode uses one full-width annotation.

Each additional conflict region receives its own annotation. Clean regions
never receive the old/current paired display because their exact Expected
Replay -> Later HEAD comparison already answers what changed between review
versions.

The renderer must not construct one composite left-hand file and ask a global
diff matcher to compare it with the Later HEAD. It receives independently
diffed, bounded regions and stitches their rows. Otherwise a matcher can align
text across a conflict boundary and destroy the provenance guarantee.

## Current Core behavior

The reviewer-visible comparison uses only the regional projection. It records
per-edit replay results and provenance, does not substitute Earlier HEAD for
Expected Replay after a conflict, and reports missing evidence as explicit
incomplete regions. Its algorithm identity is
`region-aware-replay-v1:conflict-only-anchors`, not a JJ interdiff.

Core and Desktop now make artifact-only execution conditional on exact proof,
bulk-load unresolved endpoints through one deduplicated evidence batch, and
render the regional projection directly with conflict annotations and explicit
incomplete states. The remaining host work is the PLAN-owned Codiff Web path,
whose revisions are absent from this checkout.

Approximate artifacts may still help matching choose a conservative
classification. They must not masquerade as the exact code a reviewer is
asked to approve.

## Edge cases

- **No base movement:** Expected Replay is Earlier HEAD; clean comparison
  naturally reduces to Earlier HEAD -> Later HEAD without special handling.
- **No conflicts:** render only Expected Replay -> Later HEAD. If it is empty,
  the file has no revised code to review.
- **Whole-file conflict:** render the Current Patch with one file-wide nested
  Prior Patch annotation.
- **Several conflict islands:** keep the file contiguous and attach one nested
  annotation to each coalesced island.
- **No affected current edit:** show the unchanged Later Base region with its
  nested Prior Patch. This makes a possibly dropped prior intent explicit.
- **One-to-many or many-to-one:** include every affected Current Patch edit and
  the union of contributing Prior Patch edits. Do not force edit pairing.
- **Base absorption:** treat an exact Prior Patch postimage already present at
  its mapped Later Base locus as clean. If the Later HEAD is unchanged, the
  review projection is empty there.
- **Unrelated overlap:** include the exact Current Patch edit because it affects
  the conflict locus, but make no claim that it replaces the Prior Patch edit.
- **Ambiguous repeated code:** do not choose a textual candidate. Expand the
  conflict to the smallest exactly anchored scope, possibly the whole file.
- **Rename:** establish path identity before replay and retain both endpoint
  paths in region coordinates.
- **Add/delete:** use absent content as an explicit endpoint value, not a
  missing blob. A delete/add pair is not assumed to be a rename without
  artifact evidence.
- **Binary, submodule, or incomplete content:** show an explicit non-textual or
  incomplete region; do not synthesize textual replay.
- **Merge commits:** use the Commit Artifact's selected parent. If the source
  cannot provide a well-defined parent-relative patch, exact region replay is
  unavailable.

## Validation

Use public synthetic fixtures, never private repository data. At minimum, add
coverage for:

- base-only edits surrounding a clean replay, proving they produce no changed
  rows;
- a cleanly replayed, unchanged prior edit producing no false-positive changed
  row;
- a cleanly replayed old edit revised in the Later HEAD;
- one file with clean edits before and after a replay conflict;
- several separated conflicts and conflict-region coalescing;
- located conflicts with zero, one, and many affected Current Patch edits;
- one-to-many and many-to-one edit shapes without forced correspondence;
- exact Base Absorption and a Later HEAD that subsequently changes the
  absorbed content;
- an unrelated Current Patch edit overlapping a conflict locus;
- ambiguous repeated context that must conflict rather than choose a target;
- insertion-only Edit Blocks and edits at file boundaries;
- renames, additions, deletions, binary changes, and missing blobs;
- split and unified Pierre annotations, including line alignment and source
  coordinate labels;
- artifact-only proof planning; bulk acquisition of the union of unresolved
  blobs; immutable cache reuse; cancellation; and zero serial per-file provider
  requests;
- atomic whole-version presentation after every exact projection is ready;
- absence of direct-HEAD and approximate-patch fallbacks in exact projections.

The key regression fixture should change the target base heavily, conflict
with only one old edit, and revise another old edit cleanly. The expected view
must show the clean revision, the current/prior pair for the conflict, and none
of the unrelated target-base movement.
