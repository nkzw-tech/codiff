import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const {
  buildNarrativeWalkthroughPrompt,
  narrativeWalkthroughResponseSchema,
  narrativeWalkthroughSchema,
  normalizeNarrativeWalkthrough,
} = require('../narrative-walkthrough.cjs') as {
  buildNarrativeWalkthroughPrompt: (state: any, context?: unknown, agentLabel?: string) => string;
  narrativeWalkthroughResponseSchema: {
    properties: Record<string, any>;
    required: ReadonlyArray<string>;
    type: string;
  };
  narrativeWalkthroughSchema: { type: string; required: ReadonlyArray<string> };
  normalizeNarrativeWalkthrough: (
    input: unknown,
    files: ReadonlyArray<{
      oldPath?: string;
      path: string;
      sections: ReadonlyArray<{ id: string; kind: string; patch?: string }>;
      status: string;
    }>,
  ) => any;
};

const files = [
  {
    path: 'src/App.tsx',
    sections: [{ id: 'src/App.tsx:staged', kind: 'staged', patch: '@@ -1 +1 @@\n-a\n+b\n' }],
    status: 'modified',
  },
  {
    path: 'src/__tests__/hunkNavigation.test.ts',
    sections: [
      {
        id: 'src/__tests__/hunkNavigation.test.ts:staged',
        kind: 'staged',
        patch: '@@ -0,0 +1,2 @@\n+one\n+two\n',
      },
    ],
    status: 'added',
  },
  {
    path: 'pnpm-lock.yaml',
    sections: [{ id: 'pnpm-lock.yaml:staged', kind: 'staged', patch: '@@ -1 +1 @@\n-a\n+b\n' }],
    status: 'modified',
  },
];

const anchor = (id: string, path: string, extra: Record<string, unknown> = {}) => ({
  added: 1,
  anchor: { display: path, sectionId: `${path}:staged`, side: 'both' },
  deleted: 1,
  granularity: 'file',
  id,
  path,
  status: path.endsWith('.test.ts') ? 'added' : 'modified',
  ...extra,
});

const baseInput = () => ({
  agent: 'claude',
  chapters: [
    {
      blurb: 'Where it breaks.',
      icon: 'bug',
      id: 'bug',
      stops: [
        {
          anchors: [
            anchor('a1', 'src/App.tsx', {
              anchor: {
                display: 'src/App.tsx:311',
                sectionId: 'src/App.tsx:staged',
                side: 'both',
                startLine: 311,
              },
              granularity: 'line',
            }),
          ],
          body: 'The root cause line.',
          id: 'stop-1',
          importance: 'critical',
          summary: 'Navigation now follows the hunk order.',
          title: 'Hunk order',
        },
        {
          anchors: [
            anchor('a2', 'src/__tests__/hunkNavigation.test.ts', {
              added: 14,
              anchor: { display: 'hunkNavigation.test.ts (new)' },
              deleted: 0,
            }),
          ],
          body: 'The regression test covers the skip.',
          id: 'stop-2',
          importance: 'normal',
          summary: 'The regression test covers collapsed-file movement.',
          title: 'Regression',
        },
      ],
      title: 'Bug',
    },
  ],
  focus: 'A one-line ordering bug let j/k skip collapsed files.',
  generatedAt: '2026-06-05T00:00:00.000Z',
  kind: 'narrative',
  repo: { branch: 'fix/hunk-nav', root: '/repo' },
  source: { type: 'working-tree' },
  support: [
    {
      files: [
        anchor('lock', 'pnpm-lock.yaml', {
          added: 312,
          anchor: { display: 'pnpm-lock.yaml' },
          deleted: 180,
        }),
      ],
      id: 'lockfiles',
      note: 'Regenerated.',
      title: 'Lockfile',
    },
  ],
  title: 'Hunk navigation skips collapsed files',
  version: 3,
});

