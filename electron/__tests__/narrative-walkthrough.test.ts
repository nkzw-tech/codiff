import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import narrativeSchemaJson from '../../core/walkthrough/narrative-walkthrough.schema.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const {
  buildNarrativeWalkthroughPrompt,
  getNarrativeWalkthroughCacheKey,
  narrativeWalkthroughSchema,
  normalizeNarrativeWalkthrough,
  readNarrativeWalkthrough,
  resolveNarrativeWalkthroughModel,
} = require('../narrative-walkthrough.cjs') as any;

const addedPatch = (count: number) =>
  `@@ -0,0 +1,${count} @@\n${Array.from({ length: count }, (_, index) => `+line ${index + 1}`).join('\n')}\n`;
const fourHunkPatch = Array.from(
  { length: 4 },
  (_, index) => `@@ -${index + 1} +${index + 1} @@\n-old ${index + 1}\n+new ${index + 1}\n`,
).join('');
const manyHunkPatch = Array.from(
  { length: 18 },
  (_, index) => `@@ -${index + 1} +${index + 1} @@\n-old ${index + 1}\n+new ${index + 1}\n`,
).join('');

const files = [
  {
    path: 'src/App.tsx',
    sections: [
      {
        id: 'src/App.tsx:staged',
        kind: 'staged',
        patch: '@@ -310,3 +310,3 @@\n context\n-old order\n+new order\n context\n',
      },
    ],
    status: 'modified',
  },
  {
    path: 'src/__tests__/hunkNavigation.test.ts',
    sections: [
      {
        id: 'src/__tests__/hunkNavigation.test.ts:staged',
        kind: 'staged',
        patch: addedPatch(14),
      },
    ],
    status: 'added',
  },
  {
    path: 'pnpm-lock.yaml',
    sections: [{ id: 'pnpm-lock.yaml:staged', kind: 'staged', patch: addedPatch(3) }],
    status: 'modified',
  },
  {
    path: 'wide.py',
    sections: [{ id: 'wide.py:staged', kind: 'staged', patch: fourHunkPatch }],
    status: 'modified',
  },
];

test('reports only the long-running walkthrough generation phases', async () => {
  const phases: Array<string> = [];
  let runOptions: any;
  let runSchema: any;
  const state = {
    branch: 'main',
    files,
    generatedAt: 1,
    root: '/repo',
    source: { type: 'working-tree' },
  };
  const agent = {
    defaultTimeoutMs: 90_000,
    id: 'codex',
    isNotFoundError: () => false,
    label: 'Codex',
    run: async (
      _root: string,
      _prompt: string,
      schema: unknown,
      _outputName: string,
      _timeoutMessage: string,
      options: unknown,
    ) => {
      runOptions = options;
      runSchema = schema;
      return JSON.stringify({
        ...baseInput(),
        chapters: [
          {
            ...baseInput().chapters[0],
            stops: [
              { ...baseInput().chapters[0].stops[0], hunkIds: ['h1'] },
              { ...baseInput().chapters[0].stops[1], hunkIds: ['h2'] },
            ],
          },
        ],
        support: [{ hunkIds: ['h3'], id: 'lock', reason: 'Lockfile' }],
      });
    },
  };

  await expect(
    readNarrativeWalkthrough(
      state,
      agent,
      {
        onProgress: (phase: string) => phases.push(phase),
      },
      null,
    ),
  ).resolves.toMatchObject({
    status: 'ready',
    walkthrough: {
      narrative: {
        chapters: [
          {
            stops: [
              { hunkIds: ['src/App.tsx:staged:h1'] },
              { hunkIds: ['src/__tests__/hunkNavigation.test.ts:staged:h1'] },
            ],
          },
        ],
        support: [
          { hunkIds: ['pnpm-lock.yaml:staged:h1'] },
          {
            hunkIds: [
              'wide.py:staged:h1',
              'wide.py:staged:h2',
              'wide.py:staged:h3',
              'wide.py:staged:h4',
            ],
          },
        ],
      },
    },
  });

  expect(phases).toEqual(['agent-generation', 'response-received']);
  expect(runOptions.reasoningEffort).toBeUndefined();
  expect(runOptions.timeoutMs).toBe(90_000);
  expect(runSchema.required).toEqual(Object.keys(runSchema.properties));
  expect(runSchema.properties.agent).toBeUndefined();
  expect(runSchema.properties.generatedAt).toBeUndefined();
  expect(runSchema.properties.meta).toBeUndefined();
  expect(runSchema.properties.repo).toBeUndefined();
  expect(runSchema.properties.source).toBeUndefined();
  expect(runSchema.properties.support).toBeUndefined();
  expect(runSchema.properties.commit.required).toEqual(['body', 'title']);
  expect(runSchema.properties.commit.type).toContain('null');

  const chapters = runSchema.properties.chapters;
  const stopProperties = chapters.items.properties.stops.items.properties;
  expect(chapters.maxItems).toBe(6);
  expect(chapters.items.properties.title.maxLength).toBe(16);
  expect(chapters.items.properties.stops.maxItems).toBe(14);
  expect(stopProperties.added).toBeUndefined();
  expect(stopProperties.deleted).toBeUndefined();
  expect(stopProperties.path).toBeUndefined();
  expect(stopProperties.status).toBeUndefined();
  expect(stopProperties.changeType).toBeUndefined();
  expect(stopProperties.commitNote).toBeUndefined();
  expect(stopProperties.notes).toBeUndefined();
  expect(stopProperties.summary).toBeUndefined();
  expect(stopProperties.title.maxLength).toBe(80);
  expect(chapters.items.properties.stops.items.required).toContain('title');
  expect(stopProperties.hunkIds.minItems).toBe(1);
  expect(stopProperties.hunkIds.maxItems).toBe(14);
  expect(stopProperties.comments).toBeUndefined();
});

const baseInput = () => ({
  chapters: [
    {
      blurb: 'Where it breaks.',
      icon: 'bug',
      id: 'bug',
      stops: [
        {
          hunkIds: ['src/App.tsx:staged:h1'],
          id: 's1',
          importance: 'critical',
          prose: 'The root cause line.',
          title: 'Collapsed file ordering',
        },
        {
          hunkIds: ['src/__tests__/hunkNavigation.test.ts:staged:h1'],
          id: 's6',
          importance: 'normal',
          prose: 'The regression test.',
          title: 'Navigation regression test',
        },
      ],
      title: 'The bug',
    },
  ],
  focus: 'A one-line ordering bug let j/k skip collapsed files.',
  kind: 'narrative',
  support: [{ hunkIds: ['pnpm-lock.yaml:staged:h1'], id: 'lock', reason: 'Lockfile' }],
  title: 'Hunk navigation skips collapsed files',
  version: 4,
});

test('exposes a schema requiring the hunk-based narrative fields', async () => {
  expect(narrativeWalkthroughSchema.type).toBe('object');
  expect(narrativeWalkthroughSchema.required).toContain('chapters');
  expect(narrativeWalkthroughSchema.required).not.toContain('segments');
  expect(narrativeWalkthroughSchema.required).not.toContain('orders');
  expect(narrativeWalkthroughSchema.required).not.toContain('defaultOrder');
  expect(narrativeWalkthroughSchema.properties.agent).toBeUndefined();
  expect(narrativeWalkthroughSchema.properties.repo).toBeUndefined();
  expect(narrativeWalkthroughSchema.properties.version).toBeUndefined();
  expect(narrativeWalkthroughSchema.required).not.toContain('version');
  const stopProperties =
    narrativeWalkthroughSchema.properties.chapters.items.properties.stops.items.properties;
  expect(stopProperties.added).toBeUndefined();
  expect(stopProperties.anchor).toBeUndefined();
  expect(stopProperties.regions.maxItems).toBe(4);
});

test('keeps the renderer JSON schema in sync with the live narrative schema', async () => {
  expect(narrativeSchemaJson).toEqual(narrativeWalkthroughSchema);
});

test('scales walkthrough timeouts passed to the agent', async () => {
  const createState = (count: number) => ({
    branch: 'main',
    files: Array.from({ length: count }, (_, index) => ({
      path: `file-${index}.ts`,
      sections: [
        {
          id: `file-${index}.ts:staged`,
          kind: 'staged',
          patch: `@@ -1 +1 @@\n-old ${index}\n+new ${index}\n`,
        },
      ],
      status: 'modified',
    })),
    generatedAt: 1,
    root: '/repo',
    source: { type: 'working-tree' },
  });
  const readTimeout = async (count: number, defaultTimeoutMs: number) => {
    let timeoutMs = 0;
    await readNarrativeWalkthrough(
      createState(count),
      {
        defaultTimeoutMs,
        id: 'codex',
        isNotFoundError: () => false,
        label: 'Codex',
        run: async (
          _root: string,
          _prompt: string,
          _schema: unknown,
          _outputName: string,
          _timeoutMessage: string,
          options: { timeoutMs: number },
        ) => {
          timeoutMs = options.timeoutMs;
          return JSON.stringify({
            chapters: [],
            focus: 'Review the change.',
            kind: 'narrative',
            title: 'Review',
            version: 4,
          });
        },
      },
      {},
    );
    return timeoutMs;
  };

  const smallTimeout = await readTimeout(4, 90_000);
  const mediumTimeout = await readTimeout(32, 90_000);
  const largeTimeout = await readTimeout(100, 90_000);

  expect(smallTimeout).toBe(90_000);
  expect(mediumTimeout).toBeGreaterThan(smallTimeout);
  expect(mediumTimeout).toBeLessThan(300_000);
  expect(largeTimeout).toBe(300_000);
  expect(await readTimeout(4, 180_000)).toBe(180_000);
});

test('prompts generated walkthroughs to use deterministic hunk groups', async () => {
  const prompt = await buildNarrativeWalkthroughPrompt({
    branch: 'main',
    files: Array.from({ length: 28 }, (_, index) => ({
      path: `file-${index}.ts`,
      sections: [],
      status: 'modified',
    })),
    generatedAt: 1,
    root: '/repo',
    source: { type: 'working-tree' },
  });

  expect(prompt).toContain('digest has 28 files');
  expect(prompt).toContain('Target 6-9 main-path stops');
  expect(prompt).toContain('Define chapters[] and stops[] in display order');
  expect(prompt).toContain('Default to one review idea per stop');
  expect(prompt).toContain('Every stop must have a concise semantic title');
  expect(prompt).toContain('Never use a filename or path as a stop title');
  expect(prompt).toContain('A stop may contain at most 14 hunkIds');
  expect(prompt).toContain('Group multiple hunkIds when they implement the same invariant');
  expect(prompt).toContain('compact request-local aliases');
  expect(prompt).toContain('Generated-like files have "generated":true');
  expect(prompt).toContain('Never split them');
  expect(prompt).toContain('main-path them only when they explain behavior');
  expect(prompt).toContain('listed in the exact display order');
  expect(prompt).toContain('automatically places every unreferenced hunk in support');
  expect(prompt).toContain('Do not provide support, added/deleted counts');
});

