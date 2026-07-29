import {
  array,
  boolean,
  check,
  literal,
  maxLength,
  minLength,
  null_,
  number,
  optional,
  parse,
  picklist,
  pipe,
  record,
  regex,
  safeParse,
  strictObject,
  string,
  union,
  variant,
} from 'valibot';
import type {
  AssessmentCodeScope,
  AssessmentThreadAnchor,
  ChangedFile,
  DiffRange,
  NarrativeWalkthroughV4,
  WalkthroughArtifactV5,
  WalkthroughModel,
} from '../types.ts';

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
const regionSchema = pipe(
  strictObject({
    endLine: number(),
    hunkId: string(),
    id: string(),
    side: picklist(['additions', 'deletions']),
    startLine: number(),
    title: string(),
    tooltip: string(),
  }),
  check(
    (region) =>
      Number.isInteger(region.startLine) &&
      Number.isInteger(region.endLine) &&
      region.startLine > 0 &&
      region.endLine >= region.startLine,
    'Invalid region line range.',
  ),
);
const stopV5Schema = strictObject({
  ...hunkGroupFields,
  importance: picklist(['critical', 'normal', 'context']),
  prose: string(),
  regions: optional(array(regionSchema)),
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
const chapterV5Schema = strictObject({
  blurb: string(),
  icon: picklist(['bug', 'wrench', 'path', 'flask', 'beaker', 'doc', 'gear']),
  id: string(),
  stops: array(stopV5Schema),
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

const revisionLabelSchema = strictObject({
  kind: picklist(['bookmark', 'branch', 'commit', 'review-marker', 'tag', 'version']),
  text: string(),
  url: optional(string()),
});
const revisionCommonFields = {
  aliases: optional(array(revisionLabelSchema)),
  label: revisionLabelSchema,
};
const revisionSchema = union([
  strictObject({ ...revisionCommonFields, kind: optional(literal('commit')), sha: gitShaSchema }),
  strictObject({ ...revisionCommonFields, kind: literal('index') }),
  strictObject({ ...revisionCommonFields, kind: literal('working-copy') }),
]);
const diffRangeSchema = strictObject({ base: revisionSchema, head: revisionSchema });

const capturedSectionSchema = strictObject({
  binary: boolean(),
  id: string(),
  kind: picklist(['commit', 'pull-request', 'staged', 'unstaged']),
  loadState: optional(picklist(['binary', 'deferred', 'directory', 'error', 'ready', 'too-large'])),
  newFile: optional(strictObject({ contents: string(), name: string() })),
  oldFile: optional(strictObject({ contents: string(), name: string() })),
  patch: string(),
  range: optional(diffRangeSchema),
  summary: optional(
    strictObject({
      canLoad: optional(boolean()),
      fileCount: optional(number()),
      fingerprint: optional(string()),
      limit: optional(number()),
      reason: string(),
      size: optional(number()),
    }),
  ),
});
const capturedSourceSchema = union([
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
    description: optional(string()),
    headSha: optional(gitShaSchema),
    number: optional(number()),
    projectPath: optional(string()),
    provider: optional(picklist(['github', 'gitlab'])),
    targetBranch: optional(string()),
    title: optional(string()),
    type: literal('pull-request'),
    url: string(),
  }),
]);
const capturedContextSchema = strictObject({
  branch: union([string(), null_()]),
  files: array(
    strictObject({
      fingerprint: string(),
      generated: optional(boolean()),
      oldPath: optional(string()),
      path: string(),
      sections: array(capturedSectionSchema),
      status: picklist(['added', 'deleted', 'modified', 'renamed', 'untracked']),
    }),
  ),
  source: capturedSourceSchema,
});

const generationProfileSchema = strictObject({
  agent: picklist(['codex', 'claude', 'opencode', 'pi']),
  authoringVersion: string(),
  modelCandidates: pipe(array(string()), minLength(1)),
  settings: optional(record(string(), union([boolean(), number(), string()]))),
});
const generationMetadataSchema = strictObject({
  agent: picklist(['codex', 'claude', 'opencode', 'pi']),
  generatedAt: string(),
  model: string(),
  profile: generationProfileSchema,
});
const assessmentCodeScopeSchema = strictObject({ type: literal('single-diff') });
const assessmentThreadAnchorSchema = strictObject({
  filePath: string(),
  lineNumber: optional(number()),
  position: optional(strictObject({ range: diffRangeSchema })),
  side: optional(picklist(['additions', 'deletions'])),
  startLineNumber: optional(number()),
  startSide: optional(picklist(['additions', 'deletions'])),
});
const assessmentInputSchema = strictObject({
  codeScope: assessmentCodeScopeSchema,
  thread: strictObject({
    comments: pipe(
      array(
        strictObject({
          anchor: optional(assessmentThreadAnchorSchema),
          author: strictObject({ login: string(), name: optional(string()) }),
          body: string(),
          id: string(),
          submittedAt: optional(string()),
        }),
      ),
      minLength(1),
    ),
    id: string(),
  }),
});
const assessmentIdentitySchema = strictObject({
  codeScope: assessmentCodeScopeSchema,
  threadId: string(),
});
const assessmentResultSchema = strictObject({
  disposition: picklist([
    'addressed',
    'partially-addressed',
    'still-applies',
    'no-longer-applicable',
    'unclear',
  ]),
  explanation: pipe(string(), minLength(1), maxLength(2000)),
});
const assessmentOutcomeSchema = variant('status', [
  strictObject({
    generationMetadata: generationMetadataSchema,
    result: assessmentResultSchema,
    status: literal('ready'),
  }),
  strictObject({ error: pipe(string(), minLength(1), maxLength(500)), status: literal('failed') }),
]);
const assessmentComponentSchema = strictObject({
  capturedPresentationState: strictObject({ threadState: picklist(['open', 'resolved']) }),
  identity: assessmentIdentitySchema,
  input: assessmentInputSchema,
  outcome: assessmentOutcomeSchema,
});
const assessmentCollectionSchema = strictObject({ items: array(assessmentComponentSchema) });
const generationRequestSchema = strictObject({
  customInstructions: optional(string()),
  review: strictObject({ relation: literal('single-diff'), structure: literal('single-diff') }),
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

/** Strict single-call V5 envelope with captured inputs and generation provenance. */
export const walkthroughArtifactV5Schema = strictObject({
  assessments: optional(assessmentCollectionSchema),
  capturedContext: capturedContextSchema,
  generationRequest: generationRequestSchema,
  narrative: strictObject({
    ...narrativeFields,
    chapters: array(chapterV5Schema),
    generationMetadata: generationMetadataSchema,
    repo: strictObject({ branch: union([string(), null_()]) }),
    source: capturedSourceSchema,
    structure: literal('single-diff'),
  }),
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

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
};

const valuesEqual = (left: unknown, right: unknown) =>
  JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));

const assessmentScopeResolves = (artifact: WalkthroughArtifactV5, scope: AssessmentCodeScope) =>
  scope.type === 'single-diff' &&
  artifact.generationRequest.review.relation === 'single-diff' &&
  artifact.narrative.structure === 'single-diff';

const assessmentAnchorMatchesScope = (
  artifact: WalkthroughArtifactV5,
  anchor: AssessmentThreadAnchor,
) =>
  !anchor.position ||
  artifact.capturedContext.files.some(
    (file) =>
      (file.path === anchor.filePath || file.oldPath === anchor.filePath) &&
      file.sections.some(
        (section) => section.range != null && valuesEqual(section.range, anchor.position?.range),
      ),
  );

const validateAssessmentCollection = (artifact: WalkthroughArtifactV5) => {
  if (!artifact.assessments) {
    return artifact;
  }
  const paths = new Set(
    artifact.capturedContext.files.flatMap((file) =>
      file.oldPath ? [file.path, file.oldPath] : [file.path],
    ),
  );
  const identities = new Set<string>();
  for (const component of artifact.assessments.items) {
    if (
      component.identity.threadId !== component.input.thread.id ||
      !valuesEqual(component.identity.codeScope, component.input.codeScope)
    ) {
      throw new Error('Assessment identity does not match its authoritative input.');
    }
    if (!assessmentScopeResolves(artifact, component.identity.codeScope)) {
      throw new Error('Assessment code scope does not resolve against this artifact.');
    }
    const identity = JSON.stringify(stableValue(component.identity));
    if (identities.has(identity)) {
      throw new Error('Assessment identities must be unique.');
    }
    identities.add(identity);
    const commentIds = new Set<string>();
    for (const comment of component.input.thread.comments) {
      if (commentIds.has(comment.id)) {
        throw new Error('Assessment thread comment references must be unique.');
      }
      commentIds.add(comment.id);
      if (comment.anchor && !paths.has(comment.anchor.filePath)) {
        throw new Error('Assessment thread anchor references unknown captured code.');
      }
      if (comment.anchor && !assessmentAnchorMatchesScope(artifact, comment.anchor)) {
        throw new Error('Assessment thread anchor does not match the captured single diff.');
      }
    }
  }
  return artifact;
};

export const parseWalkthroughArtifactV5 = (value: unknown): WalkthroughArtifactV5 =>
  validateAssessmentCollection(parse(walkthroughArtifactV5Schema, value) as WalkthroughArtifactV5);

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

  const artifact = validateAssessmentCollection(persisted as WalkthroughArtifactV5);
  return {
    ...artifact.narrative,
    ...(artifact.assessments ? { assessments: artifact.assessments } : {}),
    capturedContext: artifact.capturedContext,
    generationRequest: artifact.generationRequest,
    repo: { branch: artifact.narrative.repo.branch, root: '' },
    sourceVersion: 5,
  };
};

/** Use the exact evidence a V5 narrative was authored against when it is available. */
export const resolveWalkthroughFiles = (
  walkthrough: WalkthroughModel | null,
  fallback: ReadonlyArray<ChangedFile>,
): ReadonlyArray<ChangedFile> =>
  walkthrough?.capturedContext?.files.length
    ? walkthrough.capturedContext.files.map((file) => ({
        ...file,
        sections: file.sections.map(({ range, ...section }) => ({
          ...section,
          ...(range ? { range: range as unknown as DiffRange } : {}),
        })),
      }))
    : fallback;
