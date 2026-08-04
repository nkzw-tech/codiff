import { expect, test } from 'vite-plus/test';
import { parseWalkthroughArtifactV5 } from '../lib/narrative-walkthrough-schema.ts';
import {
  authorWalkthroughArtifactV5,
  buildReviewFocusPrompt,
  buildWalkthroughPrompt,
  buildWalkthroughPromptInput,
  captureWalkthroughContext,
  createWalkthroughGenerationRequest,
  createWalkthroughGenerationProfile,
  indexWalkthroughHunks,
  normalizeWalkthroughDraft,
  parseWalkthroughDraft,
} from '../lib/walkthrough-authoring.ts';
import type { EvolutionUnitId, GenerationMetadata, GitSha, RepositoryState } from '../types.ts';

const gitSha = (value: string) => value as GitSha;
const revision = (sha: string, label: string) => ({
  label: { kind: 'version' as const, text: label },
  sha: gitSha(sha),
});
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

test('builds Review focus prompts from ordered Commit Evolution inputs', () => {
  const content = {
    agent: 'codex' as const,
    chapters: [
      {
        blurb: 'Trace the behavior.',
        icon: 'path' as const,
        id: 'chapter',
        stops: [
          {
            added: 1,
            deleted: 1,
            hunkIds: [],
            hunks: [],
            id: 'stop',
            importance: 'normal' as const,
            prose: 'Trace the new path.',
            title: 'New path',
          },
        ],
        title: 'Routing change',
      },
    ],
    focus: 'Follow the routing behavior.',
    generatedAt: '2026-07-28T00:00:00.000Z',
    kind: 'narrative' as const,
    repo: { branch: 'feature' },
    source: { type: 'working-tree' as const },
    support: [],
    title: 'Routing update',
  };
  const prompt = buildReviewFocusPrompt({
    generationRequest: {
      customInstructions: 'Emphasize user-visible behavior.',
      review: {
        comparison: {
          after: {
            base: revision('c'.repeat(40), 'Target'),
            head: revision('d'.repeat(40), 'Version 2'),
          },
          before: {
            base: revision('a'.repeat(40), 'Target'),
            head: revision('b'.repeat(40), 'Version 1'),
          },
        },
        relation: 'version-comparison',
        structure: 'commit-evolution',
      },
    },
    units: [{ content, unitId: 'evolution-unit-1' as EvolutionUnitId }],
  });

  expect(prompt).toContain('from Version 1 to Version 2');
  expect(prompt).toContain('Emphasize user-visible behavior.');
  expect(prompt).toContain('Follow the routing behavior.');
  expect(prompt).toContain('Routing change');
});

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
    reviewers: [
      {
        approved: false,
        id: 'reviewer-1',
        login: 'reviewer',
        name: 'Reviewer',
      },
    ],
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
        source: {
          sha: gitSha('cccccccccccccccccccccccccccccccccccccccc'),
          type: 'commit',
        },
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
      {
        ...state,
        source: {
          base: 'main',
          head: 'feature',
          symmetric: true,
          type: 'range',
        },
      },
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

test('authors commit prompts from only that commit diff and canonical identity', () => {
  const commitSha = gitSha('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const commitContext = { sha: commitSha, subject: 'Add request routing' };
  const capturedContext = captureWalkthroughContext({
    ...state,
    source: {
      ...state.source,
      description: 'Summarize the entire merge request as one change.',
      title: 'Complete merge request',
    },
  });
  const request = createWalkthroughGenerationRequest({
    range: {
      base: {
        label: { kind: 'commit', text: 'base' },
        sha: gitSha('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      },
      head: { label: { kind: 'commit', text: 'head' }, sha: commitSha },
    },
    relation: 'target-comparison',
    structure: 'commit-by-commit',
  });
  const options = {
    commitContext,
    scope: { kind: 'commit' as const, sha: commitSha },
  };
  const { digest } = buildWalkthroughPromptInput(capturedContext, request, options);
  const prompt = buildWalkthroughPrompt(capturedContext, request, options);

  expect(digest.commitContext).toEqual(commitContext);
  expect(digest.scope).toEqual({ kind: 'commit', sha: commitSha });
  expect(digest.source).toMatchObject({ title: commitContext.subject });
  expect(digest.source).not.toHaveProperty('description');
  expect(prompt).toContain(`independent walkthrough for commit ${commitSha}`);
  expect(prompt).toContain('Explain only the changes introduced by this commit');
  expect(prompt).not.toContain('Summarize the entire merge request as one change.');
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

test('normalizes grounded V5 regions and drops invalid regions', () => {
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
              prose: 'The [new call](#new-call) is the new execution path.',
              regions: [
                {
                  endLine: 1,
                  hunkId: 'h1',
                  id: 'new-call',
                  side: 'additions',
                  startLine: 1,
                  title: 'New call',
                  tooltip: 'This invokes the replacement path.',
                },
                {
                  endLine: 4,
                  hunkId: 'h1',
                  id: 'outside-hunk',
                  side: 'additions',
                  startLine: 3,
                  title: 'Invalid range',
                  tooltip: 'Outside the supplied hunk.',
                },
              ],
              title: 'New call path',
            },
          ],
          title: 'Core',
        },
      ],
      focus: 'Review the feature.',
      kind: 'narrative',
      title: 'Feature walkthrough',
    },
    state,
    generationMetadata,
  );

  const stop = walkthrough.chapters[0]?.stops[0];
  expect(stop?.hunkIds).toEqual([index.hunks[0]!.id]);
  expect(stop?.regions).toEqual([
    expect.objectContaining({ hunkId: index.hunks[0]!.id, id: 'new-call' }),
  ]);
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

test('includes final commit-evolution guidance and scope identity', () => {
  const prompt = buildWalkthroughPrompt(capturedState, singleDiffRequest, {
    scope: { kind: 'evolution-unit', unitId: 'unit-1' as EvolutionUnitId },
    versionCommitContext: {
      after: { shortSha: 'bbbbbbb', subject: 'Later' },
      before: { shortSha: 'aaaaaaa', subject: 'Earlier' },
      evolutionKind: 'revised',
      kind: 'version-commit',
      range: { fromLabel: 'v1', toLabel: 'v2' },
      unitId: 'unit-1' as EvolutionUnitId,
    },
    versionCompareRange: {
      fromLabel: 'v1',
      structure: 'commit-evolution',
      toLabel: 'v2',
    },
  });
  expect(prompt).toContain('logical commit between v1 and v2');
  expect(prompt).toContain('Earlier');
  expect(prompt).toContain('Later');
  expect(prompt).toContain('"kind":"evolution-unit"');
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
      content: { repo: { branch: state.branch } },
      generationMetadata,
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
        profile: {
          ...generationMetadata.profile,
          authoringVersion: 'stale-authoring',
        },
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
