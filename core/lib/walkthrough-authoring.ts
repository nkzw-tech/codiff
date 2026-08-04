/**
 * Deterministic walkthrough authoring: draft parsing, hunk indexing, prompt
 * construction, V5 normalization, and captured-input projection.
 *
 * Hosts own model IDs, retries, and cache policy. This module owns shared
 * authoring semantics used by local Codiff and Codiff Web.
 */
import {
  array,
  boolean,
  check,
  type InferOutput,
  literal,
  looseObject,
  maxLength,
  minLength,
  null_,
  number,
  object,
  optional,
  parse,
  picklist,
  pipe,
  safeParse,
  string,
  strictObject,
  union,
} from 'valibot';
import type {
  ChangedFile,
  DiffSection,
  EvolutionUnitId,
  GenerationMetadata,
  GenerationProfile,
  GitSha,
  RepositoryState,
  ResolvedReviewSource,
  ReviewSource,
  TreeInspectionScope,
  WalkthroughArtifactV5,
  WalkthroughCapturedContext,
  WalkthroughGenerationRequest,
  WalkthroughHunk,
  WalkthroughNarrativeContentV5,
  WalkthroughNarrativeV5,
  WalkthroughRegion,
} from '../types.ts';
import {
  getSectionWalkthroughHunks,
  isGeneratedWalkthroughPath,
} from './narrative-walkthrough-diff.js';
import type { TargetComparisonReviewClassification } from './review-strategy.ts';

export const maxProseChars = 4000;
export const maxPatchExcerpt = 2500;
export const maxTotalPatchExcerpt = 60_000;
export const maxLargePatchExcerpt = 700;
export const maxLargeTotalPatchExcerpt = 35_000;
export const maxWalkthroughChapters = 20;
export const maxWalkthroughStops = 14;
export const maxHunksPerGroup = 14;
/** Changes only when prompt projection, response schema, or normalization semantics change. */
export const walkthroughAuthoringVersion = 'walkthrough-v5-narrative-2';

/** Build the safe requested profile that participates in component reuse. */
export const createWalkthroughGenerationProfile = (
  input: Omit<GenerationProfile, 'authoringVersion'>,
): GenerationProfile => {
  if (input.modelCandidates.length === 0) {
    throw new Error('A generation profile requires at least one model candidate.');
  }
  return { ...input, authoringVersion: walkthroughAuthoringVersion };
};

const boundedString = (maximum: number) => pipe(string(), maxLength(maximum));
const nonEmptyString = (maximum: number) => pipe(string(), minLength(1), maxLength(maximum));
const positiveInt = pipe(
  number(),
  check((value) => Number.isInteger(value) && value > 0, 'Expected a positive integer.'),
);
const noteSchema = object({
  body: nonEmptyString(500),
  hunkId: nonEmptyString(200),
});

const diffSectionSchema = looseObject({
  binary: boolean(),
  id: nonEmptyString(500),
  kind: picklist(['commit', 'pull-request', 'staged', 'unstaged']),
  patch: string(),
});

const changedFileSchema = looseObject({
  fingerprint: nonEmptyString(256),
  oldPath: optional(string()),
  path: nonEmptyString(4096),
  sections: array(diffSectionSchema),
  status: picklist(['added', 'deleted', 'modified', 'renamed', 'untracked']),
});

const pullRequestSourceSchema = looseObject({
  type: literal('pull-request'),
  url: nonEmptyString(2048),
});

const genericSourceSchema = looseObject({
  type: picklist([
    'working-tree',
    'commit',
    'branch',
    'branch-diff',
    'branch-working-tree',
    'range',
    'pull-request',
  ]),
});

export const repositoryStateSchema = looseObject({
  branch: union([string(), null_()]),
  files: array(changedFileSchema),
  generatedAt: number(),
  launchPath: string(),
  root: string(),
  source: union([pullRequestSourceSchema, genericSourceSchema]),
});

const changeTypeSchema = picklist([
  'fix',
  'feature',
  'refactor',
  'test',
  'generated',
  'lockfile',
  'snapshot',
  'i18n',
  'docs',
]);

const groupFields = {
  changeType: optional(changeTypeSchema),
  commitNote: optional(boundedString(1000)),
  hunkIds: pipe(array(nonEmptyString(200)), minLength(1), maxLength(maxHunksPerGroup)),
  id: nonEmptyString(100),
  notes: optional(pipe(array(noteSchema), maxLength(maxHunksPerGroup))),
  summary: optional(boundedString(1000)),
  title: optional(boundedString(200)),
};

const regionSchema = pipe(
  strictObject({
    endLine: positiveInt,
    hunkId: nonEmptyString(200),
    id: nonEmptyString(100),
    side: picklist(['additions', 'deletions']),
    startLine: positiveInt,
    title: nonEmptyString(120),
    tooltip: nonEmptyString(600),
  }),
  check((region) => region.endLine >= region.startLine, 'Invalid region line range.'),
);

const stopSchema = object({
  ...groupFields,
  importance: picklist(['critical', 'normal', 'context']),
  prose: nonEmptyString(4000),
  regions: optional(pipe(array(regionSchema), maxLength(4))),
});

const supportSchema = object({
  ...groupFields,
  note: optional(boundedString(2000)),
  reason: nonEmptyString(200),
});

export const walkthroughDraftSchema = object({
  chapters: pipe(
    array(
      object({
        blurb: boundedString(1000),
        icon: picklist(['bug', 'wrench', 'path', 'flask', 'beaker', 'doc', 'gear']),
        id: nonEmptyString(100),
        stops: pipe(array(stopSchema), maxLength(maxWalkthroughStops)),
        title: nonEmptyString(16),
      }),
    ),
    minLength(1),
    maxLength(maxWalkthroughChapters),
  ),
  focus: nonEmptyString(2000),
  kind: literal('narrative'),
  support: optional(pipe(array(supportSchema), maxLength(30))),
  title: nonEmptyString(200),
});

