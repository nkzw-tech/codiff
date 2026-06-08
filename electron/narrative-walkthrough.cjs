// @ts-check

// Validation, generation, and normalization for the Narrative Walkthrough
// (version 2) document. This module is the trust boundary: it validates and
// repairs agent-authored documents against the live diff so the renderer always
// gets a walkthrough whose references resolve.

const {
  cleanText,
  normalizeEnum,
  oneLine,
  parseJSONMessage,
  truncate,
} = require('./agent-shared.cjs');

/**
 * @typedef {import('../src/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../src/types.ts').DiffSection} DiffSection
 * @typedef {import('../src/types.ts').NarrativeWalkthrough} NarrativeWalkthrough
 * @typedef {import('../src/types.ts').NarrativeWalkthroughResult} NarrativeWalkthroughResult
 * @typedef {import('../src/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../src/types.ts').WalkthroughContext} WalkthroughContext
 * @typedef {import('./agent.cjs').Agent} Agent
 * @typedef {import('./agent.cjs').AgentOptions} AgentOptions
 */

const GRANULARITIES = new Set(['line', 'hunk', 'file']);
const IMPORTANCES = new Set(['critical', 'normal', 'context']);
const SIDES = new Set(['additions', 'deletions', 'both']);
const COMMENT_SIDES = new Set(['additions', 'deletions']);
const STATUSES = new Set(['added', 'deleted', 'modified', 'renamed', 'untracked']);
const ICONS = new Set(['bug', 'wrench', 'path', 'flask', 'beaker', 'doc', 'gear']);
const AGENTS = new Set(['codex', 'claude']);
const SECTION_KINDS = new Set(['commit', 'pull-request', 'staged', 'unstaged']);
const CHANGE_TYPES = new Set([
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

const MAX_PROSE_CHARS = 4_000;
const MAX_TOTAL_PATCH_CHARS = 60_000;
const MAX_LARGE_TOTAL_PATCH_CHARS = 35_000;
const MAX_SECTION_PATCH_CHARS = 2_500;
const MAX_LARGE_SECTION_PATCH_CHARS = 700;
const MAX_WALKTHROUGH_PHASES = 6;
const MAX_WALKTHROUGH_STOPS = 14;

const anchorTargetSchema = {
  additionalProperties: false,
  properties: {
    added: { type: 'number' },
    anchor: {
      additionalProperties: false,
      properties: {
        display: { type: 'string' },
        endLine: { type: 'number' },
        sectionId: { type: 'string' },
        sectionKind: { enum: [...SECTION_KINDS], type: 'string' },
        side: { enum: [...SIDES], type: 'string' },
        startLine: { type: 'number' },
      },
      required: ['display'],
      type: 'object',
    },
    changeType: { enum: [...CHANGE_TYPES], type: 'string' },
    comments: {
      items: {
        additionalProperties: false,
        properties: {
          author: { type: 'string' },
          body: { type: 'string' },
          id: { type: 'string' },
          lineNumber: { type: 'number' },
          side: { enum: [...COMMENT_SIDES], type: 'string' },
          startLineNumber: { type: 'number' },
          startSide: { enum: [...COMMENT_SIDES], type: 'string' },
        },
        required: ['id', 'body', 'side', 'lineNumber'],
        type: 'object',
      },
      type: 'array',
    },
    commitNote: { type: 'string' },
    deleted: { type: 'number' },
    granularity: { enum: [...GRANULARITIES], type: 'string' },
    id: { type: 'string' },
    oldPath: { type: 'string' },
    path: { type: 'string' },
    status: { enum: [...STATUSES], type: 'string' },
    summary: { type: 'string' },
    title: { type: 'string' },
  },
  required: ['id', 'path', 'status', 'granularity', 'anchor', 'added', 'deleted'],
  type: 'object',
};

// The narrative walkthrough JSON schema, kept in sync with src/walkthrough/
// narrative-walkthrough.schema.json. Authoring agents constrain output to it; the
// renderer trusts only the normalized result, not the raw schema-valid input.
const narrativeWalkthroughSchema = {
  additionalProperties: false,
  properties: {
    agent: { enum: ['codex', 'claude'], type: 'string' },
    chapters: {
      items: {
        additionalProperties: false,
        properties: {
          blurb: { type: 'string' },
          icon: { enum: [...ICONS], type: 'string' },
          id: { type: 'string' },
          stops: {
            items: {
              additionalProperties: false,
              properties: {
                anchors: {
                  items: anchorTargetSchema,
                  maxItems: 8,
                  type: 'array',
                },
                body: { type: 'string' },
                id: { type: 'string' },
                importance: { enum: [...IMPORTANCES], type: 'string' },
                summary: { type: 'string' },
                title: { type: 'string' },
              },
              required: ['id', 'title', 'summary', 'body', 'importance', 'anchors'],
              type: 'object',
            },
            maxItems: MAX_WALKTHROUGH_STOPS,
            type: 'array',
          },
          title: { maxLength: 16, type: 'string' },
        },
        required: ['id', 'title', 'icon', 'blurb', 'stops'],
        type: 'object',
      },
      maxItems: MAX_WALKTHROUGH_PHASES,
      type: 'array',
    },
    commit: {
      additionalProperties: false,
      properties: {
        body: { type: 'string' },
        title: { type: 'string' },
      },
      type: 'object',
    },
    context: { type: 'object' },
    focus: { type: 'string' },
    generatedAt: { type: 'string' },
    kind: { const: 'narrative', type: 'string' },
    meta: { type: 'string' },
    repo: {
      additionalProperties: false,
      properties: {
        branch: { type: ['string', 'null'] },
        root: { type: 'string' },
      },
      required: ['root', 'branch'],
      type: 'object',
    },
    source: { type: 'object' },
    support: {
      items: {
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          files: {
            items: anchorTargetSchema,
            type: 'array',
          },
          note: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['id', 'title', 'files'],
        type: 'object',
      },
      type: 'array',
    },
    title: { type: 'string' },
    version: { const: 3, type: 'number' },
  },
  required: ['version', 'kind', 'agent', 'title', 'focus', 'repo', 'source', 'chapters', 'support'],
  type: 'object',
};

const toArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);

/**
 * OpenAI structured outputs require every object key to be listed in `required`.
 * Keep Codiff's public schema ergonomic, and derive the stricter response-format
 * schema only for agent calls. Originally optional properties become nullable.
 * @param {any} schema
 * @param {boolean} [optional]
 */
const strictResponseSchema = (schema, optional = false) => {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema;
  }

  const next = { ...schema };
  const typeValues = toArray(next.type);
  const isObject = typeValues.includes('object') || next.properties;

  if (next.properties && typeof next.properties === 'object') {
    const originalRequired = new Set(Array.isArray(next.required) ? next.required : []);
    const properties = {};
    for (const [key, value] of Object.entries(next.properties)) {
      properties[key] = strictResponseSchema(value, !originalRequired.has(key));
    }
    next.properties = properties;
  }

  if (next.items) {
    next.items = strictResponseSchema(next.items, false);
  }

  if (isObject) {
    next.additionalProperties = false;
    next.required = Object.keys(next.properties || {});
  }

  if (optional) {
    if (next.type) {
      next.type = [...new Set([...toArray(next.type), 'null'])];
    } else if (next.const !== undefined) {
      next.anyOf = [{ const: next.const }, { type: 'null' }];
      delete next.const;
    }
  }

  return next;
};

