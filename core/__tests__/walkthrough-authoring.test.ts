import { expect, test } from 'vite-plus/test';
import { parseWalkthroughArtifactV5 } from '../lib/narrative-walkthrough-schema.ts';
import {
  authorWalkthroughArtifactV5,
  buildWalkthroughPrompt,
  buildWalkthroughPromptInput,
  captureWalkthroughContext,
  createWalkthroughGenerationRequest,
  createWalkthroughGenerationProfile,
  indexWalkthroughHunks,
  normalizeWalkthroughDraft,
  parseWalkthroughDraft,
} from '../lib/walkthrough-authoring.ts';
import type { GenerationMetadata, GitSha, RepositoryState } from '../types.ts';

const gitSha = (value: string) => value as GitSha;
const generationMetadata: GenerationMetadata = {
  agent: 'codex',
  generatedAt: '2026-06-26T00:00:00.000Z',
  model: 'example-model',
  profile: createWalkthroughGenerationProfile({
    agent: 'codex',
    modelCandidates: ['example-model', 'example-fallback-model'],
    settings: { reasoningEffort: 'medium' },
  }),
};

const state = {
  branch: 'feature/walkthrough',
  files: [
    {
      fingerprint: 'fingerprint',
      path: 'src/app.ts',
      sections: [
        {
          binary: false,
          id: 'src/app.ts:pull-request:42',
          kind: 'pull-request',
          patch:
            'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old();\n+newCall();\n@@ -10,0 +11 @@\n+test();\n',
        },
      ],
      status: 'modified',
    },
  ],
  generatedAt: Date.parse('2026-06-26T00:00:00.000Z'),
  launchPath: '/private/tmp/example-launch',
  root: '/private/tmp/example-repository',
  source: {
    headSha: gitSha('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    host: 'internal-provider-host',
    number: 42,
    projectPath: 'example/repository',
    provider: 'gitlab',
    reviewers: [{ approved: false, id: 'reviewer-1', login: 'reviewer', name: 'Reviewer' }],
    type: 'pull-request',
    url: 'https://git.example.org/example/repository/merge_requests/42',
  },
} satisfies RepositoryState;

const capturedState = captureWalkthroughContext(state);
const singleDiffRequest = createWalkthroughGenerationRequest({
  relation: 'single-diff',
  structure: 'single-diff',
});

test('indexes stable hunk ids but sends compact aliases in the prompt', () => {
  const index = indexWalkthroughHunks(state.files);
  expect(index.hunks.map(({ id }) => id)).toEqual([
    'src/app.ts:pull-request:42:h1',
    'src/app.ts:pull-request:42:h2',
  ]);
  expect(index.hunkIdByAlias.get('h1')).toBe('src/app.ts:pull-request:42:h1');
  const prompt = buildWalkthroughPrompt(capturedState, singleDiffRequest);
  expect(prompt).toContain('"id":"h1"');
  expect(prompt).not.toContain('"id":"src/app.ts:pull-request:42:h1"');
  expect(prompt).toContain('compact request-local aliases');
  expect(prompt).toContain('Every stop must have a concise semantic title');
  expect(prompt).toContain('Match explanation depth to complexity');
  expect(prompt).toContain('Do not narrate syntax line by line');
});

test('uses source-aware terminology and applies custom instructions once', () => {
  const customInstructions = 'Use German product-review terminology.';
  const sources = [
    [{ ...state, source: { ...state.source, provider: 'github' } }, 'GitHub pull request'],
    [{ ...state, source: { ...state.source, provider: 'gitlab' } }, 'GitLab merge request'],
    [{ ...state, source: { ...state.source, provider: undefined } }, 'pull request'],
    [
      {
        ...state,
        source: { sha: gitSha('cccccccccccccccccccccccccccccccccccccccc'), type: 'commit' },
      },
      'commit',
    ],
    [
      {
        ...state,
        source: {
          baseSha: gitSha('dddddddddddddddddddddddddddddddddddddddd'),
          headSha: gitSha('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
          ref: 'main',
          type: 'branch-diff',
        },
      },
      'branch comparison',
    ],
    [
      { ...state, source: { base: 'main', head: 'feature', symmetric: true, type: 'range' } },
      'ref range',
    ],
    [{ ...state, source: { type: 'working-tree' } }, 'working-tree changes'],
  ] as const;

  for (const [sourceState, description] of sources) {
    expect(
      buildWalkthroughPrompt(captureWalkthroughContext(sourceState), singleDiffRequest),
    ).toContain(`Author a Codiff narrative walkthrough for this ${description}.`);
  }

  const prompt = buildWalkthroughPrompt(
    capturedState,
    createWalkthroughGenerationRequest(
      { relation: 'single-diff', structure: 'single-diff' },
      customInstructions,
    ),
  );
  expect(prompt.split(customInstructions)).toHaveLength(2);
  expect(prompt).toContain('Custom walkthrough instructions:');
});

test('normalizes draft aliases back onto live hunk ids and fills support', () => {
  const index = indexWalkthroughHunks(state.files);
  const walkthrough = normalizeWalkthroughDraft(
    {
      chapters: [
        {
          blurb: 'Core change',
          icon: 'path',
          id: 'c1',
          stops: [
            {
              hunkIds: ['h1'],
              id: 's1',
              importance: 'critical',
              prose: 'Explain the new call path.',
              title: 'New call path',
            },
          ],
          title: 'Core',
        },
      ],
      focus: 'Review the feature.',
      kind: 'narrative',
      title: 'Feature walkthrough',
      version: 4,
    },
    state,
    generationMetadata,
  );
  expect(walkthrough.chapters[0]?.stops[0]?.hunkIds).toEqual([index.hunks[0]!.id]);
  expect(walkthrough.support.length).toBeGreaterThan(0);
  expect(walkthrough.support.some((item) => item.hunkIds.includes(index.hunks[1]!.id))).toBe(true);
});

test('accepts compact and legacy nullable draft shapes', () => {
  const compact = parseWalkthroughDraft({
    chapters: [
      {
        blurb: 'Core',
        icon: 'path',
        id: 'c1',
        stops: [
          {
            hunkIds: ['h1'],
            id: 's1',
            importance: 'normal',
            prose: 'Details',
            title: 'Title here',
          },
        ],
        title: 'Core',
      },
    ],
    focus: 'Focus',
    kind: 'narrative',
    title: 'Title',
    version: 4,
  });
  expect(compact.chapters[0]?.stops[0]?.title).toBe('Title here');

  const legacy = parseWalkthroughDraft({
    chapters: [
      {
        blurb: 'Core',
        icon: 'path',
        id: 'c1',
        stops: [
          {
            changeType: null,
            commitNote: null,
            hunkIds: ['h1'],
            id: 's1',
            importance: 'normal',
            notes: null,
            prose: 'Details',
            summary: null,
            title: null,
          },
        ],
        title: 'Core',
      },
    ],
    focus: 'Focus',
    kind: 'narrative',
    support: null,
    title: 'Title',
    version: 4,
  });
  expect(legacy.chapters[0]?.stops[0]?.hunkIds).toEqual(['h1']);
  expect(legacy.support).toBeUndefined();
});

test('authors a sanitized V5 artifact from authoritative inputs', () => {
  const response = {
    chapters: [
      {
        blurb: 'Core change',
        icon: 'path',
        id: 'c1',
        stops: [
          {
            hunkIds: ['h1'],
            id: 's1',
            importance: 'critical',
            prose: 'Explain the new call path.',
            title: 'New call path',
          },
        ],
        title: 'Core',
      },
    ],
    focus: 'Review the feature.',
    kind: 'narrative',
    title: 'Feature walkthrough',
    version: 4,
  };
  const generationRequest = createWalkthroughGenerationRequest(
    { relation: 'single-diff', structure: 'single-diff' },
    ' Prioritize the request path. ',
  );
  const artifact = authorWalkthroughArtifactV5({
    generationMetadata,
    generationRequest,
    response,
    state: { ...state, reviewComments: [] },
  });

  expect(artifact).toMatchObject({
    capturedContext: { branch: state.branch, files: [{ path: 'src/app.ts' }] },
    generationRequest: { customInstructions: 'Prioritize the request path.' },
    narrative: {
      generationMetadata,
      repo: { branch: state.branch },
      structure: 'single-diff',
    },
    version: 5,
  });
  expect(captureWalkthroughContext(state)).toEqual(artifact.capturedContext);
  expect(JSON.stringify(artifact)).not.toContain(state.root);
  expect(JSON.stringify(artifact)).not.toContain(state.launchPath);
  expect(JSON.stringify(artifact)).not.toContain('reviewComments');
  expect(JSON.stringify(artifact)).not.toContain('internal-provider-host');
  expect(JSON.stringify(artifact)).not.toContain('reviewers');
  expect(parseWalkthroughArtifactV5(structuredClone(artifact))).toEqual(artifact);
});

test('rejects successful metadata outside the requested fallback chain', () => {
  expect(() =>
    authorWalkthroughArtifactV5({
      generationMetadata: { ...generationMetadata, model: 'undeclared-model' },
      generationRequest: singleDiffRequest,
      response: {},
      state,
    }),
  ).toThrow('requested fallback chain');
});

test('rejects stale authoring semantics for newly generated artifacts', () => {
  expect(() =>
    authorWalkthroughArtifactV5({
      generationMetadata: {
        ...generationMetadata,
        profile: { ...generationMetadata.profile, authoringVersion: 'stale-authoring' },
      },
      generationRequest: singleDiffRequest,
      response: {},
      state,
    }),
  ).toThrow('current walkthrough authoring version');
});

test('exposes prompt digest sizing and patch budgets', () => {
  const { digest, patchBudgets, size } = buildWalkthroughPromptInput(
    capturedState,
    singleDiffRequest,
  );
  expect(size.hunkCount).toBe(2);
  expect(digest.files[0]?.sections[0]?.hunks[0]?.id).toBe('h1');
  expect(patchBudgets.total).toBeGreaterThan(0);
});