export type WalkthroughDraft = InferOutput<typeof walkthroughDraftSchema>;

/** @deprecated Prefer WalkthroughDraft. */
export type AuthoredWalkthrough = WalkthroughDraft;

const nullableGroupFields = {
  changeType: optional(union([changeTypeSchema, null_()])),
  commitNote: optional(union([boundedString(1000), null_()])),
  hunkIds: groupFields.hunkIds,
  id: groupFields.id,
  notes: optional(union([pipe(array(noteSchema), maxLength(maxHunksPerGroup)), null_()])),
  summary: optional(union([boundedString(1000), null_()])),
  title: optional(union([boundedString(200), null_()])),
};

const legacyWalkthroughDraftSchema = object({
  chapters: pipe(
    array(
      object({
        blurb: boundedString(1000),
        icon: picklist(['bug', 'wrench', 'path', 'flask', 'beaker', 'doc', 'gear']),
        id: nonEmptyString(100),
        stops: pipe(
          array(
            object({
              ...nullableGroupFields,
              importance: picklist(['critical', 'normal', 'context']),
              prose: nonEmptyString(4000),
            }),
          ),
          maxLength(maxWalkthroughStops),
        ),
        title: nonEmptyString(16),
      }),
    ),
    minLength(1),
    maxLength(maxWalkthroughChapters),
  ),
  focus: nonEmptyString(2000),
  kind: literal('narrative'),
  support: optional(
    union([
      pipe(
        array(
          object({
            ...nullableGroupFields,
            note: optional(union([boundedString(2000), null_()])),
            reason: nonEmptyString(200),
          }),
        ),
        maxLength(30),
      ),
      null_(),
    ]),
  ),
  title: nonEmptyString(200),
});

const compactWalkthroughDraftSchema = strictObject({
  chapters: pipe(
    array(
      object({
        blurb: boundedString(1000),
        icon: picklist(['bug', 'wrench', 'path', 'flask', 'beaker', 'doc', 'gear']),
        id: nonEmptyString(100),
        stops: pipe(
          array(
            object({
              hunkIds: groupFields.hunkIds,
              id: groupFields.id,
              importance: picklist(['critical', 'normal', 'context']),
              prose: nonEmptyString(4000),
              regions: optional(pipe(array(regionSchema), maxLength(4))),
              title: nonEmptyString(80),
            }),
          ),
          maxLength(maxWalkthroughStops),
        ),
        title: nonEmptyString(16),
      }),
    ),
    minLength(1),
    maxLength(maxWalkthroughChapters),
  ),
  focus: nonEmptyString(2000),
  kind: literal('narrative'),
  title: nonEmptyString(200),
});

/** Strict versionless model-response schema; persistence versioning stays on the V5 envelope. */
export const walkthroughDraftAgentOutputSchema = compactWalkthroughDraftSchema;

const compactNullableGroup = (group: {
  changeType?: string | null;
  commitNote?: string | null;
  hunkIds: ReadonlyArray<string>;
  id: string;
  notes?: ReadonlyArray<{ body: string; hunkId: string }> | null;
  summary?: string | null;
  title?: string | null;
}) => ({
  ...(group.changeType
    ? {
        changeType: group.changeType as NonNullable<
          WalkthroughDraft['chapters'][number]['stops'][number]['changeType']
        >,
      }
    : {}),
  ...(group.commitNote ? { commitNote: group.commitNote } : {}),
  hunkIds: [...group.hunkIds],
  id: group.id,
  ...(group.notes ? { notes: [...group.notes] } : {}),
  ...(group.summary ? { summary: group.summary } : {}),
  ...(group.title ? { title: group.title } : {}),
});

export const parseWalkthroughDraft = (value: unknown): WalkthroughDraft => {
  const authored = safeParse(walkthroughDraftSchema, value);
  if (authored.success) {
    return authored.output;
  }

  const legacyOutput = safeParse(legacyWalkthroughDraftSchema, value);
  if (legacyOutput.success) {
    return {
      chapters: legacyOutput.output.chapters.map((chapter) => ({
        blurb: chapter.blurb,
        icon: chapter.icon,
        id: chapter.id,
        stops: chapter.stops.map((stop) => ({
          ...compactNullableGroup(stop),
          importance: stop.importance,
          prose: stop.prose,
        })),
        title: chapter.title,
      })),
      focus: legacyOutput.output.focus,
      kind: legacyOutput.output.kind,
      ...(Array.isArray(legacyOutput.output.support)
        ? {
            support: legacyOutput.output.support.map((item) => ({
              ...compactNullableGroup(item),
              ...(item.note ? { note: item.note } : {}),
              reason: item.reason,
            })),
          }
        : {}),
      title: legacyOutput.output.title,
    };
  }

  const output = parse(compactWalkthroughDraftSchema, value);
  return {
    chapters: output.chapters.map((chapter) => ({
      blurb: chapter.blurb,
      icon: chapter.icon,
      id: chapter.id,
      stops: chapter.stops.map((stop) => ({
        hunkIds: [...stop.hunkIds],
        id: stop.id,
        importance: stop.importance,
        prose: stop.prose,
        ...(stop.regions ? { regions: stop.regions } : {}),
        title: stop.title,
      })),
      title: chapter.title,
    })),
    focus: output.focus,
    kind: output.kind,
    title: output.title,
  };
};

/** @deprecated Prefer parseWalkthroughDraft. */
export const parseAuthoredWalkthrough = parseWalkthroughDraft;

export const parseRepositoryState = (value: unknown): RepositoryState =>
  parse(repositoryStateSchema, value) as RepositoryState;

export type WalkthroughReviewStrategy = TargetComparisonReviewClassification;

type IndexedHunk = WalkthroughHunk & {
  sectionId: string;
  sectionKind: 'pull-request';
};

const toWalkthroughHunk = ({
  sectionId: _sectionId,
  sectionKind: _sectionKind,
  ...hunk
}: IndexedHunk): WalkthroughHunk => hunk;

type SectionWalkthroughHunk = ReturnType<typeof getSectionWalkthroughHunks>[number];

const defaultSideForStatus = (status: ChangedFile['status']) =>
  status === 'added' || status === 'untracked'
    ? ('additions' as const)
    : status === 'deleted'
      ? ('deletions' as const)
      : ('both' as const);

const createIndexedHunk = (
  file: ChangedFile,
  section: DiffSection,
  hunk: SectionWalkthroughHunk,
): IndexedHunk => {
  const patchHunk = 'additionStart' in hunk ? hunk : null;
  const startLine = patchHunk
    ? patchHunk.added > 0
      ? patchHunk.additionStart
      : patchHunk.deletionStart
    : undefined;
  const endLine = patchHunk
    ? patchHunk.added > 0
      ? patchHunk.additionEnd
      : patchHunk.deletionEnd
    : undefined;
  const display =
    startLine == null
      ? file.path
      : startLine === endLine
        ? `${file.path}:${startLine}`
        : `${file.path}:${startLine}-${endLine}`;

  return {
    added: hunk.added,
    ...(patchHunk ? { additionEnd: patchHunk.additionEnd } : {}),
    ...(patchHunk ? { additionStart: patchHunk.additionStart } : {}),
    anchor: {
      display,
      ...(endLine != null ? { endLine } : {}),
      sectionId: section.id,
      sectionKind: section.kind,
      side: defaultSideForStatus(file.status),
      ...(startLine != null ? { startLine } : {}),
    },
    deleted: hunk.deleted,
    ...(patchHunk ? { deletionEnd: patchHunk.deletionEnd } : {}),
    ...(patchHunk ? { deletionStart: patchHunk.deletionStart } : {}),
    id: hunk.id,
    kind: patchHunk ? 'patch' : 'synthetic',
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    path: file.path,
    sectionId: section.id,
    sectionKind: 'pull-request',
    status: file.status,
  };
};

const indexFileHunks = (file: ChangedFile): Array<IndexedHunk> =>
  file.sections.flatMap((section) =>
    getSectionWalkthroughHunks(file, section).map((hunk) => createIndexedHunk(file, section, hunk)),
  );

export const indexWalkthroughHunks = (files: ReadonlyArray<ChangedFile>) => {
  const hunks = files.flatMap(indexFileHunks);
  const byId = new Map<string, IndexedHunk>();
  const aliasByHunkId = new Map<string, string>();
  const hunkIdByAlias = new Map<string, string>();
  hunks.forEach((hunk, index) => {
    const alias = `h${index + 1}`;
    byId.set(hunk.id, hunk);
    byId.set(alias, hunk);
    aliasByHunkId.set(hunk.id, alias);
    hunkIdByAlias.set(alias, hunk.id);
  });
  return {
    aliasByHunkId,
    byId,
    hunkIdByAlias,
    hunks,
  };
};

const lineCounts = (hunks: ReadonlyArray<IndexedHunk>) =>
  hunks.reduce(
    (total, hunk) => ({
      added: total.added + hunk.added,
      deleted: total.deleted + hunk.deleted,
    }),
    { added: 0, deleted: 0 },
  );

const clean = (value: string, fallback = '') => value.trim() || fallback;

export const normalizeWalkthroughDraft = (
  value: unknown,
  state: RepositoryState,
  generationMetadata: GenerationMetadata,
): WalkthroughNarrativeContentV5 => {
  const authored = parseWalkthroughDraft(value);
  const index = indexWalkthroughHunks(state.files);
  const used = new Set<string>();
  const itemIds = new Set<string>();
  const usedRegionIds = new Set<string>();

  const resolveGroup = (
    group:
      | WalkthroughDraft['chapters'][number]['stops'][number]
      | NonNullable<WalkthroughDraft['support']>[number],
  ) => {
    if (itemIds.has(group.id)) {
      return null;
    }
    const groupHunkIds = new Set<string>();
    const hunks = group.hunkIds.flatMap((id) => {
      const hunk = index.byId.get(id);
      if (!hunk || used.has(hunk.id) || groupHunkIds.has(hunk.id)) {
        return [];
      }
      groupHunkIds.add(hunk.id);
      return [hunk];
    });
    if (hunks.length === 0) {
      return null;
    }
    hunks.forEach((hunk) => used.add(hunk.id));
    itemIds.add(group.id);
    const counts = lineCounts(hunks);
    const hunkIds = hunks.map((hunk) => hunk.id);
    const walkthroughHunks = hunks.map(toWalkthroughHunk);
    return {
      ...counts,
      ...(group.changeType
        ? {
            changeType: group.changeType as NonNullable<
              WalkthroughDraft['chapters'][number]['stops'][number]['changeType']
            >,
          }
        : {}),
      ...(group.commitNote ? { commitNote: clean(group.commitNote) } : {}),
      hunkIds,
      hunks: walkthroughHunks,
      id: group.id,
      ...(group.notes
        ? {
            notes: group.notes
              .map((note) => ({
                ...note,
                hunkId: index.byId.get(note.hunkId)?.id ?? note.hunkId,
              }))
              .filter(
                (note, noteIndex, notes) =>
                  hunkIds.includes(note.hunkId) &&
                  notes.findIndex((candidate) => candidate.hunkId === note.hunkId) === noteIndex,
              ),
          }
        : {}),
      ...(group.summary ? { summary: clean(group.summary) } : {}),
      ...(group.title ? { title: clean(group.title) } : {}),
    };
  };

  const resolveRegions = (
    regions: ReadonlyArray<WalkthroughRegion> | undefined,
    prose: string,
    hunkIds: ReadonlyArray<string>,
  ): ReadonlyArray<WalkthroughRegion> =>
    (regions ?? []).flatMap((region) => {
      const hunk = index.byId.get(region.hunkId);
      const escapedRegionId = region.id.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
      const hasReference = new RegExp(`\\[[^\\]\\n]+\\]\\(#${escapedRegionId}\\)`).test(prose);
      const sideRange =
        region.side === 'additions'
          ? [hunk?.additionStart, hunk?.additionEnd]
          : [hunk?.deletionStart, hunk?.deletionEnd];
      const tooltipHasUnsupportedMarkdown =
        /\[[^\]]*\]\([^)]*\)|(^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s)/m.test(region.tooltip);
      if (
        !hunk ||
        !hunkIds.includes(hunk.id) ||
        !hasReference ||
        usedRegionIds.has(region.id) ||
        sideRange[0] == null ||
        sideRange[1] == null ||
        region.startLine < sideRange[0] ||
        region.endLine > sideRange[1] ||
        tooltipHasUnsupportedMarkdown
      ) {
        return [];
      }
      usedRegionIds.add(region.id);
      return [{ ...region, hunkId: hunk.id }];
    });

  const chapters = authored.chapters.flatMap((chapter) => {
    const stops = chapter.stops.flatMap((stop) => {
      const group = resolveGroup(stop);
      const regions = group ? resolveRegions(stop.regions, stop.prose, group.hunkIds) : [];
      return group
        ? [
            {
              ...group,
              importance: stop.importance,
              prose: clean(stop.prose),
              ...(regions.length > 0 ? { regions } : {}),
            },
          ]
        : [];
    });
    return stops.length > 0
      ? [
          {
            blurb: clean(chapter.blurb),
            icon: chapter.icon,
            id: chapter.id,
            stops,
            title: clean(chapter.title, 'Review'),
          },
        ]
      : [];
  });
  if (chapters.length === 0) {
    throw new Error('The generated walkthrough did not reference any current diff hunks.');
  }

  const support = (authored.support ?? []).flatMap((item) => {
    const group = resolveGroup(item);
    return group
      ? [
          {
            ...group,
            ...(item.note ? { note: clean(item.note) } : {}),
            reason: clean(item.reason, 'Other changes'),
          },
        ]
      : [];
  });
  const remainingByPath = new Map<string, Array<IndexedHunk>>();
  for (const hunk of index.hunks) {
    if (!used.has(hunk.id)) {
      remainingByPath.set(hunk.path, [...(remainingByPath.get(hunk.path) ?? []), hunk]);
    }
  }
  for (const [path, hunks] of remainingByPath) {
    for (let start = 0; start < hunks.length; start += maxHunksPerGroup) {
      const chunk = hunks.slice(start, start + maxHunksPerGroup);
      const counts = lineCounts(chunk);
      let supportId = `support-${support.length + 1}`;
      while (itemIds.has(supportId)) {
        supportId = `support-${Number(supportId.slice('support-'.length)) + 1}`;
      }
      support.push({
        ...counts,
        hunkIds: chunk.map((hunk) => hunk.id),
        hunks: chunk.map(toWalkthroughHunk),
        id: supportId,
        reason: 'Other changes',
        title: path,
      });
      itemIds.add(supportId);
    }
  }
  const stopCount = chapters.reduce((count, chapter) => count + chapter.stops.length, 0);
  return {
    agent: generationMetadata.agent,
    chapters,
    focus: clean(authored.focus, 'Walk through the merge request.'),
    generatedAt: generationMetadata.generatedAt,
    kind: 'narrative',
    meta: `${stopCount} stops · ${chapters.length} chapters`,
    repo: { branch: state.branch },
    source: captureWalkthroughSource(state.source),
    support,
    title: clean(authored.title, 'Merge request walkthrough'),
  };
};

/**
 * Capture normalized review code before per-call aliasing and patch budgets.
 * Local roots, launch paths, review threads, caches, and transient host state
 * are deliberately absent.
 */
const isGitSha = (value: string | undefined): value is GitSha =>
  value != null && /^(?:[\da-f]{40}|[\da-f]{64})$/i.test(value);

const captureWalkthroughSource = (
  source: RepositoryState['source'],
): WalkthroughCapturedContext['source'] => {
  if (source.type !== 'pull-request') {
    return source;
  }
  return {
    ...(source.description ? { description: source.description } : {}),
    ...(isGitSha(source.headSha) ? { headSha: source.headSha } : {}),
    ...(source.number != null ? { number: source.number } : {}),
    ...(source.projectPath ? { projectPath: source.projectPath } : {}),
    ...(source.provider ? { provider: source.provider } : {}),
    ...(source.targetBranch ? { targetBranch: source.targetBranch } : {}),
    ...(source.title ? { title: source.title } : {}),
    type: source.type,
    url: source.url,
  };
};

const omitPullRequestDescription = (
  source: Extract<WalkthroughCapturedContext['source'], { type: 'pull-request' }>,
) => {
  const { description: _description, ...sourceWithoutDescription } = source;
  return sourceWithoutDescription;
};

export const captureWalkthroughContext = (state: RepositoryState): WalkthroughCapturedContext => ({
  branch: state.branch,
  files: state.files.map((file) => ({
    fingerprint: file.fingerprint,
    ...(file.generated ? { generated: true } : {}),
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    path: file.path,
    sections: file.sections.map((section) => ({
      binary: section.binary,
      id: section.id,
      kind: section.kind,
      ...(section.loadState ? { loadState: section.loadState } : {}),
      ...(section.newFile
        ? {
            newFile: {
              contents: section.newFile.contents,
              name: section.newFile.name,
            },
          }
        : {}),
      ...(section.oldFile
        ? {
            oldFile: {
              contents: section.oldFile.contents,
              name: section.oldFile.name,
            },
          }
        : {}),
      patch: section.patch,
      ...(section.range ? { range: section.range } : {}),
      ...(section.summary ? { summary: section.summary } : {}),
    })),
    status: file.status,
  })),
  source: captureWalkthroughSource(state.source),
});

