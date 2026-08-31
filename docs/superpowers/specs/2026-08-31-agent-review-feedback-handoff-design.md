# Agent Review Feedback Handoff Design

## Summary

Codiff will let a user return local inline review comments to the agent that opened the review. In an agent-launched review window, the user adds comments and clicks **Send feedback**. Codiff saves a versioned result, closes the window, and unblocks the originating agent turn so it can apply the feedback.

The first version supports the Codex, Claude Code, OpenCode, and Pi integrations. Normal desktop launches and remote pull request or merge request review submission remain unchanged.

## Goals

- Return local review comments to the same blocked agent invocation that opened Codiff.
- Preserve structured anchors and agent-ready Markdown for each comment.
- Make the handoff explicit, reliable, and backend-neutral.
- Keep user comments intact when saving fails.
- Let the agent decide whether to open Codiff again after making changes.

## Non-Goals

- Keeping Codiff open while the agent edits files.
- Sending feedback to a newly spawned agent process from Electron.
- Automatically locating or starting an agent for independently launched Codiff windows.
- Replacing existing GitHub or GitLab review submission.
- Automatically repeating the review loop after every iteration.

## Existing Behavior

Agent integrations already open Codiff through blocking launcher scripts and attach the relevant agent backend and session identifier. Codiff already supports local inline comment drafts, renders agent replies through the inline **Ask** action, and formats pending comments as agent-ready Markdown through `buildReviewCommentsMarkdown`.

The **Ask** action runs a separate, constrained review-assistant request. It does not return repository-editing work to the originating agent turn. Plan mode already demonstrates the required blocking result-file pattern and provides the model for this feature.

## Architecture

Each agent launcher creates a unique temporary review-result path before starting Codiff. It passes that path through a new internal command-line option. The option is stored in `CodiffLaunchOptions` and marks the window as a blocking agent review handoff.

The renderer exposes **Send feedback** only when that handoff option is present. When invoked, it flushes the active editor draft, builds the final ordered feedback payload, and asks Electron to complete the handoff.

Electron validates the request against the current window and repository, writes the result atomically, marks the handoff complete, and closes the window. The blocked launcher then reads the result and emits one machine-readable `CODIFF_REVIEW_RESULT` line for the originating agent.

This flow is backend-neutral. The four integration launchers use the same result schema and differ only in their existing session discovery and launch details.

## User Experience

Agent-launched review windows show a primary **Send feedback** action in the existing top-bar comment action area.

- The action includes the pending local-comment count.
- It is disabled until at least one non-empty local comment exists.
- It changes to **Sending...** while Codiff finalizes and writes feedback.
- Repeated activation is ignored while submission is in progress.
- A successful handoff closes the Codiff window.
- A failed handoff keeps the window open, preserves comments, and displays an inline error.
- Closing the window normally returns a canceled result and does not send comments.

Existing **Copy Comments**, **Ask**, and pull request or merge request controls retain their current behavior. Independently launched windows do not show **Send feedback**.

## Feedback Contract

The result file contains versioned JSON with these conceptual fields:

```json
{
  "version": 1,
  "status": "submitted",
  "repository": {
    "root": "/absolute/repository/path",
    "source": {}
  },
  "comments": [],
  "markdown": "# Address these Review Comments\n..."
}
```

`status` is either `submitted` or `closed`. A submitted result contains at least one comment. A closed result contains no actionable feedback and tells the waiting integration that the user canceled the handoff.

Each structured comment contains:

- Stable ordering index.
- Repository-relative file path.
- Section identifier.
- File or line anchor.
- Addition or deletion side where applicable.
- End and optional start line information.
- Trimmed comment body.
- The nearby diff context used by the existing Markdown formatter.

The top-level `markdown` field uses the existing review-comment formatting, including the configured prefix, ordered file and line references, fenced diff excerpts, and user comment bodies. Structured comments are authoritative for integrations that need fields; Markdown is the direct prompt input for agents.

