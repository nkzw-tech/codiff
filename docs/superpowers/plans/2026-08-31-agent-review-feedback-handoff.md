# Agent Review Feedback Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent-launched Codiff review return local inline comments to the blocked originating agent turn through a reliable result-file handoff.

**Architecture:** The renderer builds one ordered structured feedback snapshot and matching Markdown, then submits it over IPC. Electron validates the snapshot against the sender's resolved repository state, atomically writes a versioned result, and closes the handoff window. Each agent launcher supplies a unique result path, waits for Codiff, validates the result, and emits one `CODIFF_REVIEW_RESULT` record to its originating turn.

**Tech Stack:** TypeScript 7, React 19, Electron 44, Node.js ESM/CommonJS, shell terminal helper, Vite Plus/Vitest.

## Global Constraints

- Support Codex, Claude Code, OpenCode, and Pi in the first version.
- Show **Send feedback** only in agent-launched review windows with a blocking result path.
- Keep existing Copy Comments, inline Ask, and GitHub/GitLab submission behavior unchanged.
- A successful send closes Codiff; a failed send keeps the window open and preserves every comment.
- Closing Codiff without sending returns `status: "closed"` and no actionable feedback.
- Do not automatically reopen Codiff after the agent applies feedback.
- Use Phosphor icons for the new control.
- Run `vp check --fix` before the final `vpr build`.

---

### Task 1: Shared Feedback Contract And Formatter

**Files:**
- Modify: `core/types.ts:426-443,675-706`
- Modify: `core/lib/review-comments.ts:249-380`
- Test: `core/__tests__/review-comments.test.ts`

**Interfaces:**
- Produces: `AgentReviewFeedbackComment`, `AgentReviewFeedback`, and `AgentReviewResult` in `core/types.ts`.
- Produces: `buildAgentReviewFeedback(files, comments, showWhitespace, prefix): AgentReviewFeedbackContent` in `core/lib/review-comments.ts`.
- Preserves: `buildReviewCommentsMarkdown(...)` as a compatibility wrapper over the new builder.

- [ ] **Step 1: Write failing formatter tests**

Import `buildAgentReviewFeedback` and add focused fixtures proving that one ordered snapshot drives both representations:

```ts
test('buildAgentReviewFeedback returns ordered structured comments and matching markdown', () => {
  const files = [createChangedFile('src/a.ts'), createChangedFile('src/b.ts')];
  const comments = [
    createReviewComment({
      body: '  Second file.  ',
      filePath: 'src/b.ts',
      id: 'b',
      lineNumber: 9,
      sectionId: files[1]!.sections[0]!.id,
    }),
    createReviewComment({
      body: 'First range.',
      filePath: 'src/a.ts',
      id: 'a',
      lineNumber: 7,
      startLineNumber: 5,
      startSide: 'deletions',
    }),
    createReviewComment({ body: 'Remote.', id: 'remote', isReadOnly: true }),
  ];

  const feedback = buildAgentReviewFeedback(files, comments, false, '# Fix these');

  expect(feedback.comments.map(({ body, filePath, order }) => ({ body, filePath, order }))).toEqual([
    { body: 'First range.', filePath: 'src/a.ts', order: 1 },
    { body: 'Second file.', filePath: 'src/b.ts', order: 2 },
  ]);
  expect(feedback.comments[0]).toMatchObject({
    anchor: 'line',
    lineNumber: 7,
    startLineNumber: 5,
    startSide: 'deletions',
  });
  expect(feedback.markdown).toContain('# Fix these');
  expect(feedback.markdown.indexOf('src/a.ts')).toBeLessThan(feedback.markdown.indexOf('src/b.ts'));
  expect(feedback.markdown).toContain('First range.');
  expect(feedback.markdown).toContain('Second file.');
});

test('buildAgentReviewFeedback excludes empty and read-only comments', () => {
  const file = createChangedFile('src/a.ts');
  expect(
    buildAgentReviewFeedback(
      [file],
      [createReviewComment({ body: ' ' }), createReviewComment({ isReadOnly: true })],
      false,
      '',
    ),
  ).toEqual({ comments: [], markdown: '' });
});
```

- [ ] **Step 2: Run the formatter tests and confirm the new export is missing**

Run: `vp test core/__tests__/review-comments.test.ts`

Expected: FAIL because `buildAgentReviewFeedback` and the feedback types do not exist.

- [ ] **Step 3: Add the versioned shared types**

Add these exact public shapes to `core/types.ts`:

```ts
export type AgentReviewFeedbackComment = {
  anchor: 'file' | 'line';
  body: string;
  context: string;
  filePath: string;
  lineNumber?: number;
  order: number;
  sectionId: string;
  side?: 'additions' | 'deletions';
  startLineNumber?: number;
  startSide?: 'additions' | 'deletions';
};

export type AgentReviewFeedbackContent = {
  comments: ReadonlyArray<AgentReviewFeedbackComment>;
  markdown: string;
};

export type AgentReviewFeedback = AgentReviewFeedbackContent & {
  repository: { root: string; source: ReviewSource };
  version: 1;
};

export type AgentReviewResult =
  | (AgentReviewFeedback & { status: 'submitted' })
  | {
      comments: [];
      markdown: '';
      repository: { root: string; source: ReviewSource };
      status: 'closed';
      version: 1;
    };
```

- [ ] **Step 4: Extract a single structured/Markdown builder**

In `core/lib/review-comments.ts`, move the existing pending filter, file/line/id sort, and `getReviewCommentPatchContext` call into `buildAgentReviewFeedback`. Normalize `anchor` to `comment.anchor ?? 'line'`, trim each body, assign one-based `order`, and build Markdown from that exact array. Rewrite `buildReviewCommentsMarkdown` as:

```ts
export const buildReviewCommentsMarkdown = (
  files: ReadonlyArray<ChangedFile>,
  comments: ReadonlyArray<ReviewComment>,
  showWhitespace: boolean,
  prefix?: string,
) => buildAgentReviewFeedback(files, comments, showWhitespace, prefix).markdown;
```

- [ ] **Step 5: Run formatter and existing Markdown regression tests**

Run: `vp test core/__tests__/review-comments.test.ts core/__tests__/App.test.tsx`

Expected: PASS, including existing prefix, range, and diff-context assertions.

- [ ] **Step 6: Commit the contract and formatter**

```bash
git add core/types.ts core/lib/review-comments.ts core/__tests__/review-comments.test.ts
git commit -m "Add agent review feedback contract"
```

---

### Task 2: Result Path Propagation And Window Identity

**Files:**
- Modify: `bin/arguments.js:9-109,330-475`
- Modify: `bin/codiff.js:286-358`
- Modify: `bin/codiff-app:263-280,343-407,429-545,607-663`
- Modify: `electron/main/command-line.cjs:120-156,243-359`
- Modify: `electron/window-identity.cjs:179-209`
- Modify: `core/types.ts:426-443`
- Test: `electron/__tests__/command-line.test.ts`
- Test: `electron/__tests__/window-identity.test.ts`
- Test: `core/__tests__/codiff-cli.test.ts`

**Interfaces:**
- Consumes: `CodiffLaunchOptions` from Task 1's shared type file.
- Produces: hidden CLI option `--review-result-file <file>` and environment variable `CODIFF_REVIEW_RESULT_FILE`.
- Produces: `CodiffLaunchOptions.reviewResultFile?: string`.

- [ ] **Step 1: Write failing propagation and identity tests**

Add a command-line assertion:

```ts
test('parses agent review handoff command-line options', () => {
  expect(readCommandLine(['codiff', '--review-result-file', '/tmp/review.json', '/repo'])).toMatchObject({
    launchOptions: {
      repositoryPathProvided: true,
      reviewResultFile: '/tmp/review.json',
      walkthrough: false,
    },
    repositoryPath: '/repo',
  });
});
```

Add a window identity assertion proving two handoffs for the same working tree do not share a window:

```ts
expect(
  getWindowIdentity(directory.path, { reviewResultFile: '/tmp/review-a.json' })?.key,
).not.toBe(getWindowIdentity(directory.path, { reviewResultFile: '/tmp/review-b.json' })?.key);
```

Extend the packaged terminal-helper forwarding test to assert `--review-result-file` survives unchanged in the `open -n ... --args` list.

- [ ] **Step 2: Run the focused CLI tests and confirm they fail**

Run: `vp test electron/__tests__/command-line.test.ts electron/__tests__/window-identity.test.ts core/__tests__/codiff-cli.test.ts`

Expected: FAIL because the new option is unknown or omitted and handoff identities collide.

- [ ] **Step 3: Add the hidden option through every parser**

Add a hidden string definition in `bin/arguments.js`, parse it into an absolute `reviewResultFilePath`, pass it to `codiff.js`, and export it as `CODIFF_REVIEW_RESULT_FILE`. Add matching parsing to `electron/main/command-line.cjs` and `bin/codiff-app`. Do not include the option in generated help or usage examples.

Extend `CodiffLaunchOptions` with:

```ts
/** Result file used to resume the waiting agent review process. */
reviewResultFile?: string;
```

- [ ] **Step 4: Separate concurrent handoff windows**

In `getWindowIdentity`, append a real-path handoff suffix only when `reviewResultFile` exists:

```js
const handoffKey = launchOptions.reviewResultFile
  ? `\0review:${getRealPath(launchOptions.reviewResultFile)}`
  : '';
// Return key: `${repositoryRoot}\0${sourceKey}${handoffKey}`.
```

This keeps ordinary same-source window reuse unchanged while ensuring each blocked launcher owns one window.

- [ ] **Step 5: Run the propagation tests**

Run: `vp test electron/__tests__/command-line.test.ts electron/__tests__/window-identity.test.ts core/__tests__/codiff-cli.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit CLI propagation**

```bash
git add bin/arguments.js bin/codiff.js bin/codiff-app core/types.ts electron/main/command-line.cjs electron/window-identity.cjs electron/__tests__/command-line.test.ts electron/__tests__/window-identity.test.ts core/__tests__/codiff-cli.test.ts
git commit -m "Propagate agent review handoff paths"
```

---

### Task 3: Atomic Electron Handoff Lifecycle

**Files:**
- Create: `electron/agent-review-handoff.cjs`
- Create: `electron/__tests__/agent-review-handoff.test.ts`
- Modify: `electron/main.cjs:132-152,921-1067,1434-1541`
- Modify: `electron/preload.cjs:15-48`
- Modify: `core/global.d.ts:45-126`

**Interfaces:**
- Consumes: `AgentReviewFeedback` and `AgentReviewResult` from Task 1.
- Produces: `createAgentReviewHandoffController({ writeResult? })` with `complete`, `close`, `hasCompleted`, and `clear` methods.
- Produces: `window.codiff.completeAgentReview(feedback): Promise<void>`.

- [ ] **Step 1: Write failing controller tests**

Cover atomic output, first-result-wins, retry after a write error, and closed output:

```ts
test('writes one submitted terminal result atomically', async () => {
  await using directory = await createTemporaryDirectory('codiff-agent-review-');
  const resultPath = join(directory.path, 'result.json');
  const controller = createAgentReviewHandoffController();

  controller.complete(7, resultPath, feedback);
  controller.close(7, resultPath, feedback.repository);

  expect(JSON.parse(await readFile(resultPath, 'utf8'))).toEqual({
    ...feedback,
    status: 'submitted',
  });
});

test('allows retry when persistence fails', () => {
  const writeResult = vi.fn().mockImplementationOnce(() => {
    throw new Error('disk full');
  });
  const controller = createAgentReviewHandoffController({ writeResult });

  expect(() => controller.complete(7, '/tmp/result.json', feedback)).toThrow('disk full');
  expect(controller.hasCompleted(7)).toBe(false);
  expect(() => controller.complete(7, '/tmp/result.json', feedback)).not.toThrow();
});
```

- [ ] **Step 2: Run the controller test and confirm the module is missing**

Run: `vp test electron/__tests__/agent-review-handoff.test.ts`

Expected: FAIL because `electron/agent-review-handoff.cjs` does not exist.

- [ ] **Step 3: Implement the focused handoff controller**

`writeAgentReviewResult(path, result)` must write JSON plus a trailing newline to a sibling path containing `process.pid` and `randomUUID()`, then call `renameSync(tempPath, path)`. Remove the temp file on failure. `complete` validates version 1, non-empty comments, non-empty Markdown, and trimmed comment bodies before writing `{...feedback, status: 'submitted'}`. Add the web contents ID to the completed set only after the rename succeeds. `close` writes the exact closed shape once:

```js
{
  comments: [],
  markdown: '',
  repository,
  status: 'closed',
  version: 1,
}
```

- [ ] **Step 4: Wire IPC and lifecycle ownership in Electron**

Instantiate one controller in `electron/main.cjs`. Add `codiff:completeAgentReview` that:

1. Requires `windowLaunchOptions.get(event.sender.id)?.reviewResultFile`.
2. Awaits the resolved repository state for that sender.
3. Rejects unless `feedback.repository.root === state.root` and `feedback.repository.source` deeply equals `state.source`.
4. Calls `controller.complete(...)`.
5. Closes the sender's `BrowserWindow` only after success.

In the normal `close`, `render-process-gone`, and main-frame `did-fail-load` paths, call `controller.close(...)` when a review result path exists and no submitted result won. Use the stored resolved root/source; if repository loading failed before identity was available, allow the launcher to report a missing result rather than inventing identity. Call `controller.clear(webContentsId)` during `closed` cleanup.

- [ ] **Step 5: Expose typed preload IPC**

Add to `core/global.d.ts` and `electron/preload.cjs`:

```ts
completeAgentReview: (feedback: AgentReviewFeedback) => Promise<void>;
```

```js
completeAgentReview: (feedback) => ipcRenderer.invoke('codiff:completeAgentReview', feedback),
```

- [ ] **Step 6: Run handoff, command-line, and window lifecycle tests**

Run: `vp test electron/__tests__/agent-review-handoff.test.ts electron/__tests__/command-line.test.ts electron/__tests__/window-identity.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Electron handoff support**

```bash
git add electron/agent-review-handoff.cjs electron/__tests__/agent-review-handoff.test.ts electron/main.cjs electron/preload.cjs core/global.d.ts
git commit -m "Add atomic agent review handoff"
```

---

### Task 4: Renderer Submission And Send Feedback Control

**Files:**
- Modify: `core/app/hooks/useReviewCommentDrafts.ts:21-35,128-162`
- Modify: `core/app/hooks/useAppReviewComments.ts:25-263`
- Modify: `core/app/components/Panels.tsx:384-438`
- Modify: `core/App.tsx:265-285,1603-1607,1821-1829`
- Modify: `core/App.css:870-877,3801-4006`
- Test: `core/__tests__/app-review-comment-hooks.test.tsx`
- Test: `core/__tests__/CopyCommentsButton.test.tsx`
- Test: `core/__tests__/App-render.test.tsx`

**Interfaces:**
- Consumes: `buildAgentReviewFeedback` from Task 1 and `window.codiff.completeAgentReview` from Task 3.
- Produces: `flushActiveReviewCommentDraft(): ReadonlyArray<ReviewComment>` from `useReviewCommentDrafts` and `useAppReviewComments`.
- Produces: `pendingReviewCommentCount: number` from `useAppReviewComments`.
- Produces: `SendFeedbackButton({ count, onSend })` in `Panels.tsx`.

- [ ] **Step 1: Write failing synchronous draft-flush tests**

In `app-review-comment-hooks.test.tsx`, set one comment with an old body, call `updateActiveReviewCommentDraft` with new text, then assert:

```ts
const snapshot = getState().flushActiveReviewCommentDraft();
expect(snapshot[0]?.body).toBe('Focused feedback');
expect(getState().reviewCommentsRef.current[0]?.body).toBe('Focused feedback');
```

- [ ] **Step 2: Write failing button-state tests**

Extend `CopyCommentsButton.test.tsx` to render `SendFeedbackButton` and cover zero-count disabled state, count text, a deferred `onSend` showing `Sending...`, ignored duplicate clicks, and a rejected promise rendering `role="alert"` while re-enabling the button.

- [ ] **Step 3: Run renderer tests and confirm the new interfaces are missing**

Run: `vp test core/__tests__/app-review-comment-hooks.test.tsx core/__tests__/CopyCommentsButton.test.tsx core/__tests__/App-render.test.tsx`

Expected: FAIL because the flush function and `SendFeedbackButton` do not exist.

- [ ] **Step 4: Implement synchronous active-draft flushing**

Add a callback to `useReviewCommentDrafts` that merges `activeReviewCommentDraftRef.current` through `updateCommentBody`, assigns the returned array to `reviewCommentsRef.current`, calls `setComments(next)`, and returns `next`. Do not clear the active draft. Return and re-export it from `useAppReviewComments`.

In `useAppReviewComments`, derive `pendingReviewCommentCount` by filtering non-read-only comments and replacing the matching comment's stored body with `activeReviewCommentDraftState.body` (`"pending"` or `""`) before testing whether it is non-empty. This state already rerenders when focused editor content crosses the empty/non-empty boundary, so the count remains current without committing each keystroke.

- [ ] **Step 5: Implement the send button**

Add a sibling to `CopyCommentsButton` using a Phosphor `PaperPlaneTilt` icon. The component owns `sending` and `error` state, disables itself for `count === 0 || sending`, awaits `onSend`, and displays the exact labels `Send feedback` and `Sending...`. Render failures in a nearby `role="alert"` element without mutating comments.

- [ ] **Step 6: Wire the App submission callback**

When `launchOptions.reviewResultFile` is present, render `SendFeedbackButton` beside `CopyCommentsButton`. Its callback must:

```ts
const comments = flushActiveReviewCommentDraft();
const content = buildAgentReviewFeedback(
  stateRef.current!.files,
  comments,
  preferencesRef.current.showWhitespace,
  preferencesRef.current.reviewCommentsPrefix,
);
if (content.comments.length === 0) return;
await window.codiff.completeAgentReview({
  ...content,
  repository: {
    root: stateRef.current!.root,
    source: stateRef.current!.source,
  },
  version: 1,
});
```

Pass `pendingReviewCommentCount` to the button so a focused, unblurred non-empty comment enables the action. Hide the action entirely when the result path is absent.

- [ ] **Step 7: Add App-level visibility and payload tests**

In `App-render.test.tsx`, assert no send action for default launch options, visibility when `reviewResultFile` exists, an IPC payload containing an unblurred draft plus repository identity, and rejection leaving the comment editor mounted with its text intact.

- [ ] **Step 8: Run renderer and existing review regressions**

Run: `vp test core/__tests__/app-review-comment-hooks.test.tsx core/__tests__/CopyCommentsButton.test.tsx core/__tests__/App-render.test.tsx core/__tests__/ReviewCodeView-scroll.test.tsx core/__tests__/App.test.tsx`

Expected: PASS.

- [ ] **Step 9: Commit renderer submission UX**

```bash
git add core/app/hooks/useReviewCommentDrafts.ts core/app/hooks/useAppReviewComments.ts core/app/components/Panels.tsx core/App.tsx core/App.css core/__tests__/app-review-comment-hooks.test.tsx core/__tests__/CopyCommentsButton.test.tsx core/__tests__/App-render.test.tsx
git commit -m "Add send feedback review action"
```

---

### Task 5: Blocking Agent Launcher Results

**Files:**
- Create: `bin/agent-review-result.js`
- Modify: `codex/skills/codiff/scripts/open-codiff.mjs`
- Modify: `claude/skills/codiff/scripts/open-codiff.mjs`
- Modify: `opencode/skills/codiff/scripts/open-codiff.mjs`
- Modify: `pi/skills/codiff/scripts/open-codiff.mjs`
- Modify: `bin/codiff-app:607-663`
- Modify: `bin/codiff.js:296-358`
- Test: `core/__tests__/codiff-cli.test.ts`

**Interfaces:**
- Consumes: `--review-result-file` from Task 2 and the version 1 result written by Task 3.
- Produces: `createAgentReviewResultPath()`, `readAgentReviewResult(path, expectedRoot)`, and `formatAgentReviewResult(result)` from `bin/agent-review-result.js`.
- Produces: exactly one stdout line `CODIFF_REVIEW_RESULT <json>` for valid `submitted` or `closed` results.

- [ ] **Step 1: Write failing helper and launcher tests**

In `codiff-cli.test.ts`, add table-driven cases for all four launcher paths. The fake `codiff` command must capture the `--review-result-file` argument and write a valid submitted result to it before exiting. Assert each launcher forwards its existing backend/session arguments and emits:

```text
CODIFF_REVIEW_RESULT {"version":1,"status":"submitted","repository":{"root":"/repo","source":{"type":"working-tree"}},"comments":[{"anchor":"line","body":"Rename this helper.","context":"@@ -1 +1 @@","filePath":"src/app.ts","lineNumber":1,"order":1,"sectionId":"src/app.ts:unstaged","side":"additions"}],"markdown":"# Address these Review Comments\n"}
```

Add cases for `closed`, malformed JSON, version 2, a mismatched repository root, and no result file. Valid terminal results produce one result line; invalid results produce stderr and a non-zero exit.

- [ ] **Step 2: Run launcher tests and confirm no handoff is emitted**

Run: `vp test core/__tests__/codiff-cli.test.ts`

Expected: FAIL because launchers do not create, pass, read, or print review results.

- [ ] **Step 3: Implement the shared launcher result helper**

`createAgentReviewResultPath` creates `mkdtempSync(join(tmpdir(), 'codiff-review-result-'))` and returns `{ directory, path: join(directory, 'result.json') }`. `readAgentReviewResult` strictly checks `version === 1`, `status` in `submitted|closed`, exact root equality after `resolve`, empty feedback for `closed`, and non-empty comments/Markdown for `submitted`. The launcher scripts import this packaged helper from `../../../../bin/agent-review-result.js`; their installed skill directories are symlinks to the packaged source, so that relative path resolves in development and packaged apps. `formatAgentReviewResult` returns:

```js
`CODIFF_REVIEW_RESULT ${JSON.stringify(result)}\n`
```

Export a cleanup function using `rmSync(directory, { force: true, recursive: true })` so every launcher uses identical cleanup.

- [ ] **Step 4: Add the blocking desktop handoff to all launchers**

For desktop walkthrough mode only, each launcher creates a result path, appends `--review-result-file <path>` to its existing synchronous Codiff invocation, validates the file after Codiff returns, prints one formatted line, and cleans up in `finally`. Preserve each backend's current CWD/session discovery and leave plan/share modes unchanged.

- [ ] **Step 5: Make source and packaged CLIs wait when an explicit review path is supplied**

In `bin/codiff.js` and `bin/codiff-app`, mirror the existing plan waiter for the caller-supplied review result path. Do not create a second result path. Poll until the file contains a parseable `submitted` or `closed` result, or fail if the app process exits without one. Then return control to the agent launcher without printing a second `CODIFF_REVIEW_RESULT` line.

- [ ] **Step 6: Run all launcher and packaged helper tests**

Run: `vp test core/__tests__/codiff-cli.test.ts electron/__tests__/command-line.test.ts`

Expected: PASS for all four backends, malformed results, cancellation, and forwarding.

- [ ] **Step 7: Commit launcher support**

```bash
git add bin/agent-review-result.js bin/codiff.js bin/codiff-app codex/skills/codiff/scripts/open-codiff.mjs claude/skills/codiff/scripts/open-codiff.mjs opencode/skills/codiff/scripts/open-codiff.mjs pi/skills/codiff/scripts/open-codiff.mjs core/__tests__/codiff-cli.test.ts
git commit -m "Return Codiff feedback to agent launchers"
```

---

### Task 6: Agent Guidance, Documentation, And Full Verification

**Files:**
- Modify: `codex/skills/codiff/SKILL.md:79-139`
- Modify: `claude/skills/codiff/SKILL.md:79-139`
- Modify: `opencode/skills/codiff/SKILL.md:79-139`
- Modify: `pi/skills/codiff/SKILL.md:79-139`
- Modify: `bin/walkthrough-guide.md:8-15`
- Modify: `README.md:248-264`
- Test: `electron/__tests__/agent-skills.test.ts`
- Test: `core/__tests__/codiff-cli.test.ts`

**Interfaces:**
- Consumes: the `CODIFF_REVIEW_RESULT` contract from Task 5.
- Produces: identical backend-neutral processing instructions in all installed skills and updated `--walkthrough-guide` output.

- [ ] **Step 1: Add failing guidance assertions**

Extend `agent-skills.test.ts` and the walkthrough-guide test in `codiff-cli.test.ts` to require these concepts:

```ts
expect(document).toContain('CODIFF_REVIEW_RESULT');
expect(document).toContain('status: "submitted"');
expect(document).toContain('status: "closed"');
expect(document).toContain('Address every returned comment');
expect(document).toContain('Do not automatically reopen Codiff');
```

- [ ] **Step 2: Run guidance tests and confirm the instructions are absent**

Run: `vp test electron/__tests__/agent-skills.test.ts core/__tests__/codiff-cli.test.ts`

Expected: FAIL on the new content assertions.

- [ ] **Step 3: Update all four skill documents identically**

After the desktop launch command, instruct the agent to read one `CODIFF_REVIEW_RESULT` record. For `closed`, stop without feedback-driven edits. For `submitted`, validate repository/source identity, address every ordered comment, use anchors/context, ask one focused question for material ambiguity, summarize handled feedback, and decide whether another review is useful. State explicitly that reopening is not automatic.

Keep only the existing `**Agent integration:**` paragraph backend-specific so the parity test remains meaningful.

- [ ] **Step 4: Update live guide and README**

Add the same concise result semantics to `bin/walkthrough-guide.md` so user-land agents receive current behavior through `--walkthrough-guide`. Update the integration section in `README.md` to describe adding local comments and choosing **Send feedback** to resume the waiting agent.

- [ ] **Step 5: Run focused documentation and feature tests**

Run: `vp test electron/__tests__/agent-skills.test.ts core/__tests__/codiff-cli.test.ts electron/__tests__/agent-review-handoff.test.ts core/__tests__/app-review-comment-hooks.test.tsx core/__tests__/App-render.test.tsx`

Expected: PASS.

- [ ] **Step 6: Run repository validation and refresh built files**

Run: `vp check --fix`

Expected: all checks pass; inspect and include only formatter fixes related to this feature.

Run: `vpr build`

Expected: all packages and Electron renderer build successfully, refreshing local built files for manual testing.

- [ ] **Step 7: Manually exercise the OpenCode flow**

From an OpenCode session in a repository with a local diff, invoke `$codiff`, add an inline comment without first blurring the editor, and click **Send feedback**. Confirm Codiff closes, the same OpenCode turn receives one `CODIFF_REVIEW_RESULT`, and the comment contains the correct path, line/range, diff context, and text. Repeat by closing Codiff normally and confirm the agent makes no feedback-driven edit.

- [ ] **Step 8: Inspect the final diff and commit documentation/validation fixes**

```bash
git status --short
git diff --check
git diff
git add README.md bin/walkthrough-guide.md codex/skills/codiff/SKILL.md claude/skills/codiff/SKILL.md opencode/skills/codiff/SKILL.md pi/skills/codiff/SKILL.md electron/__tests__/agent-skills.test.ts core/__tests__/codiff-cli.test.ts
git commit -m "Document agent review feedback workflow"
```
