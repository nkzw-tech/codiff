---
name: walkthrough
description: Author a narrative Codiff walkthrough JSON from the current change and open it in Codiff. Use when the user writes "/walkthrough", "make a walkthrough", "walk me through this change", or asks to review the staged work as a guided narrative in Codiff.
metadata:
  short-description: Generate a narrative walkthrough and open Codiff
---

# Walkthrough

Author a **narrative walkthrough** of the current change as a JSON document, then open
Codiff pointed at it. Unlike Codiff's built-in walkthrough (which only orders files), a
narrative walkthrough tells the _story_ of the change: ordered stops grouped into chapters,
each pinned to a specific slice of the diff, with your narration and the prior conversation
attached so Codiff can answer follow-up questions.

You — the agent running this skill — write the JSON yourself. You already hold the
conversation that produced the change, which is exactly the context the narrative needs.

## Workflow

1. **Pick the change.** Default to the **staged** diff (`git diff --staged`). If the user
   named a target (a commit, `HEAD`, a PR, a path), use that instead.

   ```bash
   git diff --staged --stat
   git diff --staged
   ```

   If nothing is staged, fall back to the working tree (`git diff`) and say so.

2. **Author the JSON.** Write a document conforming to the narrative walkthrough schema,
   published at
   `https://raw.githubusercontent.com/nkzw-tech/codiff/main/src/walkthrough/narrative-walkthrough.schema.json`
   (in the Codiff repo at `src/walkthrough/narrative-walkthrough.schema.json`). Set
   `"$schema"` to that URL for editor validation. Write it to `.codiff/walkthrough.json` in
   the repository root:

   ```bash
   mkdir -p .codiff
   ```

   See **Authoring guide** below.

3. **Open Codiff** with the file:

   ```bash
   node scripts/open-codiff.mjs --file .codiff/walkthrough.json
   ```

   Forward an explicit target after the flag if the user gave one:

   ```bash
   node scripts/open-codiff.mjs --file .codiff/walkthrough.json HEAD
   node scripts/open-codiff.mjs --file .codiff/walkthrough.json /path/to/repository
   ```

   The launcher passes `CLAUDE_SESSION_ID` to Codiff with `--agent claude` so follow-up
   questions reuse this conversation. Codiff validates and repairs the document against the
   live diff, so anchors that drift are pinned to a real section rather than dropped.

## The data model

The document separates **segments** (order-independent slices of the diff) from **orders**
(reading views over them). The same segment can lead one order and sit in another order's
"rest". This is what lets one changeset present as both _key-changes-first_ and
_results-first_ without duplicating data.

- **`segments[]`** — each is one addressable slice: `path`, `status`, `granularity`
  (`line` | `hunk` | `file`), `added`/`deleted` counts, and an `anchor`. The `anchor` points
  into the live diff: `display` (e.g. `src/App.tsx:311`), optional `sectionId`
  (`<path>:staged` for staged diffs), `side` (`additions` | `deletions` | `both`), and
  `startLine`/`endLine` for `line`/`hunk` granularity (omit for `file`). Optionally seed
  review `comments[]` anchored by `side` + `lineNumber`.
- **`orders[]`** — each has `phases[]` (named chapters with an `icon`), an ordered
  `sequence[]` of stops (`segmentId` + `phaseId` + `importance` + `prose`), and a `rest[]`
  of off-path files grouped by `reason` (`Generated` | `Lockfile` | `Snapshot` |
  `Mechanical`).
- **`defaultOrder`** — the order id Codiff opens first. Choose `results` when the change has
  a strong test/snapshot/contract that previews it well; otherwise `keys`.
- **`context`** — a compact summary of this conversation (objective, decisions, risks,
  validation, a few key messages), so Codiff can answer questions without you.

## Authoring guide

- Order stops by **review leverage and story**, not by file path. It is good for the arc to
  cross files and return to an earlier one (the bug, the fix, the refactor, the proof).
- Choose `granularity` per stop: pull out a single `line` for a one-line bug, a `hunk` for a
  focused change, a whole `file` for a new test that reads as a spec.
- Use `importance: "critical"` sparingly — only the genuine root cause or the defining test.
- Write `prose` as the agent's voice explaining _why this matters now_. It may use inline
  markdown/code. Keep review comments separate (`comments[]`), not baked into prose.
- Push generated files, lockfiles, and snapshots into each order's `rest[]` with a `reason`.
  In a results-first order you may instead promote a signal-bearing one (a snapshot, a
  widened contract) to a lead stop.
- Provide **two orders** when both make sense (`keys` and `results`); one is fine for small
  changes. Do not invent bugs or produce review findings — describe what changed and why.
- Emit JSON only into the file. Do not summarize the conversation back to the user; the
  skill is a handoff into Codiff.
