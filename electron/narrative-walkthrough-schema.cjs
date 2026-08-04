// @ts-check

const IMPORTANCES = new Set(['critical', 'normal', 'context']);
const ICONS = new Set(['bug', 'wrench', 'path', 'flask', 'beaker', 'doc', 'gear']);
const AGENTS = new Set(['codex', 'claude', 'opencode', 'pi']);
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

const MAX_WALKTHROUGH_CHAPTERS = 6;
const MAX_WALKTHROUGH_STOPS = 14;
const MAX_HUNKS_PER_WALKTHROUGH_GROUP = 14;

const hunkGroupProperties = {
  changeType: { enum: [...CHANGE_TYPES], type: 'string' },
  commitNote: { type: 'string' },
  hunkIds: {
    items: { type: 'string' },
    maxItems: MAX_HUNKS_PER_WALKTHROUGH_GROUP,
    minItems: 1,
    type: 'array',
  },
  id: { type: 'string' },
  notes: {
    description:
      'Optional short header notes for selected hunk ids. Codiff renders each note under that focused diff header.',
    items: {
      additionalProperties: false,
      properties: {
        body: { type: 'string' },
        hunkId: { type: 'string' },
      },
      required: ['hunkId', 'body'],
      type: 'object',
    },
    type: 'array',
  },
  summary: { type: 'string' },
  title: { type: 'string' },
};

const regionProperties = {
  endLine: { maximum: 1_000_000_000, minimum: 1, type: 'number' },
  hunkId: { type: 'string' },
  id: { type: 'string' },
  side: { enum: ['additions', 'deletions'], type: 'string' },
  startLine: { maximum: 1_000_000_000, minimum: 1, type: 'number' },
  title: { maxLength: 120, type: 'string' },
  tooltip: { maxLength: 600, type: 'string' },
};

// Keep in sync with core/walkthrough/narrative-walkthrough.schema.json;
// electron/__tests__/narrative-walkthrough.test.ts enforces equality.
// Authoring agents constrain output to it; the renderer trusts only the
// normalized result, not the raw schema-valid input.
const narrativeWalkthroughSchema = {
  additionalProperties: false,
  properties: {
    commit: {
      additionalProperties: false,
      properties: {
        body: { type: 'string' },
        title: { type: 'string' },
      },
      type: 'object',
    },
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
                ...hunkGroupProperties,
                importance: { enum: [...IMPORTANCES], type: 'string' },
                prose: { type: 'string' },
                regions: {
                  items: {
                    additionalProperties: false,
                    properties: regionProperties,
                    required: ['id', 'hunkId', 'side', 'startLine', 'endLine', 'title', 'tooltip'],
                    type: 'object',
                  },
                  maxItems: 4,
                  type: 'array',
                },
              },
              required: ['id', 'hunkIds', 'importance', 'prose'],
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
      maxItems: MAX_WALKTHROUGH_CHAPTERS,
      type: 'array',
    },
    focus: { type: 'string' },
    kind: { const: 'narrative', type: 'string' },
    support: {
      items: {
        additionalProperties: false,
        properties: {
          ...hunkGroupProperties,
          note: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['id', 'hunkIds', 'reason'],
        type: 'object',
      },
      type: 'array',
    },
    title: { type: 'string' },
  },
  required: ['kind', 'title', 'focus', 'chapters'],
  type: 'object',
};

// Agent generation only needs the fields that define the review path. Codiff
// derives support groups and all display metadata from the live diff.
const narrativeWalkthroughGenerationSchema = {
  additionalProperties: false,
  properties: {
    commit: narrativeWalkthroughSchema.properties.commit,
    chapters: {
      ...narrativeWalkthroughSchema.properties.chapters,
      items: {
        ...narrativeWalkthroughSchema.properties.chapters.items,
        properties: {
          ...narrativeWalkthroughSchema.properties.chapters.items.properties,
          stops: {
            ...narrativeWalkthroughSchema.properties.chapters.items.properties.stops,
            items: {
              additionalProperties: false,
              properties: {
                hunkIds: hunkGroupProperties.hunkIds,
                id: hunkGroupProperties.id,
                importance: { enum: [...IMPORTANCES], type: 'string' },
                prose: { type: 'string' },
                regions:
                  narrativeWalkthroughSchema.properties.chapters.items.properties.stops.items
                    .properties.regions,
                title: { maxLength: 80, type: 'string' },
              },
              required: ['id', 'hunkIds', 'importance', 'prose', 'regions', 'title'],
              type: 'object',
            },
          },
        },
      },
    },
    focus: narrativeWalkthroughSchema.properties.focus,
    kind: narrativeWalkthroughSchema.properties.kind,
    title: narrativeWalkthroughSchema.properties.title,
  },
  required: ['kind', 'title', 'focus', 'chapters'],
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
    if (Array.isArray(next.enum) && !next.enum.includes(null)) {
      next.enum = [...next.enum, null];
    }

    if (next.type) {
      next.type = [...new Set([...toArray(next.type), 'null'])];
    } else if (next.const !== undefined) {
      next.anyOf = [{ const: next.const }, { type: 'null' }];
      delete next.const;
    }
  }

  return next;
};

const narrativeWalkthroughResponseSchema = strictResponseSchema(
  narrativeWalkthroughGenerationSchema,
);

const versionCommitOverviewResponseSchema = {
  additionalProperties: false,
  properties: { focus: { type: 'string' } },
  required: ['focus'],
  type: 'object',
};

const walkthroughAssessmentResponseSchema = {
  additionalProperties: false,
  properties: {
    disposition: {
      enum: [
        'addressed',
        'partially-addressed',
        'still-applies',
        'no-longer-applicable',
        'unclear',
      ],
      type: 'string',
    },
    explanation: { type: 'string' },
  },
  required: ['disposition', 'explanation'],
  type: 'object',
};

module.exports = {
  AGENTS,
  CHANGE_TYPES,
  ICONS,
  IMPORTANCES,
  MAX_WALKTHROUGH_CHAPTERS,
  MAX_WALKTHROUGH_STOPS,
  MAX_HUNKS_PER_WALKTHROUGH_GROUP,
  narrativeWalkthroughResponseSchema,
  narrativeWalkthroughSchema,
  versionCommitOverviewResponseSchema,
  walkthroughAssessmentResponseSchema,
};
