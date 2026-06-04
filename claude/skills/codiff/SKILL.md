---
name: codiff
description: Open Codiff from the current Claude Code session with a walkthrough seeded by the active conversation. Use when the user writes "/codiff", "show me codiff", "open Codiff", or asks to review the current changes in Codiff with Claude Code context.
metadata:
  short-description: Open Codiff with session context
---

# Codiff

Open Codiff with a walkthrough seeded by the active Claude Code conversation.

## Workflow

1. Run the bundled launcher from this skill directory:

```bash
node scripts/open-codiff.mjs
```

2. Forward any explicit user target after the command:

```bash
node scripts/open-codiff.mjs HEAD
node scripts/open-codiff.mjs pr 75
node scripts/open-codiff.mjs /path/to/repository
```

The launcher uses `CLAUDE_SESSION_ID` when available and passes it to Codiff with
`--agent claude`. Codiff owns repository state, diff digest creation, and the ephemeral
Claude Code walkthrough call.

Do not summarize the conversation manually. The skill is only a handoff into Codiff.