test('exposes a schema requiring the core narrative fields', () => {
  expect(narrativeWalkthroughSchema.type).toBe('object');
  expect(narrativeWalkthroughSchema.required).toContain('chapters');
  expect(narrativeWalkthroughSchema.required).toContain('support');
  expect(narrativeWalkthroughSchema.required).not.toContain('orders');
});

test('derives an OpenAI strict-compatible response schema', () => {
  expect(narrativeWalkthroughResponseSchema.required).toEqual(
    Object.keys(narrativeWalkthroughResponseSchema.properties),
  );
  expect(narrativeWalkthroughResponseSchema.properties.context).toBeUndefined();
  expect(narrativeWalkthroughResponseSchema.properties.source).toBeUndefined();
  expect(narrativeWalkthroughResponseSchema.required).not.toContain('context');
  expect(narrativeWalkthroughResponseSchema.required).not.toContain('source');
  expect(narrativeWalkthroughResponseSchema.properties.commit.required).toEqual(['body', 'title']);
  expect(narrativeWalkthroughResponseSchema.properties.commit.type).toContain('null');
  expect(narrativeWalkthroughResponseSchema.properties.chapters.maxItems).toBe(6);
  expect(
    narrativeWalkthroughResponseSchema.properties.chapters.items.properties.title.maxLength,
  ).toBe(16);
  expect(
    narrativeWalkthroughResponseSchema.properties.chapters.items.properties.stops.maxItems,
  ).toBe(14);
  expect(
    narrativeWalkthroughResponseSchema.properties.chapters.items.properties.stops.items.properties
      .anchors.maxItems,
  ).toBe(8);
});