/**
 * @param {any} schema
 * @param {ReadonlyArray<string>} keys
 */
const omitSchemaProperties = (schema, keys) => {
  const next = {
    ...schema,
    properties: { ...schema.properties },
  };
  for (const key of keys) {
    delete next.properties[key];
  }
  next.required = (Array.isArray(schema.required) ? schema.required : []).filter(
    (key) => !keys.includes(key),
  );
  return next;
};

const narrativeWalkthroughResponseSchema = strictResponseSchema(
  omitSchemaProperties(narrativeWalkthroughSchema, ['context', 'source']),
);

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
const coerceLine = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;

/** @param {unknown} value */
const coerceCount = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

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

/** @param {ReadonlyArray<ChangedFile>} files */
const indexFiles = (files) => {
  const byPath = new Map();
  for (const file of files) {
    const sections = (file.sections || []).map((section) => ({
      id: section.id,
      kind: section.kind,
    }));
    byPath.set(file.path, {
      firstSection: sections[0],
      oldPath: file.oldPath,
      sectionById: new Map(sections.map((section) => [section.id, section])),
      sections,
      status: file.status,
    });
  }

  return byPath;
};

/**
 * Pin an anchor to a real DiffSection for `path`, repairing a missing or stale
 * sectionId. Prefers a section whose kind matches the requested sectionKind.
 * @param {any} anchor @param {ReturnType<typeof indexFiles> extends Map<any, infer V> ? V : never} entry @param {string} status @param {string} granularity
 */
const normalizeAnchor = (anchor, entry, status, granularity) => {
  const requestedId = oneLine(anchor?.sectionId);
  const requestedKind = normalizeEnum(anchor?.sectionKind, SECTION_KINDS, undefined);

  let section = requestedId ? entry.sectionById.get(requestedId) : undefined;
  if (!section && requestedKind) {
    section = entry.sections.find((candidate) => candidate.kind === requestedKind);
  }
  if (!section) {
    section = entry.firstSection;
  }

  const side = normalizeEnum(anchor?.side, SIDES, defaultSideForStatus(status));
  const startLine = granularity === 'file' ? undefined : coerceLine(anchor?.startLine);
  const endLine = granularity === 'file' ? undefined : coerceLine(anchor?.endLine);

  /** @type {Record<string, unknown>} */
  const normalized = {
    display: cleanText(anchor?.display),
    side,
  };
  if (section) {
    normalized.sectionId = section.id;
    normalized.sectionKind = section.kind;
  }
  if (startLine !== undefined) {
    normalized.startLine = startLine;
  }
  if (endLine !== undefined) {
    normalized.endLine = endLine;
  }

  return normalized;
};

/** @param {any} comment */
const normalizeComment = (comment, index) => {
  const lineNumber = coerceLine(comment?.lineNumber);
  if (lineNumber === undefined) {
    return null;
  }

  /** @type {Record<string, unknown>} */
  const normalized = {
    body: typeof comment?.body === 'string' ? comment.body : '',
    id: oneLine(comment?.id) || `c${index + 1}`,
    lineNumber,
    side: normalizeEnum(comment?.side, COMMENT_SIDES, 'additions'),
  };

  const author = oneLine(comment?.author);
  if (author) {
    normalized.author = author;
  }
  const startLineNumber = coerceLine(comment?.startLineNumber);
  if (startLineNumber !== undefined) {
    normalized.startLineNumber = startLineNumber;
  }
  const startSide = normalizeEnum(comment?.startSide, COMMENT_SIDES, undefined);
  if (startSide) {
    normalized.startSide = startSide;
  }

  return normalized;
};

/** @param {any} segment */
const getSegmentAnchor = (segment) => {
  if (segment?.anchor && typeof segment.anchor === 'object') {
    return segment.anchor;
  }

  return {
    display: oneLine(segment?.display) || oneLine(segment?.path),
    endLine: segment?.endLine,
    sectionId: segment?.sectionId,
    sectionKind: segment?.sectionKind,
    side: segment?.side,
    startLine: segment?.startLine,
  };
};

/**
 * @param {ReadonlyArray<any>} targets
 * @param {ReadonlyArray<ChangedFile>} files
 * @param {Set<string>} usedIds
 * @param {Set<string>} usedPaths
 */
const normalizeAnchorTargets = (targets, files, usedIds, usedPaths) => {
  const byPath = indexFiles(files);
  const normalizedTargets = [];

  for (const segment of Array.isArray(targets) ? targets : []) {
    const id = oneLine(segment?.id);
    const path = oneLine(segment?.path);
    const entry = byPath.get(path);
    if (!id || usedIds.has(id) || usedPaths.has(path) || !entry) {
      // Drop unidentified, duplicate, or stale-path anchors.
      continue;
    }

    const granularity = normalizeEnum(segment?.granularity, GRANULARITIES, 'hunk');
    const status = normalizeEnum(segment?.status, STATUSES, entry.status);

    /** @type {Record<string, unknown>} */
    const normalized = {
      added: coerceCount(segment?.added),
      anchor: normalizeAnchor(getSegmentAnchor(segment), entry, status, granularity),
      deleted: coerceCount(segment?.deleted),
      granularity,
      id,
      path,
      status,
    };

    const oldPath = oneLine(segment?.oldPath) || entry.oldPath;
    if (oldPath) {
      normalized.oldPath = oldPath;
    }
    const title = cleanText(segment?.title);
    if (title) {
      normalized.title = title;
    }
    const summary = cleanText(segment?.summary);
    if (summary) {
      normalized.summary = summary;
    }
    const changeType = normalizeEnum(segment?.changeType, CHANGE_TYPES, undefined);
    if (changeType) {
      normalized.changeType = changeType;
    }
    const commitNote = cleanText(segment?.commitNote);
    if (commitNote) {
      normalized.commitNote = commitNote;
    }
    const comments = (Array.isArray(segment?.comments) ? segment.comments : [])
      .map((comment, index) => normalizeComment(comment, index))
      .filter(Boolean);
    if (comments.length > 0) {
      normalized.comments = comments;
    }

    normalizedTargets.push(normalized);
    usedIds.add(id);
    usedPaths.add(path);
  }

  return normalizedTargets;
};

