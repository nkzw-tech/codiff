import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vite-plus/test';
import {
  createCommitArtifactRequestKey,
  createReviewArtifactRun,
  reviewArtifactSchemaVersion,
  validateCommitArtifact,
  validateRangeArtifact,
  validateStackSnapshot,
} from '../../core/lib/review-artifacts.ts';
import type {
  CommitArtifact,
  ReviewArtifactProject,
  ReviewArtifactSource,
} from '../../core/lib/review-artifacts.ts';
import type { GitSha, ReviewEvolutionUnit } from '../../core/types.ts';

const require = createRequire(import.meta.url);
const {
  artifactCacheKey,
  artifactToReplayPatchFiles,
  createArtifactBlobLookup,
  createFallbackReviewArtifactSource,
  createPersistentReviewArtifactSource,
  getComparisonArtifactRun,
  listArtifactRepositoryHistory,
  materializeReviewUnitFromArtifacts,
  recordComparisonRunMetric,
  rememberReviewUnitArtifactRun,
} = require('../git-state/review-artifact-run.cjs') as {
  artifactCacheKey: (
    kind: 'commit-artifact' | 'stack-and-range-artifact',
    project: ReviewArtifactProject,
    schemaVersion: string,
    coordinates: {
      baseSha?: string;
      commitSha?: string;
      headSha?: string;
      parentSha?: string | null;
    },
    rangeDiffSemantics?: string,
  ) => Record<string, unknown>;
  artifactToReplayPatchFiles: (
    artifact: CommitArtifact | import('../../core/lib/review-artifacts.ts').RangeArtifact,
  ) => ReadonlyArray<import('../../core/lib/rebase-replay-compare.ts').ReplayPatchFile>;
  createArtifactBlobLookup: (
    repoRoot: string,
    run: ReturnType<typeof createReviewArtifactRun>,
    artifacts: ReadonlyArray<
      CommitArtifact | import('../../core/lib/review-artifacts.ts').RangeArtifact
    >,
    signal?: AbortSignal,
  ) => (
    requests: ReadonlyArray<{ path: string; ref: string }>,
  ) => Promise<ReadonlyMap<string, string | null>>;
  createFallbackReviewArtifactSource: (
    primary: ReviewArtifactSource,
    fallback: ReviewArtifactSource,
  ) => ReviewArtifactSource;
  createPersistentReviewArtifactSource: (
    source: ReviewArtifactSource,
    options: {
      cache?: {
        read?: (key: unknown) => Promise<unknown | null>;
        write?: (key: unknown, value: unknown) => Promise<boolean>;
      };
      diffSemantics?: string;
      project: ReviewArtifactProject;
      provenanceKind?: 'github-api' | 'gitlab-api' | 'native-git';
      schemaVersion: string;
      validators?: {
        validateCommitArtifact?: (value: unknown) => unknown;
        validateRangeArtifact?: (value: unknown) => unknown;
        validateStackSnapshot?: (value: unknown) => unknown;
      };
    },
  ) => ReviewArtifactSource;
  getComparisonArtifactRun: (
    repoRoot: string,
    project: ReviewArtifactProject,
    control?: { comparisonRun?: { artifactRuns?: Map<string, Promise<unknown>> } },
  ) => Promise<ReturnType<typeof createReviewArtifactRun>>;
  listArtifactRepositoryHistory: (
    repoRoot: string,
    project: ReviewArtifactProject,
    baseSha: GitSha,
    headSha: GitSha,
    limit?: number,
    control?: { comparisonRun?: { artifactRuns?: Map<string, Promise<unknown>> } },
  ) => Promise<import('../../core/types.ts').RepositoryHistory>;
  materializeReviewUnitFromArtifacts: (
    repoRoot: string,
    project: ReviewArtifactProject,
    unit: ReviewEvolutionUnit,
  ) => Promise<ReadonlyArray<import('../../core/types.ts').ChangedFile> | null>;
  recordComparisonRunMetric: (
    control: { comparisonRun?: Record<string, unknown> } | Record<string, unknown>,
    metric: Record<string, unknown>,
  ) => void;
  rememberReviewUnitArtifactRun: (
    repoRoot: string,
    project: ReviewArtifactProject,
    units: ReadonlyArray<ReviewEvolutionUnit>,
    run: ReturnType<typeof createReviewArtifactRun>,
  ) => void;
};

const sha = (value: string) => value.repeat(40) as GitSha;
const project: ReviewArtifactProject = {
  host: 'github.com',
  project: 'nkzw-tech/codiff',
  provider: 'github',
};

