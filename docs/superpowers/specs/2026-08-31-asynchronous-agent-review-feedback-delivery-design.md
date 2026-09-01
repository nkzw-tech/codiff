# Asynchronous Agent Review Feedback Delivery Design

## Summary

Replace the blocking agent review result-file handoff with asynchronous delivery into the exact
agent session that opened Codiff. The launching agent turn returns as soon as Codiff opens. When the
reviewer later clicks **Send feedback**, Codiff queues a new user turn through a backend-specific
session bridge and closes only after that bridge acknowledges acceptance.

The first release targets Codex, Claude Code, OpenCode, and Pi. Reliable delivery requires richer
managed integrations for the three agents that do not expose a suitable queue command: an OpenCode
plugin, a Claude Code Channel, and a Pi extension. Codex uses its native external thread queue.

## Problem

The current desktop launcher blocks until Codiff writes `CODIFF_REVIEW_RESULT`. Codiff itself has no
review timeout after the handoff owner is published, but the surrounding agent tool call can time
out. The Codiff window remains live and can later write a valid result, while the process that was
supposed to consume that result no longer exists. A later process can then consume stale feedback
from the previous window, as demonstrated during local OpenCode testing.

The root issue is architectural: delivery ownership belongs to a transient shell invocation rather
than the durable agent session. Extending the shell timeout cannot make the handoff reliable.

## Goals

- Return the launching agent turn immediately after Codiff opens.
- Deliver submitted feedback as a new user message to the exact originating session.
- Queue feedback after any active turn rather than interrupting it.
- Support Codex, Claude Code, OpenCode, and Pi.
- Close Codiff only after the target agent accepts or queues the message.
- Preserve every comment and focused draft when delivery fails.
- Prevent stale windows and retries from creating unintended messages in later sessions.
- Preserve structured comment anchors and ordered Markdown in the delivered message.

## Non-Goals

- Resuming the same session through a second independent agent process.
- Delivering feedback after the target session or its required bridge has closed.
- A durable offline inbox or background retry queue.
- Automatically reopening Codiff after an agent handles feedback.
- Treating bridge acknowledgement as proof that the resulting agent turn completed successfully.
- Supporting agent versions that lack the required bridge or queue capability.

## User Experience

The agent runs Codiff and receives immediate confirmation that the review window opened and that
feedback will arrive as a separate message. The original turn is then free to finish normally.

The reviewer writes inline comments as today. A focused, unblurred draft counts as feedback and is
included synchronously. **Send feedback** is available only when the launch is associated with a
validated live session bridge and at least one comment exists.

On acknowledgement, Codiff closes. The target agent shows a new user message and starts or queues a
new turn in the same session. If delivery fails, Codiff stays open, displays an actionable error,
and preserves all comments and drafts. Closing Codiff without sending creates no agent message.

Codiff never falls back to detached session resumption. When an integration is missing, outdated,
closed, or unreachable, the user can retry after restoring it or use the existing copy-comments
workflow.

## Architecture

### Launch Flow

The installed agent skill discovers the current session and repository as it does today, then
launches Codiff without waiting for review completion. Launch options identify the backend, session,
repository, and a unique delivery ID. Secrets and bridge tokens are not placed in process arguments.

The launcher waits only for an explicit window-open acknowledgement with a short bounded timeout.
This distinguishes a successful asynchronous handoff from a launch failure without tying the
agent's lifetime to the review. Once acknowledged, the launcher exits successfully and removes only
launch-specific temporary state. The Codiff window owns the review and delivery lifecycle from that
point onward.

### Common Delivery Contract

Electron sends every adapter the same logical request:

```ts
type AgentFeedbackDeliveryRequest = {
  version: 1;
  deliveryId: string;
  backend: 'codex' | 'claude' | 'opencode' | 'pi';
  sessionId: string;
  repositoryRoot: string;
  feedback: AgentReviewFeedback;
};

type AgentFeedbackDeliveryResponse =
  | { status: 'accepted' | 'queued' | 'already-accepted'; deliveryId: string }
  | { status: 'rejected'; deliveryId: string; reason: string };
```

