import { expect, test } from 'vite-plus/test';
import {
  parseNarrativeWalkthroughV4,
  parseWalkthroughArtifactV5,
  parseWalkthroughModel,
  resolveWalkthroughFiles,
} from '../lib/narrative-walkthrough-schema.ts';
import { buildWalkthroughView } from '../lib/narrative-walkthrough.ts';
import {
  hasCapturedContextCapability,
  hasGenerationRequestCapability,
  type GitSha,
  type GenerationMetadata,
  type NarrativeWalkthroughV4,
  type WalkthroughArtifactV5,
} from '../types.ts';

const gitSha = (value: string) => value as GitSha;

const generationMetadata = (): GenerationMetadata => ({
  agent: 'codex',
  generatedAt: '2026-07-28T12:00:00.000Z',
  model: 'example-model',
  profile: {
    agent: 'codex',
    authoringVersion: 'walkthrough-v5-single-diff-1',
    modelCandidates: ['example-model'],
  },
});

const v4 = (): NarrativeWalkthroughV4 => ({
  agent: 'codex',
  chapters: [
    {
      blurb: 'Understand the change.',
      icon: 'path',
      id: 'main',
      stops: [
        {
          added: 2,
          changeType: 'feature',
          commitNote: 'preserve the compatibility boundary',
          deleted: 1,
          hunkIds: ['src/example.ts:commit:h1'],
          hunks: [
            {
              added: 2,
              additionEnd: 4,
              additionStart: 3,
              anchor: {
                display: 'src/example.ts:3',
                endLine: 4,
                sectionId: 'src/example.ts:commit',
                sectionKind: 'commit',
                side: 'both',
                startLine: 3,
              },
              deleted: 1,
              deletionEnd: 3,
              deletionStart: 3,
              id: 'src/example.ts:commit:h1',
              kind: 'patch',
              path: 'src/example.ts',
              status: 'modified',
            },
          ],
          id: 'stop-1',
          importance: 'critical',
          notes: [{ body: 'Legacy note', hunkId: 'src/example.ts:commit:h1' }],
          prose: 'Read the compatibility boundary.',
          summary: 'Compatibility boundary',
          title: 'Boundary',
        },
      ],
      title: 'Main path',
    },
  ],
  commit: { body: 'Keep V4 immutable.', title: 'Preserve walkthrough compatibility' },
  context: {
    changedFiles: [{ path: 'src/example.ts', rationale: 'Boundary', role: 'implementation' }],
    constraints: ['Do not rewrite V4.'],
    decisions: ['Normalize for display only.'],
    implementationSummary: 'Introduces a runtime boundary.',
    messages: [{ role: 'user', text: 'Preserve this value.' }],
    objective: 'Keep old walkthroughs readable.',
    risks: ['Accidental relabeling'],
    source: {
      generatedAt: '2026-07-28T12:00:00.000Z',
      threadId: 'thread-1',
      type: 'codex-session-excerpt',
    },
    validation: ['Round trip the document.'],
    version: 1,
  },
  focus: 'Keep persisted V4 stable while introducing V5.',
  generatedAt: '2026-07-28T12:00:00.000Z',
  kind: 'narrative',
  meta: '1 stop · 1 chapter',
  repo: { branch: 'main', root: '/repo' },
  source: { sha: gitSha('0123456789abcdef0123456789abcdef01234567'), type: 'commit' },
  support: [],
  title: 'Compatibility boundary',
  version: 4,
});

const v5 = (): WalkthroughArtifactV5 => {
  const { repo, version: _version, ...narrative } = v4();
  return {
    capturedContext: {
      branch: 'main',
      files: [],
      source: { sha: gitSha('0123456789abcdef0123456789abcdef01234567'), type: 'commit' },
    },
    generationRequest: { review: { relation: 'single-diff', structure: 'single-diff' } },
    narrative: {
      content: {
        ...narrative,
        repo: { branch: repo.branch },
        source: { sha: gitSha('0123456789abcdef0123456789abcdef01234567'), type: 'commit' },
      },
      generationMetadata: generationMetadata(),
      structure: 'single-diff',
    },
    version: 5,
  };
};

