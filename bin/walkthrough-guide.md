# Narrative walkthrough — authoring guide

This is Codiff's guidance for authoring a **narrative walkthrough**: a compact review path
through a change, with ordered chapters, stops, and direct anchors into the live diff.
The diff content itself is not embedded. Codiff computes the diff from the repository,
repairs anchors on load, and renders the real current diff.

Write the JSON document to a **temporary file outside the repository** and pass it to
Codiff with `--walkthrough-file`. Set `"$schema"` to
`https://raw.githubusercontent.com/nkzw-tech/codiff/main/src/walkthrough/narrative-walkthrough.schema.json`
for editor validation.

Default to the **staged** diff (`git diff --staged`). If the user named a target, use that:
a commit, branch, pull request, ref range, or repository path. If nothing is staged, fall back
to the working tree (`git diff`) and say so. Anchor every `chapters[].stops[].anchors[]` and
`support[].files[]` item against whichever diff you choose.

## Shape

- **`chapters[]`** — 2-6 compact sections in the review path. A chapter is a conceptual group,
  not a file. Keep `title` to 1-2 short words and at most 16 characters, e.g. `"UI"`, `"CLI"`,
  `"Tests"`, `"Docs"`, `"Runtime"`, `"Cleanup"`.
- **`chapters[].stops[]`** — the main review path. Use 3-6 stops for small changes, 5-9 for
  medium changes, and 7-12 for large changes. Never exceed 14. A stop should represent one
  review idea and can cover up to 8 files via direct anchors.
- **`anchors[]` / `support[].files[]`** — direct slices of the live diff:
  - `id` — stable within the document, e.g. `"a1"`.
  - `path`, `oldPath?`, `status` (`added` | `deleted` | `modified` | `renamed` | `untracked`).
  - `granularity` — `line` | `hunk` | `file`.
  - `added`, `deleted` — line counts for this slice.
  - `anchor` — `display`, optional `sectionId`, `sectionKind`, `side`, `startLine`, `endLine`.
    Codiff repairs missing or stale section ids against the live diff.
  - `title?`, `summary?` — short labels for the file or slice.
  - `comments?` — optional seeded review comments anchored by side and line.
  - `changeType?`, `commitNote?` — optional commit composer metadata.
- **`support[]`** — changed files that should stay off the main path. Use it for generated
  files, lockfiles, snapshots, broad CSS churn, deleted legacy files, and repeated mechanical
  edits unless they are essential to review.
- **`commit?`** — for working-tree walkthroughs, include `title` and `body` when there is enough
  signal for a useful commit message. Omit it for commits, branches, and pull requests.
- **`context?`** — compact originating conversation context, if available, for follow-up Q&A.

## Rules

- Every changed file should appear exactly once in either a stop anchor or support. Codiff adds
  any omitted live-diff file to `support`, but a clean document reads better.
- Order stops by review leverage, not by file path.
- Do not make one stop per file for broad changes. Group files that implement the same idea in
  one stop.
- Keep `summary` to one concrete sentence. Keep `body` short and specific. Do not use markdown
  headings, lists, or other block structure. Inline code is supported, though: wrap symbol names,
  file paths, flags, and other literals in backticks, e.g. `--walkthrough-file` or `renderInlineMarkdown`.
- Avoid generic filler, broad assurance language, and meta-explanatory labels.
- Do not invent bugs, risks, tests, or validation. Describe what the diff and conversation
  actually support.
- Put review findings in `comments[]`, not in the stop body.

## Schema

The document must conform to the following JSON schema:
