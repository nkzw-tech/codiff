# Session-Routed Agent Feedback Design

## Goal

When an agent session launches Codiff, feedback must return to that exact session regardless of which repository or worktree Codiff reviews. The flow must remain automatic and must not require the user to restart the agent in the reviewed directory.

## Current Behavior

OpenCode, Claude, and Pi use a resident local feedback bridge. Each bridge registers its backend, session ID, repository root, process ID, Unix socket, and authentication token in a private per-user registry. Codiff currently locates a bridge by matching all of these routing fields:

- Backend
- Session ID
- Repository root

The repository root used during bridge registration is the agent session's directory. The repository root used during Codiff preflight and delivery is the repository open in Codiff. Reviewing another worktree or an unrelated repository therefore fails preflight even though Codiff has the exact launching session ID and a live authenticated bridge for it.

Codex does not have this limitation because it routes directly to an exact thread ID through its queue command.

## Design

### Recipient Identity

Resident bridge routing will use only:

- Backend
- Exact session ID

The bridge registry remains private to the current OS user. Codiff will continue validating registration ownership, permissions, freshness, process liveness, socket availability, and the per-registration bearer token. It will challenge the selected socket before reporting delivery as available.

The registration may retain the agent session's repository root as diagnostic metadata, but that root will not participate in candidate selection or recipient authorization.

### Review Provenance

The repository open in Codiff remains part of `AgentReviewFeedback.repository`. Before delivery, Codiff will continue validating that the submitted comments refer to the repository root and review source associated with the open window.

Recipient identity and review provenance are intentionally separate:

- The exact session ID determines who receives feedback.
- The Codiff window's repository and source determine what change the feedback describes.

Opening a different repository must not rewrite, discard, or substitute either identity.

### Preflight And Delivery

The launcher continues forwarding the launching agent's exact session ID. Codiff probes the freshest valid registration matching the requested backend and session ID. A matching registration is accepted even when its diagnostic repository root differs from the reviewed repository.

Delivery uses the same authenticated bridge. The delivery request retains the reviewed repository root as feedback context, but the bridge does not compare it with the agent session's startup directory. The bridge dispatches the formatted feedback to its registered session.

If multiple valid registrations exist for the same backend and session ID, Codiff tries them newest first and accepts the first registration that passes the authenticated identity challenge.

### Failure Behavior

Codiff reports delivery as unavailable when:

- No registration exists for the exact backend and session ID.
- Matching registrations are stale or owned by dead processes.
- Registry files or directories are not private and owned by the current user.
- The socket is unavailable or fails its authentication challenge.
- The challenged bridge reports a different backend or session ID.

Codiff must not fall back to another session based on repository path, recency, or backend alone. Refocusing an open Codiff window may re-run preflight so a bridge that becomes available after launch can be used.

Existing ambiguous-delivery and idempotency behavior remains unchanged.

## Backend Scope

The routing change applies to the shared resident bridge used by OpenCode, Claude, and Pi. Codex remains unchanged because its queue transport already addresses the launching thread directly and does not use repository-root bridge matching.

## Testing

Bridge client tests will verify:

- A registration is found when backend and session ID match but repository roots differ.
- Delivery succeeds from an agent session into another worktree of the same repository.
- Delivery succeeds when the reviewed repository is unrelated to the agent session directory.
- A different session ID or backend is rejected.
- Stale registrations, dead processes, insecure files, unavailable sockets, and invalid authentication challenges remain rejected.
- Multiple registrations for one session are tried newest first.

Controller and integration tests will verify:

- Preflight no longer depends on the reviewed repository root.
- Delivered feedback retains the actual Codiff window repository and review source.
- Repository validation still rejects feedback that does not match the open Codiff window.
- Existing same-directory delivery remains successful.
- OpenCode, Claude, and Pi use the new shared routing behavior while Codex behavior remains unchanged.

## Out Of Scope

- Routing feedback to a session other than the one that launched Codiff.
- Falling back to a repository-matched session when the launching session is unavailable.
- Changing feedback formatting, comment anchors, delivery assurances, or retry semantics.
- Adding a persistent callback daemon or another background process.