test('normalizes equivalent V4 and V5 narratives to equivalent rendering models', () => {
  const v4Model = parseWalkthroughModel(v4());
  const v5Model = parseWalkthroughModel(v5());
  const {
    capturedContext: _capturedContext,
    generationMetadata: _generationMetadata,
    generationRequest: _generationRequest,
    sourceVersion: _v5SourceVersion,
    structure: _structure,
    ...v5Narrative
  } = v5Model;
  const { sourceVersion: _v4SourceVersion, ...v4Narrative } = v4Model;

  expect({ ...v5Narrative, repo: v4Narrative.repo }).toEqual(v4Narrative);
  expect(buildWalkthroughView(v5Model)).toEqual(buildWalkthroughView(v4Model));
  expect('version' in v4Model).toBe(false);
  expect('version' in v5Model).toBe(false);
});

test('preserves every V4 value without fabricating V5 capabilities or mutating storage', () => {
  const persisted = v4();
  const before = JSON.stringify(persisted);
  const parsed = parseNarrativeWalkthroughV4(persisted);
  const model = parseWalkthroughModel(persisted);
  const { sourceVersion, ...narrative } = model;
  const { version: _version, ...expectedNarrative } = persisted;

  expect(parsed).toEqual(persisted);
  expect(narrative).toEqual(expectedNarrative);
  expect(sourceVersion).toBe(4);
  expect(hasCapturedContextCapability(model)).toBe(false);
  expect(hasGenerationRequestCapability(model)).toBe(false);
  expect(JSON.stringify(persisted)).toBe(before);
});

test('exposes V5 envelope capabilities by field presence', () => {
  const model = parseWalkthroughModel(v5());

  expect(model.sourceVersion).toBe(5);
  expect(hasCapturedContextCapability(model)).toBe(true);
  expect(hasGenerationRequestCapability(model)).toBe(true);
});

test('prefers V5 captured files over mismatched live evidence', () => {
  const artifact = v5();
  const model = parseWalkthroughModel({
    ...artifact,
    capturedContext: {
      ...artifact.capturedContext,
      files: [
        {
          fingerprint: 'captured-file',
          path: 'src/captured.ts',
          sections: [
            {
              binary: false,
              id: 'src/captured.ts:unstaged',
              kind: 'unstaged',
              patch: '@@ -1 +1 @@\n-old\n+new\n',
            },
          ],
          status: 'modified',
        },
      ],
    },
  });

  expect(
    resolveWalkthroughFiles(model, [
      { fingerprint: 'live', path: 'src/live.ts', sections: [], status: 'modified' },
    ]).map(({ path }) => path),
  ).toEqual(['src/captured.ts']);
});

test('preserves every resolved V4 review source variant', () => {
  const sources: ReadonlyArray<NarrativeWalkthroughV4['source']> = [
    { type: 'working-tree' },
    { sha: gitSha('1111111111111111111111111111111111111111'), type: 'commit' },
    {
      baseSha: gitSha('2222222222222222222222222222222222222222'),
      headSha: gitSha('3333333333333333333333333333333333333333'),
      ref: 'main',
      type: 'branch-diff',
    },
    {
      baseSha: gitSha('4444444444444444444444444444444444444444'),
      headSha: gitSha('5555555555555555555555555555555555555555'),
      ref: 'main',
      type: 'branch-working-tree',
    },
    { base: 'main', head: 'feature', symmetric: true, type: 'range' },
    {
      author: { avatarUrl: '', login: 'octocat', name: '', url: '' },
      canEditDescription: true,
      canEditReviewers: false,
      canEditTitle: true,
      description: '',
      headSha: '',
      host: '',
      mergeState: {
        autoMergeEnabled: false,
        canCancelAutoMerge: false,
        canMerge: true,
        canSetAutoMerge: true,
        checks: [{ detail: '', label: '', status: 'neutral', url: '' }],
        detailedStatus: '',
        forceRemoveSourceBranch: false,
        mergeError: '',
        options: { removeSourceBranch: false, squash: true },
        reason: '',
        sha: '',
        status: 'ready',
        statusLabel: '',
      },
      number: 0,
      owner: '',
      projectPath: '',
      provider: 'gitlab',
      repo: '',
      reviewers: [{ approved: false, avatarUrl: '', id: '', login: '', name: '', url: '' }],
      reviewStatus: {
        approve: { disabled: false, reason: '' },
        close: {},
        comment: {},
        requestChanges: {},
      },
      title: '',
      type: 'pull-request',
      url: '',
    },
  ];

  for (const source of sources) {
    const persisted = { ...v4(), source };
    expect(parseNarrativeWalkthroughV4(persisted).source).toEqual(source);
  }
});

