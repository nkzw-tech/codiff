---
name: codiff
description: Open Codiff for a narrative code walkthrough, a plain diff view, a blocking plan handoff, or a shared walkthrough URL. Use when the user writes "$codiff", "/codiff", "$codiff diff", "$codiff plan", "$codiff share", "show me codiff", "open Codiff", or asks to review a change or edit a plan in Codiff.
metadata:
  short-description: Review code or hand off a plan in Codiff
---

# Codiff

Use Codiff either to review a **narrative walkthrough** of a code change or to hand a Markdown
plan to the user for visual editing before execution.

You write the JSON yourself because you already hold the conversation that produced the
change. Codiff owns the format and authoring guidance, so this skill only handles the handoff.

## Choose The Mode

- Use **plan share mode** for `$codiff plan share`, or when a share request is clearly about the
  proposed plan in the current discussion.
- Use **walkthrough share mode** when the request includes `share`, `upload`, `link`, `URL`, `web`,
  or browser wording and is about code changes. An underspecified `$codiff share` defaults to a
  walkthrough.
- Use **plan mode** for `$codiff plan` or when the user explicitly asks to edit or approve a
  plan in Codiff before execution.
- Use **desktop mode** for plain `$codiff`, `/codiff`, "open Codiff", or "show me Codiff".
- Use **simple diff mode** for `$codiff diff`, or when the user asks for the plain diff, the raw
  diff, "just the diff", or a diff view without a narrative walkthrough.
- In share mode, only pass `--open` when the user explicitly asks to open the resulting share in
  a browser. Otherwise return the URL without opening it.

## Plan Mode

1. Write the complete proposed plan to a Markdown file. Use a unique temporary file outside the
   repository unless the user named a canonical plan file.
2. Make the intended next action explicit in the document. The user should be able to edit,
   remove, or reorder any part of the plan.
3. Open the blocking handoff:

   ```bash
   node scripts/open-codiff.mjs --plan /tmp/codiff-plan-<id>.md
   ```

4. Wait for Codiff to return. `status: "done"` means the user clicked **Done**. `status: "closed"`
   means the user closed the window after Codiff flushed the file and comments. A canceled handoff
   means the app could not complete the handoff and must not be treated as approval.
5. Read the `CODIFF_PLAN_RESULT` JSON emitted when Codiff closes. Re-read the entire Markdown file
   and process every thread in `review.threads` whose `status` is `"open"`. Treat edits, additions,
   removals, reordered steps, and open comments as user direction. Use quoted anchor context for
   detached comments. Resolved comments are retained history and must not be processed again.
6. After successfully applying one or more open comments, acknowledge only the handled thread IDs
   using the exact `reviewPath` from `CODIFF_PLAN_RESULT`:

   ```bash
   node scripts/open-codiff.mjs --resolve-plan-comments "<reviewPath>" <thread-id>...
   ```

   Do not resolve comments that were ambiguous, deferred, or not applied.

7. For `status: "done"`, execute the edited plan when the next action is clear. For
   `status: "closed"`, continue only when `documentChanged` is true or unresolved comments contain
   user direction; otherwise treat the close as cancellation. If the feedback is materially
   ambiguous, ask one focused question before changing code.

The edited Markdown file is the feedback. Do not require comments, annotations, or a separate
approval document.

## Plan Share Mode

1. Write the complete plan to a Markdown file, using the same authoring rules as plan mode.
2. Upload it without opening a blocking desktop handoff:

   ```bash
   node scripts/open-codiff.mjs --plan /tmp/codiff-plan-<id>.md --share
   ```

3. Add `--open` only when the user explicitly asks to open the shared plan in a browser.
4. Return only the `/p/…` URL printed by the command.

## Simple Diff Mode

Open Codiff's plain diff viewer with no narrative walkthrough. There is nothing to author — just
launch it:

```bash
node scripts/open-codiff.mjs --diff
```

By default this reviews the staged and unstaged changes in the session's repository. Forward an
explicit target after the flag when the user names one — a commit, `HEAD`, a branch, a PR/MR, a
range, or a repository path:

```bash
node scripts/open-codiff.mjs --diff HEAD
node scripts/open-codiff.mjs --diff main /path/to/repository
node scripts/open-codiff.mjs --diff '#75'
```

This mode does not author or share JSON. Do not summarize the diff back to the user after opening it.

## Walkthrough Workflow

1. **Get the current guidance from Codiff.** It explains the data model and prints the JSON
   schema:

   ```bash
   node scripts/open-codiff.mjs --guide
   ```

2. **Pick the change.** Default to the staged diff (`git diff --staged`). If the user named a
   target such as a commit, `HEAD`, a PR/MR, a range, or a path, use that. If nothing is
   staged, fall back to the working tree (`git diff`) and say so.

3. **Author the JSON** per the guide and write it to a unique temporary file outside the
   repository, such as `$TMPDIR/codiff-walkthrough-<id>.json`.

4. **Complete the selected handoff.**

   Desktop mode:

   ```bash
   node scripts/open-codiff.mjs --file /tmp/codiff-walkthrough-<id>.json /path/to/repository
   ```

   Share mode:

   ```bash
   node scripts/open-codiff.mjs --share --file /tmp/codiff-walkthrough-<id>.json /path/to/repository
   ```

   Share and open in the default browser:

   ```bash
   node scripts/open-codiff.mjs --share --open --file /tmp/codiff-walkthrough-<id>.json /path/to/repository
   ```

   Forward an explicit target after the flags:

   ```bash
   node scripts/open-codiff.mjs --share --file /tmp/codiff-walkthrough-<id>.json HEAD /path/to/repository
   node scripts/open-codiff.mjs --share --file /tmp/codiff-walkthrough-<id>.json mr 123 /path/to/repository
   ```

   The share command prints the final walkthrough URL to stdout. When the cached Cloudflare
   Access token is missing or unusable, Codiff automatically opens the system browser for
   authentication and resumes after sign-in. This authentication browser is independent of
   `--open`, which only controls whether the completed walkthrough is opened.

   **Agent integration:** The launcher passes `CODEX_THREAD_ID` to Codiff in desktop mode and
   identifies shared walkthroughs as authored by Codex.

   Codiff validates and repairs the document against the live diff, so anchors that drift
   are pinned to a real section rather than dropped.

Emit walkthrough JSON only into the temporary file. In desktop walkthrough mode, do not
summarize the conversation back to the user. In walkthrough share mode, respond with the URL
printed by the command. In plan share mode, respond with the shared plan URL. In plan mode,
continue from the edited Markdown after the blocking handoff returns.