/**
 * @param {any} input
 * @param {ReadonlyArray<ChangedFile>} files
 */
const normalizeChapters = (input, files, usedIds, usedPaths) => {
  const chapters = [];
  const chapterIds = new Set();
  const stopIds = new Set();
  let stopCount = 0;

  for (const [chapterIndex, chapter] of (Array.isArray(input?.chapters)
    ? input.chapters
    : []
  ).entries()) {
    if (chapters.length >= MAX_WALKTHROUGH_PHASES) {
      break;
    }
    const id = oneLine(chapter?.id) || `chapter-${chapterIndex + 1}`;
    if (chapterIds.has(id)) {
      continue;
    }

    const stops = [];
    for (const [stopIndex, stop] of (Array.isArray(chapter?.stops)
      ? chapter.stops
      : []
    ).entries()) {
      if (stopCount >= MAX_WALKTHROUGH_STOPS) {
        break;
      }
      const stopId = oneLine(stop?.id) || `${id}-stop-${stopIndex + 1}`;
      if (stopIds.has(stopId)) {
        continue;
      }
      const anchors = normalizeAnchorTargets(stop?.anchors, files, usedIds, usedPaths);
      if (anchors.length === 0) {
        continue;
      }
      stopIds.add(stopId);
      stopCount += 1;
      const title =
        cleanText(stop?.title) ||
        cleanText(anchors[0]?.title) ||
        cleanText(anchors[0]?.path) ||
        `Stop ${stopCount}`;
      const summary = cleanText(stop?.summary) || cleanText(anchors[0]?.summary) || title;
      stops.push({
        anchors,
        body: cleanRich(stop?.body || stop?.prose || summary),
        id: stopId,
        importance: normalizeEnum(stop?.importance, IMPORTANCES, 'normal'),
        summary,
        title,
      });
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
      title: cleanText(chapter?.title, 'Review'),
    });
  }

  return chapters;
};

/**
 * @param {any} input
 * @param {ReadonlyArray<ChangedFile>} files
 * @param {Set<string>} usedIds
 * @param {Set<string>} usedPaths
 */
const normalizeSupport = (input, files, usedIds, usedPaths) => {
  const groups = [];
  const groupIds = new Set();

  for (const [groupIndex, group] of (Array.isArray(input?.support)
    ? input.support
    : []
  ).entries()) {
    const id = oneLine(group?.id) || `support-${groupIndex + 1}`;
    if (groupIds.has(id)) {
      continue;
    }
    const filesForGroup = normalizeAnchorTargets(group?.files, files, usedIds, usedPaths);
    if (filesForGroup.length === 0) {
      continue;
    }
    groupIds.add(id);
    groups.push({
      files: filesForGroup,
      id,
      note: cleanText(group?.note),
      title: cleanText(group?.title, 'Other changes'),
    });
  }

  return groups;
};

/**
 * @param {ReadonlyArray<ChangedFile>} files
 * @param {ReadonlyArray<any>} chapters
 * @param {Array<any>} support
 */
const addMissingFilesToSupport = (files, chapters, support) => {
  const coveredPaths = new Set();
  for (const chapter of chapters) {
    for (const stop of chapter.stops || []) {
      for (const target of stop.anchors || []) {
        coveredPaths.add(target.path);
      }
    }
  }
  for (const group of support) {
    for (const target of group.files || []) {
      coveredPaths.add(target.path);
    }
  }

  const missing = [];
  for (const file of files) {
    if (coveredPaths.has(file.path)) {
      continue;
    }
    const section = file.sections?.[0];
    const totals = (file.sections || []).reduce(
      (sum, section) => {
        const count = countPatchLines(section.patch || '');
        return { added: sum.added + count.added, deleted: sum.deleted + count.deleted };
      },
      { added: 0, deleted: 0 },
    );
    missing.push({
      added: totals.added,
      anchor: normalizeAnchor(
        { display: file.path, sectionId: section?.id, sectionKind: section?.kind },
        {
          firstSection: section,
          oldPath: file.oldPath,
          sectionById: new Map((file.sections || []).map((section) => [section.id, section])),
          sections: (file.sections || []).map((section) => ({
            id: section.id,
            kind: section.kind,
          })),
          status: file.status,
        },
        file.status,
        'file',
      ),
      deleted: totals.deleted,
      granularity: 'file',
      id: `__file:${file.path}`,
      oldPath: file.oldPath,
      path: file.path,
      status: normalizeEnum(file.status, STATUSES, 'modified'),
      summary: 'Not included in the generated walkthrough.',
    });
  }

  if (missing.length > 0) {
    support.push({
      files: missing,
      id: '__missing',
      note: 'Not included in the generated walkthrough.',
      title: 'Other changes',
    });
  }
};

/**
 * Validate and repair a narrative walkthrough against the current diff.
 * @param {any} input
 * @param {ReadonlyArray<ChangedFile>} files
 * @returns {NarrativeWalkthrough}
 */
const normalizeNarrativeWalkthrough = (input, files) => {
  if (!input || typeof input !== 'object') {
    throw new Error('Narrative walkthrough is not an object.');
  }

  const usedIds = new Set();
  const usedPaths = new Set();
  const chapters = normalizeChapters(input, files, usedIds, usedPaths);
  const support = normalizeSupport(input, files, usedIds, usedPaths);
  addMissingFilesToSupport(files, chapters, support);

  if (chapters.length === 0 && support.length === 0) {
    throw new Error('Narrative walkthrough has no anchors that match the current diff.');
  }

  const branch =
    typeof input.repo?.branch === 'string' || input.repo?.branch === null
      ? input.repo.branch
      : null;

  /** @type {Record<string, unknown>} */
  const result = {
    agent: normalizeEnum(input.agent, AGENTS, 'claude'),
    focus: cleanText(input.focus, 'Walk through the change.'),
    generatedAt: oneLine(input.generatedAt),
    chapters,
    kind: 'narrative',
    repo: {
      branch,
      root: oneLine(input.repo?.root),
    },
    source:
      input.source && typeof input.source === 'object' ? input.source : { type: 'working-tree' },
    support,
    title: cleanText(input.title, 'Walkthrough'),
    version: 3,
  };

  const meta = cleanText(input.meta);
  if (meta) {
    result.meta = meta;
  }
  if (input.context && typeof input.context === 'object') {
    result.context = input.context;
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
    let title = cleanText(inputCommit.title || inputCommit.subjectSeed);
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

/** @param {DiffSection} section @param {number} remainingBudget */
const buildPatchExcerpt = (section, remainingBudget, sectionPatchBudget) => {
  const summary = section.summary?.reason ? `Summary: ${section.summary.reason}\n` : '';
  const patch = section.patch || '';
  const maxLength = Math.max(0, Math.min(sectionPatchBudget, remainingBudget - summary.length));

  if (maxLength === 0) {
    return summary || '[patch omitted: budget exhausted]';
  }

  return `${summary}${truncate(patch, maxLength)}`;
};

/** @param {string} patch */
const countPatchLines = (patch) => {
  let added = 0;
  let deleted = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      added += 1;
    } else if (line.startsWith('-')) {
      deleted += 1;
    }
  }

  return { added, deleted };
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
  let remainingPatchBudget = patchBudget.total;

  return {
    branch: state.branch,
    commit: state.commitMetadata
      ? {
          stats: state.commitMetadata.stats,
          subject: state.commitMetadata.subject,
        }
      : undefined,
    files: state.files.map((file, index) => {
      let added = 0;
      let deleted = 0;
      const sections = file.sections.map((section) => {
        const stats = countPatchLines(section.patch || '');
        added += stats.added;
        deleted += stats.deleted;
        const patchExcerpt = buildPatchExcerpt(section, remainingPatchBudget, patchBudget.section);
        remainingPatchBudget = Math.max(0, remainingPatchBudget - patchExcerpt.length);

        return {
          binary: section.binary,
          id: section.id,
          kind: section.kind,
          patchExcerpt,
          summary: section.summary?.reason,
        };
      });

      return {
        added,
        deleted,
        index: index + 1,
        oldPath: file.oldPath,
        path: file.path,
        sections,
        status: file.status,
      };
    }),
    generatedAt: state.generatedAt,
    root: state.root,
    source: state.source,
  };
};

