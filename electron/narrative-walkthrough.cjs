// @ts-check

// Narrative walkthrough generation and normalization trust boundary.

const {
  cleanText,
  normalizeEnum,
  oneLine,
  parseJSONMessage,
  truncate,
} = require('./agent-shared.cjs');
const {
  AGENTS,
  CHANGE_TYPES,
  ICONS,
  IMPORTANCES,
  MAX_HUNKS_PER_WALKTHROUGH_GROUP,
  MAX_WALKTHROUGH_CHAPTERS,
  MAX_WALKTHROUGH_STOPS,
  narrativeWalkthroughResponseSchema,
  narrativeWalkthroughSchema,
} = require('./narrative-walkthrough-schema.cjs');
const {
  buildAnchorDisplay,
  getSectionWalkthroughHunks,
  hunkDisplayEnd,
  hunkDisplayStart,
  isGeneratedWalkthroughFile,
  isSyntheticWalkthroughHunk,
  sumHunkLineCounts,
} = require('../core/lib/narrative-walkthrough-diff.cjs');

/**
 * @typedef {import('../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../core/types.ts').DiffSection} DiffSection
 * @typedef {import('../core/types.ts').NarrativeWalkthrough} NarrativeWalkthrough
 * @typedef {import('../core/types.ts').NarrativeWalkthroughResult} NarrativeWalkthroughResult
 * @typedef {import('../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../core/types.ts').WalkthroughContext} WalkthroughContext
 * @typedef {import('./agent.cjs').Agent} Agent
 * @typedef {import('./agent.cjs').AgentOptions} AgentOptions
 */

const MAX_PROSE_CHARS = 4_000;
const MAX_TOTAL_PATCH_CHARS = 60_000;
const MAX_LARGE_TOTAL_PATCH_CHARS = 35_000;
const MAX_SECTION_PATCH_CHARS = 2_500;
const MAX_LARGE_SECTION_PATCH_CHARS = 700;
const BASE_WALKTHROUGH_TIMEOUT_MS = 90_000;
const MAX_WALKTHROUGH_TIMEOUT_MS = 300_000;
const INCLUDED_WALKTHROUGH_FILES = 8;
const INCLUDED_WALKTHROUGH_HUNKS = 12;
const TIMEOUT_MS_PER_EXTRA_FILE = 1_000;
const TIMEOUT_MS_PER_EXTRA_HUNK = 2_000;

/** @param {unknown} value @param {string} [fallback] */
const cleanRich = (value, fallback = '') => {
  const text = typeof value === 'string' ? value : fallback;
  const trimmed = text.trim();
  if (trimmed.length <= MAX_PROSE_CHARS) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_PROSE_CHARS)}…`;
};

/** @param {string} line */
const isCommitTitleLine = (line) => {
  const title = line.trim();
  return title.length > 0 && title.length <= 72 && !/[.!?]$/.test(title);
};

/** @param {string} body @param {string} title */
const stripLeadingCommitTitle = (body, title) => {
  if (!body || !title) {
    return body;
  }
  const lines = body.split(/\r?\n/);
  const titleIndex = lines.findIndex((line) => line.trim());
  if (titleIndex === -1 || lines[titleIndex].trim() !== title.trim()) {
    return body;
  }
  let nextIndex = titleIndex + 1;
  while (nextIndex < lines.length && !lines[nextIndex].trim()) {
    nextIndex += 1;
  }
  return [...lines.slice(0, titleIndex), ...lines.slice(nextIndex)].join('\n').trim();
};

/** @param {unknown} value */
const normalizeStringArray = (value) => {
  const strings = [];
  for (const item of Array.isArray(value) ? value : []) {
    const text = oneLine(item);
    if (text && !strings.includes(text)) {
      strings.push(text);
    }
  }
  return strings;
};

/** @param {unknown} value */
const normalizeGeneratedAt = (value) => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return '';
};

/** @param {any} input */
const isLegacyV3Walkthrough = (input) =>
  input?.version === 3 ||
  (Array.isArray(input?.chapters) &&
    input.chapters.some((chapter) =>
      (chapter?.stops || []).some((stop) => Array.isArray(stop?.anchors)),
    )) ||
  (Array.isArray(input?.support) && input.support.some((item) => Array.isArray(item?.files)));

/** @param {string} status */
const defaultSideForStatus = (status) => {
  if (status === 'added' || status === 'untracked') {
    return 'additions';
  }

  if (status === 'deleted') {
    return 'deletions';
  }

  return 'both';
};

/**
 * @param {ReadonlyArray<ChangedFile>} files
 * @param {ReadonlyMap<string, string>} [hunkIdByAlias]
 */
const indexFiles = (files, hunkIdByAlias = new Map()) => {
  const hunkById = new Map();
  const generatedHunkIds = new Set();
  for (const file of files) {
    for (const section of file.sections || []) {
      for (const hunk of getSectionWalkthroughHunks(file, section)) {
        hunkById.set(hunk.id, hunk);
        if (isGeneratedWalkthroughFile(file)) {
          generatedHunkIds.add(hunk.id);
        }
      }
    }
  }
  for (const [alias, hunkId] of hunkIdByAlias) {
    const hunk = hunkById.get(hunkId);
    if (hunk) {
      hunkById.set(alias, hunk);
    }
  }

  return { generatedHunkIds, hunkById };
};

const resolveHunks = (hunkIds, index) => {
  const hunks = [];
  for (const hunkId of hunkIds) {
    const hunk = index.hunkById.get(hunkId);
    if (!hunk) {
      return null;
    }
    hunks.push(hunk);
  }
  return hunks;
};

const normalizeAnchor = (hunk) => {
  const path = hunk.path;
  const side = defaultSideForStatus(hunk.status);
  const startLine = hunkDisplayStart(hunk);
  const endLine = hunkDisplayEnd(hunk);

  /** @type {Record<string, unknown>} */
  const normalized = {
    display: buildAnchorDisplay(path, [hunk]),
    side,
    sectionId: hunk.sectionId,
    sectionKind: hunk.sectionKind,
  };
  if (startLine !== undefined) {
    normalized.startLine = startLine;
  }
  if (endLine !== undefined) {
    normalized.endLine = endLine;
  }

  return normalized;
};

const normalizeHunk = (hunk) => {
  /** @type {Record<string, unknown>} */
  const normalized = {
    added: hunk.added,
    anchor: normalizeAnchor(hunk),
    additionEnd: hunk.additionEnd,
    additionStart: hunk.additionStart,
    deleted: hunk.deleted,
    deletionEnd: hunk.deletionEnd,
    deletionStart: hunk.deletionStart,
    id: hunk.id,
    kind: isSyntheticWalkthroughHunk(hunk) ? 'synthetic' : 'patch',
    path: hunk.path,
    status: hunk.status,
  };
  if (hunk.oldPath) {
    normalized.oldPath = hunk.oldPath;
  }
  return normalized;
};

/**
 * @param {any} note
 * @param {ReadonlySet<string>} hunkIds
 * @param {ReturnType<typeof indexFiles>} index
 */
const normalizeHunkNote = (note, hunkIds, index) => {
  const requestedHunkId = oneLine(note?.hunkId);
  const hunkId = index.hunkById.get(requestedHunkId)?.id || requestedHunkId;
  const body = cleanText(note?.body);
  if (!hunkId || !body || !hunkIds.has(hunkId)) {
    return null;
  }
  return { body, hunkId };
};

/** @param {any} item @param {string} fallbackId @param {ReturnType<typeof indexFiles>} index */
const normalizeHunkGroup = (item, fallbackId, index) => {
  const id = oneLine(item?.id) || fallbackId;
  const hunkIds = normalizeStringArray(item?.hunkIds);
  if (!id || hunkIds.length === 0 || hunkIds.length > MAX_HUNKS_PER_WALKTHROUGH_GROUP) {
    return null;
  }

  const selectedHunks = resolveHunks(hunkIds, index);
  if (!selectedHunks || selectedHunks.length !== hunkIds.length) {
    return null;
  }

  const lineCount = sumHunkLineCounts(selectedHunks);
  const selectedHunkIds = new Set(selectedHunks.map((hunk) => hunk.id));

  /** @type {Record<string, unknown>} */
  const normalized = {
    added: lineCount.added,
    deleted: lineCount.deleted,
    hunkIds: selectedHunks.map((hunk) => hunk.id),
    hunks: selectedHunks.map(normalizeHunk),
    id,
  };

  const title = cleanText(item?.title);
  if (title) {
    normalized.title = title;
  }
  const summary = cleanText(item?.summary);
  if (summary) {
    normalized.summary = summary;
  }
  const changeType = normalizeEnum(item?.changeType, CHANGE_TYPES, undefined);
  if (changeType) {
    normalized.changeType = changeType;
  }
  const commitNote = cleanText(item?.commitNote);
  if (commitNote) {
    normalized.commitNote = commitNote;
  }

  const notes = [];
  const notedHunkIds = new Set();
  for (const note of Array.isArray(item?.notes) ? item.notes : []) {
    const normalizedNote = normalizeHunkNote(note, selectedHunkIds, index);
    if (!normalizedNote || notedHunkIds.has(normalizedNote.hunkId)) {
      continue;
    }
    notes.push(normalizedNote);
    notedHunkIds.add(normalizedNote.hunkId);
  }
  if (notes.length > 0) {
    normalized.notes = notes;
  }

  return normalized;
};

const hunkGroupKey = (group) => (group.hunkIds || []).join('\n');

const normalizeChapters = (input, index, coveredHunkIds) => {
  const chapters = [];
  const chapterIds = new Set();
  const itemIds = new Set();
  let stopCount = 0;

  for (const chapter of Array.isArray(input?.chapters) ? input.chapters : []) {
    if (chapters.length >= MAX_WALKTHROUGH_CHAPTERS || stopCount >= MAX_WALKTHROUGH_STOPS) {
      break;
    }

    const id = oneLine(chapter?.id) || `chapter-${chapters.length + 1}`;
    if (chapterIds.has(id)) {
      continue;
    }

    const stops = [];
    const seenStopHunkGroups = new Set();
    for (const stop of Array.isArray(chapter?.stops) ? chapter.stops : []) {
      if (stopCount >= MAX_WALKTHROUGH_STOPS) {
        break;
      }

      const group = normalizeHunkGroup(stop, `${id}-stop-${stops.length + 1}`, index);
      if (!group || itemIds.has(group.id)) {
        continue;
      }

      const key = hunkGroupKey(group);
      const overlapsCoveredHunk = group.hunkIds.some((hunkId) => coveredHunkIds.has(hunkId));
      if (seenStopHunkGroups.has(key) || overlapsCoveredHunk) {
        continue;
      }

      const prose = cleanRich(stop?.prose);
      if (!prose) {
        continue;
      }

      group.importance = normalizeEnum(stop?.importance, IMPORTANCES, 'normal');
      group.prose = prose;
      stops.push(group);
      itemIds.add(group.id);
      seenStopHunkGroups.add(key);
      stopCount += 1;
      for (const hunkId of group.hunkIds) {
        coveredHunkIds.add(hunkId);
      }
    }

    if (stops.length === 0) {
      continue;
    }

    chapterIds.add(id);
    chapters.push({
      blurb: cleanText(chapter?.blurb),
      icon: normalizeEnum(chapter?.icon, ICONS, 'path'),
      id,
      stops,
      title: cleanText(chapter?.title, 'Chapter'),
    });
  }

  return { chapters, itemIds, stopCount };
};

const normalizeAuthoredSupport = (input, index, coveredHunkIds, itemIds) => {
  const support = [];
  const seenSupportHunkGroups = new Set();
  for (const item of Array.isArray(input?.support) ? input.support : []) {
    const group = normalizeHunkGroup(item, `support-${support.length + 1}`, index);
    if (!group || itemIds.has(group.id)) {
      continue;
    }

    const key = hunkGroupKey(group);
    if (
      seenSupportHunkGroups.has(key) ||
      group.hunkIds.some((hunkId) => coveredHunkIds.has(hunkId))
    ) {
      continue;
    }

    group.reason = group.hunkIds.every((hunkId) => index.generatedHunkIds.has(hunkId))
      ? 'Generated files'
      : cleanText(item?.reason, 'Other changes');
    const note = cleanText(item?.note);
    if (note) {
      group.note = note;
    }
    support.push(group);
    itemIds.add(group.id);
    seenSupportHunkGroups.add(key);
    for (const hunkId of group.hunkIds) {
      coveredHunkIds.add(hunkId);
    }
  }
  return support;
};

const addUnreferencedSupport = (support, index, coveredHunkIds, itemIds) => {
  const groupsByPath = new Map();
  const seenHunkIds = new Set();
  for (const hunk of index.hunkById.values()) {
    if (coveredHunkIds.has(hunk.id) || seenHunkIds.has(hunk.id)) {
      continue;
    }
    seenHunkIds.add(hunk.id);
    const groups = groupsByPath.get(hunk.path) || [];
    groups.push(hunk);
    groupsByPath.set(hunk.path, groups);
  }

  for (const [path, hunks] of groupsByPath) {
    for (let start = 0; start < hunks.length; start += MAX_HUNKS_PER_WALKTHROUGH_GROUP) {
      const chunk = hunks.slice(start, start + MAX_HUNKS_PER_WALKTHROUGH_GROUP);
      const lineCount = sumHunkLineCounts(chunk);
      let counter = support.length + 1;
      let id = `support-${counter}`;
      while (itemIds.has(id)) {
        counter += 1;
        id = `support-${counter}`;
      }
      support.push({
        added: lineCount.added,
        deleted: lineCount.deleted,
        hunkIds: chunk.map((hunk) => hunk.id),
        hunks: chunk.map(normalizeHunk),
        id,
        reason: chunk.every((hunk) => index.generatedHunkIds.has(hunk.id))
          ? 'Generated files'
          : 'Other changes',
        title: path,
      });
      itemIds.add(id);
      for (const hunk of chunk) {
        coveredHunkIds.add(hunk.id);
      }
    }
  }
};

const normalizeNarrativeWalkthrough = (input, files, facts = {}, hunkIdByAlias = new Map()) => {
  if (!input || typeof input !== 'object') {
    throw new Error('Narrative walkthrough is not an object.');
  }
  if (isLegacyV3Walkthrough(input)) {
    throw new Error(
      'Narrative walkthrough uses the legacy v3 anchors[] schema. Regenerate it with the v4 hunkIds[] schema for this diff.',
    );
  }

  const index = indexFiles(files, hunkIdByAlias);
  const coveredHunkIds = new Set();
  const { chapters, itemIds, stopCount } = normalizeChapters(input, index, coveredHunkIds);
  if (chapters.length === 0 || stopCount === 0) {
    throw new Error('Narrative walkthrough has no chapters with resolvable stops.');
  }

  const support = normalizeAuthoredSupport(input, index, coveredHunkIds, itemIds);
  addUnreferencedSupport(support, index, coveredHunkIds, itemIds);

  const branch = typeof facts.branch === 'string' || facts.branch === null ? facts.branch : null;
  const source =
    facts.source && typeof facts.source === 'object' ? facts.source : { type: 'working-tree' };

  /** @type {Record<string, unknown>} */
  const result = {
    agent: normalizeEnum(facts.agent, AGENTS, 'codex'),
    chapters,
    focus: cleanText(input.focus, 'Walk through the change.'),
    generatedAt: normalizeGeneratedAt(facts.generatedAt),
    kind: 'narrative',
    repo: {
      branch,
      root: oneLine(facts.root),
    },
    source,
    support,
    title: cleanText(input.title, 'Walkthrough'),
    version: 4,
  };

  result.meta = `${stopCount} stops · ${chapters.length} chapters`;
  if (facts.context && typeof facts.context === 'object') {
    result.context = facts.context;
  }

  // A commit composer only makes sense for a live staging set — never a past
  // commit, branch, or pull request. For working trees, always expose the
  // composer even when the agent did not draft a message, so the reviewer can
  // complete the whole workflow in Codiff.
  if (/** @type {{type?: string}} */ (result.source).type === 'working-tree') {
    /** @type {Record<string, unknown>} */
    const commit = {};
    const inputCommit = input.commit && typeof input.commit === 'object' ? input.commit : {};
    const rawBody = cleanRich(inputCommit.body);
    let title = cleanText(inputCommit.title);
    if (!title && rawBody) {
      const firstLine = rawBody
        .split(/\r?\n/)
        .find((line) => line.trim())
        ?.trim();
      if (firstLine && isCommitTitleLine(firstLine)) {
        title = firstLine;
      }
    }
    if (title) {
      commit.title = title;
    }
    const body = stripLeadingCommitTitle(rawBody, title);
    if (body) {
      commit.body = body;
    }
    result.commit = commit;
  }

  return /** @type {NarrativeWalkthrough} */ (result);
};

/** @param {DiffSection} section @param {number} remainingBudget @param {number} sectionPatchBudget */
const buildPatchExcerpt = (section, remainingBudget, sectionPatchBudget) => {
  const summary = section.summary?.reason ? `Summary: ${section.summary.reason}\n` : '';
  const maxLength = Math.max(0, Math.min(sectionPatchBudget, remainingBudget));
  const excerpt = `${summary}${section.patch || ''}` || '[patch omitted: no text patch available]';
  return excerpt.length <= maxLength
    ? excerpt
    : maxLength <= 1
      ? excerpt.slice(0, maxLength)
      : `${excerpt.slice(0, maxLength - 1)}…`;
};

/** @param {number} start @param {number} end */
const formatPromptLineRange = (start, end) => (start === end ? `${start}` : `${start}-${end}`);

/**
 * @param {ReturnType<typeof getSectionWalkthroughHunks>[number]} hunk
 * @param {string} id
 */
const buildPromptHunkInput = (hunk, id) => {
  if (isSyntheticWalkthroughHunk(hunk)) {
    return {
      added: hunk.added,
      deleted: hunk.deleted,
      id,
      kind: 'synthetic',
      summary: hunk.summary,
    };
  }

  return {
    added: hunk.added,
    deleted: hunk.deleted,
    header: hunk.header,
    id,
    kind: 'patch',
    newLines: formatPromptLineRange(hunk.additionStart, hunk.additionEnd),
    oldLines: formatPromptLineRange(hunk.deletionStart, hunk.deletionEnd),
  };
};

/** @param {number} fileCount */
const getPromptPatchBudgets = (fileCount) =>
  fileCount > 32
    ? {
        section: MAX_LARGE_SECTION_PATCH_CHARS,
        total: MAX_LARGE_TOTAL_PATCH_CHARS,
      }
    : {
        section: MAX_SECTION_PATCH_CHARS,
        total: MAX_TOTAL_PATCH_CHARS,
      };

/** @param {RepositoryState} state */
const buildPromptInput = (state) => {
  const patchBudget = getPromptPatchBudgets(state.files.length);
  const hunkIdByAlias = new Map();
  let nextHunkAlias = 1;
  let remainingPatchBudget = patchBudget.total;

  const input = {
    branch: state.branch,
    files: state.files.map((file) => {
      const generated = isGeneratedWalkthroughFile(file);
      return {
        ...(generated
          ? {
              generated: true,
              generatedReason:
                'Generated-like file; Codiff exposes each changed section as one synthetic hunk.',
            }
          : {}),
        oldPath: file.oldPath,
        path: file.path,
        sections: file.sections.map((section) => {
          const patchExcerpt = buildPatchExcerpt(
            section,
            remainingPatchBudget,
            patchBudget.section,
          );
          remainingPatchBudget = Math.max(0, remainingPatchBudget - patchExcerpt.length);
          const hunks = getSectionWalkthroughHunks(file, section).map((hunk) => {
            const alias = `h${nextHunkAlias}`;
            nextHunkAlias += 1;
            hunkIdByAlias.set(alias, hunk.id);
            return buildPromptHunkInput(hunk, alias);
          });

          return {
            binary: section.binary,
            hunks,
            id: section.id,
            kind: section.kind,
            loadState: section.loadState,
            patchExcerpt,
            summary: section.summary?.reason,
          };
        }),
        status: file.status,
      };
    }),
    generatedAt: state.generatedAt,
    root: state.root,
    source:
      state.source.type === 'pull-request' && typeof state.source.description === 'string'
        ? { ...state.source, description: truncate(state.source.description, MAX_PROSE_CHARS) }
        : state.source,
  };

  return { hunkIdByAlias, input };
};

const buildWalkthroughContextInput = (context, agentLabel) =>
  context
    ? `${agentLabel} conversation context:
${JSON.stringify(context, null, 2)}

Use this context as orientation for reviewer intent, implementation rationale, validation, and known risks.
Treat the repository change digest as the source of truth for what changed.
If the context and digest conflict, trust the digest.
`
    : '';

/** @param {unknown} customPrompt */
const buildCustomPromptInput = (customPrompt) => {
  const prompt = typeof customPrompt === 'string' ? customPrompt.trim() : '';

  return prompt
    ? `Custom walkthrough instructions:
${prompt}

Use these instructions to customize language, tone, and review detail. If they conflict with the JSON schema, repository digest, hunk ids, or review-order constraints above, keep Codiff's constraints and the digest as the source of truth.
`
    : '';
};

/** @param {RepositoryState} state */
const getWalkthroughSize = (state) => ({
  fileCount: state.files.length,
  hunkCount: state.files.reduce(
    (total, file) =>
      total +
      (file.sections || []).reduce(
        (sectionTotal, section) => sectionTotal + getSectionWalkthroughHunks(file, section).length,
        0,
      ),
    0,
  ),
});

/**
 * Small walkthroughs retain the normal agent timeout. Larger digests get more
 * time for hunk classification and structured output, capped at five minutes.
 *
 * @param {RepositoryState} state
 * @param {number} [minimumMs]
 */
const getNarrativeWalkthroughTimeoutMs = (state, minimumMs = BASE_WALKTHROUGH_TIMEOUT_MS) => {
  const { fileCount, hunkCount } = getWalkthroughSize(state);
  const estimatedMs =
    BASE_WALKTHROUGH_TIMEOUT_MS +
    Math.max(0, fileCount - INCLUDED_WALKTHROUGH_FILES) * TIMEOUT_MS_PER_EXTRA_FILE +
    Math.max(0, hunkCount - INCLUDED_WALKTHROUGH_HUNKS) * TIMEOUT_MS_PER_EXTRA_HUNK;

  return Math.min(MAX_WALKTHROUGH_TIMEOUT_MS, Math.max(minimumMs, estimatedMs));
};

const buildWalkthroughSizingGuidance = (state) => {
  const { fileCount, hunkCount } = getWalkthroughSize(state);
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
  const targetChapters =
    fileCount <= 2
      ? '1'
      : fileCount <= 4 && hunkCount <= 8
        ? '1-2'
        : `2-${MAX_WALKTHROUGH_CHAPTERS}`;
  const targetChapterInstruction =
    targetChapters === '1' ? '1 story chapter' : `${targetChapters} story chapters`;
  return `Coverage contract:
- The digest has ${fileCount} files and ${hunkCount} reviewable hunks. Put the highest-leverage review path in chapters[]; Codiff preserves everything else as support.
- Digest hunk ids are compact request-local aliases like h1 and h2. Return those aliases exactly; Codiff maps them back to stable live-diff ids.
- Define chapters[] in display order. Inside each chapter, define stops[] in display order.
- Use stable item ids like s1, s2, ... for main stops. Do not invent hunk ids.
- Default to one review idea per stop. Include multiple hunkIds when the hunks implement the same idea, especially in small diffs.

Grouping contract:
- Target ${targetStops} main-path stops and at most ${MAX_WALKTHROUGH_STOPS}. Prefer the low end when it still preserves distinct state transitions, submission paths, or runtime contracts.
- Use ${targetChapterInstruction}. A chapter is a conceptual group, not a file. For one- or two-file diffs, prefer one chapter unless there are clearly separate review phases.
- Chapter titles render in a compact top bar: keep each title to 1-2 short words and at most 16 characters, e.g. "UI", "CLI", "Tests", "Docs", "Runtime", "Cleanup".
- Every stop must have a concise semantic title that names the review idea in roughly 2-6 words, e.g. "Prevent duplicate payments" or "Preserve offline drafts". Never use a filename or path as a stop title.
- A stop may contain at most ${MAX_HUNKS_PER_WALKTHROUGH_GROUP} hunkIds. Use multiple hunkIds when the prose needs those hunks read together to understand one invariant, behavior, or repeated pattern.
- Generated-like files have "generated": true and one synthetic hunk per changed section. Never split them; main-path them only when they explain behavior, like snapshots proving output.
- For 1-4 total hunks, usually write 1-2 stops. Similar same-file hunks should usually be one stop with multiple hunkIds, not separate chapters or stops.
- Split distant same-file hunks into separate consecutive stops when they deserve separate prose. Do not make a chapter-sized stop.
- Do not group a whole large file into one stop when its hunks implement distinct workflows, state transitions, or submission paths.
- Put hunkIds in the exact display order you want Codiff to render. Out-of-line and cross-file order is allowed when it improves reviewer comprehension.
- Do not provide added/deleted counts, status, oldPath, section ids, display labels, path, repo, source, generatedAt, agent, or meta; Codiff computes those.
- Leave secondary, mechanical, docs-only, generated, styling, fixture, and repeated-pattern hunks out of chapters[]. Codiff automatically places every unreferenced hunk in support. Use reason "Generated files" for generated-only support items so they render together.
- For working-tree sources, include commit.title and commit.body by default unless there are no commit-worthy files. Put the subject line in commit.title, not as the first line of commit.body.
`;
};

const buildNarrativeWalkthroughRequest = (state, context, agentLabel = 'Codex', customPrompt) => {
  const { hunkIdByAlias, input } = buildPromptInput(state);
  return {
    hunkIdByAlias,
    prompt: `You are authoring Codiff's narrative walkthrough JSON.

Return JSON only. Do not inspect the repository or run shell commands; use only the optional conversation context and repository digest below.
If source.description is present, treat it as author-written PR/MR intent and orientation, not proof of behavior. The changed files, patches, and hunk data remain the source of truth for what changed.

${buildWalkthroughSizingGuidance(state)}

${buildWalkthroughContextInput(context, agentLabel)}
${buildCustomPromptInput(customPrompt)}
Repository change digest:
${JSON.stringify(input)}
`,
  };
};

const buildNarrativeWalkthroughPrompt = (state, context, agentLabel = 'Codex', customPrompt) =>
  buildNarrativeWalkthroughRequest(state, context, agentLabel, customPrompt).prompt;

const readNarrativeWalkthrough = async (state, agent, agentOptions, context, customPrompt) => {
  try {
    const timeoutMs = getNarrativeWalkthroughTimeoutMs(state, agent.defaultTimeoutMs);
    const { fileCount, hunkCount } = getWalkthroughSize(state);
    const { hunkIdByAlias, prompt } = buildNarrativeWalkthroughRequest(
      state,
      context,
      agent.label,
      customPrompt,
    );
    agentOptions?.onProgress?.('agent-generation');
    const response = await agent.run(
      state.root,
      prompt,
      narrativeWalkthroughResponseSchema,
      'walkthrough.json',
      `${agent.label} walkthrough timed out after ${Math.ceil(timeoutMs / 1_000)} seconds while processing ${fileCount} files and ${hunkCount} reviewable hunks.`,
      {
        ...agentOptions,
        reasoningEffort:
          agentOptions?.reasoningEffort ?? (agent.id === 'codex' ? 'low' : undefined),
        timeoutMs,
      },
    );
    agentOptions?.onProgress?.('response-received');
    const parsed = parseJSONMessage(response);
    const walkthrough = normalizeNarrativeWalkthrough(
      parsed,
      state.files,
      {
        agent: agent.id,
        branch: state.branch,
        generatedAt: state.generatedAt,
        root: state.root,
        source: state.source,
      },
      hunkIdByAlias,
    );
    if (context && !walkthrough.context) {
      walkthrough.context = context;
    }

    return {
      status: 'ready',
      walkthrough,
    };
  } catch (error) {
    if (agent.isNotFoundError(error)) {
      return {
        code: agent.notFoundCode,
        reason: error instanceof Error ? error.message : String(error),
        status: 'unavailable',
      };
    }

    return {
      reason: error instanceof Error ? error.message : String(error),
      status: 'unavailable',
    };
  }
};

module.exports = {
  buildNarrativeWalkthroughPrompt,
  getNarrativeWalkthroughTimeoutMs,
  narrativeWalkthroughResponseSchema,
  narrativeWalkthroughSchema,
  normalizeNarrativeWalkthrough,
  readNarrativeWalkthrough,
};