test('keeps comparison phase metrics transient on the owning Comparison Run', () => {
  const comparisonRun: Record<string, unknown> = {};

  recordComparisonRunMetric(
    { comparisonRun },
    { kind: 'commit-matching', provider: 'gitlab', elapsedMs: 12 },
  );
  recordComparisonRunMetric(comparisonRun, {
    kind: 'regional-replay',
    provider: 'github',
    elapsedMs: 8,
  });

  expect(comparisonRun.comparisonMetrics).toEqual([
    { kind: 'commit-matching', provider: 'gitlab', elapsedMs: 12 },
    { kind: 'regional-replay', provider: 'github', elapsedMs: 8 },
  ]);
});

test('keeps an Artifact Run linked to its owning Comparison Run for deferred unit diagnostics', async () => {
  const comparisonRun: Record<string, unknown> = { artifactRuns: new Map() };
  const run = await getComparisonArtifactRun(process.cwd(), project, { comparisonRun });

  expect((run as typeof run & { comparisonRun?: unknown }).comparisonRun).toBe(comparisonRun);
});

test('persists complete Commit and Stack/Range Artifacts under Core-derived keys', async () => {
  const baseSha = sha('a');
  const headSha = sha('b');
  const provenance = { kind: 'native-git', project } as const;
  const artifact: CommitArtifact = {
    commitSha: headSha,
    coverage: 'complete',
    files: [
      {
        coverage: 'complete',
        patch: '@@ -1 +1 @@\n-before\n+after\n',
        path: 'src/app.ts',
        status: 'modified',
      },
    ],
    parentSha: baseSha,
    provenance,
  };
  const stackAndRange = {
    range: {
      baseSha,
      coverage: 'complete' as const,
      files: artifact.files,
      headSha,
      provenance,
    },
    stack: {
      baseSha,
      commits: [
        {
          authoredAt: '2026-08-01T00:00:00.000Z',
          authorName: 'Ada',
          parentShas: [baseSha],
          sha: headSha,
          shortSha: headSha.slice(0, 7),
          subject: 'Update app',
        },
      ],
      coverage: 'complete' as const,
      headSha,
      provenance,
    },
  };
  const persistent = new Map<string, unknown>();
  const read = vi.fn(async (key: unknown) => persistent.get(JSON.stringify(key)) ?? null);
  const write = vi.fn(async (key: unknown, value: unknown) => {
    persistent.set(JSON.stringify(key), value);
    return true;
  });
  const backing: ReviewArtifactSource = {
    readBlobs: async () => new Map(),
    readCommitArtifacts: vi.fn(
      async () => new Map([[createCommitArtifactRequestKey(artifact), artifact]]),
    ),
    readStackAndRange: vi.fn(async () => stackAndRange),
  };
  const options = {
    cache: { read, write },
    project,
    schemaVersion: reviewArtifactSchemaVersion,
    validators: {
      validateCommitArtifact,
      validateRangeArtifact,
      validateStackSnapshot,
    },
  };
  const first = createReviewArtifactRun(createPersistentReviewArtifactSource(backing, options));

  await first.readStackAndRange({ headSha: headSha, requestedBaseSha: baseSha }, first.signal);
  await first.readCommitArtifacts([{ commitSha: headSha, parentSha: baseSha }], first.signal);

  const warm = createReviewArtifactRun(createPersistentReviewArtifactSource(backing, options));
  const [warmStackAndRange, warmArtifacts] = await Promise.all([
    warm.readStackAndRange({ headSha: headSha, requestedBaseSha: baseSha }, warm.signal),
    warm.readCommitArtifacts([{ commitSha: headSha, parentSha: baseSha }], warm.signal),
  ]);

  expect(backing.readStackAndRange).toHaveBeenCalledTimes(1);
  expect(backing.readCommitArtifacts).toHaveBeenCalledTimes(1);
  expect(warmStackAndRange).toEqual(stackAndRange);
  expect(warmArtifacts.get(createCommitArtifactRequestKey(artifact))).toEqual(artifact);
  expect(write).toHaveBeenCalledTimes(2);
  expect(
    persistent.get(
      JSON.stringify(
        artifactCacheKey('commit-artifact', project, reviewArtifactSchemaVersion, {
          commitSha: headSha,
          parentSha: baseSha,
        }),
      ),
    ),
  ).toEqual(artifact);
  expect(
    persistent.get(
      JSON.stringify(
        artifactCacheKey('stack-and-range-artifact', project, reviewArtifactSchemaVersion, {
          baseSha,
          headSha,
        }),
      ),
    ),
  ).toEqual(stackAndRange);
  expect(
    artifactCacheKey('stack-and-range-artifact', project, reviewArtifactSchemaVersion, {
      baseSha,
      headSha,
    }),
  ).toMatchObject({
    artifactSchemaVersion: reviewArtifactSchemaVersion,
    diffSemantics: 'native-git-patch-with-raw-unified-0-v1',
  });
});

