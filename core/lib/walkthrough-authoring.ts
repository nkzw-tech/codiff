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
  GenerationMetadata,
  GenerationProfile,
  GitSha,
  RepositoryState,
  ResolvedReviewSource,
  ReviewSource,
  WalkthroughArtifactV5,
  WalkthroughCapturedContext,
  WalkthroughGenerationRequest,
  WalkthroughHunk,
  WalkthroughNarrativeV5,
} from '../types.ts';
import {
  getSectionWalkthroughHunks,
  isGeneratedWalkthroughPath,
} from './narrative-walkthrough-diff.js';

export const maxProseChars = 4000;
export const maxPatchExcerpt = 2500;
export const maxTotalPatchExcerpt = 60_000;
export const maxLargePatchExcerpt = 700;
export const maxLargeTotalPatchExcerpt = 35_000;
export const maxWalkthroughChapters = 20;
export const maxWalkthroughStops = 14;
export const maxHunksPerGroup = 14;
/** Changes only when prompt projection, response schema, or normalization semantics change. */
export const walkthroughAuthoringVersion = 'walkthrough-v5-single-diff-1';

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

const stopSchema = object({
  ...groupFields,
  importance: picklist(['critical', 'normal', 'context']),
  prose: nonEmptyString(4000),
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
): WalkthroughNarrativeV5 => {
  const authored = parseWalkthroughDraft(value);
  const index = indexWalkthroughHunks(state.files);
  const used = new Set<string>();
  const itemIds = new Set<string>();

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

  const chapters = authored.chapters.flatMap((chapter) => {
    const stops = chapter.stops.flatMap((stop) => {
      const group = resolveGroup(stop);
      return group
        ? [
            {
              ...group,
              importance: stop.importance,
              prose: clean(stop.prose),
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
    generationMetadata,
    kind: 'narrative',
    meta: `${stopCount} stops · ${chapters.length} chapters`,
    repo: { branch: state.branch },
    source: captureWalkthroughSource(state.source),
    structure: 'single-diff',
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
        ? { newFile: { contents: section.newFile.contents, name: section.newFile.name } }
        : {}),
      ...(section.oldFile
        ? { oldFile: { contents: section.oldFile.contents, name: section.oldFile.name } }
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

/** Persist a complete single-call V5 narrative with its authoritative inputs. */
export const createWalkthroughArtifactV5 = (
  narrative: WalkthroughNarrativeV5,
  capturedContext: WalkthroughCapturedContext,
  generationRequest: WalkthroughGenerationRequest,
): WalkthroughArtifactV5 => ({ capturedContext, generationRequest, narrative, version: 5 });

/** Normalize one successful model response directly into a persisted V5 artifact. */
export const authorWalkthroughArtifactV5 = (input: {
  generationMetadata: GenerationMetadata;
  generationRequest: WalkthroughGenerationRequest;
  response: unknown;
  state: RepositoryState;
}): WalkthroughArtifactV5 => {
  if (input.generationRequest.review.structure !== 'single-diff') {
    throw new Error('This authoring revision supports only single-diff V5 narratives.');
  }
  if (input.generationMetadata.profile.authoringVersion !== walkthroughAuthoringVersion) {
    throw new Error('Generation metadata must use the current walkthrough authoring version.');
  }
  if (!input.generationMetadata.profile.modelCandidates.includes(input.generationMetadata.model)) {
    throw new Error('The successful model must belong to the requested fallback chain.');
  }
  return createWalkthroughArtifactV5(
    normalizeWalkthroughDraft(input.response, input.state, input.generationMetadata),
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

const buildWalkthroughSizingGuidance = ({ fileCount, hunkCount }: WalkthroughSize) => {
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
- Target ${targetStops} main-path stops and at most ${maxWalkthroughStops}. Use ${targetChapters} conceptual chapters.
- Chapter titles render in a compact top bar: keep each title to 1-2 short words and at most 16 characters.
- Default to one review idea per stop. Group multiple hunkIds when they implement the same invariant, behavior, or repeated pattern.
- Every stop must have a concise semantic title that names the review idea in roughly 2-6 words, e.g. "Prevent duplicate payments" or "Preserve offline drafts". Never use a filename or path as a stop title.
- A stop may contain at most ${maxHunksPerGroup} hunkIds, listed in the exact display order Codiff should render.
- Generated-like files have "generated":true and one synthetic hunk per changed section. Never split them; main-path them only when they explain behavior.
- Leave secondary, mechanical, docs-only, generated, styling, fixture, lockfile, snapshot, and repeated-pattern hunks out of chapters[]. Codiff automatically places every unreferenced hunk in support.
- Do not provide support, added/deleted counts, status, paths, section ids, repo, source, generatedAt, agent, meta, notes, changeType, summary, or commitNote for stops; Codiff computes display metadata from the live diff.`;
};

/** Reserved for future prompt projections; W02 authors one complete diff per call. */
export type WalkthroughPromptOptions = Record<never, never>;

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

export const buildWalkthroughPromptInput = (
  capturedContext: WalkthroughCapturedContext,
  generationRequest: WalkthroughGenerationRequest,
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
    source:
      capturedContext.source.type === 'pull-request' &&
      typeof capturedContext.source.description === 'string'
        ? {
            ...capturedContext.source,
            description: truncate(capturedContext.source.description, maxProseChars),
          }
        : capturedContext.source,
    walkthroughRequest: generationRequest.review,
  };
  return { digest, patchBudgets, size };
};

export const buildWalkthroughPrompt = (
  capturedContext: WalkthroughCapturedContext,
  generationRequest: WalkthroughGenerationRequest,
) => {
  const { digest, size } = buildWalkthroughPromptInput(capturedContext, generationRequest);
  return `Author a Codiff narrative walkthrough for this ${sourceDescription(capturedContext.source)}.

Use only the supplied digest. Return the required structured object. If source.description is present, treat it as author-written intent and orientation, not proof of behavior; patches and hunk data remain the source of truth.

${buildWalkthroughSizingGuidance(size)}

Product rules:
- Write all user-visible text in English.
- Order the review by conceptual leverage, not file path.
- Keep prose focused, concrete, and evidence-based. Inline code is allowed.
- Walk the reviewer through each branch of the implementation logic. Establish contracts and state before the behavior that consumes them, and explain behavior before downstream effects.
- When multiple hunks cooperate, explain the invariant one establishes, what depends on it, and the relevant data or control flow.
- Match explanation depth to complexity. Simple stops may use one paragraph. Complex stops should use two to four short paragraphs covering behavior, mechanism, dependencies, downstream effects, and reviewer considerations.
- Do not narrate syntax line by line. Explain why the code is structured this way, what changed in the execution path, and what downstream code now assumes.
- Stop prose supports paragraphs and safe inline Markdown. Do not use headings or lists.
- Do not claim tests, risks, or behavior that the diff does not support.
- Prefer conceptual chapters across the complete diff.
${buildCustomInstructionsGuidance(generationRequest.customInstructions)}

Repository digest:
${JSON.stringify(digest)}`;
};

/** @deprecated Prefer normalizeWalkthroughDraft. */
export const normalizeAuthoredWalkthrough = normalizeWalkthroughDraft;