test('prompts generated walkthroughs to stay grouped instead of file-per-stop', () => {
  const prompt = buildNarrativeWalkthroughPrompt({
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
  expect(prompt).toContain('Target 7-12 main-path stops');
  expect(prompt).toContain('Coverage contract');
  expect(prompt).toContain('Every file must appear exactly once');
  expect(prompt).toContain('Chapter titles render in a compact top bar');
  expect(prompt).toContain('Do not create one stop per file');
  expect(prompt).toContain('can include up to 8 anchors');
  expect(prompt).toContain('support[]');
  expect(prompt).toContain('include commit.title and commit.body by default');
  expect(prompt).toContain('Do not use generic filler');
});

test('normalizes a well-formed narrative walkthrough', () => {
  const result = normalizeNarrativeWalkthrough(baseInput(), files);

  expect(result.version).toBe(3);
  expect(result.kind).toBe('narrative');
  expect(result.chapters).toHaveLength(1);
  expect(result.chapters[0].stops.map((stop: any) => stop.id)).toEqual(['stop-1', 'stop-2']);
  expect(result.support[0].files[0].id).toBe('lock');
  expect(result.chapters[0].stops[1].anchors[0].anchor.startLine).toBeUndefined();
});

test('coerces flat anchor fields into the nested anchor shape', () => {
  const input = baseInput();
  input.chapters[0].stops[0].anchors[0] = {
    ...anchor('flat', 'src/App.tsx'),
    anchor: undefined,
    display: 'src/App.tsx flat',
    sectionId: 'src/App.tsx:staged',
    sectionKind: 'staged',
    side: 'both',
  } as any;

  const result = normalizeNarrativeWalkthrough(input, files);

  expect(result.chapters[0].stops[0].anchors[0].anchor).toMatchObject({
    display: 'src/App.tsx flat',
    sectionId: 'src/App.tsx:staged',
    sectionKind: 'staged',
    side: 'both',
  });
});

test('drops stops and support files that reference unknown live paths', () => {
  const input = baseInput();
  input.chapters[0].stops.push({
    anchors: [anchor('ghost', 'src/removed.ts')],
    body: 'Ghost.',
    id: 'ghost-stop',
    importance: 'normal',
    summary: 'Ghost.',
    title: 'Ghost',
  });
  input.support.push({
    files: [anchor('also-missing', 'src/also-removed.ts')],
    id: 'missing',
    title: 'Missing',
  });

  const result = normalizeNarrativeWalkthrough(input, files);

  expect(result.chapters[0].stops.map((stop: any) => stop.id)).toEqual(['stop-1', 'stop-2']);
  expect(result.support.map((group: any) => group.id)).toEqual(['lockfiles']);
});

test('adds omitted live files to support so changed files remain visible', () => {
  const input = baseInput();
  input.support = [];

  const result = normalizeNarrativeWalkthrough(input, files);

  expect(result.support.at(-1)).toMatchObject({
    id: '__missing',
    note: 'Not included in the generated walkthrough.',
    title: 'Other changes',
  });
  expect(result.support.at(-1).files.map((file: any) => file.path)).toEqual(['pnpm-lock.yaml']);
});

test('normalizes multiple anchors under the same stop', () => {
  const input = baseInput();
  input.chapters[0].stops = [
    {
      anchors: [
        input.chapters[0].stops[0].anchors[0],
        input.chapters[0].stops[1].anchors[0],
        anchor('missing', 'src/nope.ts'),
      ],
      body: 'The root cause and proof are one review idea.',
      id: 'combined',
      importance: 'critical',
      summary: 'The root cause and proof are one review idea.',
      title: 'Flow',
    },
  ];

  const result = normalizeNarrativeWalkthrough(input, files);

  expect(result.chapters[0].stops).toHaveLength(1);
  expect(result.chapters[0].stops[0].anchors.map((item: any) => item.id)).toEqual(['a1', 'a2']);
  expect(result.support.map((group: any) => group.id)).toEqual(['lockfiles']);
});

test('drops duplicate file paths after their first anchor', () => {
  const input = baseInput();
  input.chapters[0].stops[0].anchors.push(
    anchor('duplicate-app', 'src/App.tsx', {
      summary: 'A second anchor for the same file should not render twice.',
    }),
  );

  const result = normalizeNarrativeWalkthrough(input, files);

  expect(result.chapters[0].stops[0].anchors.map((item: any) => item.id)).toEqual(['a1']);
});

test('duplicate stop ids do not consume anchors from the kept coverage set', () => {
  const input = baseInput();
  input.chapters[0].stops.push({
    anchors: [
      anchor('duplicate-stop-lock', 'pnpm-lock.yaml', {
        summary: 'A duplicate stop id should not hide this file from support.',
      }),
    ],
    body: 'Duplicate stop.',
    id: 'stop-1',
    importance: 'normal',
    summary: 'Duplicate stop.',
    title: 'Duplicate',
  });

  const result = normalizeNarrativeWalkthrough(input, files);

  expect(result.support.map((group: any) => group.id)).toEqual(['lockfiles']);
  expect(result.support[0].files.map((file: any) => file.id)).toEqual(['lock']);
});

test('duplicate support group ids do not consume files from later coverage repair', () => {
  const input = baseInput();
  const filesWithDocs = [
    ...files,
    {
      path: 'docs/walkthrough.md',
      sections: [
        {
          id: 'docs/walkthrough.md:staged',
          kind: 'staged',
          patch: '@@ -0,0 +1 @@\n+docs\n',
        },
      ],
      status: 'added',
    },
  ];
  input.support = [
    {
      files: [
        anchor('lock-first', 'pnpm-lock.yaml', {
          summary: 'First support group.',
        }),
      ],
      id: 'duplicate',
      title: 'First',
    },
    {
      files: [
        anchor('docs-skipped', 'docs/walkthrough.md', {
          summary: 'Duplicate support group.',
          status: 'added',
        }),
      ],
      id: 'duplicate',
      title: 'Second',
    },
    {
      files: [
        anchor('docs-kept', 'docs/walkthrough.md', {
          summary: 'Unique support group.',
          status: 'added',
        }),
      ],
      id: 'docs',
      title: 'Docs',
    },
  ];

  const result = normalizeNarrativeWalkthrough(input, filesWithDocs);

  expect(result.support.map((group: any) => group.id)).toEqual(['duplicate', 'docs']);
  expect(result.support[1].files.map((file: any) => file.id)).toEqual(['docs-kept']);
});

test('repairs a missing or stale anchor sectionId against the live diff', () => {
  const input = baseInput();
  input.chapters[0].stops[0].anchors[0].anchor.sectionId = 'src/App.tsx:unstaged';
  delete (input.chapters[0].stops[1].anchors[0].anchor as any).sectionId;

  const result = normalizeNarrativeWalkthrough(input, files);

  expect(result.chapters[0].stops[0].anchors[0].anchor.sectionId).toBe('src/App.tsx:staged');
  expect(result.chapters[0].stops[1].anchors[0].anchor.sectionId).toBe(
    'src/__tests__/hunkNavigation.test.ts:staged',
  );
});

test('throws when no anchors match the diff and there are no live files', () => {
  const input = baseInput();
  input.chapters[0].stops[0].anchors[0].path = 'nope.ts';
  input.chapters[0].stops[1].anchors[0].path = 'still-nope.ts';
  input.support = [];

  expect(() => normalizeNarrativeWalkthrough(input, [])).toThrow(/no anchors/i);
});

test('preserves embedded conversation context for in-app Q&A', () => {
  const input = baseInput() as any;
  input.context = {
    objective: 'Stop hunk navigation skipping collapsed files.',
    source: { generatedAt: '2026-06-05T00:00:00.000Z', type: 'claude-session' },
    version: 1,
  };

  const result = normalizeNarrativeWalkthrough(input, files);

  expect(result.context.objective).toBe('Stop hunk navigation skipping collapsed files.');
});

test('normalizes per-anchor commit tags', () => {
  const input = baseInput() as any;
  input.chapters[0].stops[0].anchors[0].changeType = 'fix';
  input.chapters[0].stops[0].anchors[0].commitNote = 'derive a collapse-independent hunk order';
  input.support[0].files[0].changeType = 'not-a-tag';

  const result = normalizeNarrativeWalkthrough(input, files);

  expect(result.chapters[0].stops[0].anchors[0].changeType).toBe('fix');
  expect(result.chapters[0].stops[0].anchors[0].commitNote).toBe(
    'derive a collapse-independent hunk order',
  );
  expect(result.support[0].files[0].changeType).toBeUndefined();
});

test('keeps the commit composer for a working-tree staging set', () => {
  const input = baseInput() as any;
  input.commit = {
    body: 'Hunk order is now collapse-independent.\n\nNavigation expands a collapsed target before scrolling.',
    title: 'Fix hunk nav',
  };

  const result = normalizeNarrativeWalkthrough(input, files);

  expect(result.commit).toEqual({
    body: 'Hunk order is now collapse-independent.\n\nNavigation expands a collapsed target before scrolling.',
    title: 'Fix hunk nav',
  });
});

test('derives a missing commit title from a title-like body first line', () => {
  const input = baseInput() as any;
  input.commit = {
    body: 'Fix hunk nav\n\nNavigation expands a collapsed target before scrolling.',
  };

  const result = normalizeNarrativeWalkthrough(input, files);

  expect(result.commit).toEqual({
    body: 'Navigation expands a collapsed target before scrolling.',
    title: 'Fix hunk nav',
  });
});

test('adds an empty commit composer for a working-tree walkthrough without commit seeds', () => {
  const input = baseInput() as any;
  delete input.commit;

  const result = normalizeNarrativeWalkthrough(input, files);

  expect(result.commit).toEqual({});
});

test('strips the commit composer when the source is not a working tree', () => {
  const input = baseInput() as any;
  input.commit = { title: 'Fix hunk nav' };
  input.source = { ref: 'abc1234', type: 'commit' };

  const result = normalizeNarrativeWalkthrough(input, files);

  expect(result.commit).toBeUndefined();
});
