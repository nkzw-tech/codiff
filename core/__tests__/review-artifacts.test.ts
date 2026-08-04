import { expect, test } from 'vite-plus/test';
import {
  createCommitArtifactRequestKey,
  createFileBlobArtifactRequestKey,
  createReviewArtifactRun,
  validateCommitArtifact,
  validateRangeArtifact,
  validateReviewArtifactRangeResult,
  validateStackSnapshot,
  type ReviewArtifactProject,
  type ReviewArtifactProvenance,
  type ReviewArtifactSource,
  type CommitArtifactRequest,
  type ReviewArtifactRangeRequest,
} from '../lib/review-artifacts.ts';
import type { GitSha, ReviewCommitSummary } from '../types.ts';

const sha = (value: string) => value.repeat(40) as GitSha;
const project: ReviewArtifactProject = {
  host: 'GitLab.Example.com',
  project: 'group/project with spaces',
  provider: 'gitlab',
};
const provenance: ReviewArtifactProvenance = { kind: 'gitlab-api', project };

const commit = (value: string, parentShas: ReadonlyArray<GitSha>): ReviewCommitSummary => ({
  authoredAt: '2026-01-01T00:00:00.000Z',
  authorName: 'Ada',
  parentShas,
  sha: sha(value),
  shortSha: value.repeat(7),
  subject: `Commit ${value}`,
});

test('complete artifacts reject files without complete change data', () => {
  expect(() =>
    validateCommitArtifact({
      commitSha: sha('b'),
      coverage: 'complete',
      files: [{ coverage: 'truncated', path: 'src/app.ts', status: 'modified' }],
      parentSha: sha('a'),
      provenance,
    }),
  ).toThrow('cannot be complete');
  expect(() =>
    validateRangeArtifact({
      baseSha: sha('a'),
      coverage: 'complete',
      files: [{ coverage: 'complete', path: 'src/app.ts', status: 'modified' }],
      headSha: sha('b'),
      provenance,
    }),
  ).toThrow('without a patch or exact object/mode metadata');
});

test('Range Artifacts preserve explicit incomplete evidence without calling it complete', () => {
  const artifact = validateRangeArtifact({
    baseSha: sha('a'),
    coverage: 'truncated',
    files: [],
    headSha: sha('b'),
    incompleteReason: "The provider response reached Codiff's range budget.",
    provenance,
  });
  expect(artifact.incompleteReason).toContain('range budget');

  expect(() =>
    validateRangeArtifact({
      baseSha: sha('a'),
      coverage: 'complete',
      files: [],
      headSha: sha('b'),
      incompleteReason: 'This must remain incomplete.',
      provenance,
    }),
  ).toThrow('incomplete-evidence reason');
});

test('Stack Snapshots are parent-first and end at the declared head', () => {
  const first = commit('b', [sha('a')]);
  const head = commit('c', [first.sha]);
  expect(
    validateStackSnapshot({
      baseSha: sha('a'),
      commits: [first, head],
      coverage: 'complete',
      headSha: head.sha,
      provenance,
    }).commits,
  ).toEqual([first, head]);
  expect(() =>
    validateStackSnapshot({
      baseSha: sha('a'),
      commits: [head, first],
      coverage: 'complete',
      headSha: head.sha,
      provenance,
    }),
  ).toThrow();
});

test('one Artifact Run deduplicates overlapping and warm immutable reads', async () => {
  const base = sha('a');
  const first = sha('b');
  const head = sha('c');
  const commitCalls: Array<ReadonlyArray<CommitArtifactRequest>> = [];
  const blobCalls: Array<ReadonlyArray<string>> = [];
  let rangeCalls = 0;
  let now = 0;
  const artifact = (commitSha: GitSha) => ({
    commitSha,
    coverage: 'complete' as const,
    files: [],
    parentSha: commitSha === first ? base : first,
    provenance,
  });
  const source: ReviewArtifactSource = {
    readBlobs: async (objectIds) => {
      blobCalls.push(objectIds);
      now += 2;
      return new Map(
        objectIds.map((objectId) => [
          objectId,
          { bytes: new Uint8Array([1, 2, 3]), objectId, provenance },
        ]),
      );
    },
    readCommitArtifacts: async (commits) => {
      commitCalls.push(commits);
      now += 4;
      await Promise.resolve();
      return new Map(
        commits.map(({ commitSha, parentSha }) => {
          const request = { commitSha, parentSha };
          return [createCommitArtifactRequestKey(request), { ...artifact(commitSha), parentSha }];
        }),
      );
    },
    readStackAndRange: async () => {
      rangeCalls += 1;
      now += 3;
      return {
        range: { baseSha: base, coverage: 'complete', files: [], headSha: head, provenance },
        stack: {
          baseSha: base,
          commits: [commit('b', [base]), commit('c', [first])],
          coverage: 'complete',
          headSha: head,
          provenance,
        },
      };
    },
  };
  const run = createReviewArtifactRun(source, { now: () => now });

  const [left, right, firstRange, secondRange] = await Promise.all([
    run.readCommitArtifacts(
      [
        { commitSha: first, parentSha: base },
        { commitSha: head, parentSha: first },
      ],
      run.signal,
    ),
    run.readCommitArtifacts([{ commitSha: head, parentSha: first }], run.signal),
    run.readStackAndRange({ headSha: head, requestedBaseSha: base }, run.signal),
    run.readStackAndRange({ headSha: head, requestedBaseSha: base }, run.signal),
  ]);
  await run.readCommitArtifacts(
    [
      { commitSha: first, parentSha: base },
      { commitSha: head, parentSha: first },
    ],
    run.signal,
  );
  await Promise.all([
    run.readBlobs(['blob-a', 'blob-b'], run.signal),
    run.readBlobs(['blob-b'], run.signal),
  ]);
  await run.readBlobs(['blob-a'], run.signal);

  expect([...left]).toHaveLength(2);
  expect([...right]).toHaveLength(1);
  expect(left.get(createCommitArtifactRequestKey({ commitSha: first, parentSha: base }))).toEqual(
    expect.objectContaining({ commitSha: first, parentSha: base }),
  );
  expect(firstRange).toBe(secondRange);
  expect(commitCalls).toEqual([
    [
      { commitSha: first, parentSha: base },
      { commitSha: head, parentSha: first },
    ],
  ]);
  expect(blobCalls).toEqual([['blob-a', 'blob-b']]);
  expect(rangeCalls).toBe(1);
  expect(run.diagnostics()).toMatchObject({
    acquired: {
      blobs: { 'blob-a': 1, 'blob-b': 1 },
      commits: { [`${first}:${base}`]: 1, [`${head}:${first}`]: 1 },
      stackAndRanges: { [`${base}:${head}`]: 1 },
    },
    execution: {
      blobBytesRead: 6,
      elapsedMs: 9,
      peakSourceReads: 2,
      sourceElapsedMs: { blobs: 2, commits: 7, stackAndRanges: 3 },
      wasCanceled: false,
    },
    sourceCalls: { blobs: 1, commits: 1, stackAndRanges: 1 },
  });
});

test('one bulk read preserves the same merge commit relative to two parents', async () => {
  const merge = sha('m');
  const firstParent = sha('a');
  const secondParent = sha('b');
  const requests = [
    { commitSha: merge, parentSha: firstParent },
    { commitSha: merge, parentSha: secondParent },
  ];
  const source: ReviewArtifactSource = {
    readBlobs: async () => new Map(),
    readCommitArtifacts: async (commits) =>
      new Map(
        commits.map((request) => [
          createCommitArtifactRequestKey(request),
          {
            commitSha: request.commitSha,
            coverage: 'complete' as const,
            files: [],
            parentSha: request.parentSha,
            provenance,
          },
        ]),
      ),
    readStackAndRange: async () => {
      throw new Error('unused');
    },
  };
  const run = createReviewArtifactRun(source);
  const artifacts = await run.readCommitArtifacts(requests, run.signal);

  expect(artifacts).toHaveLength(2);
  expect(artifacts.get(createCommitArtifactRequestKey(requests[0]!))?.parentSha).toBe(firstParent);
  expect(artifacts.get(createCommitArtifactRequestKey(requests[1]!))?.parentSha).toBe(secondParent);
  expect(run.diagnostics().acquired.commits).toEqual({
    [createCommitArtifactRequestKey(requests[0]!)]: 1,
    [createCommitArtifactRequestKey(requests[1]!)]: 1,
  });
});

test('rejects a Commit Artifact returned under the wrong request coordinate', async () => {
  const request = { commitSha: sha('c'), parentSha: sha('a') };
  const source: ReviewArtifactSource = {
    readBlobs: async () => new Map(),
    readCommitArtifacts: async () =>
      new Map([
        [
          createCommitArtifactRequestKey(request),
          {
            commitSha: request.commitSha,
            coverage: 'complete' as const,
            files: [],
            parentSha: sha('b'),
            provenance,
          },
        ],
      ]),
    readStackAndRange: async () => {
      throw new Error('unused');
    },
  };
  const run = createReviewArtifactRun(source);

  await expect(run.readCommitArtifacts([request], run.signal)).rejects.toThrow(
    'returned different coordinates',
  );
});

test('uses the canonical root request key for root Commit Artifacts', async () => {
  const request = { commitSha: sha('r'), parentSha: null };
  const key = createCommitArtifactRequestKey(request);
  const source: ReviewArtifactSource = {
    readBlobs: async () => new Map(),
    readCommitArtifacts: async () =>
      new Map([
        [
          key,
          {
            commitSha: request.commitSha,
            coverage: 'complete' as const,
            files: [],
            parentSha: null,
            provenance,
          },
        ],
      ]),
    readStackAndRange: async () => {
      throw new Error('unused');
    },
  };
  const run = createReviewArtifactRun(source);

  expect((await run.readCommitArtifacts([request], run.signal)).get(key)?.parentSha).toBeNull();
  expect(key.endsWith(':root')).toBe(true);
});

test('artifact range results distinguish requested and effective bases without sharing request-local cache entries', async () => {
  const requestedBase = sha('a');
  const equivalentSelector = sha('b');
  const effectiveBase = sha('c');
  const head = sha('d');
  const requests: Array<ReviewArtifactRangeRequest> = [];
  const source: ReviewArtifactSource = {
    readBlobs: async () => new Map(),
    readCommitArtifacts: async () => new Map(),
    readStackAndRange: async (request) => {
      requests.push(request);
      return {
        range: {
          baseSha: effectiveBase,
          coverage: 'complete',
          files: [],
          headSha: request.headSha,
          provenance,
        },
        stack: {
          baseSha: effectiveBase,
          commits: [commit('d', [effectiveBase])],
          coverage: 'complete',
          headSha: request.headSha,
          provenance,
        },
      };
    },
  };
  const run = createReviewArtifactRun(source);

  const first = await run.readStackAndRange(
    { headSha: head, requestedBaseSha: requestedBase },
    run.signal,
  );
  expect(
    await run.readStackAndRange({ headSha: head, requestedBaseSha: requestedBase }, run.signal),
  ).toBe(first);
  await run.readStackAndRange({ headSha: head, requestedBaseSha: equivalentSelector }, run.signal);

  expect(first.range.baseSha).toBe(effectiveBase);
  expect(first.stack.baseSha).toBe(effectiveBase);
  expect(requests).toEqual([
    { headSha: head, requestedBaseSha: requestedBase },
    { headSha: head, requestedBaseSha: equivalentSelector },
  ]);
  expect(run.diagnostics().acquired.stackAndRanges).toEqual({
    [`${equivalentSelector}:${head}`]: 1,
    [`${requestedBase}:${head}`]: 1,
  });
});

test('artifact range results reject mismatched endpoints, substituted heads, and provenance', () => {
  const requestedBase = sha('a');
  const effectiveBase = sha('b');
  const head = sha('c');
  const result = () => ({
    range: {
      baseSha: effectiveBase,
      coverage: 'complete' as const,
      files: [],
      headSha: head,
      provenance,
    },
    stack: {
      baseSha: effectiveBase,
      commits: [commit('c', [effectiveBase])],
      coverage: 'complete' as const,
      headSha: head,
      provenance,
    },
  });
  const request = { headSha: head, requestedBaseSha: requestedBase };

  expect(validateReviewArtifactRangeResult(request, result()).range.baseSha).toBe(effectiveBase);
  expect(() =>
    validateReviewArtifactRangeResult(request, {
      ...result(),
      stack: { ...result().stack, baseSha: requestedBase },
    }),
  ).toThrow('different endpoints');
  expect(() =>
    validateReviewArtifactRangeResult(request, {
      ...result(),
      range: { ...result().range, headSha: requestedBase },
      stack: {
        ...result().stack,
        commits: [commit('a', [effectiveBase])],
        headSha: requestedBase,
      },
    }),
  ).toThrow('substituted a different head');
  expect(() =>
    validateReviewArtifactRangeResult(request, {
      ...result(),
      stack: {
        ...result().stack,
        provenance: { ...provenance, project: { ...project, project: 'other/project' } },
      },
    }),
  ).toThrow('different provider projects');
});

test('same-commit artifact requests remain empty same-commit results', () => {
  const same = sha('a');
  const request = { headSha: same, requestedBaseSha: same };
  expect(() =>
    validateReviewArtifactRangeResult(request, {
      range: { baseSha: same, coverage: 'complete', files: [], headSha: same, provenance },
      stack: { baseSha: same, commits: [], coverage: 'complete', headSha: same, provenance },
    }),
  ).not.toThrow();
  expect(() =>
    validateReviewArtifactRangeResult(request, {
      range: { baseSha: same, coverage: 'complete', files: [], headSha: same, provenance },
      stack: {
        baseSha: same,
        commits: [commit('a', [])],
        coverage: 'complete',
        headSha: same,
        provenance,
      },
    }),
  ).toThrow('same-commit artifact request');
});