/** Create the one authoritative request retained beside a V5 narrative. */
export const createWalkthroughGenerationRequest = (
  review: WalkthroughGenerationRequest['review'],
  customInstructions?: string | null,
): WalkthroughGenerationRequest => ({
  ...(customInstructions?.trim() ? { customInstructions: customInstructions.trim() } : {}),
  review,
});

/** Persist a structurally complete V5 narrative with its authoritative inputs. */
export const createWalkthroughArtifactV5 = (
  narrative: WalkthroughNarrativeV5,
  capturedContext: WalkthroughCapturedContext,
  generationRequest: WalkthroughGenerationRequest,
): WalkthroughArtifactV5 => ({
  capturedContext,
  generationRequest,
  narrative,
  version: 5,
});

/** Normalize one successful model response directly into a persisted V5 artifact. */
export const authorWalkthroughArtifactV5 = (input: {
  generationMetadata: GenerationMetadata;
  generationRequest: WalkthroughGenerationRequest;
  response: unknown;
  state: RepositoryState;
}): WalkthroughArtifactV5 => {
  const { structure } = input.generationRequest.review;
  if (structure === 'commit-by-commit' || structure === 'commit-evolution') {
    throw new Error('Multi-unit V5 narratives must be composed by the generation orchestrator.');
  }
  if (input.generationMetadata.profile.authoringVersion !== walkthroughAuthoringVersion) {
    throw new Error('Generation metadata must use the current walkthrough authoring version.');
  }
  if (!input.generationMetadata.profile.modelCandidates.includes(input.generationMetadata.model)) {
    throw new Error('The successful model must belong to the requested fallback chain.');
  }
  return createWalkthroughArtifactV5(
    {
      content: normalizeWalkthroughDraft(input.response, input.state, input.generationMetadata),
      generationMetadata: input.generationMetadata,
      structure,
    },
    captureWalkthroughContext(input.state),
    input.generationRequest,
  );
};

const truncate = (value: string, maxLength: number) =>
  value.length <= maxLength
    ? value
    : maxLength <= 1
      ? value.slice(0, maxLength)
      : `${value.slice(0, maxLength - 1)}…`;

const getPromptPatchBudgets = (fileCount: number) =>
  fileCount > 32
    ? { section: maxLargePatchExcerpt, total: maxLargeTotalPatchExcerpt }
    : { section: maxPatchExcerpt, total: maxTotalPatchExcerpt };

const buildPatchExcerpt = (
  section: DiffSection,
  remainingBudget: number,
  sectionBudget: number,
) => {
  const summary = section.summary?.reason ? `Summary: ${section.summary.reason}\n` : '';
  const patch = `${summary}${section.patch || ''}`;
  if (!patch) {
    return '[patch omitted: no text patch available]';
  }
  const maxLength = Math.max(0, Math.min(sectionBudget, remainingBudget));
  return truncate(patch, maxLength);
};

const formatPromptLineRange = (start: number, end: number) =>
  start === end ? `${start}` : `${start}-${end}`;

const buildPromptHunk = (hunk: IndexedHunk, id: string) =>
  hunk.kind === 'synthetic'
    ? {
        added: hunk.added,
        deleted: hunk.deleted,
        id,
        kind: 'synthetic' as const,
      }
    : {
        added: hunk.added,
        deleted: hunk.deleted,
        id,
        kind: 'patch' as const,
        newLines: formatPromptLineRange(hunk.additionStart ?? 0, hunk.additionEnd ?? 0),
        oldLines: formatPromptLineRange(hunk.deletionStart ?? 0, hunk.deletionEnd ?? 0),
      };

type WalkthroughSize = {
  fileCount: number;
  hunkCount: number;
};

const buildWalkthroughSizingGuidance = (
  { fileCount, hunkCount }: WalkthroughSize,
  { independentCommit = false }: { independentCommit?: boolean } = {},
) => {
  const targetStops =
    fileCount <= 2
      ? hunkCount <= 4
        ? '1-2'
        : '2-3'
      : fileCount <= 4 && hunkCount <= 4
        ? '1-2'
        : fileCount <= 4 && hunkCount <= 8
          ? '1-3'
          : fileCount <= 16
            ? '5-9'
            : '6-9';
  const targetChapters = fileCount <= 2 ? '1' : fileCount <= 4 && hunkCount <= 8 ? '1-2' : '2-6';

  return `Coverage contract:
- The digest has ${fileCount} files and ${hunkCount} reviewable hunks. Put only the highest-leverage review path in chapters[]; Codiff preserves everything else as support.
- Digest hunk ids are compact request-local aliases like h1 and h2. Return those aliases exactly; Codiff maps them back to stable live-diff ids.
- Define chapters[] and stops[] in display order. Use stable stop ids like s1, s2, and never invent hunk ids.
${
  independentCommit
    ? '- Choose as many conceptual chapters as this commit needs. Do not collapse distinct review ideas into one chapter.'
    : `- Target ${targetStops} main-path stops and at most ${maxWalkthroughStops}. Use ${targetChapters} conceptual chapters.`
}
- Chapter titles render in a compact top bar: keep each title to 1-2 short words and at most 16 characters.
- Default to one review idea per stop. Group multiple hunkIds when they implement the same invariant, behavior, or repeated pattern.
- Every stop must have a concise semantic title that names the review idea in roughly 2-6 words, e.g. "Prevent duplicate payments" or "Preserve offline drafts". Never use a filename or path as a stop title.
- A stop may contain at most ${maxHunksPerGroup} hunkIds, listed in the exact display order Codiff should render.
- Generated-like files have "generated":true and one synthetic hunk per changed section. Never split them; main-path them only when they explain behavior.
- Leave secondary, mechanical, docs-only, generated, styling, fixture, lockfile, snapshot, and repeated-pattern hunks out of chapters[]. Codiff automatically places every unreferenced hunk in support.
- Do not provide support, added/deleted counts, status, paths, section ids, repo, source, generatedAt, agent, meta, notes, changeType, summary, or commitNote for stops; Codiff computes display metadata from the live diff.`;
};

export type WalkthroughPromptOptions = {
  /** When set, the digest contains exactly one commit and is authored independently. */
  commitContext?: {
    sha: GitSha;
    subject: string;
  } | null;
  reviewStrategy?: WalkthroughReviewStrategy | null;
  /** Exact narrative unit identity; aggregate calls omit this field. */
  scope?: Exclude<TreeInspectionScope, { kind: 'complete-diff' }> | null;
  versionBaseContext?: {
    absorbedCommits: ReadonlyArray<{
      baseShortSha?: string;
      shortSha: string;
      subject: string;
    }>;
    commits: ReadonlyArray<{ shortSha: string; subject: string }>;
    relationship: 'forward' | 'backward' | 'divergent' | 'unknown';
  } | null;
  /** One changed logical commit unit inside a selected version range. */
  versionCommitContext?: {
    after?: { shortSha: string; subject: string };
    before?: { shortSha: string; subject: string };
    evolutionKind: 'ambiguous' | 'introduced' | 'removed' | 'revised';
    kind: 'version-commit';
    range: { fromLabel: string; toLabel: string };
    rebaseOverlaps?: ReadonlyArray<{
      authorName: string;
      overlappingPaths: ReadonlyArray<string>;
      shortSha: string;
      subject: string;
    }>;
    unitId: Extract<TreeInspectionScope, { kind: 'evolution-unit' }>['unitId'];
  } | null;
  /** When set, author a walkthrough of MR version evolution, not the whole net MR. */
  versionCompareRange?: {
    fromLabel: string;
    structure?: 'commit-evolution' | 'complete-comparison';
    toLabel: string;
  } | null;
};

const sourceDescription = (source: ResolvedReviewSource | ReviewSource) => {
  if (source.type === 'pull-request') {
    if (source.provider === 'github') {
      return 'GitHub pull request';
    }
    if (source.provider === 'gitlab') {
      return 'GitLab merge request';
    }
    return 'pull request';
  }
  if (source.type === 'commit') {
    return 'commit';
  }
  if (
    source.type === 'branch' ||
    source.type === 'branch-diff' ||
    source.type === 'branch-working-tree'
  ) {
    return 'branch comparison';
  }
  if (source.type === 'range') {
    return 'ref range';
  }
  return 'working-tree changes';
};

const buildCustomInstructionsGuidance = (instructions: string | null | undefined) => {
  const trimmed = instructions?.trim();
  return trimmed
    ? `Custom walkthrough instructions:
${trimmed}`
    : '';
};

/** Build the required cross-unit orientation call for Commit Evolution. */
export const buildReviewFocusPrompt = ({
  generationRequest,
  units,
}: {
  generationRequest: WalkthroughGenerationRequest;
  units: ReadonlyArray<{
    content: WalkthroughNarrativeContentV5;
    unitId: EvolutionUnitId;
  }>;
}) => {
  const review = generationRequest.review;
  if (review.relation !== 'version-comparison' || review.structure !== 'commit-evolution') {
    throw new Error('Review focus requires a Commit Evolution generation request.');
  }
  const fromLabel = review.comparison.before.head.label.text;
  const toLabel = review.comparison.after.head.label.text;
  const summaries = units.map(({ content, unitId }) => ({
    chapters: content.chapters.map((chapter) => ({
      stops: chapter.stops.map((stop) => stop.title),
      title: chapter.title,
    })),
    focus: content.focus,
    unitId,
  }));

  return `Write the Review focus for a Commit Evolution comparison from ${fromLabel} to ${toLabel}.

Scope every statement to changes after ${fromLabel} through ${toLabel}. Synthesize the supplied Evolution Unit summaries into 2-4 short, evidence-based sentences with no heading or list. Explain the most important behavioral progression and review order. Do not merely count units, repeat titles, describe behavior already present in ${fromLabel} as newly introduced, or treat pure rebase overlap as new behavior.

${buildCustomInstructionsGuidance(generationRequest.customInstructions)}

Evolution Unit summaries (ordered):
${JSON.stringify(summaries)}`;
};

const buildReviewStrategyDigest = (strategy: WalkthroughReviewStrategy | null | undefined) => {
  if (!strategy) {
    return null;
  }
  if (strategy.structure === 'commit-by-commit') {
    return {
      commits: strategy.commits.map((commit) => ({
        role: commit.role,
        sha: commit.shortSha,
        subject: truncate(commit.subject, 120),
      })),
      confidence: strategy.confidence,
      reason: strategy.reason,
      structure: strategy.structure,
    };
  }
  return {
    confidence: strategy.confidence,
    reason: strategy.reason,
    structure: strategy.structure,
  };
};

const buildCommitStructureGuidance = (strategy: WalkthroughReviewStrategy | null | undefined) => {
  if (!strategy || strategy.structure !== 'commit-by-commit') {
    return `- Prefer conceptual chapters across the net merge-request diff.
- A commit list may be present as weak author history context; do not structure the walkthrough around fixups or review-response commits.
- Do not invent commit metadata that is not in the digest.`;
  }
  return `- Review strategy is commit-by-commit (${strategy.reason}).
- Preserve distinct review ideas as separate chapters; there is no one-chapter-per-commit limit.
- Stop titles must stay semantic, but may reference the related commit subject.
- Digest hunks still come from the live whole-MR diff for stable anchors; optionally mention commit subjects in prose when they clarify chapter boundaries.
- Include every non-merge commit in its own boundary; do not group commits.`;
};

const buildVersionCompareStructureGuidance = (
  versionCompareRange: WalkthroughPromptOptions['versionCompareRange'],
) => {
  if (!versionCompareRange) {
    return '';
  }
  const structureLabel =
    versionCompareRange.structure === 'commit-evolution'
      ? 'commit-evolution'
      : versionCompareRange.structure === 'complete-comparison'
        ? 'complete-comparison'
        : null;
  return `- This walkthrough covers the version comparison from ${versionCompareRange.fromLabel} to ${versionCompareRange.toLabel}${structureLabel ? ` as a ${structureLabel} walkthrough` : ''}.
- Focus on how the merge request itself evolved: intentional edits, conflict-resolution fallout, and newly added/removed behavior.
- Do not narrate pure rebase noise. Prefer chapters that answer "what changed since the earlier version?" for a returning reviewer.
- Hunks still come from the supplied digest; treat them as the version-comparison surface, not the full historical MR net diff.${
    structureLabel === 'commit-evolution'
      ? '\n- This request is one Evolution Unit inside a commit-evolution walkthrough; stay scoped to the supplied unit.'
      : structureLabel === 'complete-comparison'
        ? '\n- This is a Complete Comparison walkthrough across the intentional version-comparison surface.'
        : ''
  }`;
};

const buildVersionBaseGuidance = (context: WalkthroughPromptOptions['versionBaseContext']) => {
  if (!context) {
    return '';
  }
  const absorbed = context.absorbedCommits
    .map(
      (commit) =>
        `  - ${commit.shortSha}: ${commit.subject}${commit.baseShortSha ? ` (now in base as ${commit.baseShortSha})` : ''}`,
    )
    .join('\n');
  const baseCommits = context.commits
    .slice(0, 12)
    .map((commit) => `  - ${commit.shortSha}: ${commit.subject}`)
    .join('\n');
  return `- The target base changed between these versions (${context.relationship}).
${
  absorbed
    ? `- These earlier MR commits are now supplied by the target base. Do not describe their behavior as removed:
${absorbed}`
    : '- No earlier MR commits were confidently identified as moving into the target base.'
}
- Base commits are context only. Mention them only when the supplied version diff demonstrates an adaptation:
${baseCommits || '  - none available'}`;
};

const buildSingleCommitGuidance = (commit: WalkthroughPromptOptions['commitContext']) => {
  if (!commit) {
    return '';
  }
  return `- This is an independent walkthrough for commit ${commit.sha}: ${commit.subject}.
- Explain only the changes introduced by this commit. Do not summarize the merge request as a whole.
- Never refer to earlier or later commits, the commit stack, a rebase, or cumulative merge-request history.
- Do not infer behavior from code outside this commit's supplied diff.
- Build the best reviewer path through this commit's own diff.`;
};

const buildVersionCommitGuidance = (context: WalkthroughPromptOptions['versionCommitContext']) => {
  if (!context) {
    return '';
  }
  const before = context.before ? `${context.before.shortSha}: ${context.before.subject}` : 'none';
  const after = context.after ? `${context.after.shortSha}: ${context.after.subject}` : 'none';
  if (context.evolutionKind === 'introduced') {
    return `- This is one commit added between ${context.range.fromLabel} and ${context.range.toLabel}: ${after}.
- Explain only this new commit's own contribution. Do not summarize the complete version range.`;
  }
  if (context.evolutionKind === 'removed') {
    return `- This commit was removed from the MR stack between ${context.range.fromLabel} and ${context.range.toLabel}: ${before}.
- The supplied diff is intentionally inverted. Explain what was removed from the MR, never as newly authored implementation.`;
  }
  if (context.evolutionKind === 'ambiguous') {
    return `- Commit changes could not be paired confidently between ${context.range.fromLabel} and ${context.range.toLabel}.
- This best-effort paired comparison may be useful, but its logical commit identity is uncertain.
- Explain only the supplied patch evolution and do not invent a confident commit identity.`;
  }
  const overlaps = context.rebaseOverlaps ?? [];
  if (overlaps.length === 0) {
    return `- This is the change to one logical commit between ${context.range.fromLabel} and ${context.range.toLabel}.
- Earlier commit: ${before}. Later commit: ${after}.
- Explain only the supplied patch evolution, not the complete later commit or changes in other commits.
- This pairing is heuristic. Never claim the two SHAs are exactly the same commit.
- If the patch looks like conflict resolution or context-line churn, say the rewrite may be rebase fallout, but only when the supplied hunks support that reading.
- Do not invent base-branch commits that are not listed in the digest.
- Treat the supplied hunks as the source of truth.`;
  }
  const primary = overlaps[0]!;
  const overlapLines = overlaps
    .map(
      (driver) =>
        `  - ${driver.shortSha}: ${driver.subject} (by ${driver.authorName}; overlaps ${driver.overlappingPaths.slice(0, 4).join(', ')}${driver.overlappingPaths.length > 4 ? ', …' : ''})`,
    )
    .join('\n');
  return `- This is a REBASE-REVISED logical commit between ${context.range.fromLabel} and ${context.range.toLabel}.
- Earlier commit: ${before}. Later commit: ${after}.
- Opening requirement: the first sentence of the first chapter blurb MUST start from the base-branch update that this rebase pulled in, using this shape:
  "Because this rebase brought in ${primary.shortSha} (${primary.subject}) from the base branch, this MR commit was revised to …"
- Preferred primary driver: ${primary.shortSha} — ${primary.subject}.
- All attributed base-branch commits brought in by the rebase:
${overlapLines}
- After that opening sentence, explain only the supplied patch evolution for this logical commit.
- Distinguish clearly:
  1) adaptations required because the rebase moved the MR onto newer base-branch commits, versus
  2) intentional new MR behavior not explained by those base-branch commits.
- Do not narrate the entire base branch; only the listed base commits that the rebase introduced under this MR commit.
- Prefer wording like "brought in by the rebase", "now present on the updated base", or "required after rebasing onto newer base commits". Avoid "landed by rebase".
- This pairing is heuristic. Never claim the two SHAs are exactly the same commit.
- Treat the supplied hunks as the source of truth.
`;
};

export const buildWalkthroughPromptInput = (
  capturedContext: WalkthroughCapturedContext,
  generationRequest: WalkthroughGenerationRequest,
  options: WalkthroughPromptOptions = {},
) => {
  const index = indexWalkthroughHunks(capturedContext.files);
  const patchBudgets = getPromptPatchBudgets(capturedContext.files.length);
  const size = {
    fileCount: capturedContext.files.length,
    hunkCount: index.hunks.length,
  };
  let remainingPatchBudget = patchBudgets.total;
  const digest = {
    branch: capturedContext.branch,
    commitContext: options.commitContext ?? null,
    files: capturedContext.files.map((file) => ({
      ...(isGeneratedWalkthroughPath(file.path)
        ? {
            generated: true,
            generatedReason:
              'Generated-like file; Codiff exposes each changed section as one synthetic hunk.',
          }
        : {}),
      oldPath: file.oldPath,
      path: file.path,
      sections: file.sections.map((section) => {
        const patchExcerpt = buildPatchExcerpt(section, remainingPatchBudget, patchBudgets.section);
        remainingPatchBudget = Math.max(0, remainingPatchBudget - patchExcerpt.length);
        return {
          binary: section.binary,
          hunks: index.hunks
            .filter((hunk) => hunk.sectionId === section.id)
            .map((hunk) => buildPromptHunk(hunk, index.aliasByHunkId.get(hunk.id) ?? hunk.id)),
          id: section.id,
          kind: section.kind,
          loadState: section.loadState,
          patchExcerpt,
          summary: section.summary?.reason,
        };
      }),
      status: file.status,
    })),
    reviewStrategy: buildReviewStrategyDigest(options.reviewStrategy),
    scope: options.scope ?? null,
    source:
      (options.commitContext || options.versionCommitContext) &&
      capturedContext.source.type === 'pull-request'
        ? {
            ...omitPullRequestDescription(capturedContext.source),
            title:
              options.commitContext?.subject ??
              options.versionCommitContext?.after?.subject ??
              options.versionCommitContext?.before?.subject ??
              capturedContext.source.title,
          }
        : capturedContext.source.type === 'pull-request' &&
            typeof capturedContext.source.description === 'string'
          ? {
              ...capturedContext.source,
              description: truncate(capturedContext.source.description, maxProseChars),
            }
          : capturedContext.source,
    versionBaseContext: options.versionBaseContext ?? null,
    versionCommitContext: options.versionCommitContext ?? null,
    versionCompareRange: options.versionCompareRange ?? null,
    walkthroughRequest: generationRequest.review,
  };
  return { digest, patchBudgets, size };
};

export const buildWalkthroughPrompt = (
  capturedContext: WalkthroughCapturedContext,
  generationRequest: WalkthroughGenerationRequest,
  options: WalkthroughPromptOptions = {},
) => {
  const { digest, size } = buildWalkthroughPromptInput(capturedContext, generationRequest, options);
  return `Author a Codiff narrative walkthrough for this ${sourceDescription(capturedContext.source)}.

Use only the supplied digest. Return the required structured object. If source.description is present, treat it as author-written intent and orientation, not proof of behavior; patches and hunk data remain the source of truth.

${buildWalkthroughSizingGuidance(size, { independentCommit: Boolean(options.commitContext || options.versionCommitContext) })}

Product rules:
- Write all user-visible text in English.
- Order the review by conceptual leverage, not file path.
- Keep prose focused, concrete, and evidence-based. Inline code is allowed.
- Walk the reviewer through each branch of the implementation logic. Establish contracts and state before the behavior that consumes them, and explain behavior before downstream effects.
- When multiple hunks cooperate, explain the invariant one establishes, what depends on it, and the relevant data or control flow.
- Match explanation depth to complexity. Simple stops may use one paragraph. Complex stops should use two to four short paragraphs covering behavior, mechanism, dependencies, downstream effects, and reviewer considerations.
- Do not narrate syntax line by line. Explain why the code is structured this way, what changed in the execution path, and what downstream code now assumes.
- Stop prose supports paragraphs and safe inline Markdown. Do not use headings or lists.
- Return regions[] for every stop. For a substantive line-local implementation claim, include one or two precise regions. Use an empty array only when every supplied hunk is synthetic or the explanation is inherently structural, cross-file, or whole-file. Never add more than four.
- Each region must stay inside one supplied hunk and one side, and stop prose must reference it as [phrase](#region-id). Region titles are short labels. Tooltips use safe inline Markdown only, no links or block elements, and explain why the selected range matters. Do not add regions that merely cover a whole hunk without added precision.
- Do not claim tests, risks, or behavior that the diff does not support.
${buildCommitStructureGuidance(options.reviewStrategy)}
${buildVersionCompareStructureGuidance(options.versionCompareRange)}
${buildVersionBaseGuidance(options.versionBaseContext)}
${buildSingleCommitGuidance(options.commitContext)}
${buildVersionCommitGuidance(options.versionCommitContext)}
${buildCustomInstructionsGuidance(generationRequest.customInstructions)}

Repository digest:
${JSON.stringify(digest)}`;
};

/** @deprecated Prefer normalizeWalkthroughDraft. */
export const normalizeAuthoredWalkthrough = normalizeWalkthroughDraft;
