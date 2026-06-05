# Narrative walkthrough — authoring guide

This is Codiff's guidance for authoring a **narrative walkthrough**: a story-shaped
review of a change. Unlike Codiff's built-in walkthrough (which only orders files), a
narrative walkthrough tells the _story_ of the change — ordered stops grouped into
chapters, each pinned to a specific slice of the diff, with your narration and the prior
conversation attached so Codiff can answer follow-up questions.

You — the agent — author a JSON document conforming to the schema printed at the end of
this guide. Write it to a **temporary file outside the repository** (e.g. a unique path in
the system temp directory) so it never clutters the working tree; pass that path to Codiff
with `--walkthrough-file`. Set the document's `"$schema"` to
`https://raw.githubusercontent.com/nkzw-tech/codiff/main/src/walkthrough/narrative-walkthrough.schema.json`
for editor validation.

Default to the **staged** diff (`git diff --staged`). If the user named a target (a commit,
`HEAD`, a PR, a path), use that. If nothing is staged, fall back to the working tree
(`git diff`) and say so.

## The shape, and why it's shaped this way

The document separates **segments** (order-independent slices of the diff) from **orders**
(reading views over them). The same segment can lead one order and sit in another order's
"rest". This is what lets one changeset present as both _key-changes-first_ and
_results-first_ without duplicating data.

- **`segments[]`** — the order-independent atoms. Each is one addressable slice of the diff:
  - `id` — stable within the document, e.g. `"s1"`.
  - `path`, `oldPath?`, `status` (`added` | `deleted` | `modified` | `renamed` | `untracked`).
  - `granularity` — `line` | `hunk` | `file`. Choose per stop: pull out a single `line` for a
    one-line bug, a `hunk` for a focused change, a whole `file` for a new test that reads as a
    spec.
  - `added`, `deleted` — line counts for the slice.
  - `anchor` — where it points into the live diff: `display` (e.g. `"src/App.tsx:311"`),
    optional `sectionId` (`<path>:staged` for staged diffs, `<path>:unstaged` for working-tree
    edits), `sectionKind`, `side` (`additions` | `deletions` | `both`), and `startLine`/`endLine`
    for `line`/`hunk` granularity (omit for `file`). Codiff repairs anchors against the live diff,
    so a missing or slightly-off `sectionId` is fine — it's pinned to a real section on load.
  - `title?`, `summary?` — default framing; an order's stop may override the title.
  - `comments?` — review comments to seed, anchored by `side` + `lineNumber` (+ optional range).

- **`orders[]`** — one or more reading views over the segments. Each has:
  - `id` (e.g. `"keys"`, `"results"`), `label`, `tagline`.
  - `phases[]` — named chapters, each with an `icon` (`bug` | `wrench` | `path` | `flask` |
    `beaker` | `doc` | `gear`) and a `blurb`.
  - `sequence[]` — the ordered stops. Each is `{ segmentId, phaseId, importance, prose, title? }`.
  - `rest[]` — files changed alongside the work but kept off the narrative path, each
    `{ segmentId, reason, note? }`. Group by `reason` (e.g. `Generated`, `Lockfile`, `Snapshot`,
    `Mechanical`).
  - `restLabel`, `restBlurb` — how "the rest" is presented.

- **`defaultOrder`** — the order id Codiff opens first. Choose `results` when the change has a
  strong test/snapshot/contract that previews it well; otherwise `keys`.

- **`context`** — a compact summary of the originating conversation (objective, decisions,
  risks, validation, a few key messages), so Codiff can answer questions without you. Use the
  `WalkthroughContext` shape (`version: 1`, `source: { type: "claude-session" | "codex-session", generatedAt }`).

## How to think about it

- Order stops by **review leverage and story**, not by file path. It is good for the arc to
  cross files and return to an earlier one (the bug, the fix, the refactor, the proof).
- Write `prose` as the agent's voice explaining _why this matters now_. It may use inline
  markdown / code. Keep review comments separate (`comments[]`), not baked into prose.
- Use `importance: "critical"` sparingly — only the genuine root cause or the defining test.
- Push generated files, lockfiles, and snapshots into each order's `rest[]` with a `reason`. In
  a results-first order you may instead promote a signal-bearing one (a snapshot, a widened
  contract) to a lead stop.

- Provide **two orders** when both make sense (`keys` and `results`); one is fine for small
  changes. Do not invent bugs or produce review findings — describe what changed and why.
- Every `segmentId` referenced by a `sequence` or `rest` entry must exist in `segments[]`, and
  every segment `path` should be a file in the diff. Codiff drops dangling references on load,
  but a clean document renders best.

## The schema

The document must conform to the following JSON schema:
