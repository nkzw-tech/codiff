# Session-Routed Agent Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return Codiff feedback to the exact agent session that launched it, even when Codiff reviews another worktree or an unrelated repository.

**Architecture:** Separate recipient identity from review provenance. Resident bridge discovery and authentication use the backend plus exact session ID, while the delivery request and `AgentReviewFeedback.repository` retain the repository actually open in Codiff.

**Tech Stack:** Node.js, Electron, Unix-domain HTTP sockets, TypeScript/JSDoc, Vite Plus tests.

## Global Constraints

- Route only to the exact backend and session ID supplied by the launcher.
- Do not fall back to another session based on repository path, recency, or backend alone.
- Preserve private registry permissions, process-liveness checks, freshness checks, bearer-token authentication, nonce challenges, idempotency, and ambiguous-delivery handling.
- Preserve validation that feedback repository metadata matches the open Codiff window.
- Apply the shared resident-bridge behavior to OpenCode, Claude, and Pi; leave Codex queue routing unchanged.
- Run `vp check --fix` before the final `vpr build`.

---

### Task 1: Route Resident Bridges By Session

**Files:**

- Modify: `electron/__tests__/agent-feedback-bridge.test.ts`
- Modify: `electron/agent-feedback-bridge.cjs`
- Modify: `bin/agent-feedback-bridge.mjs`

**Interfaces:**

- Consumes: resident registrations containing `backend`, `repositoryRoot`, `sessionId`, socket endpoint, token, PID, and timestamp.
- Produces: bridge discovery by exact `backend + sessionId`; authenticated delivery may carry a different non-empty `repositoryRoot` describing the reviewed change.

- [ ] **Step 1: Add the failing cross-repository bridge test**

Add this test after `probe authenticates the exact resident identity without delivering` in `electron/__tests__/agent-feedback-bridge.test.ts`:

```ts
test('routes an authenticated delivery to the exact session across repository roots', async () => {
  const { deliver, registrationRoot } = await setup();
  const client = createAgentFeedbackBridgeClient({ registrationRoot });
  const crossRepositoryRequest = {
    ...request,
    feedback: {
      ...feedback,
      repository: { ...feedback.repository, root: '/review-repo' },
    },
    repositoryRoot: '/review-repo',
  };

  await expect(client.probeAgentFeedbackBridge(crossRepositoryRequest)).resolves.toEqual({
    available: true,
  });
  await expect(client.deliverToAgentFeedbackBridge(crossRepositoryRequest)).resolves.toMatchObject({
    deliveryId: 'delivery-1',
    status: 'accepted',
  });
  expect(deliver).toHaveBeenCalledWith(
    expect.objectContaining({
      repositoryRoot: '/review-repo',
      sessionId: 'session-1',
    }),
  );
});
```

Keep the existing identity-challenge repository-mismatch cases. The bridge must still prove the repository root recorded in its own registration; that diagnostic root simply stops selecting the feedback recipient.

- [ ] **Step 2: Run the focused test and verify the current root coupling fails**

Run:

```bash
vp test electron/__tests__/agent-feedback-bridge.test.ts
```

Expected: the new test fails because the client finds no registration for `/review-repo`, or because the bridge rejects delivery whose reviewed root differs from `/repo`.

- [ ] **Step 3: Remove repository root from candidate selection while preserving the authenticated challenge**

In `electron/agent-feedback-bridge.cjs`, change registration filtering to reject only a different session:

```js
if (registration.sessionId !== identity.sessionId) {
  continue;
}
```

When validating `/v1/identity`, compare the response repository root to the selected registration's own root rather than the reviewed root supplied by the caller:

```js
if (
  identityMatches(response, {
    backend: identity.backend,
    nonce,
    repositoryRoot: candidate.repositoryRoot,
    sessionId: identity.sessionId,
    version: PROTOCOL_VERSION,
  })
) {
  return candidate;
}
```

In `bin/agent-feedback-bridge.mjs`, replace the `/v1/deliver` identity condition with validation that the reviewed root is non-empty while session and protocol still match the registered bridge:

```js
if (
  typeof body.repositoryRoot !== 'string' ||
  !body.repositoryRoot.trim() ||
  body.sessionId !== sessionId ||
  body.version !== PROTOCOL_VERSION
) {
  sendJson(response, 409, { error: 'Delivery identity does not match this bridge.' });
  return;
}
```

Continue passing `body.repositoryRoot` to the bridge's `deliver` callback unchanged.

- [ ] **Step 4: Run bridge tests and verify security behavior remains green**

Run:

```bash
vp test electron/__tests__/agent-feedback-bridge.test.ts bin/__tests__/agent-feedback-bridge.test.ts
```

Expected: all tests pass, including stale registration, dead PID, permissions, wrong backend, wrong session, wrong token, wrong nonce, and repository challenge mismatch cases.

- [ ] **Step 5: Commit the bridge behavior**

```bash
git add bin/agent-feedback-bridge.mjs electron/agent-feedback-bridge.cjs electron/__tests__/agent-feedback-bridge.test.ts
git commit -m "Route agent feedback by exact session"
```

---

### Task 2: Make Probe Identity Session-Only

**Files:**

- Modify: `core/types.ts`
- Modify: `electron/agent-feedback-bridge.cjs`
- Modify: `electron/agent-feedback-adapters.cjs`
- Modify: `electron/agent-feedback-delivery.cjs`
- Modify: `electron/main.cjs`
- Modify: `electron/__tests__/agent-feedback-bridge.test.ts`
- Modify: `electron/__tests__/agent-feedback-adapters.test.ts`
- Modify: `electron/__tests__/agent-feedback-delivery.test.ts`

**Interfaces:**

- Consumes: `AgentFeedbackDeliveryRequest`, which still carries the reviewed `repositoryRoot` for delivery context.
- Produces: `AgentFeedbackSessionIdentity = { backend: AgentBackend; sessionId: string }` for recipient capability probes.

- [ ] **Step 1: Change probe expectations to omit repository context**

In `electron/__tests__/agent-feedback-delivery.test.ts`, update both probe expectations in the repository identity tests to contain only the recipient identity:

```ts
expect(probe).toHaveBeenLastCalledWith({
  backend: 'pi',
  sessionId: 'session-1',
});
```

```ts
expect(probe).toHaveBeenCalledWith({
  backend: 'claude',
  sessionId: 'session-1',
});
```

Keep the delivery expectation asserting `repositoryRoot: repository.root`; only preflight loses repository coupling.

- [ ] **Step 2: Run the controller test and verify the old probe shape fails**

Run:

```bash
vp test electron/__tests__/agent-feedback-delivery.test.ts
```

Expected: the two updated assertions fail because the probe still receives `repositoryRoot`.

- [ ] **Step 3: Add the explicit session identity type and update probe contracts**

Add this type after `AgentBackend` in `core/types.ts`:

```ts
export type AgentFeedbackSessionIdentity = {
  backend: AgentBackend;
  sessionId: string;
};
```

Update probe JSDoc/type declarations in `electron/agent-feedback-bridge.cjs`, `electron/agent-feedback-adapters.cjs`, `electron/agent-feedback-delivery.cjs`, and their tests to consume `AgentFeedbackSessionIdentity` rather than a pick containing `repositoryRoot`.

In both `prepare` and `deliver` in `electron/agent-feedback-delivery.cjs`, call the probe with only:

```js
const capability = await probe({
  backend: binding.backend,
  sessionId: binding.sessionId,
});
```

In `getWindowAgentActiveStatus` in `electron/main.cjs`, require only the session ID and probe with only recipient identity:

```js
if (!sessionId) {
  return false;
}
const result = await agentFeedbackAdapters.probe({ backend, sessionId });
```

Do not remove `repositoryRoot` from `AgentFeedbackDeliveryRequest`; delivery and feedback provenance still require it.

- [ ] **Step 4: Run recipient, adapter, and controller tests**

Run:

```bash
vp test electron/__tests__/agent-feedback-bridge.test.ts electron/__tests__/agent-feedback-adapters.test.ts electron/__tests__/agent-feedback-delivery.test.ts
```

Expected: all tests pass and TypeScript accepts the session-only probe contract.

- [ ] **Step 5: Commit the probe API cleanup**

```bash
git add core/types.ts electron/agent-feedback-bridge.cjs electron/agent-feedback-adapters.cjs electron/agent-feedback-delivery.cjs electron/main.cjs electron/__tests__/agent-feedback-bridge.test.ts electron/__tests__/agent-feedback-adapters.test.ts electron/__tests__/agent-feedback-delivery.test.ts
git commit -m "Separate feedback recipient from review repository"
```

---

### Task 3: Document Hands-Off Cross-Repository Delivery

**Files:**

- Modify: `electron/__tests__/agent-skills.test.ts`
- Modify: `codex/skills/codiff/SKILL.md`
- Modify: `claude/skills/codiff/SKILL.md`
- Modify: `opencode/skills/codiff/SKILL.md`
- Modify: `pi/skills/codiff/SKILL.md`

**Interfaces:**

- Consumes: the backend-specific `Agent integration` paragraphs used by the installed skills and walkthrough guide.
- Produces: consistent user-land guidance that an explicit review target does not change the feedback recipient.

- [ ] **Step 1: Add a failing guidance assertion**

In the document loop in `keeps asynchronous review instructions identical outside agent integration details`, add:

```ts
expect(normalizedDocument).toContain(
  'The reviewed repository may differ from the agent session directory; the exact launching session remains the feedback recipient.',
);
```

- [ ] **Step 2: Run the skill test and verify the sentence is absent**

Run:

```bash
vp test electron/__tests__/agent-skills.test.ts
```

Expected: the new guidance assertion fails for each skill document.

- [ ] **Step 3: Update each backend-specific integration paragraph**

Add this exact sentence to the `Agent integration` paragraph in all four skill files:

```md
The reviewed repository may differ from the agent session directory; the exact launching session remains the feedback recipient.
```

Also replace the OpenCode paragraph's claim that it links “the most recent OpenCode session for the current project” with an accurate statement that the launcher passes the current `OPENCODE_SESSION_ID` and routes feedback to that exact session.

- [ ] **Step 4: Run the skill tests**

Run:

```bash
vp test electron/__tests__/agent-skills.test.ts core/__tests__/codiff-cli.test.ts
```

Expected: all tests pass, including cross-agent instruction parity and launcher session-ID coverage.

- [ ] **Step 5: Commit the guidance**

```bash
git add codex/skills/codiff/SKILL.md claude/skills/codiff/SKILL.md opencode/skills/codiff/SKILL.md pi/skills/codiff/SKILL.md electron/__tests__/agent-skills.test.ts
git commit -m "Document session-routed review feedback"
```

---

### Task 4: Validate And Build

**Files:**

- Verify only; formatting may update files already modified by Tasks 1-3.

**Interfaces:**

- Consumes: all implementation and documentation changes from Tasks 1-3.
- Produces: validated source and refreshed build artifacts for local testing.

- [ ] **Step 1: Run automatic validation fixes**

```bash
vp check --fix
```

Expected: command exits successfully. Inspect any automatic edits and keep only changes related to this feature.

- [ ] **Step 2: Run the focused regression suite**

```bash
vp test electron/__tests__/agent-feedback-bridge.test.ts bin/__tests__/agent-feedback-bridge.test.ts electron/__tests__/agent-feedback-adapters.test.ts electron/__tests__/agent-feedback-delivery.test.ts electron/__tests__/agent-skills.test.ts core/__tests__/codiff-cli.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 3: Run the full test suite**

```bash
vp test
```

Expected: all tests pass, apart from tests explicitly marked skipped by the repository.

- [ ] **Step 4: Refresh built files**

```bash
vpr build
```

Expected: all workspace builds complete successfully.

- [ ] **Step 5: Inspect the final diff and commit formatter-only corrections if needed**

```bash
git status --short
```

Expected: no whitespace errors and no unrelated files staged or modified by this work. If `vp check --fix` changed feature files after their commits, stage only those files and commit them with:

```bash
git commit -m "Fix session routing validation"
```