test('reuses an initial provider range before reacquiring the native range', async () => {
  const baseSha = sha('a');
  const headSha = sha('b');
  const provenance = { kind: 'github-api', project } as const;
  const stackAndRange = {
    range: {
      baseSha,
      coverage: 'complete' as const,
      files: [
        {
          coverage: 'complete' as const,
          patch: '@@ -1 +1 @@\n-before\n+after\n',
          path: 'src/app.ts',
          status: 'modified' as const,
        },
      ],
      headSha,
      provenance,
    },
    stack: {
      baseSha,
      commits: [
        {
          authoredAt: '2026-08-01T00:00:00.000Z',
          authorName: 'Ada',
          parentShas: [baseSha],
          sha: headSha,
          shortSha: headSha.slice(0, 7),
          subject: 'Update app',
        },
      ],
      coverage: 'complete' as const,
      headSha,
      provenance,
    },
  };
  const persistent = new Map<string, unknown>();
  const cache = {
    read: async (key: unknown) => persistent.get(JSON.stringify(key)) ?? null,
    write: async (key: unknown, value: unknown) => {
      persistent.set(JSON.stringify(key), value);
      return true;
    },
  };
  const providerRead = vi.fn(async () => stackAndRange);
  const providerOptions = {
    cache,
    diffSemantics: 'github-repository-compare-v1',
    project,
    provenanceKind: 'github-api' as const,
    schemaVersion: reviewArtifactSchemaVersion,
    validators: { validateCommitArtifact, validateRangeArtifact, validateStackSnapshot },
  };
  const initial = createPersistentReviewArtifactSource(
    {
      readBlobs: async () => new Map(),
      readCommitArtifacts: async () => new Map(),
      readStackAndRange: providerRead,
    },
    providerOptions,
  );
  const signal = new AbortController().signal;
  await initial.readStackAndRange({ headSha: headSha, requestedBaseSha: baseSha }, signal);

  const nativeRead = vi.fn(async () => {
    throw new Error('The cached provider range should win.');
  });
  const warmProviderRead = vi.fn(async () => {
    throw new Error('The provider should not be reacquired.');
  });
  const hybrid = createFallbackReviewArtifactSource(
    {
      readBlobs: async () => new Map(),
      readCommitArtifacts: async () => new Map(),
      readStackAndRange: nativeRead,
    },
    createPersistentReviewArtifactSource(
      {
        readBlobs: async () => new Map(),
        readCommitArtifacts: async () => new Map(),
        readStackAndRange: warmProviderRead,
      },
      providerOptions,
    ),
  );

  await expect(
    hybrid.readStackAndRange({ headSha: headSha, requestedBaseSha: baseSha }, signal),
  ).resolves.toEqual(stackAndRange);
  expect(providerRead).toHaveBeenCalledTimes(1);
  expect(nativeRead).not.toHaveBeenCalled();
  expect(warmProviderRead).not.toHaveBeenCalled();
  expect(
    persistent.has(
      JSON.stringify(
        artifactCacheKey(
          'stack-and-range-artifact',
          project,
          reviewArtifactSchemaVersion,
          { baseSha, headSha },
          'github-repository-compare-v1',
        ),
      ),
    ),
  ).toBe(true);
});

test('returns incomplete artifacts without persisting them as complete cache entries', async () => {
  const commitSha = sha('b');
  const parentSha = sha('a');
  const incomplete: CommitArtifact = {
    commitSha,
    coverage: 'truncated',
    files: [
      {
        coverage: 'truncated',
        path: 'src/app.ts',
        status: 'modified',
      },
    ],
    parentSha,
    provenance: { kind: 'native-git', project },
  };
  const write = vi.fn(async () => true);
  const source = createPersistentReviewArtifactSource(
    {
      readBlobs: async () => new Map(),
      readCommitArtifacts: async () =>
        new Map([[createCommitArtifactRequestKey(incomplete), incomplete]]),
      readStackAndRange: async () => {
        throw new Error('unused');
      },
    },
    {
      cache: { read: async () => null, write },
      project,
      schemaVersion: reviewArtifactSchemaVersion,
      validators: { validateCommitArtifact },
    },
  );
  const controller = new AbortController();

  const artifacts = await source.readCommitArtifacts([{ commitSha, parentSha }], controller.signal);

  expect(artifacts.get(createCommitArtifactRequestKey(incomplete))).toEqual(incomplete);
  expect(write).not.toHaveBeenCalled();
});

test('preserves artifact object identities when adapting range patches for replay', () => {
  const files = artifactToReplayPatchFiles({
    baseSha: sha('a'),
    coverage: 'complete',
    files: [
      {
        coverage: 'complete',
        newObjectId: sha('c'),
        oldObjectId: sha('b'),
        patch: '@@ -1 +1 @@\n-before\n+after\n',
        path: 'src/app.ts',
        status: 'modified',
      },
    ],
    headSha: sha('d'),
    provenance: { kind: 'native-git', project },
  });

  expect(files).toEqual([
    {
      coverage: 'complete',
      newObjectId: sha('c'),
      newPath: 'src/app.ts',
      oldObjectId: sha('b'),
      oldPath: 'src/app.ts',
      patchBody: '@@ -1 +1 @@\n-before\n+after\n',
      status: 'modified',
    },
  ]);
});

test('builds provider review history from one warmable native Artifact Run', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'codiff-artifact-history-'));
  const runGit = (args: ReadonlyArray<string>) =>
    execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  const control: { comparisonRun: { artifactRuns?: Map<string, Promise<unknown>> } } = {
    comparisonRun: {},
  };
  const localProject: ReviewArtifactProject = {
    host: 'local',
    project: repository,
    provider: 'git',
  };
  try {
    runGit(['init', '--quiet']);
    runGit(['config', 'user.email', 'ada@example.com']);
    runGit(['config', 'user.name', 'Ada']);
    await writeFile(join(repository, 'app.ts'), 'base\n');
    runGit(['add', 'app.ts']);
    runGit(['commit', '--quiet', '-m', 'Base']);
    const baseSha = runGit(['rev-parse', 'HEAD']) as GitSha;
    await writeFile(join(repository, 'app.ts'), 'base\none\n');
    runGit(['add', 'app.ts']);
    runGit(['commit', '--quiet', '-m', 'Add one']);
    await writeFile(join(repository, 'app.ts'), 'base\ntwo\n');
    runGit(['add', 'app.ts']);
    runGit(['commit', '--quiet', '-m', 'Revise one']);
    const headSha = runGit(['rev-parse', 'HEAD']) as GitSha;

    const first = await listArtifactRepositoryHistory(
      repository,
      localProject,
      baseSha,
      headSha,
      10,
      control,
    );
    const warm = await listArtifactRepositoryHistory(
      repository,
      localProject,
      baseSha,
      headSha,
      10,
      control,
    );
    const artifactRun = await getComparisonArtifactRun(repository, localProject, control);

    expect(first.entries.slice(0, 2)).toMatchObject([
      { author: 'Ada', diffStat: { additions: 1, deletions: 0 }, scope: 'pull-request' },
      { author: 'Ada', diffStat: { additions: 1, deletions: 1 }, scope: 'pull-request' },
    ]);
    expect(first.entries[2]).toMatchObject({ scope: 'base', subject: 'Base' });
    expect(warm).toEqual(first);
    expect(artifactRun.diagnostics().sourceCalls).toMatchObject({
      commits: 1,
      stackAndRanges: 1,
    });
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
}, 15_000);

test('reuses a Comparison Run Commit Artifact when opening an introduced unit', async () => {
  const parentSha = sha('a');
  const commitSha = sha('b');
  const artifact: CommitArtifact = {
    commitSha,
    coverage: 'complete',
    files: [
      {
        coverage: 'complete',
        patch: '@@ -1 +1 @@\n-old\n+new',
        path: 'src/app.ts',
        status: 'modified',
      },
    ],
    parentSha,
    provenance: { kind: 'native-git', project },
  };
  const readCommitArtifacts = vi.fn<ReviewArtifactSource['readCommitArtifacts']>(
    async () => new Map([[createCommitArtifactRequestKey(artifact), artifact]]),
  );
  const run = createReviewArtifactRun({
    readBlobs: async () => new Map(),
    readCommitArtifacts,
    readStackAndRange: async () => {
      throw new Error('unused');
    },
  });
  const unit = {
    after: {
      authoredAt: '2026-01-01T00:00:00.000Z',
      authorName: 'Ada',
      parentShas: [parentSha],
      sha: commitSha,
      shortSha: commitSha.slice(0, 7),
      subject: 'Update app',
    },
    confidence: 'high',
    kind: 'introduced',
    matchReasons: [],
    matchScore: 1,
    order: 0,
    reviewable: true,
    unitId: 'vcu-artifact-reuse',
  } as ReviewEvolutionUnit;

  await run.readCommitArtifacts([{ commitSha, parentSha }], run.signal);
  rememberReviewUnitArtifactRun('/repo', project, [unit], run);
  const files = await materializeReviewUnitFromArtifacts('/repo', project, unit);

  expect(files?.[0]).toMatchObject({ path: 'src/app.ts', status: 'modified' });
  expect(readCommitArtifacts).toHaveBeenCalledTimes(1);
  expect(run.diagnostics().cacheHits.commits).toBe(1);
});

test('replays a revised unit from cached Commit Artifacts with one deduplicated blob batch', async () => {
  const parentSha = sha('a');
  const beforeSha = sha('b');
  const afterSha = sha('c');
  const baseObjectId = '1'.repeat(40);
  const beforeObjectId = '2'.repeat(40);
  const afterObjectId = '3'.repeat(40);
  const provenance = { kind: 'native-git', project } as const;
  const artifacts = new Map<ReturnType<typeof createCommitArtifactRequestKey>, CommitArtifact>([
    [
      createCommitArtifactRequestKey({ commitSha: beforeSha, parentSha }),
      {
        commitSha: beforeSha,
        coverage: 'complete',
        files: [
          {
            coverage: 'complete',
            newObjectId: beforeObjectId,
            oldObjectId: baseObjectId,
            patch: '@@ -1 +1 @@\n-base\n+old',
            path: 'src/app.ts',
            status: 'modified',
          },
        ],
        parentSha,
        provenance,
      },
    ],
    [
      createCommitArtifactRequestKey({ commitSha: afterSha, parentSha }),
      {
        commitSha: afterSha,
        coverage: 'complete',
        files: [
          {
            coverage: 'complete',
            newObjectId: afterObjectId,
            oldObjectId: baseObjectId,
            patch: '@@ -1 +1 @@\n-base\n+new',
            path: 'src/app.ts',
            status: 'modified',
          },
        ],
        parentSha,
        provenance,
      },
    ],
  ]);
  const readCommitArtifacts = vi.fn<ReviewArtifactSource['readCommitArtifacts']>(
    async () => artifacts,
  );
  const encoder = new TextEncoder();
  const readBlobs = vi.fn<ReviewArtifactSource['readBlobs']>(
    async (objectIds) =>
      new Map(
        objectIds.map((objectId) => [
          objectId,
          {
            bytes: encoder.encode(
              objectId === baseObjectId
                ? 'base\n'
                : objectId === beforeObjectId
                  ? 'old\n'
                  : 'new\n',
            ),
            objectId,
            provenance,
          },
        ]),
      ),
  );
  const run = createReviewArtifactRun({
    readBlobs,
    readCommitArtifacts,
    readStackAndRange: async () => {
      throw new Error('unused');
    },
  });
  const comparisonRun: Record<string, unknown> = { comparisonMetrics: [] };
  (run as typeof run & { comparisonRun?: Record<string, unknown> }).comparisonRun = comparisonRun;
  const summary = (commitSha: GitSha, subject: string) => ({
    authoredAt: '2026-01-01T00:00:00.000Z',
    authorName: 'Ada',
    parentShas: [parentSha],
    sha: commitSha,
    shortSha: commitSha.slice(0, 7),
    subject,
  });
  const unit = {
    after: summary(afterSha, 'Update app again'),
    before: summary(beforeSha, 'Update app'),
    confidence: 'high',
    kind: 'revised',
    matchReasons: [],
    matchScore: 1,
    order: 0,
    reviewable: true,
    unitId: 'vcu-revised-artifact-reuse',
  } as ReviewEvolutionUnit;

  await run.readCommitArtifacts(
    [
      { commitSha: beforeSha, parentSha },
      { commitSha: afterSha, parentSha },
    ],
    run.signal,
  );
  rememberReviewUnitArtifactRun('/repo', project, [unit], run);
  const first = await materializeReviewUnitFromArtifacts('/repo', project, unit);
  const second = await materializeReviewUnitFromArtifacts('/repo', project, unit);

  expect(first?.[0]).toMatchObject({ path: 'src/app.ts', status: 'modified' });
  expect(first?.[0]?.sections[0]?.patch).toContain('-old');
  expect(first?.[0]?.sections[0]?.patch).toContain('+new');
  expect(second).toEqual(first);
  expect(readCommitArtifacts).toHaveBeenCalledTimes(1);
  expect(readBlobs).toHaveBeenCalledTimes(1);
  expect(readBlobs.mock.calls[0]?.[0]).toEqual(
    expect.arrayContaining([baseObjectId, beforeObjectId, afterObjectId]),
  );
  expect(run.diagnostics().sourceCalls).toMatchObject({ blobs: 1, commits: 1 });
  expect(comparisonRun.comparisonMetrics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        evidence: expect.objectContaining({ requested: 3, resolved: 3, unavailable: 0 }),
        kind: 'unit-regional-replay',
        outcome: 'complete',
        provider: 'github',
        unitId: unit.unitId,
      }),
    ]),
  );
});

test('records a canceled individual replay on its owning Comparison Run', async () => {
  const parentSha = sha('a');
  const beforeSha = sha('b');
  const afterSha = sha('c');
  const controller = new AbortController();
  const run = createReviewArtifactRun(
    {
      readBlobs: async () => new Map(),
      readCommitArtifacts: async (_commits, signal) => {
        controller.abort();
        signal.throwIfAborted();
        return new Map();
      },
      readStackAndRange: async () => {
        throw new Error('unused');
      },
    },
    { signal: controller.signal },
  );
  const comparisonRun: Record<string, unknown> = { comparisonMetrics: [] };
  (run as typeof run & { comparisonRun?: Record<string, unknown> }).comparisonRun = comparisonRun;
  const summary = (commitSha: GitSha, subject: string) => ({
    authoredAt: '2026-01-01T00:00:00.000Z',
    authorName: 'Ada',
    parentShas: [parentSha],
    sha: commitSha,
    shortSha: commitSha.slice(0, 7),
    subject,
  });
  const unit = {
    after: summary(afterSha, 'Later change'),
    before: summary(beforeSha, 'Earlier change'),
    confidence: 'high',
    kind: 'revised',
    matchReasons: [],
    matchScore: 1,
    order: 0,
    reviewable: true,
    unitId: 'vcu-canceled-artifact-replay',
  } as ReviewEvolutionUnit;

  rememberReviewUnitArtifactRun('/repo', project, [unit], run);

  await expect(materializeReviewUnitFromArtifacts('/repo', project, unit)).resolves.toBeNull();
  expect(comparisonRun.comparisonMetrics).toEqual([
    expect.objectContaining({
      kind: 'unit-regional-replay',
      outcome: 'canceled',
      provider: 'github',
      unitId: unit.unitId,
    }),
  ]);
});

test('projects complete one-sided revised artifacts without reading blobs', async () => {
  const parentSha = sha('a');
  const beforeSha = sha('b');
  const afterSha = sha('c');
  const provenance = { kind: 'native-git', project } as const;
  const artifacts = new Map<ReturnType<typeof createCommitArtifactRequestKey>, CommitArtifact>([
    [
      createCommitArtifactRequestKey({ commitSha: beforeSha, parentSha }),
      {
        commitSha: beforeSha,
        coverage: 'complete',
        files: [
          {
            coverage: 'complete',
            patch: '@@ -0,0 +1 @@\n+prior\n',
            path: 'src/added.ts',
            status: 'added',
          },
        ],
        parentSha,
        provenance,
      },
    ],
    [
      createCommitArtifactRequestKey({ commitSha: afterSha, parentSha }),
      {
        commitSha: afterSha,
        coverage: 'complete',
        files: [
          {
            coverage: 'complete',
            patch: '@@ -0,0 +1 @@\n+current\n',
            path: 'src/added.ts',
            status: 'added',
          },
        ],
        parentSha,
        provenance,
      },
    ],
  ]);
  const readBlobs = vi.fn<ReviewArtifactSource['readBlobs']>(async () => {
    throw new Error('Complete one-sided artifacts must not read blobs.');
  });
  const readCommitArtifacts = vi.fn<ReviewArtifactSource['readCommitArtifacts']>(
    async () => artifacts,
  );
  const run = createReviewArtifactRun({
    readBlobs,
    readCommitArtifacts,
    readStackAndRange: async () => {
      throw new Error('unused');
    },
  });
  const summary = (commitSha: GitSha, subject: string) => ({
    authoredAt: '2026-01-01T00:00:00.000Z',
    authorName: 'Ada',
    parentShas: [parentSha],
    sha: commitSha,
    shortSha: commitSha.slice(0, 7),
    subject,
  });
  const unit = {
    after: summary(afterSha, 'Update added file'),
    before: summary(beforeSha, 'Add file'),
    confidence: 'high',
    kind: 'revised',
    matchReasons: [],
    matchScore: 1,
    order: 0,
    reviewable: true,
    unitId: 'vcu-one-sided-artifact-reuse',
  } as ReviewEvolutionUnit;

  await run.readCommitArtifacts(
    [
      { commitSha: beforeSha, parentSha },
      { commitSha: afterSha, parentSha },
    ],
    run.signal,
  );
  rememberReviewUnitArtifactRun('/repo', project, [unit], run);
  const files = await materializeReviewUnitFromArtifacts('/repo', project, unit);

  expect(files?.[0]?.sections[0]?.patch).toContain('-prior');
  expect(files?.[0]?.sections[0]?.patch).toContain('+current');
  expect(readCommitArtifacts).toHaveBeenCalledTimes(1);
  expect(readBlobs).not.toHaveBeenCalled();
  expect(run.diagnostics().sourceCalls).toMatchObject({ blobs: 0, commits: 1 });
});

test('omits equal complete modified artifact endpoints without reading blobs', async () => {
  const parentSha = sha('a');
  const beforeSha = sha('b');
  const afterSha = sha('c');
  const beforeObjectId = '1'.repeat(40);
  const afterObjectId = '2'.repeat(40);
  const finalObjectId = '3'.repeat(40);
  const provenance = { kind: 'native-git', project } as const;
  const artifacts = new Map<ReturnType<typeof createCommitArtifactRequestKey>, CommitArtifact>([
    [
      createCommitArtifactRequestKey({ commitSha: beforeSha, parentSha }),
      {
        commitSha: beforeSha,
        coverage: 'complete',
        files: [
          {
            coverage: 'complete',
            newObjectId: finalObjectId,
            oldObjectId: beforeObjectId,
            patch: '@@ -1 +1 @@\n-before base\n+final\n',
            path: 'src/app.ts',
            status: 'modified',
          },
        ],
        parentSha,
        provenance,
      },
    ],
    [
      createCommitArtifactRequestKey({ commitSha: afterSha, parentSha }),
      {
        commitSha: afterSha,
        coverage: 'complete',
        files: [
          {
            coverage: 'complete',
            newObjectId: finalObjectId,
            oldObjectId: afterObjectId,
            patch: '@@ -1 +1 @@\n-after base\n+final\n',
            path: 'src/app.ts',
            status: 'modified',
          },
        ],
        parentSha,
        provenance,
      },
    ],
  ]);
  const readBlobs = vi.fn<ReviewArtifactSource['readBlobs']>(async () => {
    throw new Error('Equal final artifact object IDs must not read blobs.');
  });
  const readCommitArtifacts = vi.fn<ReviewArtifactSource['readCommitArtifacts']>(
    async () => artifacts,
  );
  const run = createReviewArtifactRun({
    readBlobs,
    readCommitArtifacts,
    readStackAndRange: async () => {
      throw new Error('unused');
    },
  });
  const summary = (commitSha: GitSha, subject: string) => ({
    authoredAt: '2026-01-01T00:00:00.000Z',
    authorName: 'Ada',
    parentShas: [parentSha],
    sha: commitSha,
    shortSha: commitSha.slice(0, 7),
    subject,
  });
  const unit = {
    after: summary(afterSha, 'Rebase without changing app'),
    before: summary(beforeSha, 'Original app change'),
    confidence: 'high',
    kind: 'revised',
    matchReasons: [],
    matchScore: 1,
    order: 0,
    reviewable: true,
    unitId: 'vcu-modified-artifact-equality',
  } as ReviewEvolutionUnit;

  await run.readCommitArtifacts(
    [
      { commitSha: beforeSha, parentSha },
      { commitSha: afterSha, parentSha },
    ],
    run.signal,
  );
  rememberReviewUnitArtifactRun('/repo', project, [unit], run);
  const files = await materializeReviewUnitFromArtifacts('/repo', project, unit);

  expect(files).toEqual([]);
  expect(readCommitArtifacts).toHaveBeenCalledTimes(1);
  expect(readBlobs).not.toHaveBeenCalled();
  expect(run.diagnostics().sourceCalls).toMatchObject({ blobs: 0, commits: 1 });
});

test('resolves omitted revised endpoint IDs through the proof-triggered blob batch', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'codiff-revised-artifact-endpoints-'));
  const runGit = (args: ReadonlyArray<string>) =>
    execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  const provenance = { kind: 'native-git', project } as const;
  try {
    runGit(['init', '--quiet']);
    runGit(['config', 'user.email', 'ada@example.com']);
    runGit(['config', 'user.name', 'Ada']);
    await writeFile(join(repository, 'app.ts'), 'base\n');
    runGit(['add', 'app.ts']);
    runGit(['commit', '--quiet', '-m', 'Base']);
    const parentSha = runGit(['rev-parse', 'HEAD']) as GitSha;
    const baseObjectId = runGit(['rev-parse', `${parentSha}:app.ts`]);

    await writeFile(join(repository, 'app.ts'), 'old\n');
    runGit(['add', 'app.ts']);
    runGit(['commit', '--quiet', '-m', 'Earlier change']);
    const beforeSha = runGit(['rev-parse', 'HEAD']) as GitSha;
    const beforeObjectId = runGit(['rev-parse', `${beforeSha}:app.ts`]);

    runGit(['checkout', '--quiet', parentSha]);
    await writeFile(join(repository, 'app.ts'), 'new\n');
    runGit(['add', 'app.ts']);
    runGit(['commit', '--quiet', '-m', 'Later change']);
    const afterSha = runGit(['rev-parse', 'HEAD']) as GitSha;
    const afterObjectId = runGit(['rev-parse', `${afterSha}:app.ts`]);

    const artifacts = new Map<ReturnType<typeof createCommitArtifactRequestKey>, CommitArtifact>([
      [
        createCommitArtifactRequestKey({ commitSha: beforeSha, parentSha }),
        {
          commitSha: beforeSha,
          coverage: 'complete',
          files: [
            {
              coverage: 'complete',
              newObjectId: beforeObjectId,
              patch: '@@ -1 +1 @@\n-base\n+old',
              path: 'app.ts',
              status: 'modified',
            },
          ],
          parentSha,
          provenance,
        },
      ],
      [
        createCommitArtifactRequestKey({ commitSha: afterSha, parentSha }),
        {
          commitSha: afterSha,
          coverage: 'complete',
          files: [
            {
              coverage: 'complete',
              newObjectId: afterObjectId,
              patch: '@@ -1 +1 @@\n-base\n+new',
              path: 'app.ts',
              status: 'modified',
            },
          ],
          parentSha,
          provenance,
        },
      ],
    ]);
    const contents = new Map([
      [baseObjectId, 'base\n'],
      [beforeObjectId, 'old\n'],
      [afterObjectId, 'new\n'],
    ]);
    const readBlobs = vi.fn<ReviewArtifactSource['readBlobs']>(
      async (objectIds) =>
        new Map(
          objectIds.flatMap((objectId) => {
            const content = contents.get(objectId);
            return content == null
              ? []
              : [
                  [
                    objectId,
                    { bytes: new TextEncoder().encode(content), objectId, provenance },
                  ] as const,
                ];
          }),
        ),
    );
    const readCommitArtifacts = vi.fn<ReviewArtifactSource['readCommitArtifacts']>(
      async () => artifacts,
    );
    const run = createReviewArtifactRun({
      readBlobs,
      readCommitArtifacts,
      readStackAndRange: async () => {
        throw new Error('unused');
      },
    });
    const summary = (commitSha: GitSha, subject: string) => ({
      authoredAt: '2026-01-01T00:00:00.000Z',
      authorName: 'Ada',
      parentShas: [parentSha],
      sha: commitSha,
      shortSha: commitSha.slice(0, 7),
      subject,
    });
    const unit = {
      after: summary(afterSha, 'Later change'),
      before: summary(beforeSha, 'Earlier change'),
      confidence: 'high',
      kind: 'revised',
      matchReasons: [],
      matchScore: 1,
      order: 0,
      reviewable: true,
      unitId: 'vcu-revised-omitted-endpoint',
    } as ReviewEvolutionUnit;

    await run.readCommitArtifacts(
      [
        { commitSha: beforeSha, parentSha },
        { commitSha: afterSha, parentSha },
      ],
      run.signal,
    );
    rememberReviewUnitArtifactRun(repository, project, [unit], run);
    const files = await materializeReviewUnitFromArtifacts(repository, project, unit);

    expect(files?.[0]?.sections[0]?.patch).toContain('-old');
    expect(files?.[0]?.sections[0]?.patch).toContain('+new');
    expect(readCommitArtifacts).toHaveBeenCalledTimes(1);
    expect(readBlobs).toHaveBeenCalledTimes(1);
    expect(readBlobs.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([baseObjectId, beforeObjectId, afterObjectId]),
    );
    expect(readBlobs.mock.calls[0]?.[0]).toHaveLength(3);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
}, 15_000);

