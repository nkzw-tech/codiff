# Agent Review Feedback Final Fixes Report

## Status

DONE_WITH_CONCERNS

## Summary

Implemented and regression-tested all nine approved review findings across the launcher, packaged helper, Electron lifecycle, renderer, and repository-state layers.

## Findings Addressed

1. **Forwarded launches could stop waiting before the primary app completed the review.** Added an atomic sibling owner record containing the primary PID and resolved repository identity. Source and packaged waiters follow that durable owner after a forwarding process exits.
2. **Owner termination could race the terminal result write.** The waiter performs a final terminal-result read after detecting owner death and retains malformed-result diagnostics rather than replacing them with a generic missing-result error.
3. **Mutable or incomplete source identity could allow feedback from a different review.** Range results now retain resolved base/head SHAs, pull-request results retain canonical provider/repository/head identity, and launchers compare normalized result identity with the latest owner identity.
4. **Comment order validation allowed duplicates and gaps.** Electron and launcher validation now require array order to be exactly `1..N`.
5. **Feedback could be submitted while a source switch was pending.** The Send feedback control is disabled during source changes and the callback independently guards against stale-source submission.
6. **Renderer failure could leave a successfully canceled handoff window alive.** Renderer-failure handling now destroys the window only after cancellation persistence succeeds, while preserving the window when persistence or repository identity is unavailable.
7. **Out-of-order repository reads could overwrite newer accepted state.** A per-window generation coordinator allows every requester to receive its result while only the newest request updates shared repository state, handoff identity, title, watcher, and remembered path.
8. **Plan and agent-review handoffs could be combined into an invalid lifecycle.** Source CLI, packaged shell helper, and Electron parsing reject mixed plan/review modes; plan result paths also require a plan file.
9. **Immediate launcher process exit could truncate large protocol output.** All four skill launchers now set `process.exitCode`, allowing Node to drain stdout naturally. Exact 256 KiB protocol-output tests cover every launcher.

## Self-Review Finding

The final diff review found an additional race in the packaged process-ID waiter: when `open -W` exited immediately before the primary owner file appeared, the waiter failed without allowing owner publication. Added a RED regression test and a bounded one-second post-forwarding grace period. A forwarding process that exits without publishing an owner still fails promptly with the existing missing-result diagnostic.

## Verification

- Focused launcher suite passed after the self-review fix: 114 tests.
- `PATH="/opt/homebrew/opt/node/bin:$PATH" ./node_modules/.bin/vp test` -> PASS: 104 files, 1,130 passed, 4 skipped.
- `PATH="/opt/homebrew/opt/node/bin:$PATH" ./node_modules/.bin/vp check --fix` -> PASS: formatting completed with no warnings, lint errors, or type errors in 201 files.
- `PATH="/opt/homebrew/opt/node/bin:$PATH" ./node_modules/.bin/vpr build` -> PASS: all seven build tasks completed; existing chunk-size and ineffective dynamic-import warnings were emitted.

## Review

- Direct line-by-line diff review found no remaining critical, important, or minor correctness issues after the packaged forwarding race fix.
- A dedicated reviewer subagent was unavailable in this session, so the required review was performed directly rather than independently.

## Concerns

- The GUI-only manual Send feedback exercise cannot be performed in this non-interactive environment. Automated launcher, lifecycle, repository-state, renderer, validation, and build coverage is used instead.

## Arbitrated Follow-up

### Status

DONE_WITH_CONCERNS

### Commit

- `a78edd6 Close agent review lifecycle races`

### Mapped Evidence

1. **Forwarding grace origin:** `waitForAgentReviewResult` now records when forwarding death is first observed and computes the owner deadline as the earlier of exit plus grace or the overall open deadline. Its clock and polling wait are injectable; the deterministic test advances forwarding death to 900 ms and owner/result publication to 1,500 ms.
2. **Stale owner publication:** delayed initial repository publication verifies that its handoff is still registered and has no newer accepted repository before writing the owner. The regression sets a new commit source before resolving the initial working-tree source, then verifies both owner and submitted result retain the new source.
3. **Repository TOCTOU:** `resolveRepository` re-checks the accepted repository immediately after awaiting the initial outcome and before using its value or error. The regression starts close, publishes a new source, resolves the stale source, and verifies the closed result uses the new source.
4. **Coordinator leak and ID reuse:** coordinator state is now an object token per window and `clear` removes it. A reused numeric web contents ID receives a new token, so the old request cannot become current when it resolves last.
5. **Post-destroy resurrection:** window close clears the coordinator before deleting window state. Repository acceptance also requires both the IPC sender and owning window to remain active; focused coordinator-boundary coverage verifies inactive requests return their local result without invoking shared-state acceptance.

### TDD Evidence

- `vp test core/__tests__/codiff-cli.test.ts -t "measures owner publication grace"` -> RED: startup-based timeout rejected before virtual owner publication; GREEN after exit-origin deadline tracking.
- `vp test electron/__tests__/agent-review-handoff.test.ts -t "delayed initial resolution"` -> RED: owner contained stale working-tree identity; GREEN after guarded initial publication.
- `vp test electron/__tests__/agent-review-handoff.test.ts -t "close prefers"` -> RED: closed result used stale working-tree identity; GREEN after the post-await repository re-check.
- `vp test electron/__tests__/repository-state-requests.test.ts -t "ID reuse"` -> RED: `clear` was absent; GREEN with per-window token invalidation.
- `vp test electron/__tests__/repository-state-requests.test.ts -t "sender becomes inactive"` -> RED: inactive request invoked acceptance; GREEN with the liveness predicate.

### Verification

- Focused suites: 3 files, 159 tests passed.
- Full `vp test`: 104 files, 1,134 passed, 4 skipped.
- `vp check --fix`: no warnings, lint errors, or type errors in 201 files.
- `vpr build`: all seven tasks passed with the existing chunk-size and ineffective dynamic-import warnings.

### Self-Review

- Confirmed owner grace starts exactly once at observed forwarding death and remains bounded by the original open timeout.
- Confirmed a live owner removes the open deadline, so launcher cleanup cannot remove an active primary handoff path.
- Confirmed initial handoff settlement cannot overwrite a newer owner and close/complete prefer a repository set across the await boundary.
- Confirmed clear plus token identity handles both memory cleanup and web contents ID reuse.
- Confirmed late repository reads can still resolve to their caller but cannot repopulate shared state after close or destruction.

### Concerns

- The GUI-only manual Send feedback exercise remains unavailable in this non-interactive environment; focused and full automated coverage passed.
