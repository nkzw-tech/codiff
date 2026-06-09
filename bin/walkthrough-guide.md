# Narrative walkthrough — authoring guide

This is Codiff's guidance for authoring a **narrative walkthrough**: a compact review path
through a change, with ordered chapters, stops, and deterministic hunk ids from the live
diff. The diff content itself is not embedded. Codiff computes the diff from the repository,
resolves hunk ids on load, and renders the real current diff.

Write the JSON document to a **temporary file outside the repository** and pass it to
Codiff with `--walkthrough-file`.

Default to the **staged** diff (`git diff --staged`). If the user named a target, use that:
a commit, branch, pull request, ref range, or repository path. If nothing is staged, fall back
to the working tree (`git diff`) and say so. Anchor every `hunkId` against whichever diff you
choose.

## Shape

- **`chapters[]`** — 2-6 compact sections in display order. A chapter is a conceptual group,
  not a file. Keep `title` to 1-2 short words and at most 16 characters, e.g. `"UI"`, `"CLI"`,
  `"Tests"`, `"Docs"`, `"Runtime"`, `"Cleanup"`.
- **`chapters[].stops[]`** — the main review path. Use 3-6 stops for small changes, 5-9 for
  medium changes, and 7-12 for large changes. Never exceed 14. A stop should represent one
  review idea and can include up to 14 ordered `hunkIds`.
- **`hunkIds[]`** — deterministic hunk ids copied from the repository digest, in the exact order
  Codiff should render them. Default to one hunk id per stop or support item. Use multiple ids
  only when those hunks must be read together; cross-file and out-of-line order is allowed when it
  improves the review path. Some ids are synthetic hunks for binary, deferred, metadata-only, or
  otherwise non-textual changes; treat them like normal hunk ids and explain why that review unit
  matters.
- **`notes[]`** — optional short header notes for individual focused hunks: `{ hunkId, body }`.
  Use these when a specific hunk needs a label under its file header.
- **`support[]`** — changed hunks that should stay off the main path. Use it for generated files,
  lockfiles, snapshots, docs-only changes, and repeated mechanical edits unless they are essential
  to review. Codiff adds any omitted live-diff hunks to support.
- **`changeType?` / `commitNote?`** — optional commit composer metadata for committable
  walkthroughs.
- **`commit?`** — for working-tree walkthroughs, include `title` and `body` when there is enough
  signal for a useful commit message. Omit it for commits, branches, and pull requests.

## Rules

- Do not provide `added`, `deleted`, `path`, `oldPath`, `status`, `anchor`, `repo`, `source`,
  `generatedAt`, `agent`, or `meta`. Codiff computes those from the live diff.
- Every changed hunk should appear at most once in either a stop or support. Codiff adds omitted
  live-diff hunks to support, but a clean document reads better.
- Order stops by review leverage, not by file path.
- Do not make one stop per file for broad changes. Group hunks that implement the same idea in
  one stop.
- Keep `summary` to one concrete sentence. Keep `prose` short and specific. Do not use markdown
  headings, lists, or other block structure. Inline code is supported, though: wrap symbol names,
  file paths, flags, and other literals in backticks, e.g. `--walkthrough-file` or `renderInlineMarkdown`.
- Avoid generic filler, broad assurance language, and meta-explanatory labels.
- Do not invent bugs, risks, tests, or validation. Describe what the diff and conversation
  actually support.

## Schema

The document must conform to the following JSON schema:
