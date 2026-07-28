import {
  array,
  boolean,
  literal,
  null_,
  number,
  optional,
  parse,
  picklist,
  pipe,
  regex,
  safeParse,
  strictObject,
  string,
  union,
  variant,
} from 'valibot';
import type { NarrativeWalkthroughV4, WalkthroughArtifactV5, WalkthroughModel } from '../types.ts';

const gitShaSchema = pipe(string(), regex(/^(?:[\da-f]{40}|[\da-f]{64})$/i));

const reviewAuthorFields = {
  avatarUrl: optional(string()),
  login: string(),
  name: optional(string()),
  url: optional(string()),
};
const reviewActionStatusSchema = strictObject({
  disabled: optional(boolean()),
  reason: optional(string()),
});
const mergeStateSchema = strictObject({
  autoMergeEnabled: boolean(),
  canCancelAutoMerge: boolean(),
  canMerge: boolean(),
  canSetAutoMerge: boolean(),
  checks: array(
    strictObject({
      detail: optional(string()),
      label: string(),
      status: picklist(['failed', 'neutral', 'pending', 'success']),
      url: optional(string()),
    }),
  ),
  detailedStatus: optional(string()),
  forceRemoveSourceBranch: boolean(),
  mergeError: optional(string()),
  options: strictObject({ removeSourceBranch: boolean(), squash: boolean() }),
  reason: optional(string()),
  sha: string(),
  status: picklist(['blocked', 'checking', 'closed', 'merged', 'ready', 'waiting']),
  statusLabel: string(),
});

const resolvedSourceSchema = variant('type', [
  strictObject({ type: literal('working-tree') }),
  strictObject({ sha: gitShaSchema, type: literal('commit') }),
  strictObject({
    baseSha: gitShaSchema,
    headSha: gitShaSchema,
    ref: string(),
    type: literal('branch-diff'),
  }),
  strictObject({
    baseSha: gitShaSchema,
    headSha: gitShaSchema,
    ref: string(),
    type: literal('branch-working-tree'),
  }),
  strictObject({
    base: string(),
    head: string(),
    symmetric: boolean(),
    type: literal('range'),
  }),
  strictObject({
    author: optional(strictObject(reviewAuthorFields)),
    canEditDescription: optional(boolean()),
    canEditReviewers: optional(boolean()),
    canEditTitle: optional(boolean()),
    description: optional(string()),
    headSha: optional(string()),
    host: optional(string()),
    mergeState: optional(mergeStateSchema),
    number: optional(number()),
    owner: optional(string()),
    projectPath: optional(string()),
    provider: optional(picklist(['github', 'gitlab'])),
    repo: optional(string()),
    reviewers: optional(
      array(strictObject({ ...reviewAuthorFields, approved: boolean(), id: string() })),
    ),
    reviewStatus: optional(
      strictObject({
        approve: optional(reviewActionStatusSchema),
        close: optional(reviewActionStatusSchema),
        comment: optional(reviewActionStatusSchema),
        requestChanges: optional(reviewActionStatusSchema),
      }),
    ),
    title: optional(string()),
    type: literal('pull-request'),
    url: string(),
  }),
]);

const anchorSchema = strictObject({
  display: string(),
  endLine: optional(number()),
  sectionId: optional(string()),
  sectionKind: optional(picklist(['commit', 'pull-request', 'staged', 'unstaged'])),
  side: optional(picklist(['additions', 'deletions', 'both'])),
  startLine: optional(number()),
});
const hunkSchema = strictObject({
  added: number(),
  additionEnd: optional(number()),
  additionStart: optional(number()),
  anchor: anchorSchema,
  deleted: number(),
  deletionEnd: optional(number()),
  deletionStart: optional(number()),
  id: string(),
  kind: optional(picklist(['patch', 'synthetic'])),
  oldPath: optional(string()),
  path: string(),
  status: picklist(['added', 'deleted', 'modified', 'renamed', 'untracked']),
});
const noteSchema = strictObject({ body: string(), hunkId: string() });
const hunkGroupFields = {
  added: number(),
  changeType: optional(
    picklist([
      'fix',
      'feature',
      'refactor',
      'test',
      'generated',
      'lockfile',
      'snapshot',
      'i18n',
      'docs',
    ]),
  ),
  commitNote: optional(string()),
  deleted: number(),
  hunkIds: array(string()),
  hunks: array(hunkSchema),
  id: string(),
  notes: optional(array(noteSchema)),
  summary: optional(string()),
  title: optional(string()),
};
const stopSchema = strictObject({
  ...hunkGroupFields,
  importance: picklist(['critical', 'normal', 'context']),
  prose: string(),
});
const supportSchema = strictObject({
  ...hunkGroupFields,
  note: optional(string()),
  reason: string(),
});
const chapterSchema = strictObject({
  blurb: string(),
  icon: picklist(['bug', 'wrench', 'path', 'flask', 'beaker', 'doc', 'gear']),
  id: string(),
  stops: array(stopSchema),
  title: string(),
});
const commitSchema = strictObject({ body: optional(string()), title: optional(string()) });
const contextSchema = strictObject({
  changedFiles: optional(
    array(strictObject({ path: string(), rationale: optional(string()), role: string() })),
  ),
  constraints: optional(array(string())),
  decisions: optional(array(string())),
  implementationSummary: optional(string()),
  messages: optional(
    array(strictObject({ role: picklist(['assistant', 'user']), text: string() })),
  ),
  objective: optional(string()),
  risks: optional(array(string())),
  source: strictObject({
    generatedAt: string(),
    threadId: optional(string()),
    type: picklist([
      'codex-session',
      'codex-session-excerpt',
      'claude-session',
      'claude-session-excerpt',
      'opencode-session',
      'opencode-session-excerpt',
      'pi-session',
      'pi-session-excerpt',
    ]),
  }),
  validation: optional(array(string())),
  version: literal(1),
});

/** Exact released V4 persisted fields. Keep this object and its schema frozen. */
const narrativeFields = {
  agent: picklist(['codex', 'claude', 'opencode', 'pi']),
  chapters: array(chapterSchema),
  commit: optional(commitSchema),
  context: optional(contextSchema),
  focus: string(),
  generatedAt: string(),
  kind: literal('narrative'),
  meta: optional(string()),
  repo: strictObject({ branch: union([string(), null_()]), root: string() }),
  source: resolvedSourceSchema,
  support: array(supportSchema),
  title: string(),
};

/** Strict parser schema for the immutable v1.9.1 V4 persistence contract. */
export const narrativeWalkthroughV4Schema = strictObject({
  ...narrativeFields,
  version: literal(4),
});

/**
 * Strict initial V5 envelope. Later revisions populate the two empty input
 * capability positions while keeping narrative and independently replaceable
 * artifact state separate.
 */
export const walkthroughArtifactV5Schema = strictObject({
  capturedContext: strictObject({}),
  generationRequest: strictObject({}),
  narrative: strictObject(narrativeFields),
  version: literal(5),
});

const persistedWalkthroughSchema = variant('version', [
  narrativeWalkthroughV4Schema,
  walkthroughArtifactV5Schema,
]);

export const parseNarrativeWalkthroughV4 = (value: unknown): NarrativeWalkthroughV4 =>
  parse(narrativeWalkthroughV4Schema, value) as NarrativeWalkthroughV4;

export const safeParseNarrativeWalkthroughV4 = (value: unknown) =>
  safeParse(narrativeWalkthroughV4Schema, value);

export const parseWalkthroughArtifactV5 = (value: unknown): WalkthroughArtifactV5 =>
  parse(walkthroughArtifactV5Schema, value) as WalkthroughArtifactV5;

const modelFromV4 = (walkthrough: NarrativeWalkthroughV4): WalkthroughModel => {
  const { version: _version, ...narrative } = walkthrough;
  return { ...narrative, sourceVersion: 4 };
};

/**
 * Adapt trusted in-process V4 output for display only. This is deliberately
 * one-way: no runtime-model-to-V4 serializer or V4 relabeling path exists.
 */
export const walkthroughModelFromV4 = (walkthrough: NarrativeWalkthroughV4): WalkthroughModel =>
  modelFromV4(walkthrough);

/**
 * Core's sole trust boundary for unknown persisted walkthrough JSON. It
 * strictly validates V4 or V5 and returns the non-persisted immutable model
 * consumed by rendering and navigation APIs.
 */
export const parseWalkthroughModel = (value: unknown): WalkthroughModel => {
  const persisted = parse(persistedWalkthroughSchema, value);
  if (persisted.version === 4) {
    return modelFromV4(persisted as NarrativeWalkthroughV4);
  }

  const artifact = persisted as WalkthroughArtifactV5;
  return {
    ...artifact.narrative,
    capturedContext: artifact.capturedContext,
    generationRequest: artifact.generationRequest,
    sourceVersion: 5,
  };
};
