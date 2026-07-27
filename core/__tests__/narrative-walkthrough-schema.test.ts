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
      ...narrative,
      generationMetadata: generationMetadata(),
      repo: { branch: repo.branch },
      source: { sha: gitSha('0123456789abcdef0123456789abcdef01234567'), type: 'commit' },
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
  const stop = artifact.narrative.chapters[0]!.stops[0]!;
  const parsed = parseWalkthroughArtifactV5({
    ...artifact,
    narrative: {
      ...artifact.narrative,
      chapters: [
        {
          ...artifact.narrative.chapters[0]!,
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
  });

  expect(parsed.narrative.chapters[0]?.stops[0]?.regions).toHaveLength(1);
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
