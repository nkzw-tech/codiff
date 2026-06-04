// @ts-check

const {
  cleanText,
  normalizeEnum,
  oneLine,
  parseJSONMessage,
  truncate,
} = require('./agent-shared.cjs');

const MAX_TOTAL_PATCH_CHARS = 160_000;
const MAX_SECTION_PATCH_CHARS = 4_000;

/**
 * @typedef {import('../src/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../src/types.ts').DiffSection} DiffSection
 * @typedef {import('../src/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../src/types.ts').WalkthroughContext} WalkthroughContext
 * @typedef {import('./agent.cjs').Agent} Agent
 * @typedef {import('./agent.cjs').AgentOptions} AgentOptions
 */

const walkthroughSchema = {
  additionalProperties: false,
  properties: {
    groups: {
      items: {
        additionalProperties: false,
        properties: {
          files: {
            items: {
              additionalProperties: false,
              properties: {
                action: { enum: ['review', 'scan', 'skim'], type: 'string' },
                context: { type: 'string' },
                impact: { enum: ['wide', 'contained', 'mechanical'], type: 'string' },
                path: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['path', 'reason', 'context', 'action', 'impact'],
              type: 'object',
            },
            type: 'array',
          },
          reason: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['title', 'reason', 'files'],
        type: 'object',
      },
      type: 'array',
    },
    summary: {
      additionalProperties: false,
      properties: {
        focus: { type: 'string' },
        skim: { type: 'string' },
      },
      required: ['focus', 'skim'],
      type: 'object',
    },
    version: { const: 1, type: 'number' },
  },
  required: ['version', 'summary', 'groups'],
  type: 'object',
};

/** @param {DiffSection} section @param {number} remainingBudget */
const buildPatchExcerpt = (section, remainingBudget) => {
  const summary = section.summary?.reason ? `Summary: ${section.summary.reason}\n` : '';
  const patch = section.patch || '';
  const maxLength = Math.max(
    0,
    Math.min(MAX_SECTION_PATCH_CHARS, remainingBudget - summary.length),
  );

  if (maxLength === 0) {
    return summary || '[patch omitted: budget exhausted]';
  }

  return `${summary}${truncate(patch, maxLength)}`;
};

/** @param {RepositoryState} state */
const buildPromptInput = (state) => {
  let remainingPatchBudget = MAX_TOTAL_PATCH_CHARS;

  return {
    files: state.files.map((file) => ({
      oldPath: file.oldPath,
      path: file.path,
      sections: file.sections.map((section) => {
        const patchExcerpt = buildPatchExcerpt(section, remainingPatchBudget);
        remainingPatchBudget = Math.max(0, remainingPatchBudget - patchExcerpt.length);

        return {
          binary: section.binary,
          kind: section.kind,
          loadState: section.loadState,
          patchExcerpt,
          summary: section.summary?.reason,
        };
      }),
      status: file.status,
    })),
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

/** @param {RepositoryState} state @param {WalkthroughContext | null | undefined} [context] @param {string} [agentLabel] */
const buildPrompt = (
  state,
  context,
  agentLabel = 'Codex',
) => `You are helping Codiff order a code review.

Return a high-leverage review walkthrough order, not review findings.
Do not inspect the repository or run shell commands; use only the digest below.
Your job is to help a human reviewer spend attention where architectural judgment matters and avoid blocking work on low-value changes.
Use every provided path exactly once.
Order files from highest review leverage to lowest.
High leverage: architecture boundaries, public APIs, exported types, schemas, IPC, routing, persistence, auth/security, shared state, cross-cutting utilities, build/runtime behavior, files likely to affect multiple call sites, and tests that define important behavior or show how a new API is meant to be used.
Medium leverage: feature implementation, contained behavior changes, local tests that clarify intent, and relevant config.
Low leverage: leaf UI details, isolated tests/fixtures, docs, generated files, snapshots, lockfiles, formatting-only or mechanical churn.
Rank by reviewability, not file type. A test may come before implementation when it is the clearest behavioral contract, usage example, or entry point for understanding the change. Do not always put tests first or last.
Group files by review strategy, not by directory.
Use group titles that tell the reviewer how to spend attention, such as "Review carefully", "Trace the data flow", "Verify behavior with tests", "Scan contained changes", or "Low value / skim".
Avoid generic group titles like "Frontend files", "Tests", "Miscellaneous", or "Other changed files".
For each file:
- reason: why this file is in this position, max 140 characters.
- context: what the reviewer should pay attention to, max 180 characters.
- action: "review", "scan", or "skim".
- impact: "wide", "contained", or "mechanical".
Set impact to "wide" only when the file appears to affect multiple features, contracts, boundaries, shared behavior, review order, or a test that explains a shared contract. Use it sparingly; if uncertain, choose "contained".
Set impact to "contained" when the change appears limited to one feature, leaf component, local behavior, or focused test.
Set impact to "mechanical" when the reviewer likely should skim unless they own that area.
Do not mark every file "wide"; a useful walkthrough separates broad blast-radius files from contained or mechanical files.
The summary must be exactly two short sentences split into focus and skim: focus says where review matters most, skim says what can be skimmed.
Do not invent bugs.
Do not produce review comments.
Do not say "looks good".
Do not nitpick syntax, naming, style, formatting, or local cleanup unless it affects review leverage.
Do not mention files that were not provided.
Return JSON only.

${buildWalkthroughContextInput(context, agentLabel)}
Repository change digest:
${JSON.stringify(buildPromptInput(state), null, 2)}
`;

/** @param {any} input @param {ReadonlyArray<ChangedFile>} files @param {string} [agentLabel] */
const normalizeWalkthrough = (input, files, agentLabel = 'Codex') => {
  const pathSet = new Set(files.map((file) => file.path));
  const seen = new Set();
  const groups = [];
  const actions = new Set(['review', 'scan', 'skim']);
  const impacts = new Set(['wide', 'contained', 'mechanical']);

  for (const group of Array.isArray(input?.groups) ? input.groups : []) {
    const nextFiles = [];

    for (const file of Array.isArray(group?.files) ? group.files : []) {
      const path = oneLine(file?.path);
      if (!pathSet.has(path) || seen.has(path)) {
        continue;
      }

      seen.add(path);
      nextFiles.push({
        action: normalizeEnum(file?.action, actions, 'scan'),
        context: cleanText(file?.context, 'Check the review-relevant context for this file.'),
        impact: normalizeEnum(file?.impact, impacts, 'contained'),
        path,
        reason: cleanText(file?.reason, 'Review this file in this part of the change.'),
      });
    }

    if (nextFiles.length > 0) {
      groups.push({
        files: nextFiles,
        reason: cleanText(group?.reason, 'These files are related.'),
        title: cleanText(group?.title, 'Walkthrough'),
      });
    }
  }

  const missingFiles = files
    .filter((file) => !seen.has(file.path))
    .map((file) => ({
      action: 'scan',
      context: `${agentLabel} did not place this file; scan it after the ranked walkthrough.`,
      impact: 'contained',
      path: file.path,
      reason: `Review after the primary walkthrough; ${agentLabel} did not place this file.`,
    }));

  if (missingFiles.length > 0) {
    groups.push({
      files: missingFiles,
      reason: `Files not included in the ${agentLabel} walkthrough response.`,
      title: 'Other changed files',
    });
  }

  if (groups.length === 0 && files.length > 0) {
    throw new Error(`${agentLabel} did not return any changed files.`);
  }

  return {
    groups,
    summary: {
      focus: cleanText(input?.summary?.focus, 'Review the highest-leverage files first.'),
      skim: cleanText(
        input?.summary?.skim,
        'Skim low-value or mechanical files after core review.',
      ),
    },
    version: 1,
  };
};

/** @param {RepositoryState} state @param {Agent} agent @param {AgentOptions} agentOptions @param {WalkthroughContext | null | undefined} [context] */
const readWalkthrough = async (state, agent, agentOptions, context) => {
  if (state.files.length === 0) {
    return {
      status: 'ready',
      walkthrough: {
        groups: [],
        summary: {
          focus: 'No changed files.',
          skim: 'Nothing to skim.',
        },
        version: 1,
      },
    };
  }

  try {
    const response = await agent.run(
      state.root,
      buildPrompt(state, context, agent.label),
      walkthroughSchema,
      'walkthrough.json',
      `${agent.label} walkthrough timed out.`,
      agentOptions,
    );
    const parsed = parseJSONMessage(response);

    return {
      status: 'ready',
      walkthrough: normalizeWalkthrough(parsed, state.files, agent.label),
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
  buildPrompt,
  normalizeWalkthrough,
  readWalkthrough,
  walkthroughSchema,
};
