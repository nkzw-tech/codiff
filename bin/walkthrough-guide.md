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

- **`version` / `kind` / `title` / `focus`** — use `version: 4`, `kind: "narrative"`,
  a short walkthrough title, and a one- or two-sentence string describing the review focus.
- **`chapters[]`** — 1-6 compact sections in display order. A chapter is a conceptual group,
  not a file. Every chapter requires a unique string `id`, plus `title`, `icon`, `blurb`, and
  `stops`. For one- or two-file diffs, prefer one chapter unless there are clearly separate review
  phases. Keep `title` to 1-2 short words and at most 16 characters, e.g. `"UI"`, `"CLI"`,
  `"Tests"`, `"Docs"`, `"Runtime"`, `"Cleanup"`.
- **`chapters[].stops[]`** — the main review path. Use 1-2 stops for tiny changes, 1-3 stops
  for focused small changes, 5-9 for medium changes, and 7-12 for large changes. Never exceed 14. A stop should represent one review idea and can include up to 14 ordered `hunkIds`.
  Give every stop a concise semantic `title` in roughly 2-6 words, such as
  `"Prevent duplicate payments"` or `"Preserve offline drafts"`. Never use a filename or path
  as the stop title.
- **`hunkIds[]`** — deterministic hunk ids copied from the repository digest, in the exact order
  Codiff should render them. Default to one review idea per stop, not one hunk per stop. Use
  multiple ids when those hunks implement the same idea, invariant, behavior, or repeated pattern;
  cross-file and out-of-line order is allowed when it improves the review path. For 1-4 total
  hunks, usually write 1-2 stops. Some ids are synthetic hunks for binary, deferred,
  metadata-only, or otherwise non-textual changes; treat them like normal hunk ids and explain why
  that review unit matters.
- **`notes[]`** — optional short header notes for individual focused hunks: `{ hunkId, body }`.
  Use these when a specific hunk needs a label under its file header.
- **`support[]`** — changed hunks that should stay off the main path. Use it for generated files,
  lockfiles, snapshots, docs-only changes, and repeated mechanical edits unless they are essential
  to review. Codiff adds any omitted live-diff hunks to support. Generated-like files are one
  synthetic hunk per changed section; never split them, use `reason: "Generated files"` for
  generated-only support items so they render together, but keep behavior-relevant snapshots or
  artifacts on the main path. Codiff also recognizes `linguist-generated` and `gitlab-generated`
  attributes from `.gitattributes`.
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
- Similar same-file hunks should usually be one stop with multiple `hunkIds`, not separate
  chapters or stops. Split them only when the reviewer needs different prose for different ideas.
- Do not make one stop per file for broad changes. Group hunks that implement the same idea in
  one stop.
- Never split a generated-like file across stops or support items. Use its single synthetic hunk id.
- Keep `summary` to one concrete sentence. Keep `prose` short and specific. Do not use markdown
  headings, lists, or other block structure. Inline code is supported, though: wrap symbol names,
  file paths, flags, and other literals in backticks, e.g. `--walkthrough-file` or `renderInlineMarkdown`.
- Avoid generic filler, broad assurance language, and meta-explanatory labels.
- Do not invent bugs, risks, tests, or validation. Describe what the diff and conversation
  actually support.
- If a PR/MR description is available, use it only as author intent and orientation. Do not copy it
  into the walkthrough JSON; the diff and hunk ids remain the source of truth.

## hunkId format

Every `hunkId` has the shape `<file path>:<scope>:h<ordinal>`. The `<file path>` is
the file's repository-relative path, `<scope>` identifies the diff the hunk came from,
and `h<ordinal>` is the hunk's 1-based position within that file's patch (`h1`, `h2`, …).
The `<scope>` segment depends on which diff you anchored against:

- `staged` — the staged diff (`git diff --staged`).
- `unstaged` — the working-tree diff (`git diff`).
- `pull-request:<number>` — a pull request.
- `<commit SHA>` — every commit-like target: a single commit, a branch comparison, or a
  ref range. This is always the **full 40-character SHA of the diff's new (head) side**,
  resolved with `git rev-parse` — never a ref name or a `branch:`/`range:` prefix:
  - single commit (`codiff <ref>`): the resolved commit SHA.
  - branch comparison (`codiff <branch>` — current branch vs `<branch>`): the resolved
    **`HEAD`** SHA, _not_ `<branch>`.
  - ref range (`codiff base..head` or `base...head`): the resolved SHA of `head`.

## Schema

The document must conform to the following JSON schema:
