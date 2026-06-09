---
name: codiff
description: Author a narrative Codiff walkthrough JSON from the current change and open it in Codiff. Use when the user writes "/codiff", "show me codiff", "open Codiff", "make a walkthrough", or asks to review the staged work as a guided narrative in Codiff.
metadata:
  short-description: Generate a narrative walkthrough and open Codiff
---

# Codiff

Author a **narrative walkthrough** of the current change as a JSON document, then open
Codiff pointed at it. You — the agent running this skill — write the JSON yourself, because
you already hold the conversation that produced the change.

Codiff owns the format and the authoring guidance, so it stays current as Codiff updates.
This skill is just the handoff: fetch the guide, author the document, open Codiff.

## Workflow

1. **Get the current guidance from Codiff.** It explains the data model, how to think about
   the document, and prints the JSON schema; scripts are in `~/.pi/agent/skills/codiff/scripts` folder:

   ```bash
   node scripts/open-codiff.mjs --guide
   ```

   Follow what it says. (Everything below is just the handoff around it.)

2. **Pick the change.** Default to the **staged** diff (`git diff --staged`). If the user named
   a target (a commit, `HEAD`, a PR, a path), use that. If nothing is staged, fall back to the
   working tree (`git diff`) and say so.

3. **Author the JSON** per the guide and write it to a **temporary file outside the
   repository** (so it never clutters the working tree). Pick a unique absolute path in the
   system temp directory — e.g. `/tmp/codiff-walkthrough-<id>.json` (use `$TMPDIR` on macOS).
   Remember that path for the next step.

4. **Open Codiff** with that file _from the git project folder_:

   ```bash
   node scripts/open-codiff.mjs --file /tmp/codiff-walkthrough-<id>.json
   ```

   Forward an explicit target after the flag if the user gave one _from the git project folder_:

   ```bash
   node scripts/open-codiff.mjs --file /tmp/codiff-walkthrough-<id>.json HEAD
   node scripts/open-codiff.mjs --file /tmp/codiff-walkthrough-<id>.json /path/to/repository
   ```

   The launcher passes `PI_SESSION_ID` to Codiff with `--agent pi` so follow-up questions
   reuse this conversation. Codiff validates and repairs the document against the live diff,
   so anchors that drift are pinned to a real section rather than dropped.

Note:

- Emit JSON only into the file.
- Do not summarize the conversation back to the user.
- The skill is a handoff into Codiff, no output is expected.
- hunkIds: a valid hunk id looks like this:
  (for unstaged): "src/App.tsx:unstaged:h1"
  (for staged): "src/App.tsx:staged:h1"
- use exactly `staged` or `unstaged` as any other will not work.
  - temporary files, when you write in tmp folder expansion don't work, so I suggest saving a tmpfile like this instead: `TMPFILE="/tmp/codiff-walkthrough-$$-$(date +%s).json"; echo "$TMPFILE"`.