The repository root and review source identify the exact reviewed state. Agent instructions require validating that identity before editing. A mismatch stops automatic application and is reported to the user.

## Agent Workflow

The installed skills for Codex, Claude Code, OpenCode, and Pi describe the same desktop workflow:

1. Author the walkthrough and invoke the blocking launcher as they do today.
2. Wait for Codiff to close and read `CODIFF_REVIEW_RESULT`.
3. Treat `closed` as cancellation and make no feedback-driven edits.
4. For `submitted`, validate the repository and source identity.
5. Address every returned comment in order, using the structured anchor and diff context.
6. Ask one focused question when feedback is materially ambiguous rather than guessing.
7. Summarize handled feedback and decide whether another Codiff review pass is useful.

The agent does not automatically reopen Codiff. This avoids an inescapable loop and lets the agent account for the scope and confidence of the resulting changes.

## Lifecycle And Failure Handling

The result lifecycle mirrors plan handoffs:

- Result files are unique per invocation.
- Writes use a temporary sibling file followed by an atomic rename.
- Electron accepts completion only from the window associated with the result path.
- The first terminal result wins; duplicate submissions and close events cannot overwrite it.
- Renderer or window failure produces a canceled result when possible.
- Submission errors are returned to the renderer without closing the window.
- Comments remain in renderer state after any failed submission.
- The launcher rejects missing, malformed, unsupported-version, or identity-mismatched submitted results.

The launcher prints exactly one `CODIFF_REVIEW_RESULT` record for a valid terminal result. Other diagnostics go to stderr so agent parsing remains deterministic.

## Components

### CLI And Launch Options

- Add the internal result-file argument and environment equivalent.
- Propagate it through `CodiffLaunchOptions` and window setup.
- Keep the option absent for regular CLI launches.

### Electron Handoff Controller

- Validate and atomically persist submitted or closed results.
- Enforce window ownership and first-result-wins semantics.
- Coordinate close behavior and expose completion through IPC.

### Renderer Review Actions

- Derive availability from launch options.
- Flush the active comment draft before calculating pending comments.
- Build structured and Markdown feedback from the same ordered comment set.
- Render pending, disabled, sending, and error states.

### Agent Launchers And Skills

- Create and pass the unique result path.
- Parse and validate the result after Codiff exits.
- Emit `CODIFF_REVIEW_RESULT` for the active agent turn.
- Document how to process submitted and canceled results.

### Walkthrough Guide

Update the user-land agent guidance so agents know that desktop review launches can return local feedback and that a submitted result is work to apply, not merely a review summary.

## Testing

Automated coverage will include:

- Command-line parsing and environment propagation for the result path.
- Result schema validation and atomic persistence.
- Successful, canceled, duplicate, malformed, and failed handoffs.
- Close behavior before and after submission.
- Active comment draft flushing before payload construction.
- Button visibility, pending count, disabled state, sending state, and error state.
- Structured comment ordering, line ranges, sides, and diff context.
- Existing Markdown output reuse, including configured prefixes.
- Launcher output and cancellation behavior for all four agent integrations.
- Updated installed skill templates and walkthrough guidance.

Repository validation will run `vp check --fix` followed by `vpr build`, as required for Codiff changes.

## Alternatives Considered

### Emit Feedback Through Process Stdout

This avoids a result file but is fragile because the terminal helper and Electron application have separate process lifecycles, and multiple windows can coexist. A durable result file gives the launcher an unambiguous completion record.

### Resume Agent Sessions Directly From Electron

Electron could invoke each agent CLI and push a prompt into a session. This creates backend-specific behavior, can bypass the blocked originating turn and its permissions, and turns a simple handoff into a live session protocol.

### Keep Codiff Open During Iteration

A live loop would require bidirectional progress, repository refresh coordination, cancellation, and conflict handling. Closing and returning feedback fits the existing blocking integration and delivers the requested iteration path with substantially less complexity.