test('uses Range Artifact endpoint IDs before resolving any replay paths', async () => {
  const beforeBase = sha('a');
  const beforeHead = sha('b');
  const afterBase = sha('c');
  const afterHead = sha('d');
  const objectIds = ['1', '2', '3', '4'].map((value) => value.repeat(40));
  const provenance = { kind: 'native-git', project } as const;
  const contents = new Map([
    [objectIds[0]!, 'before base\n'],
    [objectIds[1]!, 'before head\n'],
    [objectIds[2]!, 'after base\n'],
    [objectIds[3]!, 'after head\n'],
  ]);
  const readBlobs = vi.fn<ReviewArtifactSource['readBlobs']>(
    async (requested) =>
      new Map(
        requested.flatMap((objectId) => {
          const content = contents.get(objectId);
          return content == null
            ? []
            : [
                [
                  objectId,
                  { bytes: new TextEncoder().encode(content), objectId, provenance },
                ] as const,
              ];
        }),
      ),
  );
  const run = createReviewArtifactRun({
    readBlobs,
    readCommitArtifacts: async () => new Map(),
    readStackAndRange: async () => {
      throw new Error('unused');
    },
  });
  const range = (baseSha: GitSha, headSha: GitSha, oldObjectId: string, newObjectId: string) => ({
    baseSha,
    coverage: 'complete' as const,
    files: [
      {
        coverage: 'complete' as const,
        newObjectId,
        oldObjectId,
        path: 'src/app.ts',
        status: 'modified' as const,
      },
    ],
    headSha,
    provenance,
  });
  const lookup = createArtifactBlobLookup('/repo', run, [
    range(beforeBase, beforeHead, objectIds[0]!, objectIds[1]!),
    range(afterBase, afterHead, objectIds[2]!, objectIds[3]!),
  ]);

  const blobs = await lookup([
    { path: 'src/app.ts', ref: beforeBase },
    { path: 'src/app.ts', ref: beforeHead },
    { path: 'src/app.ts', ref: afterBase },
    { path: 'src/app.ts', ref: afterHead },
  ]);

  expect(blobs).toEqual(
    new Map([
      [`${beforeBase}:src/app.ts`, 'before base\n'],
      [`${beforeHead}:src/app.ts`, 'before head\n'],
      [`${afterBase}:src/app.ts`, 'after base\n'],
      [`${afterHead}:src/app.ts`, 'after head\n'],
    ]),
  );
  expect(readBlobs).toHaveBeenCalledTimes(1);
  expect(readBlobs.mock.calls[0]?.[0]).toEqual(objectIds);
});