The request carries the exact repository source and ordered structured comments already produced by
`buildAgentReviewFeedback`. The visible agent message begins with a stable Codiff delivery marker,
includes the Markdown review, and states that comments should be handled in order without
automatically reopening Codiff. Structured anchor metadata remains available to bridges that can
attach machine-readable message metadata.

Electron validates the sender window, backend, session, repository root, repository source, comment
schema, and delivery ID before invoking an adapter. Only `accepted`, `queued`, or
`already-accepted` is success.

### Session Bridge Registry

Managed OpenCode, Claude Code, and Pi integrations register a session-scoped local endpoint under
Codiff's application-support directory. Registrations and Unix-domain sockets are readable only by
the current user. Each registration contains a protocol version, backend, exact session ID,
repository root, process ID, endpoint, random authentication token, and liveness timestamp.

Codiff treats registry data as untrusted until it connects, authenticates, and receives a challenge
response containing the same backend, session, repository, and protocol version. Stale registrations
are ignored and cleaned up opportunistically. A session bridge unregisters on normal shutdown.

Codex does not require a resident plugin registry when its native queue capability is available.
Its adapter still validates the exact thread ID and repository before dispatch.

### Adapter Interface

Each backend implements a small adapter with capability detection, session validation, message
delivery, and acknowledgement normalization. Adapters do not own renderer state or window closing.
This keeps backend-specific process and protocol details outside the shared Electron handoff
lifecycle.

## Backend Delivery

### OpenCode

The managed OpenCode integration adds a plugin alongside the existing skill and `/codiff` command.
The plugin uses the OpenCode client associated with the running TUI and exposes authenticated local
IPC. It records the active session ID from OpenCode hooks and queues feedback through the server's
asynchronous prompt API. A busy session displays the message as queued and processes it after the
current turn. Because the plugin uses the TUI's own client transport, a separately exposed HTTP port
is not required.

The plugin acknowledges only after OpenCode accepts the asynchronous prompt. Closing OpenCode
removes the endpoint; Codiff then reports an unreachable-session error and remains open.

### Codex

The Codex adapter capability-detects external thread queue support rather than relying only on a
version string. It submits feedback to the exact thread using the native queue mechanism. Feedback
for a busy thread is queued after the active turn; an idle or unloaded thread starts a new turn.

Codiff maintains a delivery ledger keyed by delivery ID around queue dispatch. A delivery with a
known accepted ID returns `already-accepted`. An ambiguous process or transport failure is not
automatically retried, preventing duplicate turns; Codiff keeps the window open and explains that
the user should verify the thread or copy the comments.

### Claude Code

The managed Claude integration installs a Codiff Channel. The channel registers its active session
with the local bridge registry and converts a delivery request into a Claude external event. Events
arriving during a turn queue for the next turn. The channel acknowledges the delivery ID after the
event is accepted by the live session.

Claude Code Channels must be supported and enabled for the user's account or organization. Install
and capability checks explain this prerequisite. Codiff does not use `claude --resume` because a
second process does not inject into the active TUI and can concurrently mutate the same transcript.

### Pi

The managed Pi integration installs an extension alongside the skill. The extension registers the
live session and calls `sendUserMessage` for idle delivery or `sendUserMessage` with
`deliverAs: 'followUp'` while busy. It acknowledges only after Pi accepts the message.

Codiff does not start a second `pi --session` or RPC process for an active session. If the extension
is absent or the Pi process has closed, delivery fails and the review remains open.

## Lifecycle And Idempotency

Every Codiff review window receives a cryptographically random delivery ID. A window can transition
from `open` to `sending`, then to either `open` after a definite rejection or `accepted` after an
acknowledgement. Only `accepted` closes the window. Duplicate button activation while `sending` is
ignored.