test('Artifact Runs propagate cancellation to cooperative in-flight commit reads', async () => {
  let commitCalls = 0;
  const source: ReviewArtifactSource = {
    readBlobs: async () => new Map(),
    readCommitArtifacts: async (_commits, signal) => {
      commitCalls += 1;
      await new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('canceled'), { name: 'AbortError' })),
          { once: true },
        );
        if (commitCalls > 1) {
          resolve(undefined);
        }
      });
      return new Map();
    },
    readStackAndRange: async () => {
      throw new Error('unused');
    },
  };
  const controller = new AbortController();
  const run = createReviewArtifactRun(source, { signal: controller.signal });
  const pending = run.readCommitArtifacts([{ commitSha: sha('d'), parentSha: null }], run.signal);
  controller.abort();

  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(run.signal.aborted).toBe(true);
  expect(commitCalls).toBe(1);
  expect(run.diagnostics().execution.wasCanceled).toBe(true);
});

test('Artifact Runs reject signal-ignoring stack and range results resolved after cancellation', async () => {
  const base = sha('a');
  const head = sha('b');
  let resolveRange!: (
    value: Awaited<ReturnType<ReviewArtifactSource['readStackAndRange']>>,
  ) => void;
  const source: ReviewArtifactSource = {
    readBlobs: async () => new Map(),
    readCommitArtifacts: async () => new Map(),
    readStackAndRange: async () =>
      new Promise((resolve) => {
        resolveRange = resolve;
      }),
  };
  const controller = new AbortController();
  const run = createReviewArtifactRun(source, { signal: controller.signal });
  const pending = run.readStackAndRange({ headSha: head, requestedBaseSha: base }, run.signal);
  controller.abort();
  resolveRange({
    range: { baseSha: base, coverage: 'complete', files: [], headSha: head, provenance },
    stack: {
      baseSha: base,
      commits: [commit('b', [base])],
      coverage: 'complete',
      headSha: head,
      provenance,
    },
  });

  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(run.signal.aborted).toBe(true);
  expect(run.diagnostics()).toMatchObject({
    acquired: { stackAndRanges: { [`${base}:${head}`]: 1 } },
    sourceCalls: { stackAndRanges: 1 },
  });
});

test('Artifact Runs deduplicate path-resolved Blob Artifacts and reuse their object IDs', async () => {
  const request = { maxBytes: 16, path: 'src/app.ts', ref: sha('a') };
  const objectId = sha('f');
  let fileCalls = 0;
  let objectCalls = 0;
  const source: ReviewArtifactSource = {
    readBlobs: async () => {
      objectCalls += 1;
      return new Map();
    },
    readCommitArtifacts: async () => new Map(),
    readFileBlobs: async (requests) => {
      fileCalls += 1;
      return new Map(
        requests.map((value) => [
          createFileBlobArtifactRequestKey(value),
          { bytes: new TextEncoder().encode('artifact'), objectId, provenance },
        ]),
      );
    },
    readStackAndRange: async () => {
      throw new Error('unused');
    },
  };
  const run = createReviewArtifactRun(source);

  const [first, concurrent] = await Promise.all([
    run.readFileBlobs([request], run.signal),
    run.readFileBlobs([request], run.signal),
  ]);
  const warm = await run.readFileBlobs([request], run.signal);
  const byObjectId = await run.readBlobs([objectId], run.signal);

  expect(first.get(createFileBlobArtifactRequestKey(request))?.objectId).toBe(objectId);
  expect(concurrent).toEqual(first);
  expect(warm).toEqual(first);
  expect(byObjectId.get(objectId)?.objectId).toBe(objectId);
  expect(fileCalls).toBe(1);
  expect(objectCalls).toBe(0);
  expect(run.diagnostics().acquired.blobs[`file:${request.ref}:${request.path}`]).toBe(1);
});

test('Artifact Runs do not reacquire an explicit source miss', async () => {
  let commitCalls = 0;
  const source: ReviewArtifactSource = {
    readBlobs: async () => new Map(),
    readCommitArtifacts: async () => {
      commitCalls += 1;
      return new Map();
    },
    readStackAndRange: async () => {
      throw new Error('unused');
    },
  };
  const run = createReviewArtifactRun(source);
  const missing = sha('e');

  expect(
    await run.readCommitArtifacts([{ commitSha: missing, parentSha: null }], run.signal),
  ).toHaveLength(0);
  expect(
    await run.readCommitArtifacts([{ commitSha: missing, parentSha: null }], run.signal),
  ).toHaveLength(0);
  expect(commitCalls).toBe(1);
  expect(run.diagnostics().acquired.commits[`${missing}:root`]).toBe(1);
});