test('prompts small walkthroughs to group similar hunks into compact chapters', async () => {
  const prompt = await buildNarrativeWalkthroughPrompt({
    branch: 'main',
    files: [
      {
        path: 'src/App.tsx',
        sections: [
          {
            id: 'src/App.tsx:staged',
            kind: 'staged',
            patch: '@@ -1 +1 @@\n-old title\n+new title\n@@ -10 +10 @@\n-old label\n+new label\n',
          },
        ],
        status: 'modified',
      },
      {
        path: 'src/App.test.tsx',
        sections: [
          {
            id: 'src/App.test.tsx:staged',
            kind: 'staged',
            patch: '@@ -4 +4 @@\n-old assertion\n+new assertion\n',
          },
        ],
        status: 'modified',
      },
    ],
    generatedAt: 1,
    root: '/repo',
    source: { type: 'working-tree' },
  });

  expect(prompt).toContain('digest has 2 files and 3 reviewable hunks');
  expect(prompt).toContain('Target 1-2 main-path stops');
  expect(prompt).toContain('Use 1 conceptual chapters');
  expect(prompt).toContain('Prefer conceptual chapters across the complete diff');
  expect(prompt).toContain('Default to one review idea per stop');
});

test('uses GPT-5.5 for large walkthroughs only when Codex is on the default model', async () => {
  const createState = (hunkCount: number) => ({
    branch: 'main',
    files: [
      {
        path: 'large.ts',
        sections: [
          {
            id: 'large.ts:staged',
            kind: 'staged',
            patch: Array.from(
              { length: hunkCount },
              (_, index) => `@@ -${index + 1} +${index + 1} @@\n-old ${index}\n+new ${index}\n`,
            ).join(''),
          },
        ],
        status: 'modified',
      },
    ],
    generatedAt: 1,
    root: '/repo',
    source: { type: 'working-tree' },
  });
  const codexAgent = {
    defaultModel: 'gpt-5.6-terra',
    fallbackModel: 'gpt-5.5',
    id: 'codex',
    normalizeModel: (model: unknown) => String(model),
  };

  expect(resolveNarrativeWalkthroughModel(createState(99), codexAgent, 'gpt-5.6-terra')).toBe(
    'gpt-5.6-terra',
  );
  expect(resolveNarrativeWalkthroughModel(createState(100), codexAgent, 'gpt-5.6-terra')).toBe(
    'gpt-5.5',
  );
  expect(resolveNarrativeWalkthroughModel(createState(100), codexAgent, 'gpt-5.6-sol')).toBe(
    'gpt-5.6-sol',
  );
  expect(
    resolveNarrativeWalkthroughModel(
      createState(100),
      { ...codexAgent, id: 'claude' },
      'claude-sonnet',
    ),
  ).toBe('claude-sonnet');
});

test('prompts generated walkthroughs with custom user guidance without replacing core constraints', async () => {
  const prompt = await buildNarrativeWalkthroughPrompt(
    {
      branch: 'main',
      files: files.slice(0, 1),
      generatedAt: 1,
      root: '/repo',
      source: { type: 'working-tree' },
    },
    null,
    'Claude Code',
    'Answer in Japanese and use concise reviewer-facing explanations.',
  );

  expect(prompt).toContain('Custom walkthrough instructions:');
  expect(prompt).toContain('Answer in Japanese and use concise reviewer-facing explanations.');
  expect(prompt).toContain('Return the required structured object');
  expect(prompt).toContain('Repository digest:');
});

test('passes a compact previous walkthrough into regeneration prompts', async () => {
  const prompt = await buildNarrativeWalkthroughPrompt(
    {
      branch: 'main',
      files: files.slice(0, 1),
      generatedAt: 1,
      root: '/repo',
      source: { type: 'working-tree' },
    },
    null,
    'Claude Code',
    undefined,
    {
      chapters: [
        {
          blurb: 'Entry point',
          stops: [
            {
              hunkIds: ['stale-hunk'],
              prose: 'Guards against duplicate submits.',
              title: 'Prevent double submit',
            },
          ],
          title: 'Runtime',
        },
      ],
      commit: {
        body: 'Preserve the behavior.',
        title: 'Guard duplicate submits',
      },
      focus: 'Harden the submit path.',
      title: 'Submit hardening',
    },
  );

  expect(prompt).toContain('Previous walkthrough to update:');
  expect(prompt).toContain('Prevent double submit');
  expect(prompt).toContain('Guard duplicate submits');
  expect(prompt).toContain('Re-anchor every stop');
  expect(prompt).not.toContain('stale-hunk');
});

test('builds cache keys from semantic generation inputs', async () => {
  const state = {
    branch: 'main',
    files: [{ ...files[0], fingerprint: 'fingerprint-1' }],
    generatedAt: 1,
    root: '/repo',
    source: {
      description: 'Explain the change.',
      headSha: 'head-1',
      mergeState: { status: 'checking' },
      number: 42,
      provider: 'github',
      reviewStatus: { approved: false },
      type: 'pull-request',
      url: 'https://github.com/nkzw-tech/codiff/pull/42',
    },
  };
  const agent = {
    id: 'claude',
    label: 'Claude Code',
    normalizeModel: (model: unknown) => String(model || 'default'),
  };
  const key = await getNarrativeWalkthroughCacheKey(state, agent, 'claude-sonnet', null);
  const metadataChangedKey = await getNarrativeWalkthroughCacheKey(
    {
      ...state,
      generatedAt: 2,
      source: {
        ...state.source,
        mergeState: { status: 'ready' },
        reviewStatus: { approved: true },
      },
    },
    agent,
    'claude-sonnet',
    null,
  );
  const diffChangedKey = await getNarrativeWalkthroughCacheKey(
    {
      ...state,
      files: [
        {
          ...files[0],
          sections: [
            {
              ...files[0].sections[0],
              patch: '@@ -1 +1 @@\n-old\n+new behavior\n',
            },
          ],
        },
      ],
    },
    agent,
    'claude-sonnet',
    null,
  );
  const unexcerptedDiffChangedKey = await getNarrativeWalkthroughCacheKey(
    {
      ...state,
      files: [{ ...state.files[0], fingerprint: 'fingerprint-2' }],
    },
    agent,
    'claude-sonnet',
    null,
  );
  const anchorsChangedKey = await getNarrativeWalkthroughCacheKey(
    {
      ...state,
      files: [
        {
          ...state.files[0],
          sections: [{ ...state.files[0].sections[0], id: 'rebased:src/App.tsx:staged' }],
        },
      ],
    },
    agent,
    'claude-sonnet',
    null,
  );

  // Shared authoring includes more digest fields in the prompt, so branch/source
  // metadata changes can affect the cache key.
  expect(diffChangedKey).not.toBe(key);
  expect(unexcerptedDiffChangedKey).not.toBe(key);
  expect(anchorsChangedKey).not.toBe(key);
  expect(await getNarrativeWalkthroughCacheKey(state, agent, 'claude-opus', null)).not.toBe(key);
  expect(
    await getNarrativeWalkthroughCacheKey(state, agent, 'claude-sonnet', null, 'Be concise.'),
  ).not.toBe(key);
  expect(
    await getNarrativeWalkthroughCacheKey(state, agent, 'claude-sonnet', {
      summary: 'Prior discussion',
    }),
  ).not.toBe(key);
});

test('omits blank custom walkthrough prompt guidance', async () => {
  const prompt = await buildNarrativeWalkthroughPrompt(
    {
      branch: 'main',
      files: files.slice(0, 1),
      generatedAt: 1,
      root: '/repo',
      source: { type: 'working-tree' },
    },
    null,
    'Codex',
    '   ',
  );

  expect(prompt).not.toContain('Custom walkthrough instructions:');
});

test('prompts generated walkthroughs with PR descriptions as orientation only', async () => {
  const prompt = await buildNarrativeWalkthroughPrompt({
    branch: 'main',
    files: files.slice(0, 1),
    generatedAt: 1,
    root: '/repo',
    source: {
      description: '## Intent\n\nKeep reviewers oriented.',
      number: 42,
      provider: 'github',
      type: 'pull-request',
      url: 'https://github.com/nkzw-tech/codiff/pull/42',
    },
  });

  expect(prompt).toContain('"description":"## Intent\\n\\nKeep reviewers oriented."');
  expect(prompt).toContain('author-written intent and orientation');
  expect(prompt).toContain('not proof of behavior');
  expect(prompt).toContain('patches and hunk data remain the source of truth');
});

test('truncates long PR descriptions in generated walkthrough prompts', async () => {
  const prompt = await buildNarrativeWalkthroughPrompt({
    branch: 'main',
    files: files.slice(0, 1),
    generatedAt: 1,
    root: '/repo',
    source: {
      description: `${'A'.repeat(4100)}UNTRUNCATED_TAIL`,
      number: 42,
      provider: 'github',
      type: 'pull-request',
      url: 'https://github.com/nkzw-tech/codiff/pull/42',
    },
  });

  expect(prompt).toContain('…');
  expect(prompt).not.toContain('UNTRUNCATED_TAIL');
});

test('repository digest exposes compact hunk aliases and counts', async () => {
  const prompt = await buildNarrativeWalkthroughPrompt({
    branch: 'main',
    files: files.slice(0, 1),
    generatedAt: 1,
    root: '/repo',
    source: { type: 'working-tree' },
  });

  expect(prompt).toContain('"id":"h1"');
  expect(prompt).not.toContain('"id":"src/App.tsx:staged:h1"');
  expect(prompt).toContain('"added":1');
  expect(prompt).toContain('"deleted":1');
  expect(prompt).toContain('Do not provide support, added/deleted counts');
});

test('repository digest strictly enforces section and total patch budgets', async () => {
  const prompt = await buildNarrativeWalkthroughPrompt({
    branch: 'main',
    files: Array.from({ length: 100 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      sections: [
        {
          id: `src/file-${index}.ts:staged`,
          kind: 'staged',
          patch: 'x'.repeat(700),
        },
      ],
      status: 'modified',
    })),
    generatedAt: 1,
    root: '/repo',
    source: { type: 'working-tree' },
  });
  const digest = JSON.parse(prompt.split('Repository digest:\n')[1] ?? '{}') as {
    files: ReadonlyArray<{ sections: ReadonlyArray<{ patchExcerpt: string }> }>;
  };
  const lengths = digest.files.flatMap((file) =>
    file.sections.map((section) => section.patchExcerpt.length),
  );

  expect(Math.max(...lengths)).toBeLessThanOrEqual(700);
  expect(lengths.reduce((total, length) => total + length, 0)).toBeLessThanOrEqual(35_000);
});