/** @param {WalkthroughContext | null | undefined} context @param {string} agentLabel */
const buildWalkthroughContextInput = (context, agentLabel) =>
  context
    ? `${agentLabel} conversation context:
${JSON.stringify(context, null, 2)}

Use this context as orientation for reviewer intent, implementation rationale, validation, and known risks.
Treat the repository change digest as the source of truth for what changed.
If the context and digest conflict, trust the digest.
`
    : '';

/** @param {RepositoryState} state */
const buildWalkthroughSizingGuidance = (state) => {
  const fileCount = state.files.length;
  const targetStops = fileCount <= 6 ? '3-6' : fileCount <= 16 ? '5-9' : '7-12';
  return `Coverage contract:
- The digest has ${fileCount} files. Every file must appear exactly once in either a stop anchor or support.files.
- Create anchor ids a1, a2, ... in digest.files order. Do not skip files. Do not invent files.
- Use file granularity for broad file-level changes. Use hunk or line only for a truly pinpointed change.
- Do not add comments unless there is an explicit review-comment need.

Grouping contract:
- Target ${targetStops} main-path stops and at most ${MAX_WALKTHROUGH_STOPS}.
- Use 2-${MAX_WALKTHROUGH_PHASES} chapters. Chapter titles render in a compact top bar: 1-2 short words and at most 16 characters, e.g. "UI", "CLI", "Tests", "Docs", "Runtime", "Cleanup".
- Do not create one stop per file. Each stop should name one review idea and can include up to 8 anchors for files that belong to that idea.
- Put generated files, lockfiles, snapshots, broad CSS churn, deleted legacy files, and repeated mechanical edits into support[] unless they are essential to the main review path.
- Prefer fewer stronger stops over exhaustive prose.
- Keep stop.summary to one concrete sentence. Keep stop.body short and specific. Do not use generic filler, broad assurance language, meta-explanatory labels, or markdown headings.
- For working-tree sources, include commit.title and commit.body by default unless there are no commit-worthy files. Put the subject line in commit.title, not as the first line of commit.body.
`;
};

/** @param {RepositoryState} state @param {WalkthroughContext | null | undefined} [context] @param {string} [agentLabel] */
const buildNarrativeWalkthroughPrompt = (
  state,
  context,
  agentLabel = 'Codex',
) => `You are authoring Codiff's narrative walkthrough JSON.

Return JSON only and match the provided schema exactly. Do not inspect the repository or run shell commands; use only the optional conversation context and repository digest below.

${buildWalkthroughSizingGuidance(state)}

${buildWalkthroughContextInput(context, agentLabel)}
Repository change digest:
${JSON.stringify(buildPromptInput(state))}
`;

/**
 * @param {RepositoryState} state
 * @param {Agent} agent
 * @param {AgentOptions} agentOptions
 * @param {WalkthroughContext | null | undefined} [context]
 * @returns {Promise<NarrativeWalkthroughResult>}
 */
const readNarrativeWalkthrough = async (state, agent, agentOptions, context) => {
  try {
    const response = await agent.run(
      state.root,
      buildNarrativeWalkthroughPrompt(state, context, agent.label),
      narrativeWalkthroughResponseSchema,
      'walkthrough.json',
      `${agent.label} walkthrough timed out.`,
      { ...agentOptions, reasoningEffort: 'low' },
    );
    const parsed = parseJSONMessage(response);
    const normalizedInput =
      parsed && typeof parsed === 'object'
        ? {
            ...parsed,
            ...(context ? { context } : {}),
            source: state.source,
          }
        : parsed;
    const walkthrough = normalizeNarrativeWalkthrough(normalizedInput, state.files);
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
  narrativeWalkthroughResponseSchema,
  narrativeWalkthroughSchema,
  normalizeNarrativeWalkthrough,
  readNarrativeWalkthrough,
};
