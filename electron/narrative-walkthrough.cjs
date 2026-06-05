// @ts-check

// Validation + normalization for the Narrative Walkthrough (version 2) document.
// A narrative walkthrough is authored outside Codiff (by the /walkthrough skill)
// and handed in as a file. This module is the trust boundary: it validates the
// structure and *repairs* it against the live diff so the renderer always gets a
// document whose every reference resolves — unknown segments are dropped, stale
// paths are removed, and each anchor is pinned to a real DiffSection.

const { cleanText, normalizeEnum, oneLine } = require('./agent-shared.cjs');

/**
 * @typedef {import('../src/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../src/types.ts').NarrativeWalkthrough} NarrativeWalkthrough
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

// The narrative walkthrough JSON schema, kept in sync with src/walkthrough/
// narrative-walkthrough.schema.json. Authoring agents constrain output to it; the
// renderer trusts only the normalized result, not the raw schema-valid input.
const narrativeWalkthroughSchema = {
  additionalProperties: false,
  properties: {
    agent: { enum: ['codex', 'claude'], type: 'string' },
    commit: {
      additionalProperties: false,
      properties: {
        body: { type: 'string' },
        subjectSeed: { type: 'string' },
      },
      type: 'object',
    },
    context: { type: 'object' },
    defaultOrder: { type: 'string' },
    focus: { type: 'string' },
    generatedAt: { type: 'string' },
    kind: { const: 'narrative', type: 'string' },
    meta: { type: 'string' },
    orders: {
      items: {
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          phases: {
            items: {
              additionalProperties: false,
              properties: {
                blurb: { type: 'string' },
                icon: { enum: [...ICONS], type: 'string' },
                id: { type: 'string' },
                n: { type: 'number' },
                title: { type: 'string' },
              },
              required: ['id', 'title', 'icon', 'blurb'],
              type: 'object',
            },
            type: 'array',
          },
          rest: {
            items: {
              additionalProperties: false,
              properties: {
                note: { type: 'string' },
                reason: { type: 'string' },
                segmentId: { type: 'string' },
              },
              required: ['segmentId', 'reason'],
              type: 'object',
            },
            type: 'array',
          },
          restBlurb: { type: 'string' },
          restLabel: { type: 'string' },
          sequence: {
            items: {
              additionalProperties: false,
              properties: {
                importance: { enum: [...IMPORTANCES], type: 'string' },
                phaseId: { type: 'string' },
                prose: { type: 'string' },
                segmentId: { type: 'string' },
                title: { type: 'string' },
              },
              required: ['segmentId', 'phaseId', 'importance', 'prose'],
              type: 'object',
            },
            type: 'array',
          },
          tagline: { type: 'string' },
        },
        required: [
          'id',
          'label',
          'tagline',
          'phases',
          'sequence',
          'rest',
          'restLabel',
          'restBlurb',
        ],
        type: 'object',
      },
      type: 'array',
    },
    repo: {
      additionalProperties: false,
      properties: {
        branch: { type: ['string', 'null'] },
        root: { type: 'string' },
      },
      required: ['root', 'branch'],
      type: 'object',
    },
    segments: {
      items: {
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
      },
      type: 'array',
    },
    source: { type: 'object' },
    title: { type: 'string' },
    version: { const: 2, type: 'number' },
  },
  required: [
    'version',
    'kind',
    'agent',
    'title',
    'focus',
    'repo',
    'source',
    'segments',
    'orders',
    'defaultOrder',
  ],
  type: 'object',
};

/** @param {unknown} value @param {string} [fallback] */
const cleanRich = (value, fallback = '') => {
  const text = typeof value === 'string' ? value : fallback;
  const trimmed = text.trim();
  if (trimmed.length <= MAX_PROSE_CHARS) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_PROSE_CHARS)}…`;
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

/** @param {any} input @param {ReadonlyArray<ChangedFile>} files */
const normalizeSegments = (input, files) => {
  const byPath = indexFiles(files);
  const segments = [];
  const segmentIds = new Set();

  for (const segment of Array.isArray(input?.segments) ? input.segments : []) {
    const id = oneLine(segment?.id);
    const path = oneLine(segment?.path);
    const entry = byPath.get(path);
    if (!id || segmentIds.has(id) || !entry) {
      // Drop unidentified, duplicate, or stale-path segments.
      continue;
    }

    const granularity = normalizeEnum(segment?.granularity, GRANULARITIES, 'hunk');
    const status = normalizeEnum(segment?.status, STATUSES, entry.status);

    /** @type {Record<string, unknown>} */
    const normalized = {
      added: coerceCount(segment?.added),
      anchor: normalizeAnchor(segment?.anchor, entry, status, granularity),
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

    segments.push(normalized);
    segmentIds.add(id);
  }

  return { segmentIds, segments };
};

/** @param {any} order @param {ReadonlySet<string>} segmentIds */
const normalizeOrder = (order, segmentIds) => {
  const phases = [];
  const phaseIds = new Set();
  let n = 0;
  for (const phase of Array.isArray(order?.phases) ? order.phases : []) {
    const id = oneLine(phase?.id);
    if (!id || phaseIds.has(id)) {
      continue;
    }

    n += 1;
    phaseIds.add(id);
    phases.push({
      blurb: cleanText(phase?.blurb),
      icon: normalizeEnum(phase?.icon, ICONS, 'path'),
      id,
      n,
      title: cleanText(phase?.title, 'Chapter'),
    });
  }

  const fallbackPhaseId = phases[0]?.id;
  const sequence = [];
  const placedSegments = new Set();
  for (const stop of Array.isArray(order?.sequence) ? order.sequence : []) {
    const segmentId = oneLine(stop?.segmentId);
    if (!segmentIds.has(segmentId) || placedSegments.has(segmentId)) {
      continue;
    }

    const phaseId = phaseIds.has(oneLine(stop?.phaseId)) ? oneLine(stop?.phaseId) : fallbackPhaseId;
    if (!phaseId) {
      continue;
    }

    placedSegments.add(segmentId);
    /** @type {Record<string, unknown>} */
    const normalized = {
      importance: normalizeEnum(stop?.importance, IMPORTANCES, 'normal'),
      phaseId,
      prose: cleanRich(stop?.prose),
      segmentId,
    };
    const title = cleanText(stop?.title);
    if (title) {
      normalized.title = title;
    }
    sequence.push(normalized);
  }

  if (sequence.length === 0) {
    return null;
  }

  const rest = [];
  const restSegments = new Set();
  for (const item of Array.isArray(order?.rest) ? order.rest : []) {
    const segmentId = oneLine(item?.segmentId);
    if (!segmentIds.has(segmentId) || restSegments.has(segmentId)) {
      continue;
    }

    restSegments.add(segmentId);
    /** @type {Record<string, unknown>} */
    const normalized = {
      reason: cleanText(item?.reason, 'Other'),
      segmentId,
    };
    const note = cleanText(item?.note);
    if (note) {
      normalized.note = note;
    }
    rest.push(normalized);
  }

  // Phases with no surviving stops are noise; keep only referenced ones.
  const usedPhaseIds = new Set(sequence.map((stop) => stop.phaseId));
  const usedPhases = phases
    .filter((phase) => usedPhaseIds.has(phase.id))
    .map((phase, index) => ({ ...phase, n: index + 1 }));

  return {
    id: oneLine(order?.id) || 'order',
    label: cleanText(order?.label, 'Walkthrough'),
    phases: usedPhases,
    rest,
    restBlurb: cleanText(order?.restBlurb, 'Changed alongside the work but off the path.'),
    restLabel: cleanText(order?.restLabel, 'Not in the arc'),
    sequence,
    tagline: cleanText(order?.tagline),
  };
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

  const { segmentIds, segments } = normalizeSegments(input, files);
  if (segments.length === 0) {
    throw new Error('Narrative walkthrough has no segments that match the current diff.');
  }

  const orders = [];
  const orderIds = new Set();
  for (const order of Array.isArray(input.orders) ? input.orders : []) {
    const normalized = normalizeOrder(order, segmentIds);
    if (!normalized || orderIds.has(normalized.id)) {
      continue;
    }

    orderIds.add(normalized.id);
    orders.push(normalized);
  }

  if (orders.length === 0) {
    throw new Error('Narrative walkthrough has no orders with resolvable stops.');
  }

  const defaultOrder = orderIds.has(oneLine(input.defaultOrder))
    ? oneLine(input.defaultOrder)
    : orders[0].id;

  const branch =
    typeof input.repo?.branch === 'string' || input.repo?.branch === null
      ? input.repo.branch
      : null;

  /** @type {Record<string, unknown>} */
  const result = {
    agent: normalizeEnum(input.agent, AGENTS, 'claude'),
    defaultOrder,
    focus: cleanText(input.focus, 'Walk through the change.'),
    generatedAt: oneLine(input.generatedAt),
    kind: 'narrative',
    orders,
    repo: {
      branch,
      root: oneLine(input.repo?.root),
    },
    segments,
    source:
      input.source && typeof input.source === 'object' ? input.source : { type: 'working-tree' },
    title: cleanText(input.title, 'Walkthrough'),
    version: 2,
  };

  const meta = cleanText(input.meta);
  if (meta) {
    result.meta = meta;
  }
  if (input.context && typeof input.context === 'object') {
    result.context = input.context;
  }

  // A commit composer only makes sense for a live staging set — never a past
  // commit, branch, or pull request — so honor `commit` only for a working tree.
  if (
    input.commit &&
    typeof input.commit === 'object' &&
    /** @type {{type?: string}} */ (result.source).type === 'working-tree'
  ) {
    /** @type {Record<string, unknown>} */
    const commit = {};
    const subjectSeed = cleanText(input.commit.subjectSeed);
    if (subjectSeed) {
      commit.subjectSeed = subjectSeed;
    }
    const body = cleanRich(input.commit.body);
    if (body) {
      commit.body = body;
    }
    result.commit = commit;
  }

  return /** @type {NarrativeWalkthrough} */ (result);
};

module.exports = {
  narrativeWalkthroughSchema,
  normalizeNarrativeWalkthrough,
};