test('repository digest includes summaries within the section patch budget', async () => {
  const prompt = await buildNarrativeWalkthroughPrompt({
    branch: 'main',
    files: [
      {
        path: 'src/summary.ts',
        sections: [
          {
            id: 'src/summary.ts:staged',
            kind: 'staged',
            patch: 'x'.repeat(5_000),
            summary: { reason: 'R'.repeat(1_000) },
          },
        ],
        status: 'modified',
      },
    ],
    generatedAt: 1,
    root: '/repo',
    source: { type: 'working-tree' },
  });
  const digest = JSON.parse(prompt.split('Repository digest:\n')[1] ?? '{}') as {
    files: ReadonlyArray<{ sections: ReadonlyArray<{ patchExcerpt: string }> }>;
  };

  expect(digest.files[0]?.sections[0]?.patchExcerpt.length).toBeLessThanOrEqual(2_500);
});

test('repository digest collapses generated files to one synthetic hunk', async () => {
  const prompt = await buildNarrativeWalkthroughPrompt({
    branch: 'main',
    files: [
      {
        path: 'pnpm-lock.yaml',
        sections: [
          {
            id: 'pnpm-lock.yaml:staged',
            kind: 'staged',
            patch: manyHunkPatch,
          },
        ],
        status: 'modified',
      },
    ],
    generatedAt: 1,
    root: '/repo',
    source: { type: 'working-tree' },
  });

  expect(prompt).toContain('"generated":true');
  expect(prompt).toContain('"id":"h1"');
  expect(prompt).toContain('"kind":"synthetic"');
  expect(prompt).toContain('"added":18');
  expect(prompt).toContain('"deleted":18');
  expect(prompt).not.toContain('"id":"h2"');
});

test('repository digest honors generated metadata that disables path heuristics', async () => {
  const prompt = await buildNarrativeWalkthroughPrompt({
    branch: 'main',
    files: [
      {
        generated: false,
        path: 'pnpm-lock.yaml',
        sections: [
          {
            id: 'pnpm-lock.yaml:staged',
            kind: 'staged',
            patch: manyHunkPatch,
          },
        ],
        status: 'modified',
      },
    ],
    generatedAt: 1,
    root: '/repo',
    source: { type: 'working-tree' },
  });

  // Shared authoring marks generated-looking paths in the digest.
  expect(prompt).toContain('"generated":true');
  expect(prompt).toContain('"path":"pnpm-lock.yaml"');
});

test('repository digest exposes synthetic hunk ids for non-text sections', async () => {
  const prompt = await buildNarrativeWalkthroughPrompt({
    branch: 'main',
    files: [
      {
        path: 'public/logo.png',
        sections: [
          {
            binary: true,
            id: 'public/logo.png:staged',
            kind: 'staged',
            loadState: 'binary',
            patch: '',
            summary: { reason: 'Binary file changed.' },
          },
        ],
        status: 'modified',
      },
    ],
    generatedAt: 1,
    root: '/repo',
    source: { type: 'working-tree' },
  });

  expect(prompt).toContain('"id":"h1"');
  expect(prompt).toContain('"kind":"synthetic"');
  expect(prompt).toContain('"summary":"Binary file changed."');
});

test('repository digest exposes synthetic hunk ids for metadata-only renames', async () => {
  const prompt = await buildNarrativeWalkthroughPrompt({
    branch: 'main',
    files: [
      {
        oldPath: 'old.txt',
        path: 'new.txt',
        sections: [
          {
            binary: false,
            id: 'new.txt:staged',
            kind: 'staged',
            loadState: 'ready',
            patch: '',
          },
        ],
        status: 'renamed',
      },
    ],
    generatedAt: 1,
    root: '/repo',
    source: { type: 'working-tree' },
  });

  expect(prompt).toContain('"id":"h1"');
  expect(prompt).toContain('"kind":"synthetic"');
});

test('normalizes a well-formed narrative walkthrough', async () => {
  const result = await normalizeNarrativeWalkthrough(baseInput(), files, {
    agent: 'claude',
    branch: 'fix/hunk-nav',
    generatedAt: 1,
    root: '/repo',
    source: { type: 'working-tree' },
  });

  expect(result.version).toBe(5);
  expect(result.generationRequest.review).toEqual({
    relation: 'single-diff',
    structure: 'single-diff',
  });
  expect(result.narrative).toMatchObject({
    generationMetadata: { agent: 'claude', model: 'unknown' },
    structure: 'single-diff',
  });
  expect(result.narrative.kind).toBe('narrative');
  expect(result.narrative.agent).toBe('claude');
  expect(result.narrative.generatedAt).toBe('1970-01-01T00:00:00.001Z');
  expect(result.narrative.repo).toEqual({ branch: 'fix/hunk-nav' });
  expect(result.narrative.source).toEqual({ type: 'working-tree' });
  expect(result.narrative.meta).toBe('2 stops · 1 chapters');
  expect(result.narrative.chapters).toHaveLength(1);
  expect(result.narrative.chapters[0].stops.map((stop: any) => stop.id)).toEqual(['s1', 's6']);
  expect(result.narrative.support.map((item: any) => item.id)).toEqual(['lock', 'support-2']);
  expect(result.narrative.chapters[0].stops[0]).toMatchObject({
    added: 1,
    deleted: 1,
    hunkIds: ['src/App.tsx:staged:h1'],
    title: 'Collapsed file ordering',
  });
  expect(result.narrative.chapters[0].stops[0].hunks[0]).toMatchObject({
    added: 1,
    additionEnd: 312,
    additionStart: 310,
    anchor: {
      display: 'src/App.tsx:310-312',
      sectionId: 'src/App.tsx:staged',
      sectionKind: 'staged',
    },
    deleted: 1,
    deletionEnd: 312,
    deletionStart: 310,
    path: 'src/App.tsx',
    status: 'modified',
  });
  expect(result.narrative.chapters[0].stops[1]).toMatchObject({ added: 14, deleted: 0 });
  expect(result.narrative.chapters[0].stops[1].hunks[0].anchor.startLine).toBe(1);
});

test('preserves Pi as the narrative walkthrough agent', async () => {
  const result = await normalizeNarrativeWalkthrough(baseInput(), files, {
    agent: 'pi',
    source: { type: 'working-tree' },
  });

  expect(result.narrative.agent).toBe('pi');
});

test('preserves OpenCode as the narrative walkthrough agent', async () => {
  const context = {
    messages: [{ role: 'user', text: 'Keep the OpenCode session linked.' }],
    source: {
      generatedAt: '2026-06-19T00:00:00.000Z',
      threadId: 'ses_121b4816bffebMr9YE52O4870p',
      type: 'opencode-session-excerpt',
    },
    version: 1,
  };
  const result = await normalizeNarrativeWalkthrough(baseInput(), files, {
    agent: 'opencode',
    context,
    source: { type: 'working-tree' },
  });

  expect(result.narrative.agent).toBe('opencode');
  expect(result.narrative.context).toBe(context);
});

test('requires chapter ids in authored walkthrough drafts', async () => {
  const input = baseInput();
  delete input.chapters[0].id;

  await expect(normalizeNarrativeWalkthrough(input, files, { agent: 'opencode' })).rejects.toThrow(
    /id/i,
  );
});

test('normalizes walkthroughs made only of synthetic hunks', async () => {
  const syntheticFiles = [
    {
      path: 'public/logo.png',
      sections: [
        {
          binary: true,
          id: 'public/logo.png:staged',
          kind: 'staged',
          loadState: 'binary',
          patch: '',
          summary: { reason: 'Binary file changed.' },
        },
      ],
      status: 'modified',
    },
    {
      path: 'large.txt',
      sections: [
        {
          binary: false,
          id: 'large.txt:unstaged',
          kind: 'unstaged',
          loadState: 'deferred',
          patch: '',
          summary: { canLoad: true, reason: 'File is 2 MiB and will be loaded on demand.' },
        },
      ],
      status: 'modified',
    },
  ];
  const result = await normalizeNarrativeWalkthrough(
    {
      chapters: [
        {
          blurb: 'Non-text review units.',
          icon: 'path',
          id: 'assets',
          stops: [
            {
              hunkIds: ['public/logo.png:staged:h1'],
              id: 'logo',
              importance: 'normal',
              prose: 'Review the shipped image asset.',
            },
            {
              hunkIds: ['large.txt:unstaged:h1'],
              id: 'large',
              importance: 'context',
              prose: 'Review why this file is summarized.',
            },
          ],
          title: 'Assets',
        },
      ],
      focus: 'Review non-text changes.',
      kind: 'narrative',
      support: [],
      title: 'Synthetic hunk walkthrough',
      version: 4,
    },
    syntheticFiles as any,
  );

  expect(result.narrative.chapters[0].stops.map((stop: any) => stop.hunks[0])).toMatchObject([
    {
      added: 0,
      anchor: { display: 'public/logo.png', sectionId: 'public/logo.png:staged' },
      deleted: 0,
      id: 'public/logo.png:staged:h1',
      kind: 'synthetic',
    },
    {
      anchor: { display: 'large.txt', sectionId: 'large.txt:unstaged' },
      id: 'large.txt:unstaged:h1',
      kind: 'synthetic',
    },
  ]);
  expect(result.narrative.support).toEqual([]);
});

test('computes line counts and status from hunkIds instead of trusting agent math', async () => {
  const input = baseInput() as any;
  input.chapters[0].stops[0].added = 110;
  input.chapters[0].stops[0].deleted = 99;
  input.chapters[0].stops[0].status = 'added';

  const result = await normalizeNarrativeWalkthrough(input, files);

  expect(result.narrative.chapters[0].stops[0]).toMatchObject({
    added: 1,
    deleted: 1,
  });
  expect(result.narrative.chapters[0].stops[0].hunks[0].status).toBe('modified');
});

test('normalizes hunk header notes only for selected hunks', async () => {
  const input = baseInput() as any;
  input.chapters[0].stops[0].title = 'Root cause';
  input.chapters[0].stops[0].notes = [
    { body: 'Explain the exact root-cause line.', hunkId: 'src/App.tsx:staged:h1' },
    { body: 'Invalid stale note.', hunkId: 'src/App.tsx:staged:h2' },
  ];

  const result = await normalizeNarrativeWalkthrough(input, files);

  expect(result.narrative.chapters[0].stops[0].notes).toEqual([
    { body: 'Explain the exact root-cause line.', hunkId: 'src/App.tsx:staged:h1' },
  ]);
});

test('drops stops and support items with unresolvable hunk ids', async () => {
  const input = baseInput();
  input.chapters[0].stops.push({
    hunkIds: ['src/removed.ts:staged:h1'],
    id: 'stale',
    importance: 'normal',
    prose: 'Points at a stale file.',
  });
  input.support.push({ hunkIds: ['missing.ts:staged:h1'], id: 'missing', reason: 'Generated' });

  const result = await normalizeNarrativeWalkthrough(input, files);

  expect(result.narrative.chapters[0].stops.map((stop: any) => stop.id)).toEqual(['s1', 's6']);
  expect(result.narrative.support.map((item: any) => item.id)).toEqual(['lock', 'support-2']);
});

test('drops hunk groups that overlap already-covered hunks', async () => {
  const input = baseInput();
  input.chapters[0].stops.push({
    hunkIds: ['src/App.tsx:staged:h1', 'wide.py:staged:h1'],
    id: 'overlap',
    importance: 'normal',
    prose: 'Reuses an already annotated hunk.',
  });
  input.support.push({
    hunkIds: ['src/__tests__/hunkNavigation.test.ts:staged:h1'],
    id: 'duplicate-support',
    reason: 'Duplicate',
  });

  const result = await normalizeNarrativeWalkthrough(input, files);

  expect(result.narrative.chapters[0].stops.map((stop: any) => stop.id)).toEqual([
    's1',
    's6',
    'overlap',
  ]);
  expect(
    result.narrative.chapters[0].stops.find((stop: any) => stop.id === 'overlap')?.hunkIds,
  ).toEqual(['wide.py:staged:h1']);
});

test('adds unreferenced live hunks to support so changed code remains visible', async () => {
  const input = baseInput();
  input.support = [];

  const result = await normalizeNarrativeWalkthrough(input, files);

  expect(result.narrative.support.map((item: any) => item.reason)).toEqual([
    'Other changes',
    'Other changes',
  ]);
  expect(result.narrative.support.map((item: any) => item.hunkIds)).toEqual([
    ['pnpm-lock.yaml:staged:h1'],
    ['wide.py:staged:h1', 'wide.py:staged:h2', 'wide.py:staged:h3', 'wide.py:staged:h4'],
  ]);
});

test('adds unreferenced generated files to support as one review unit', async () => {
  const input = baseInput();
  input.support = [];
  const generatedFile = {
    path: 'src/__generated__/api.ts',
    sections: [{ id: 'src/__generated__/api.ts:staged', kind: 'staged', patch: manyHunkPatch }],
    status: 'modified',
  };

  const result = await normalizeNarrativeWalkthrough(input, [...files, generatedFile]);
  const generatedSupport = result.narrative.support.find(
    (item: any) => item.hunks[0]?.path === 'src/__generated__/api.ts',
  );

  expect(generatedSupport).toMatchObject({
    added: 18,
    deleted: 18,
    hunkIds: ['src/__generated__/api.ts:staged:h1'],
    hunks: [{ kind: 'synthetic', path: 'src/__generated__/api.ts' }],
    reason: 'Other changes',
  });
});

test('uses generated metadata for files without generated-looking paths', async () => {
  const input = baseInput();
  input.support = [];
  const generatedFile = {
    generated: true,
    path: 'api/client.ts',
    sections: [{ id: 'api/client.ts:staged', kind: 'staged', patch: manyHunkPatch }],
    status: 'modified',
  };

  const result = await normalizeNarrativeWalkthrough(input, [...files, generatedFile]);
  const generatedSupport = result.narrative.support.find(
    (item: any) => item.hunks[0]?.path === 'api/client.ts',
  );

  expect(generatedSupport).toMatchObject({
    hunkIds: ['api/client.ts:staged:h1'],
    hunks: [{ kind: 'synthetic', path: 'api/client.ts' }],
    reason: 'Other changes',
  });
});

test('groups authored generated support under the generated-files reason', async () => {
  const input = baseInput();
  input.support = [
    {
      hunkIds: ['pnpm-lock.yaml:staged:h1'],
      id: 'lockfile',
      reason: 'Dependency updates',
    },
  ];

  const result = await normalizeNarrativeWalkthrough(input, files);

  expect(result.narrative.support.find((item: any) => item.id === 'lockfile')?.reason).toBe(
    'Dependency updates',
  );
});

test('keeps explicitly selected generated files in the main walkthrough path', async () => {
  const input = baseInput();
  input.chapters[0].stops.push({
    hunkIds: ['pnpm-lock.yaml:staged:h1'],
    id: 'lockfile-stop',
    importance: 'normal',
    prose: 'The lockfile records the resolved dependency update.',
  });
  input.support = [];

  const result = await normalizeNarrativeWalkthrough(input, files);

  expect(result.narrative.chapters[0].stops.map((stop: any) => stop.id)).toContain('lockfile-stop');
  expect(
    result.narrative.support.some((item: any) => item.hunkIds.includes('pnpm-lock.yaml:staged:h1')),
  ).toBe(false);
});

test('normalizes ordered cross-file hunk groups under one stop', async () => {
  const input = baseInput();
  input.chapters[0].stops = [
    {
      hunkIds: ['src/__tests__/hunkNavigation.test.ts:staged:h1', 'src/App.tsx:staged:h1'],
      id: 'combo',
      importance: 'critical',
      prose: 'The proof and root cause are one review idea.',
    },
  ];

  const result = await normalizeNarrativeWalkthrough(input, files);
  const stop = result.narrative.chapters[0].stops[0];

  expect(stop).toMatchObject({
    added: 15,
    deleted: 1,
    hunkIds: ['src/__tests__/hunkNavigation.test.ts:staged:h1', 'src/App.tsx:staged:h1'],
  });
  expect(stop.hunks.map((hunk: any) => hunk.path)).toEqual([
    'src/__tests__/hunkNavigation.test.ts',
    'src/App.tsx',
  ]);
});

test('drops hunk groups that exceed the hunk group size limit', async () => {
  const input = baseInput();
  const overLimitPatch = Array.from(
    { length: 15 },
    (_, index) => `@@ -${index + 1} +${index + 1} @@\n-old ${index + 1}\n+new ${index + 1}\n`,
  ).join('');
  const overLimitFile = {
    path: 'too-wide.py',
    sections: [{ id: 'too-wide.py:staged', kind: 'staged', patch: overLimitPatch }],
    status: 'modified',
  };
  input.chapters[0].stops.push({
    hunkIds: Array.from({ length: 15 }, (_, index) => `too-wide.py:staged:h${index + 1}`),
    id: 'wide',
    importance: 'normal',
    prose: 'Too broad.',
  });

  await expect(normalizeNarrativeWalkthrough(input, [...files, overLimitFile])).rejects.toThrow();
});

test('throws when no chapters have resolvable stops', async () => {
  const input = baseInput();
  input.chapters = input.chapters.map((chapter) => ({
    ...chapter,
    stops: chapter.stops.map((stop) => ({
      ...stop,
      hunkIds: ['nope.ts:staged:h1'],
    })),
  }));

  await expect(normalizeNarrativeWalkthrough(input, files)).rejects.toThrow(
    /did not reference any current diff hunks|no chapters/i,
  );
});

test('throws an explicit error for legacy v3 anchor walkthroughs', async () => {
  const input = {
    chapters: [
      {
        blurb: 'Legacy.',
        icon: 'path',
        id: 'legacy',
        stops: [
          {
            anchors: [
              {
                added: 1,
                anchor: { display: 'src/App.tsx:310' },
                deleted: 1,
                granularity: 'line',
                id: 'a1',
                path: 'src/App.tsx',
                status: 'modified',
              },
            ],
            body: 'Legacy body.',
            id: 's1',
            importance: 'normal',
            summary: 'Legacy summary.',
            title: 'Legacy',
          },
        ],
        title: 'Legacy',
      },
    ],
    focus: 'Legacy walkthrough.',
    kind: 'narrative',
    support: [],
    title: 'Legacy',
    version: 3,
  };

  await expect(normalizeNarrativeWalkthrough(input, files)).rejects.toThrow(
    /legacy v3 anchors\[\]/i,
  );
  await expect(normalizeNarrativeWalkthrough(input, files)).rejects.toThrow(/v4 hunkIds\[\]/i);
});

test('normalizes per-item commit tags', async () => {
  const input = baseInput() as any;
  input.chapters[0].stops[0].changeType = 'fix';
  input.chapters[0].stops[0].commitNote = 'derive a collapse-independent hunk order';
  input.chapters[0].stops[0].title = 'Collapse order';

  const result = await normalizeNarrativeWalkthrough(input, files);

  expect(result.narrative.chapters[0].stops[0].changeType).toBe('fix');
  expect(result.narrative.chapters[0].stops[0].commitNote).toBe(
    'derive a collapse-independent hunk order',
  );
});

test('keeps the commit composer for a working-tree staging set', async () => {
  const input = baseInput() as any;
  input.commit = {
    body: 'Hunk order is now collapse-independent.\n\nNavigation expands a collapsed target before scrolling.',
    title: 'Fix hunk nav',
  };

  const result = await normalizeNarrativeWalkthrough(input, files);

  expect(result.narrative.commit).toEqual({
    body: 'Hunk order is now collapse-independent.\n\nNavigation expands a collapsed target before scrolling.',
    title: 'Fix hunk nav',
  });
});

test('derives a missing commit title from a title-like body first line', async () => {
  const input = baseInput() as any;
  input.commit = {
    body: 'Fix hunk nav\n\nNavigation expands a collapsed target before scrolling.',
  };

  const result = await normalizeNarrativeWalkthrough(input, files);

  expect(result.narrative.commit).toEqual({
    body: 'Navigation expands a collapsed target before scrolling.',
    title: 'Fix hunk nav',
  });
});

test('strips a duplicated commit title from the body', async () => {
  const input = baseInput() as any;
  input.commit = {
    body: 'Fix hunk nav\n\nNavigation expands a collapsed target before scrolling.',
    title: 'Fix hunk nav',
  };

  const result = await normalizeNarrativeWalkthrough(input, files);

  expect(result.narrative.commit).toEqual({
    body: 'Navigation expands a collapsed target before scrolling.',
    title: 'Fix hunk nav',
  });
});

test('adds an empty commit composer for a working-tree walkthrough without commit seeds', async () => {
  const input = baseInput() as any;
  delete input.commit;

  const result = await normalizeNarrativeWalkthrough(input, files);

  expect(result.narrative.commit).toEqual({});
});

test('strips the commit composer when the source is not a working tree', async () => {
  const input = baseInput() as any;
  input.commit = { title: 'Fix hunk nav' };

  const result = await normalizeNarrativeWalkthrough(input, files, {
    source: { sha: 'a'.repeat(40), type: 'commit' },
  });

  expect(result.narrative.commit).toBeUndefined();
});
