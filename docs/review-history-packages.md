# Review-history package boundaries

Core owns commit-diff request keys, stack/range/blob schemas, and
request-local reuse. Provider packages turn GitHub and GitLab responses into
those schemas. Hosts own authentication, process I/O, and UI.

## Ownership

| Boundary            | Responsibility                                                              |
| ------------------- | --------------------------------------------------------------------------- |
| `@nkzw/codiff-core` | Commit+parent request keys, artifact schemas, validation, and one-run reuse |
| Provider packages   | Current-review normalization and `ReviewArtifactSource` implementations     |
| Hosts               | Authentication, network and process I/O, caching, cancellation, and UI      |

Provider wire records do not cross into Core algorithms or shared UI. Provider
packages do not authenticate requests or spawn local processes.

## Commit diffs

A merge commit `M` with parents `A` and `B` has two different diffs: `M` vs
`A`, and `M` vs `B`. If a cache or in-flight map is keyed only by `M`, the
second read overwrites the first. The request key is `commitSha:parentSha`
(`M:A`, `M:B`). A root commit uses `M:root`.

GitHub compare is a second case. Asking for `requestedBase...head` may return
a different `merge_base_commit`. Dedupe the in-flight read by the pair we
asked for. Record the effective base GitHub actually used on the returned
range and stack. Two selectors that resolve to the same merge-base must not
share one pending request.

## Immutable review artifacts

- `StackSnapshot` records a parent-first commit stack for one exact range.
- `CommitArtifact` records the change from one selected parent.
- `RangeArtifact` records the net tree change for one base/head pair.
- `BlobArtifact` records bounded full-file bytes by Git object identity.
- `FileBlobArtifactRequest` resolves a path at an exact commit SHA when the
  caller does not yet know the object ID.

Every stack, commit, and range artifact carries provenance and explicit
completeness. Missing or truncated evidence is never represented as a complete
empty patch.

`ReviewArtifactSource.readStackAndRange` accepts a typed request whose
`requestedBaseSha` is the selector sent to the provider and whose `headSha` is
the requested review head. Providers may resolve that selector to an effective
base: `RangeArtifact.baseSha` and `StackSnapshot.baseSha` always record that
effective base, while their heads must remain the requested head. A
same-commit request stays an empty same-commit result.

`createReviewArtifactRun` deduplicates overlapping reads only within one
request. Range reads are cached and diagnosed by their requested selector
pair, not by a provider-resolved effective pair. Every read accepts an
`AbortSignal`; cancelable work is not shared across unrelated requests.

## Historical review adapters

`@nkzw/codiff-gitlab` owns numbered merge-request version discovery, immutable
version coordinates, provider Artifact Sources, historical comparison reads,
and GitLab normalization. `@nkzw/codiff-github` owns the equivalent
force-push timeline, including the explicit limitations of reconstructing
historical base coordinates from GitHub events.

Both packages expose separately callable aggregate and commit-evolution reads.
They normalize provider responses into Core Stack, Range, Commit, and Blob
Artifacts before invoking shared matching or replay. They do not return
provider-authored classifications, silently turn missing patches into empty
changes, or replace incomplete host evidence with a second hidden acquisition
path.

## Host integration

Electron and Web hosts inject authentication, transports, optional native-Git
Artifact Sources, persistence, cancellation ownership, and request scheduling.
Hosts may cache immutable artifacts and derived results by the complete Core
algorithm identity, but provider packages remain free of process spawning,
IPC, and UI state.

Codiff Web should import these packages rather than copying version discovery,
artifact normalization, matching, or regional replay. Its D1/R2 storage,
Workers transport, request scheduler, and comparison-run lifetime remain host
responsibilities.