Bridges and the Electron delivery ledger remember accepted delivery IDs for the lifetime of the
session. Repeating an accepted request returns `already-accepted` without creating another user
message. Codiff never automatically retries an ambiguous request. Delivery records have bounded
retention and contain no feedback body after acceptance.

A stale window cannot retarget itself. Repository or source changes invalidate the original bridge
binding until Electron validates and binds the current source. A delivery acknowledgement must echo
the exact delivery ID; mismatched or malformed responses are failures.

## Error Handling

- Missing capability: keep Codiff open and explain which integration or agent version is required.
- Missing or stale registration: keep Codiff open and ask the user to restart or reconnect the exact
  agent session.
- Authentication or identity mismatch: reject without sending and keep Codiff open.
- Definite backend rejection: show the backend reason and allow retry after correction.
- Ambiguous transport outcome: do not resend automatically; keep Codiff open and direct the user to
  verify the session or copy comments.
- Agent closes after accepting: Codiff may close because acceptance, not completion, is the contract.
- Renderer or window failure before acceptance: send nothing.

Errors are concise in the UI and retain detailed diagnostics in application logs. Feedback bodies
and bridge tokens are not logged.

## Security

- Bind bridge endpoints locally and prefer Unix-domain sockets with user-only permissions.
- Generate independent random tokens per live session and never expose them in command-line
  arguments.
- Validate process liveness, protocol version, backend, session ID, and repository root on every
  connection.
- Validate feedback and exact repository source at the Electron boundary before delivery.
- Reject symlink, ownership, or permission anomalies in registry and socket paths.
- Bound message size, comment count, and acknowledgement time.
- Never execute feedback through a shell or interpolate it into command strings.

## Integration Installation

The Codiff **Install Skill** actions become integration installers. OpenCode installation adds the
skill, command, and plugin. Claude Code installation adds the skill and Channel. Pi installation
adds the skill and extension. Codex installation retains the skill and reports whether the installed
CLI supports external queueing.

Installation clearly states that the agent must be restarted so the bridge loads. Status surfaces
distinguish installed files from an active compatible session endpoint.

## Migration

This feature branch is unreleased, so the blocking result-file protocol has no compatibility
requirement. Remove `CODIFF_REVIEW_RESULT`, `--review-result-file`, terminal-result polling, owner
files, and the associated agent instructions after asynchronous delivery is covered. Preserve the
shared feedback formatter, renderer draft flush, schema validation, window isolation, and
successful-send/failure-preservation UI behavior.

The plan handoff remains blocking because it intentionally gates implementation on document review;
this redesign applies only to code-review feedback.

## Testing

### Shared Contract

- Validate all request, response, identity, size, and order invariants.
- Verify accepted delivery IDs are idempotent and mismatched acknowledgements fail.
- Verify definite rejection returns to `open` without losing comments or focused drafts.
- Verify ambiguous failures are never automatically retried.

### Backend Adapters

- OpenCode: idle, busy/queued, wrong session, closed TUI, duplicate ID, and plugin version mismatch.
- Codex: capability detection, idle and busy queueing, wrong thread, definite CLI failure, ambiguous
  termination, and accepted-ID replay.
- Claude Code: Channel registration, idle and busy events, disabled Channels, closed process,
  authentication failure, and duplicate ID.
- Pi: idle `sendUserMessage`, busy `followUp`, stale extension registration, closed process, and
  duplicate ID.

### End-To-End

- Prove each agent launcher returns after window-open acknowledgement rather than review completion.
- Prove feedback appears as a new user message in the same running TUI and starts or queues a turn.
- Prove a previous window's feedback cannot enter a later session.
- Prove successful acceptance closes Codiff.
- Prove every failure path keeps Codiff open with comments and focused draft unchanged.
- Prove normal close sends no message.
- Prove existing Copy Comments, inline Ask, remote-review submission, and plan handoff behavior remain
  unchanged.
- Manually exercise Codex, Claude Code, OpenCode, and Pi with both idle and busy sessions.

Run focused suites during implementation, then `vp test`, `vp check --fix`, and `vpr build` in that
order.