test('rejects invalid documents and fields owned by later revisions', () => {
  const persistedV4 = v4();
  const artifact = v5();

  for (const invalid of [
    { ...persistedV4, capturedContext: {} },
    { ...persistedV4, reviewHistory: [] },
    {
      ...persistedV4,
      chapters: persistedV4.chapters.map((chapter) => ({
        ...chapter,
        stops: chapter.stops.map((stop) => ({ ...stop, regions: [] })),
      })),
    },
    { ...persistedV4, source: { sha: 'HEAD', type: 'commit' } },
    { ...persistedV4, version: 5 },
    { ...artifact, generationRequest: undefined },
    { ...artifact, narrative: { ...artifact.narrative, assessments: [] } },
  ]) {
    expect(() => parseWalkthroughModel(invalid)).toThrow();
  }
});

test('accepts grounded regions only in V5 narrative content', () => {
  const artifact = v5();
  if (!('content' in artifact.narrative)) {
    throw new Error('Expected a single-call artifact.');
  }
  const stop = artifact.narrative.content.chapters[0]!.stops[0]!;
  const parsed = parseWalkthroughArtifactV5({
    ...artifact,
    narrative: {
      ...artifact.narrative,
      content: {
        ...artifact.narrative.content,
        chapters: [
          {
            ...artifact.narrative.content.chapters[0]!,
            stops: [
              {
                ...stop,
                regions: [
                  {
                    endLine: 4,
                    hunkId: stop.hunkIds[0]!,
                    id: 'compatibility-boundary',
                    side: 'additions',
                    startLine: 3,
                    title: 'Compatibility boundary',
                    tooltip: 'This range preserves the persisted boundary.',
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  });

  expect(
    'content' in parsed.narrative && parsed.narrative.content.chapters[0]?.stops[0]?.regions,
  ).toHaveLength(1);
});

test('parses independently replaceable single-diff assessments outside narrative content', () => {
  const artifact = v5();
  const parsed = parseWalkthroughArtifactV5({
    ...artifact,
    assessments: {
      items: [
        {
          capturedPresentationState: { threadState: 'open' },
          identity: { codeScope: { type: 'single-diff' }, threadId: 'thread-1' },
          input: {
            codeScope: { type: 'single-diff' },
            thread: {
              comments: [
                {
                  author: { login: 'reviewer' },
                  body: 'Keep the compatibility boundary.',
                  id: 'comment-1',
                },
              ],
              id: 'thread-1',
            },
          },
          outcome: {
            generationMetadata: {
              ...generationMetadata(),
              profile: {
                ...generationMetadata().profile,
                authoringVersion: 'walkthrough-assessment-1',
              },
            },
            result: {
              disposition: 'still-applies',
              explanation: 'The compatibility boundary is still present.',
            },
            status: 'ready',
          },
        },
      ],
    },
  });
  const model = parseWalkthroughModel(parsed);

  expect(model.assessments?.items[0]?.identity.threadId).toBe('thread-1');
  expect(model.chapters).toEqual(
    'content' in artifact.narrative ? artifact.narrative.content.chapters : [],
  );
});

test('rejects mismatched assessment identities and unknown captured anchors', () => {
  const artifact = v5();
  const component = {
    capturedPresentationState: { threadState: 'open' },
    identity: { codeScope: { type: 'single-diff' }, threadId: 'thread-1' },
    input: {
      codeScope: { type: 'single-diff' },
      thread: {
        comments: [
          {
            anchor: { filePath: 'src/missing.ts', lineNumber: 1, side: 'additions' },
            author: { login: 'reviewer' },
            body: 'Check this.',
            id: 'comment-1',
          },
        ],
        id: 'thread-2',
      },
    },
    outcome: { error: 'Unavailable.', status: 'failed' },
  };

  expect(() =>
    parseWalkthroughArtifactV5({
      ...artifact,
      assessments: { items: [component] },
    }),
  ).toThrow(/identity does not match/);
  expect(() =>
    parseWalkthroughArtifactV5({
      ...artifact,
      assessments: {
        items: [
          {
            ...component,
            input: { ...component.input, thread: { ...component.input.thread, id: 'thread-1' } },
          },
        ],
      },
    }),
  ).toThrow(/unknown captured code/);
});

test('namespaces duplicate chapters, stops, support, regions, and prose anchors by commit', () => {
  const artifact = v5();
  if (!('content' in artifact.narrative)) {
    throw new Error('Expected a single-call artifact.');
  }
  const stop = artifact.narrative.content.chapters[0]!.stops[0]!;
  const content = {
    ...artifact.narrative.content,
    chapters: [
      {
        ...artifact.narrative.content.chapters[0]!,
        stops: [
          {
            ...stop,
            prose: 'Inspect the [compatibility boundary](#region-1).',
            regions: [
              {
                endLine: 4,
                hunkId: stop.hunkIds[0]!,
                id: 'region-1',
                side: 'additions' as const,
                startLine: 3,
                title: 'Compatibility boundary',
                tooltip: 'This range preserves compatibility.',
              },
            ],
          },
        ],
      },
    ],
    support: [
      {
        added: stop.added,
        deleted: stop.deleted,
        hunkIds: stop.hunkIds,
        hunks: stop.hunks,
        id: 'support-1',
        reason: 'Generated support',
        title: 'Support file',
      },
    ],
  };
  const firstSha = gitSha('1111111111111111111111111111111111111111');
  const secondSha = gitSha('2222222222222222222222222222222222222222');
  const persisted: WalkthroughArtifactV5 = {
    ...artifact,
    generationRequest: {
      review: {
        range: {
          base: { label: { kind: 'commit', text: 'base' }, sha: gitSha('a'.repeat(40)) },
          head: { label: { kind: 'commit', text: 'head' }, sha: gitSha('b'.repeat(40)) },
        },
        relation: 'target-comparison',
        structure: 'commit-by-commit',
      },
    },
    narrative: {
      structure: 'commit-by-commit',
      units: [firstSha, secondSha].map((sha) => ({
        content,
        generationMetadata: generationMetadata(),
        sha,
      })),
    },
  };

  const model = parseWalkthroughModel(persisted);
  const chapters = model.chapters;
  const stops = chapters.flatMap((chapter) => chapter.stops);

  expect(chapters.map((chapter) => chapter.id)).toEqual([`${firstSha}:main`, `${secondSha}:main`]);
  expect(stops.map((candidate) => candidate.id)).toEqual([
    `${firstSha}:stop-1`,
    `${secondSha}:stop-1`,
  ]);
  expect(stops.map((candidate) => candidate.regions?.[0]?.id)).toEqual([
    `${firstSha}:region-1`,
    `${secondSha}:region-1`,
  ]);
  expect(stops.map((candidate) => candidate.prose)).toEqual([
    `Inspect the [compatibility boundary](#${firstSha}:region-1).`,
    `Inspect the [compatibility boundary](#${secondSha}:region-1).`,
  ]);
  expect(model.support.map((group) => group.id)).toEqual([
    `${firstSha}:support-1`,
    `${secondSha}:support-1`,
  ]);
});

test('preserves canonical commit ownership as walkthrough chapter boundaries', () => {
  const artifact = v5();
  if (!('content' in artifact.narrative)) {
    throw new Error('Expected a single-call artifact.');
  }
  const content = artifact.narrative.content;
  const firstSha = gitSha('1111111111111111111111111111111111111111');
  const secondSha = gitSha('2222222222222222222222222222222222222222');
  const persisted: WalkthroughArtifactV5 = {
    ...artifact,
    generationRequest: {
      review: {
        range: {
          base: { label: { kind: 'commit', text: 'base' }, sha: gitSha('a'.repeat(40)) },
          head: { label: { kind: 'commit', text: 'head' }, sha: gitSha('b'.repeat(40)) },
        },
        relation: 'target-comparison',
        structure: 'commit-by-commit',
      },
    },
    narrative: {
      structure: 'commit-by-commit',
      units: [firstSha, secondSha].map((sha, index) => ({
        commit: {
          authoredAt: '2026-01-01T00:00:00.000Z',
          authorName: 'Ada',
          parentShas: [],
          sha,
          shortSha: sha.slice(0, 8),
          subject: `Commit ${index + 1}`,
        },
        content,
        generationMetadata: generationMetadata(),
        sha,
      })),
    },
  };

  const model = parseWalkthroughModel(persisted);
  const view = buildWalkthroughView(model)!;

  expect(model.units?.map((unit) => unit.identity)).toEqual([
    { kind: 'commit', sha: firstSha },
    { kind: 'commit', sha: secondSha },
  ]);
  expect(view.chapters.map((chapter) => chapter.boundary?.commit.shortSha)).toEqual([
    firstSha.slice(0, 8),
    secondSha.slice(0, 8),
  ]);
});

test('rejects empty or incomplete commit narrative collections', () => {
  const artifact = v5();
  if (!('content' in artifact.narrative)) {
    throw new Error('Expected a single-call artifact.');
  }
  for (const narrative of [
    { structure: 'commit-by-commit', units: [] },
    {
      structure: 'commit-by-commit',
      units: [
        {
          content: artifact.narrative.content,
          generationMetadata: generationMetadata(),
        },
      ],
    },
  ]) {
    expect(() => parseWalkthroughArtifactV5({ ...artifact, narrative })).toThrow();
  }
});

test('rejects mismatched structures and non-canonical commit unit identities', () => {
  const artifact = v5();
  if (!('content' in artifact.narrative)) {
    throw new Error('Expected a single-call artifact.');
  }
  const unitSha = gitSha('1'.repeat(40));
  const otherSha = gitSha('2'.repeat(40));
  const unit = {
    commit: {
      authoredAt: '2026-01-01T00:00:00.000Z',
      authorName: 'Ada',
      parentShas: [],
      sha: unitSha,
      shortSha: unitSha.slice(0, 8),
      subject: 'Add walkthrough units',
    },
    content: artifact.narrative.content,
    generationMetadata: generationMetadata(),
    sha: unitSha,
  };

  expect(() =>
    parseWalkthroughArtifactV5({
      ...artifact,
      generationRequest: {
        review: {
          range: {
            base: { label: { kind: 'commit', text: 'base' }, sha: gitSha('a'.repeat(40)) },
            head: { label: { kind: 'commit', text: 'head' }, sha: gitSha('b'.repeat(40)) },
          },
          relation: 'target-comparison',
          structure: 'net-change',
        },
      },
    }),
  ).toThrow(/does not match/);
  expect(() =>
    parseWalkthroughArtifactV5({
      ...artifact,
      generationRequest: {
        review: {
          range: {
            base: { label: { kind: 'commit', text: 'base' }, sha: gitSha('a'.repeat(40)) },
            head: { label: { kind: 'commit', text: 'head' }, sha: gitSha('b'.repeat(40)) },
          },
          relation: 'target-comparison',
          structure: 'commit-by-commit',
        },
      },
      narrative: { structure: 'commit-by-commit', units: [unit, unit] },
    }),
  ).toThrow(/identities must be unique/);
  expect(() =>
    parseWalkthroughArtifactV5({
      ...artifact,
      generationRequest: {
        review: {
          range: {
            base: { label: { kind: 'commit', text: 'base' }, sha: gitSha('a'.repeat(40)) },
            head: { label: { kind: 'commit', text: 'head' }, sha: gitSha('b'.repeat(40)) },
          },
          relation: 'target-comparison',
          structure: 'commit-by-commit',
        },
      },
      narrative: {
        structure: 'commit-by-commit',
        units: [{ ...unit, commit: { ...unit.commit, sha: otherSha } }],
      },
    }),
  ).toThrow(/metadata must match/);
});

test('round trips the initial composite V5 artifact without changing its shape', () => {
  const artifact = v5();
  const persistedV4 = v4();
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON persistence.
  const roundTripped = JSON.parse(JSON.stringify(artifact)) as unknown;
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON persistence.
  const roundTrippedV4 = JSON.parse(JSON.stringify(persistedV4)) as unknown;

  expect(parseWalkthroughArtifactV5(roundTripped)).toEqual(artifact);
  expect(parseNarrativeWalkthroughV4(roundTrippedV4)).toEqual(persistedV4);
});
