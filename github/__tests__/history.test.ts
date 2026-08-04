import {
  createCommitFingerprint,
  createCommitArtifactRequestKey,
  createFileBlobArtifactRequestKey,
  createReviewArtifactRun,
  matchVersionCommitStacks,
  projectCommitEvolution,
  toCommitArtifact,
  type ReviewArtifactProject,
  type ReviewArtifactProvenance,
} from '@nkzw/codiff-core';
import type {
  ChangedFile,
  GitSha,
  ReviewVersionId,
  ReviewVersionOption,
} from '@nkzw/codiff-core/types';
import { parsePatchFiles } from '@pierre/diffs';
import { expect, test, vi } from 'vite-plus/test';
import {
  buildBaseMovement,
  classifyGitHubReviewVersionEvolution,
  compareGitHubReviewVersionAggregate,
  compareGitHubReviewVersions,
  createGitHubArtifactSource,
  createGitHubRangeArtifact,
  fetchGitHubPullRequestReviewerActivity,
  listGitHubReviewVersions,
  normalizeForcePushEvent,
  type GitHubCommitLike,
  type GitHubHistoryGit,
} from '../src/history.ts';
import { createFakeGitHubTransport, type GitHubTransport } from '../src/transport.ts';

const gitSha = (value: string) => value as GitSha;
const reviewVersionId = (value: string) => value as ReviewVersionId;
const project: ReviewArtifactProject = {
  host: 'github.com',
  project: 'nkzw-tech/codiff',
  provider: 'github',
};
const provenance: ReviewArtifactProvenance = {
  kind: 'native-git',
  project,
};
const createGitHubProviderOutputLimitError = () => {
  const error = new Error('GitHub response exceeded the 8388608-byte Artifact safety limit.');
  error.name = 'ProviderOutputLimitError';
  return error;
};

test('normalizes GitHub range artifact patches into renderer-parseable unified diffs', () => {
  const baseSha = gitSha('a'.repeat(40));
  const headSha = gitSha('b'.repeat(40));
  const range = createGitHubRangeArtifact({
    baseSha,
    files: [
      {
        filename: 'src/app.ts',
        patch: '@@ -1 +1 @@\n-old\n+new\n',
        status: 'modified',
      },
    ],
    headSha,
    project,
  });

  expect(range.files[0]?.patch).toBe(
    'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
  );
  expect(parsePatchFiles(range.files[0]?.patch ?? '')).toMatchObject([
    { files: [{ additionLines: ['new\n'], deletionLines: ['old\n'], name: 'src/app.ts' }] },
  ]);
});

test('normalizeForcePushEvent accepts head_ref_force_pushed timeline payloads', () => {
  const event = normalizeForcePushEvent({
    after: 'b'.repeat(40),
    before: 'a'.repeat(40),
    created_at: '2026-01-02T00:00:00.000Z',
    event: 'head_ref_force_pushed',
  });
  expect(event).toEqual({
    after: 'b'.repeat(40),
    before: 'a'.repeat(40),
    createdAt: '2026-01-02T00:00:00.000Z',
  });
});

test('normalizeForcePushEvent ignores non-force-push timeline noise', () => {
  expect(
    normalizeForcePushEvent({
      created_at: '2026-01-02T00:00:00.000Z',
      event: 'commented',
    }),
  ).toBeNull();
});

test('listGitHubReviewVersions builds head timeline labels without GitLab version numbers', async () => {
  const before = 'a'.repeat(40);
  const after = 'b'.repeat(40);
  const current = 'c'.repeat(40);
  const base = '0'.repeat(40);
  const transport = createFakeGitHubTransport([
    {
      path: `/repos/nkzw-tech/codiff/issues/12/timeline`,
      response: [
        {
          after: before,
          before: base,
          created_at: '2026-01-01T12:00:00.000Z',
          event: 'head_ref_force_pushed',
        },
        {
          actor: { login: 'ada' },
          after,
          before,
          created_at: '2026-01-02T00:00:00.000Z',
          event: 'head_ref_force_pushed',
        },
      ],
    },
    {
      path: `/repos/nkzw-tech/codiff/pulls/12`,
      response: {
        base: { sha: base },
        head: { sha: current },
        updated_at: '2026-01-03T00:00:00.000Z',
      },
    },
  ]);

  const input = {
    pull: {
      number: 12,
      owner: 'nkzw-tech',
      repo: 'codiff',
    },
    transport,
  };
  const first = await listGitHubReviewVersions(input);
  const second = await listGitHubReviewVersions(input);
  const { versions, warning } = first;

  expect(warning).toBeNull();
  expect(second).toEqual(first);
  expect(versions.map((version) => version.versionId)).toEqual([before, after, current]);
  const labels = versions.map((version) => version.range.head.label.text);
  expect(labels).toEqual([
    `Force-push · ${before.slice(0, 7)}`,
    `Force-push · ${after.slice(0, 7)}`,
    'Current head',
  ]);
  expect(labels.every((label) => !/^v\d+/.test(label))).toBe(true);
  expect(transport.calls.find((call) => call.path.endsWith('/issues/12/timeline'))?.maxBytes).toBe(
    2 * 1024 * 1024,
  );
});

test('listGitHubReviewVersions moves a reused current head to the timeline tail', async () => {
  const base = '0'.repeat(40);
  const first = 'a'.repeat(40);
  const second = 'b'.repeat(40);
  const transport = createFakeGitHubTransport([
    {
      path: `/repos/nkzw-tech/codiff/issues/13/timeline`,
      response: [
        {
          after: first,
          before: base,
          created_at: '2026-01-01T00:00:00.000Z',
          event: 'head_ref_force_pushed',
        },
        {
          after: second,
          before: first,
          created_at: '2026-01-02T00:00:00.000Z',
          event: 'head_ref_force_pushed',
        },
        {
          after: first,
          before: second,
          created_at: '2026-01-03T00:00:00.000Z',
          event: 'head_ref_force_pushed',
        },
      ],
    },
    {
      path: `/repos/nkzw-tech/codiff/pulls/13`,
      response: {
        base: { sha: base },
        head: { sha: first },
      },
    },
  ]);

  const { versions } = await listGitHubReviewVersions({
    pull: { number: 13, owner: 'nkzw-tech', repo: 'codiff' },
    transport,
  });

  expect(versions.map((version) => version.versionId)).toEqual([second, first]);
  expect(versions.at(-1)?.isHead).toBe(true);
  expect(versions.at(-1)?.createdAt).toBe('2026-01-03T00:00:00.000Z');
  expect(versions.at(-1)?.range.head.label.text).toBe('Current head');
});

test('attributes authenticated reviews and comments to immutable GitHub heads', async () => {
  const base = gitSha('0'.repeat(40));
  const first = gitSha('a'.repeat(40));
  const second = gitSha('b'.repeat(40));
  const versions = [first, second].map((head, index) => ({
    createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    range: {
      base: { label: { kind: 'commit' as const, text: 'base' }, sha: base },
      head: { label: { kind: 'version' as const, text: `head ${index + 1}` }, sha: head },
    },
    versionId: reviewVersionId(head),
  }));
  const transport = createFakeGitHubTransport([
    { path: '/user', response: { login: 'reviewer' } },
    {
      path: '/repos/nkzw-tech/codiff/pulls/14/reviews',
      response: [
        {
          commit_id: first,
          id: 1,
          state: 'APPROVED',
          submitted_at: '2026-01-01T12:00:00.000Z',
          user: { login: 'reviewer' },
        },
      ],
    },
    {
      path: '/repos/nkzw-tech/codiff/pulls/14/comments',
      response: [
        {
          commit_id: first,
          created_at: '2026-01-01T13:00:00.000Z',
          id: 2,
          user: { login: 'reviewer' },
        },
      ],
    },
    {
      path: '/repos/nkzw-tech/codiff/issues/14/comments',
      response: [
        {
          created_at: '2026-01-02T12:00:00.000Z',
          id: 3,
          user: { login: 'someone-else' },
        },
      ],
    },
  ]);

  const activity = await fetchGitHubPullRequestReviewerActivity({
    pull: { number: 14, owner: 'nkzw-tech', repo: 'codiff' },
    transport,
    versions,
  });

  expect(activity.get(reviewVersionId(first))?.reasons).toEqual([
    { kind: 'approval', occurredAt: '2026-01-01T12:00:00.000Z' },
    { kind: 'comment', occurredAt: '2026-01-01T13:00:00.000Z' },
  ]);
  expect(activity.has(reviewVersionId(second))).toBe(false);
  expect(transport.calls.every((call) => call.maxBytes === 2 * 1024 * 1024)).toBe(true);
});

test('one GitHub Artifact Source populates stack, range, commit, and blob caches', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const headSha = gitSha('b'.repeat(40));
  const objectId = 'c'.repeat(40);
  const file = {
    filename: 'src/app.ts',
    patch: '@@ -1 +1 @@\n-old\n+new\n',
    sha: objectId,
    status: 'modified',
  };
  const commitResponse = {
    commit: {
      author: { date: '2026-01-01T00:00:00.000Z', name: 'Ada' },
      message: 'Update app',
    },
    files: [file],
    html_url: `https://github.com/nkzw-tech/codiff/commit/${headSha}`,
    parents: [{ sha: baseSha }],
    sha: headSha,
  };
  const comparePath = `/repos/nkzw-tech/codiff/compare/${baseSha}...${headSha}`;
  const commitPath = `/repos/nkzw-tech/codiff/commits/${headSha}`;
  const blobPath = `/repos/nkzw-tech/codiff/git/blobs/${objectId}`;
  const transport = createFakeGitHubTransport([
    {
      path: comparePath,
      response: { commits: [commitResponse], files: [file], total_commits: 1 },
    },
    { path: commitPath, response: commitResponse },
    {
      bytes: new Uint8Array([0, 1, 255]),
      path: blobPath,
      response: null,
    },
  ]);
  const run = createReviewArtifactRun(
    createGitHubArtifactSource({
      project,
      pull: { number: 12, owner: 'nkzw-tech', repo: 'codiff' },
      transport,
    }),
  );

  const firstRange = await run.readStackAndRange(
    { headSha: headSha, requestedBaseSha: baseSha },
    run.signal,
  );
  const warmRange = await run.readStackAndRange(
    { headSha: headSha, requestedBaseSha: baseSha },
    run.signal,
  );
  const artifacts = await run.readCommitArtifacts(
    [{ commitSha: headSha, parentSha: baseSha }],
    run.signal,
  );
  await run.readCommitArtifacts([{ commitSha: headSha, parentSha: baseSha }], run.signal);
  const blobs = await run.readBlobs([objectId], run.signal);
  await run.readBlobs([objectId], run.signal);

  expect(warmRange).toBe(firstRange);
  expect(firstRange.stack.commits.map((commit) => commit.sha)).toEqual([headSha]);
  expect(firstRange.range.files).toHaveLength(1);
  expect(
    artifacts.get(createCommitArtifactRequestKey({ commitSha: headSha, parentSha: baseSha })),
  ).toMatchObject({
    parentSha: baseSha,
    provenance: { kind: 'github-api', project },
  });
  expect(blobs.get(objectId)?.bytes).toEqual(new Uint8Array([0, 1, 255]));
  expect(transport.calls.filter((call) => call.path === comparePath)).toHaveLength(1);
  expect(transport.calls.filter((call) => call.path === commitPath)).toHaveLength(1);
  expect(transport.calls.filter((call) => call.path === blobPath)).toHaveLength(1);
  expect(transport.calls.every((call) => call.maxBytes === 8 * 1024 * 1024)).toBe(true);
  expect(run.diagnostics().sourceCalls).toEqual({ blobs: 1, commits: 1, stackAndRanges: 1 });
});

test('resolves GitHub ref paths as bounded Blob Artifacts', async () => {
  const ref = gitSha('a'.repeat(40));
  const objectId = gitSha('b'.repeat(40));
  const request = { maxBytes: 32, path: 'images/logo.png', ref };
  const path = '/repos/nkzw-tech/codiff/contents/images/logo.png';
  const transport = createFakeGitHubTransport([
    {
      path,
      query: { ref },
      response: {
        content: btoa(String.fromCharCode(0, 1, 255)),
        encoding: 'base64',
        sha: objectId,
      },
    },
  ]);
  const run = createReviewArtifactRun(
    createGitHubArtifactSource({
      project,
      pull: { number: 12, owner: 'nkzw-tech', repo: 'codiff' },
      transport,
    }),
  );

  const first = await run.readFileBlobs([request], run.signal);
  const warm = await run.readFileBlobs([request], run.signal);

  expect(first.get(createFileBlobArtifactRequestKey(request))).toMatchObject({
    bytes: new Uint8Array([0, 1, 255]),
    objectId,
    provenance: { kind: 'github-api', project },
  });
  expect(warm).toEqual(first);
  expect(transport.calls).toHaveLength(1);
});

test('caps every GitHub Range Artifact comparison page', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const headSha = gitSha('b'.repeat(40));
  const comparePath = `/repos/nkzw-tech/codiff/compare/${baseSha}...${headSha}`;
  const commit = {
    commit: { author: { date: '2026-01-01T00:00:00.000Z', name: 'Ada' }, message: 'Update app' },
    parents: [{ sha: baseSha }],
    sha: headSha,
  };
  const transport = createFakeGitHubTransport([
    {
      path: comparePath,
      response: { commits: [commit], files: [], total_commits: 101 },
    },
  ]);
  const source = createGitHubArtifactSource({
    project,
    pull: { number: 12, owner: 'nkzw-tech', repo: 'codiff' },
    transport,
  });

  await source.readStackAndRange(
    { headSha: headSha, requestedBaseSha: baseSha },
    new AbortController().signal,
  );

  expect(transport.calls.filter((call) => call.path === comparePath)).toEqual([
    expect.objectContaining({ maxBytes: 8 * 1024 * 1024, query: { page: 1, per_page: 100 } }),
    expect.objectContaining({ maxBytes: 8 * 1024 * 1024, query: { page: 2, per_page: 100 } }),
  ]);
});

test('keeps over-limit GitHub JSON Artifacts missing and reports range acquisition failure', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const headSha = gitSha('b'.repeat(40));
  const transport = createFakeGitHubTransport([
    {
      path: `/repos/nkzw-tech/codiff/commits/${headSha}`,
      response: () => {
        throw createGitHubProviderOutputLimitError();
      },
    },
    {
      path: `/repos/nkzw-tech/codiff/compare/${baseSha}...${headSha}`,
      response: () => {
        throw createGitHubProviderOutputLimitError();
      },
    },
  ]);
  const source = createGitHubArtifactSource({
    project,
    pull: { number: 12, owner: 'nkzw-tech', repo: 'codiff' },
    transport,
  });
  const signal = new AbortController().signal;

  const artifacts = await source.readCommitArtifacts(
    [{ commitSha: headSha, parentSha: baseSha }],
    signal,
  );

  expect(
    artifacts.get(createCommitArtifactRequestKey({ commitSha: headSha, parentSha: baseSha })),
  ).toBeUndefined();
  await expect(
    source.readStackAndRange({ headSha: headSha, requestedBaseSha: baseSha }, signal),
  ).rejects.toThrow('GitHub response exceeded the 8388608-byte Artifact safety limit.');
  expect(transport.calls.every((call) => call.maxBytes === 8 * 1024 * 1024)).toBe(true);
});

test('bounds GitHub Blob Artifacts even when a host ignores the requested byte cap', async () => {
  const objectId = 'c'.repeat(40);
  let requestedMaxBytes: number | undefined;
  const transport = {
    request: async <T>(): Promise<T> => {
      throw new Error('Blob acquisition does not request JSON.');
    },
    requestBuffer: async (request) => {
      requestedMaxBytes = request.maxBytes;
      return new Uint8Array([0, 1, 2]);
    },
  } satisfies GitHubTransport;
  const source = createGitHubArtifactSource({
    maxBlobArtifactBytes: 2,
    project,
    pull: { number: 12, owner: 'nkzw-tech', repo: 'codiff' },
    transport,
  });

  await expect(source.readBlobs([objectId], new AbortController().signal)).resolves.toEqual(
    new Map(),
  );
  expect(requestedMaxBytes).toBe(2);
});

test('bounds GitHub Commit Artifact acquisition at eight concurrent requests', async () => {
  const shas = Array.from({ length: 10 }, (_, index) => gitSha(String(index).padStart(40, '0')));
  let active = 0;
  let peak = 0;
  const transport = createFakeGitHubTransport(
    shas.map((sha, index) => ({
      path: `/repos/nkzw-tech/codiff/commits/${sha}`,
      response: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {
          files: [
            {
              filename: `src/${index}.ts`,
              patch: '@@ -1 +1 @@\n-old\n+new\n',
              sha: String(index + 1).padStart(40, '0'),
              status: 'modified',
            },
          ],
          parents: [],
          sha,
        };
      },
    })),
  );
  const source = createGitHubArtifactSource({
    project,
    pull: { number: 12, owner: 'nkzw-tech', repo: 'codiff' },
    transport,
  });

  const artifacts = await source.readCommitArtifacts(
    shas.map((commitSha) => ({ commitSha, parentSha: null })),
    new AbortController().signal,
  );

  expect(artifacts).toHaveLength(10);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
  expect(transport.calls).toHaveLength(10);
  expect(transport.calls.every((call) => call.maxBytes === 8 * 1024 * 1024)).toBe(true);
});

test('preserves opaque GitHub patches and rejects alternate-parent evidence as complete', async () => {
  const selectedParent = gitSha('a'.repeat(40));
  const otherParent = gitSha('b'.repeat(40));
  const opaqueSha = gitSha('c'.repeat(40));
  const mergeSha = gitSha('d'.repeat(40));
  const transport = createFakeGitHubTransport([
    {
      path: `/repos/nkzw-tech/codiff/commits/${opaqueSha}`,
      response: {
        files: [{ filename: 'image.png', status: 'modified' }],
        parents: [{ sha: selectedParent }],
        sha: opaqueSha,
      },
    },
    {
      path: `/repos/nkzw-tech/codiff/commits/${mergeSha}`,
      response: {
        files: [
          {
            filename: 'src/merge.ts',
            patch: '@@ -1 +1 @@\n-old\n+new\n',
            sha: 'e'.repeat(40),
            status: 'modified',
          },
        ],
        parents: [{ sha: otherParent }, { sha: selectedParent }],
        sha: mergeSha,
      },
    },
  ]);
  const source = createGitHubArtifactSource({
    project,
    pull: { number: 12, owner: 'nkzw-tech', repo: 'codiff' },
    transport,
  });

  const artifacts = await source.readCommitArtifacts(
    [
      { commitSha: opaqueSha, parentSha: selectedParent },
      { commitSha: mergeSha, parentSha: selectedParent },
    ],
    new AbortController().signal,
  );

  expect(
    artifacts.get(
      createCommitArtifactRequestKey({ commitSha: opaqueSha, parentSha: selectedParent }),
    ),
  ).toMatchObject({
    coverage: 'opaque',
    files: [{ coverage: 'opaque', path: 'image.png' }],
  });
  expect(
    artifacts.get(
      createCommitArtifactRequestKey({ commitSha: mergeSha, parentSha: selectedParent }),
    )?.coverage,
  ).toBe('truncated');
});

test('loads the aggregate GitHub comparison without reading evolution stacks', async () => {
  const base = gitSha('0'.repeat(40));
  const before = gitSha('a'.repeat(40));
  const after = gitSha('b'.repeat(40));
  let stackReads = 0;
  const git: GitHubHistoryGit = {
    ensureCommit: async (sha) => sha,
    isAncestor: async () => false,
    mergeBase: async () => base,
    readBlob: async () => null,
    readCommitArtifacts: async () => new Map(),
    readCommitDiff: async () => [],
    readCommitMeta: async (sha) => ({
      authoredAt: '2026-01-01T00:00:00.000Z',
      authorName: 'Ada',
      parentShas: [],
      sha,
      shortSha: sha.slice(0, 7),
      subject: 'Commit',
    }),
    readCommitStack: async () => {
      stackReads += 1;
      return [];
    },
    readRangeFiles: async () => [],
    readRangePatchFiles: async () => [],
  };
  const versions = [before, after].map((head, index) => ({
    createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    range: {
      base: { label: { kind: 'commit' as const, text: 'base' }, sha: base },
      head: { label: { kind: 'version' as const, text: `head ${index + 1}` }, sha: head },
    },
    versionId: reviewVersionId(head),
  }));

  const result = await compareGitHubReviewVersionAggregate({
    git,
    pull: { number: 15, owner: 'nkzw-tech', repo: 'codiff' },
    range: { fromVersionId: reviewVersionId(before), toVersionId: reviewVersionId(after) },
    versions,
  });

  expect(result.files).toEqual([]);
  expect(stackReads).toBe(0);
});

test('uses one host replay-evidence batch for an aggregate comparison', async () => {
  const base = gitSha('0'.repeat(40));
  const before = gitSha('a'.repeat(40));
  const after = gitSha('b'.repeat(40));
  const versions = [before, after].map((head, index) => ({
    createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    range: {
      base: { label: { kind: 'commit' as const, text: 'base' }, sha: base },
      head: { label: { kind: 'version' as const, text: `head ${index + 1}` }, sha: head },
    },
    versionId: reviewVersionId(head),
  }));
  const contents = new Map<string, string>([
    [`${base}:src/app.ts`, 'base\n'],
    [`${before}:src/app.ts`, 'old\n'],
    [`${after}:src/app.ts`, 'new\n'],
  ]);
  const readBlob = vi.fn(async () => {
    throw new Error('A batch-capable host must not issue serial blob reads.');
  });
  const readReplayBlobs = vi.fn(
    async (requests: ReadonlyArray<{ path: string; ref: string }>) =>
      new Map(
        requests.map((request) => [
          `${request.ref}:${request.path}`,
          contents.get(`${request.ref}:${request.path}`) ?? null,
        ]),
      ),
  );
  const git: GitHubHistoryGit = {
    ensureCommit: async (sha) => sha,
    isAncestor: async () => false,
    mergeBase: async () => base,
    readBlob,
    readCommitArtifacts: async () => new Map(),
    readCommitDiff: async () => [],
    readCommitMeta: async () => {
      throw new Error('unused');
    },
    readCommitStack: async () => [],
    readRangeFiles: async () => [],
    readRangePatchFiles: async (_base, head) => [
      {
        newPath: 'src/app.ts',
        oldPath: 'src/app.ts',
        patchBody: head === before ? '@@ -1 +1 @@\n-base\n+old' : '@@ -1 +1 @@\n-base\n+new',
        status: 'modified' as const,
      },
    ],
    readReplayBlobs,
  };

  const result = await compareGitHubReviewVersionAggregate({
    git,
    pull: { number: 15, owner: 'nkzw-tech', repo: 'codiff' },
    range: { fromVersionId: reviewVersionId(before), toVersionId: reviewVersionId(after) },
    versions,
  });

  expect(result.files).toHaveLength(1);
  expect(readReplayBlobs).toHaveBeenCalledTimes(1);
  expect(readBlob).not.toHaveBeenCalled();
});

test('preserves incomplete host Range Artifact coverage for aggregate replay', async () => {
  const base = gitSha('0'.repeat(40));
  const before = gitSha('a'.repeat(40));
  const after = gitSha('b'.repeat(40));
  const versions = [before, after].map((head, index) => ({
    createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    range: {
      base: { label: { kind: 'commit' as const, text: 'base' }, sha: base },
      head: { label: { kind: 'version' as const, text: `head ${index + 1}` }, sha: head },
    },
    versionId: reviewVersionId(head),
  }));
  const readReplayBlobs = vi.fn(async () => new Map<string, string | null>());
  const git: GitHubHistoryGit = {
    ensureCommit: async (sha) => sha,
    isAncestor: async () => false,
    mergeBase: async () => base,
    readBlob: async () => {
      throw new Error('A batch-capable host must not issue serial blob reads.');
    },
    readCommitArtifacts: async () => new Map(),
    readCommitDiff: async () => [],
    readCommitMeta: async () => {
      throw new Error('unused');
    },
    readCommitStack: async () => [],
    readRangeFiles: async () => [],
    readRangePatchFiles: async (_base, head) => ({
      coverage: 'truncated' as const,
      files: [
        {
          coverage: 'complete' as const,
          newPath: 'src/app.ts',
          oldPath: 'src/app.ts',
          patchBody: head === before ? '@@ -1 +1 @@\n-base\n+old' : '@@ -1 +1 @@\n-base\n+new',
          status: 'modified' as const,
        },
      ],
    }),
    readReplayBlobs,
  };

  const result = await compareGitHubReviewVersionAggregate({
    git,
    pull: { number: 15, owner: 'nkzw-tech', repo: 'codiff' },
    range: { fromVersionId: reviewVersionId(before), toVersionId: reviewVersionId(after) },
    versions,
  });

  expect(result.analysis.warnings).toContain(
    'One or more GitHub Range Artifacts are incomplete; aggregate comparison may omit changes.',
  );
  expect(result.files).toHaveLength(1);
  expect(readReplayBlobs).toHaveBeenCalledTimes(1);
});

test('uses equal GitHub range object IDs to avoid materializing matching modified heads', async () => {
  const base = gitSha('0'.repeat(40));
  const before = gitSha('a'.repeat(40));
  const after = gitSha('b'.repeat(40));
  const finalObjectId = 'c'.repeat(40);
  const versions = [before, after].map((head, index) => ({
    createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    range: {
      base: { label: { kind: 'commit' as const, text: 'base' }, sha: base },
      head: { label: { kind: 'version' as const, text: `head ${index + 1}` }, sha: head },
    },
    versionId: reviewVersionId(head),
  }));
  const readBlob = vi.fn(async () => {
    throw new Error('Equal complete GitHub range objects must not read raw files.');
  });
  const readReplayBlobs = vi.fn(async () => {
    throw new Error('Equal complete GitHub range objects must not request a blob batch.');
  });
  const git: GitHubHistoryGit = {
    ensureCommit: async (sha) => sha,
    isAncestor: async () => false,
    mergeBase: async () => base,
    readBlob,
    readCommitArtifacts: async () => new Map(),
    readCommitDiff: async () => [],
    readCommitMeta: async () => {
      throw new Error('unused');
    },
    readCommitStack: async () => [],
    readRangeFiles: async () => [],
    readRangePatchFiles: async (_base, head) => [
      {
        coverage: 'complete' as const,
        newObjectId: finalObjectId,
        newPath: 'src/app.ts',
        oldObjectId: head === before ? 'd'.repeat(40) : 'e'.repeat(40),
        oldPath: 'src/app.ts',
        patchBody:
          head === before
            ? '@@ -1 +1 @@\n-before base\n+final'
            : '@@ -1 +1 @@\n-after base\n+final',
        status: 'modified' as const,
      },
    ],
    readReplayBlobs,
  };

  const result = await compareGitHubReviewVersionAggregate({
    git,
    pull: { number: 15, owner: 'nkzw-tech', repo: 'codiff' },
    range: { fromVersionId: reviewVersionId(before), toVersionId: reviewVersionId(after) },
    versions,
  });

  expect(result.files).toEqual([]);
  expect(readReplayBlobs).not.toHaveBeenCalled();
  expect(readBlob).not.toHaveBeenCalled();
});

test('discovers ordinary head pushes and derives each effective base', async () => {
  const base = gitSha('0'.repeat(40));
  const before = gitSha('a'.repeat(40));
  const after = gitSha('b'.repeat(40));
  const historicalBase = gitSha('1'.repeat(40));
  const transport = createFakeGitHubTransport([
    { path: '/repos/nkzw-tech/codiff/issues/12/timeline', response: [] },
    {
      path: '/repos/nkzw-tech/codiff/pulls/12',
      response: {
        base: { sha: base },
        created_at: '2026-01-01T00:00:00.000Z',
        head: {
          ref: 'feature',
          repo: { name: 'fork', owner: { login: 'ada' } },
          sha: after,
        },
      },
    },
    {
      path: '/repos/ada/fork/events',
      response: [
        {
          created_at: '2026-01-02T00:00:00.000Z',
          payload: { before, head: after, ref: 'refs/heads/feature' },
          type: 'PushEvent',
        },
      ],
    },
  ]);
  const git: GitHubHistoryGit = {
    ensureCommit: async (sha) => sha,
    isAncestor: async () => false,
    mergeBase: async (_currentBase, head) => (head === before ? historicalBase : base),
    readCommitArtifacts: async () => new Map(),
    readCommitDiff: async () => [],
    readCommitMeta: async () => {
      throw new Error('unused');
    },
    readCommitStack: async () => [],
    readRangeFiles: async () => [],
  };

  const { versions, warning } = await listGitHubReviewVersions({
    git,
    pull: { number: 12, owner: 'nkzw-tech', repo: 'codiff' },
    transport,
  });

  expect(warning).toBeNull();
  expect(versions.map((version) => version.versionId)).toEqual([before, after]);
  expect(versions.map((version) => version.range.base)).toEqual([
    expect.objectContaining({ sha: historicalBase }),
    expect.objectContaining({ sha: base }),
  ]);
  expect(versions.at(-1)?.range.head.label.text).toBe('Current head');
});

test('compares GitHub versions from their complete patch snapshots', async () => {
  const base = gitSha('0'.repeat(40));
  const before = gitSha('a'.repeat(40));
  const after = gitSha('b'.repeat(40));
  const calls: Array<[GitSha, GitSha]> = [];
  const versions: Array<ReviewVersionOption> = [
    {
      createdAt: '2026-01-01T00:00:00.000Z',
      range: {
        base: { label: { kind: 'commit', text: 'base' }, sha: base },
        head: { label: { kind: 'version', text: 'before' }, sha: before },
      },
      versionId: reviewVersionId(before),
    },
    {
      createdAt: '2026-01-02T00:00:00.000Z',
      range: {
        base: { label: { kind: 'commit', text: 'base' }, sha: base },
        head: { label: { kind: 'version', text: 'after' }, sha: after },
      },
      versionId: reviewVersionId(after),
    },
  ];
  const git: GitHubHistoryGit = {
    ensureCommit: async (sha) => sha,
    isAncestor: async () => false,
    mergeBase: async () => base,
    readBlob: async () => null,
    readCommitArtifacts: async () => new Map(),
    readCommitDiff: async () => [],
    readCommitMeta: async () => {
      throw new Error('unused');
    },
    readCommitStack: async () => [],
    readRangeFiles: async () => [],
    readRangePatchFiles: async (from, to) => {
      calls.push([from, to]);
      return [];
    },
  };

  const result = await compareGitHubReviewVersions({
    git,
    pull: { number: 12, owner: 'nkzw-tech', repo: 'codiff' },
    range: { fromVersionId: reviewVersionId(before), toVersionId: reviewVersionId(after) },
    versions,
  });

  expect(result.versionCompare.analysis.summary.empty).toBe(true);
  expect(calls).toEqual([
    [base, before],
    [base, after],
  ]);
});

const commit = (
  shaChar: string,
  subject: string,
  parent: GitSha,
  authoredAt = '2026-01-01T00:00:00.000Z',
): GitHubCommitLike => {
  const sha = gitSha(shaChar.repeat(40));
  return {
    authoredAt,
    authorName: 'Ada',
    parentShas: [parent],
    sha,
    shortSha: sha.slice(0, 7),
    subject,
  };
};

const patchFile = (filePath: string, body: string): ChangedFile => ({
  fingerprint: filePath,
  path: filePath,
  sections: [
    {
      binary: false,
      id: filePath,
      kind: 'commit',
      patch: body,
    },
  ],
  status: 'modified',
});

test('buildBaseMovement classifies forward base advances with commitsBetween + diffStat', async () => {
  const oldBase = gitSha('1'.repeat(40));
  const mid = commit('2', 'base: mid', oldBase, '2026-01-01T01:00:00.000Z');
  const newBase = commit('3', 'base: tip', mid.sha, '2026-01-01T02:00:00.000Z');

  const git: GitHubHistoryGit = {
    ensureCommit: async (sha) => sha,
    isAncestor: async (ancestor, descendant) => {
      // oldBase < mid < newBase
      if (ancestor === oldBase && (descendant === mid.sha || descendant === newBase.sha)) {
        return true;
      }
      if (ancestor === mid.sha && descendant === newBase.sha) {
        return true;
      }
      if (ancestor === descendant) {
        return true;
      }
      return false;
    },
    mergeBase: async () => oldBase,
    readCommitArtifacts: async () => new Map(),
    readCommitDiff: async () => [],
    readCommitMeta: async (sha) => {
      if (sha === oldBase) {
        return {
          authoredAt: '2026-01-01T00:00:00.000Z',
          authorName: 'Ada',
          parentShas: [],
          sha: oldBase,
          shortSha: oldBase.slice(0, 7),
          subject: 'base: root',
        };
      }
      if (sha === mid.sha) {
        return mid;
      }
      if (sha === newBase.sha) {
        return newBase;
      }
      throw new Error(`unknown ${sha}`);
    },
    readCommitStack: async (base, head) => {
      if (base === oldBase && head === newBase.sha) {
        return [mid, newBase];
      }
      return [];
    },
    readRangeFiles: async () => [patchFile('src/a.ts', '@@ -1 +1 @@\n-old\n+new\n')],
  };

  const movement = await buildBaseMovement({
    fromBase: oldBase,
    git,
    toBase: newBase.sha,
  });

  expect(movement.changed).toBe(true);
  expect(movement.relationship).toBe('forward');
  expect(movement.commitsBetween).toBe(2);
  expect(movement.commits?.map((entry) => entry.sha)).toEqual([mid.sha, newBase.sha]);
  expect(movement.diffStat).toEqual({ additions: 1, deletions: 1, filesChanged: 1 });
  expect(movement.commitTimestampDeltaMs).toBe(
    Date.parse(newBase.authoredAt) - Date.parse('2026-01-01T00:00:00.000Z'),
  );
});

test('buildBaseMovement classifies backward base moves', async () => {
  const oldBase = commit('a', 'old tip', gitSha('0'.repeat(40)));
  const newBase = gitSha('0'.repeat(40));
  const git: GitHubHistoryGit = {
    ensureCommit: async (sha) => sha,
    isAncestor: async (ancestor, descendant) => ancestor === newBase && descendant === oldBase.sha,
    mergeBase: async () => newBase,
    readCommitArtifacts: async () => new Map(),
    readCommitDiff: async () => [],
    readCommitMeta: async (sha) => {
      if (sha === oldBase.sha) {
        return oldBase;
      }
      return {
        authoredAt: '2026-01-01T00:00:00.000Z',
        authorName: 'Ada',
        parentShas: [],
        sha: newBase,
        shortSha: newBase.slice(0, 7),
        subject: 'root',
      };
    },
    readCommitStack: async (base, head) => {
      if (base === newBase && head === oldBase.sha) {
        return [oldBase];
      }
      return [];
    },
    readRangeFiles: async () => [],
  };

  const movement = await buildBaseMovement({
    fromBase: oldBase.sha,
    git,
    toBase: newBase,
  });
  expect(movement.relationship).toBe('backward');
  expect(movement.commitsBetween).toBe(1);
});

test('buildBaseMovement classifies divergent bases', async () => {
  const fromBase = gitSha('a'.repeat(40));
  const toBase = gitSha('b'.repeat(40));
  const tip = commit('c', 'on new base', toBase);
  const git: GitHubHistoryGit = {
    ensureCommit: async (sha) => sha,
    isAncestor: async () => false,
    mergeBase: async () => fromBase,
    readCommitArtifacts: async () => new Map(),
    readCommitDiff: async () => [],
    readCommitMeta: async (sha) => ({
      authoredAt: '2026-01-01T00:00:00.000Z',
      authorName: 'Ada',
      parentShas: [],
      sha,
      shortSha: sha.slice(0, 7),
      subject: 'base',
    }),
    readCommitStack: async (base, head) => {
      if (base === fromBase && head === toBase) {
        return [tip];
      }
      return [];
    },
    readRangeFiles: async () => [],
  };
  const movement = await buildBaseMovement({ fromBase, git, toBase });
  expect(movement.relationship).toBe('divergent');
  expect(movement.commitsBetween).toBe(1);
});

test('fingerprint evolution classifies retained/revised/introduced via change evidence', async () => {
  const base = gitSha('0'.repeat(40));
  const oldA = commit('a', 'feat: one', base);
  const oldB = commit('b', 'feat: two', oldA.sha);
  const newA = { ...oldA }; // same sha retained
  const newB = commit('c', 'feat: two', newA.sha); // rewritten same subject, same patch
  const newC = commit('d', 'feat: three', newB.sha); // introduced

  const filesFor = (sha: string): Array<ChangedFile> => {
    if (sha === oldA.sha || sha === newA.sha) {
      return [patchFile('one.ts', '@@ -1 +1 @@\n-a\n+b\n')];
    }
    if (sha === oldB.sha || sha === newB.sha) {
      return [patchFile('two.ts', '@@ -1 +1 @@\n-x\n+y\n')];
    }
    if (sha === newC.sha) {
      return [patchFile('three.ts', '@@ -0,0 +1 @@\n+z\n')];
    }
    return [];
  };

  const fingerprints = new Map();
  for (const entry of [oldA, oldB, newB, newC]) {
    fingerprints.set(
      entry.sha,
      await createCommitFingerprint(
        {
          sha: entry.sha,
          title: entry.subject,
        },
        toCommitArtifact({
          commitSha: entry.sha,
          files: filesFor(entry.sha),
          parentSha: entry.parentShas[0] ?? null,
          provenance,
        }),
      ),
    );
  }

  const evolution = projectCommitEvolution(
    await matchVersionCommitStacks({
      fingerprints,
      from: {
        baseSha: base,
        headSha: oldB.sha,
        versionId: reviewVersionId('from'),
      },
      newCommits: [newA, newB, newC].map((entry) => ({
        authoredDate: entry.authoredAt,
        authorName: entry.authorName,
        message: entry.subject,
        parentShas: entry.parentShas,
        sha: entry.sha,
        shortSha: entry.shortSha,
        title: entry.subject,
        webUrl: '',
      })),
      oldCommits: [oldA, oldB].map((entry) => ({
        authoredDate: entry.authoredAt,
        authorName: entry.authorName,
        message: entry.subject,
        parentShas: entry.parentShas,
        sha: entry.sha,
        shortSha: entry.shortSha,
        title: entry.subject,
        webUrl: '',
      })),
      to: {
        baseSha: base,
        headSha: newC.sha,
        versionId: reviewVersionId('to'),
      },
    }),
  );

  expect(evolution.units.some((unit) => unit.kind === 'retained')).toBe(true);
  expect(
    evolution.units.some((unit) => unit.kind === 'rewritten-same-patch' || unit.kind === 'revised'),
  ).toBe(true);
  expect(evolution.units.some((unit) => unit.kind === 'introduced')).toBe(true);
  expect(evolution.summary.added).toBeGreaterThanOrEqual(1);
});

const versionPair = (base: GitSha, before: GitSha, after: GitSha) =>
  [before, after].map((head, index) => ({
    createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    range: {
      base: { label: { kind: 'commit' as const, text: 'base' }, sha: base },
      head: { label: { kind: 'version' as const, text: `head ${index + 1}` }, sha: head },
    },
    versionId: reviewVersionId(head),
  }));

test('normalizes reversed GitHub stacks before keeping the latest evolution window', async () => {
  const base = gitSha('f'.repeat(40));
  const before = gitSha('a'.repeat(40));
  const after = gitSha('b'.repeat(40));
  const commits: Array<GitHubCommitLike> = Array.from({ length: 42 }, (_, index) => {
    const sha = gitSha(String(index + 1).padStart(40, '0'));
    const parent = index === 0 ? base : gitSha(String(index).padStart(40, '0'));
    return {
      authoredAt: `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`,
      authorName: 'Ada',
      parentShas: [parent],
      sha,
      shortSha: sha.slice(0, 7),
      subject: `Commit ${index + 1}`,
    };
  });
  const versions = versionPair(base, before, after);
  const matcherDiagnostics = vi.fn();
  const git: GitHubHistoryGit = {
    ensureCommit: async (sha) => sha,
    isAncestor: async () => false,
    mergeBase: async () => base,
    readCommitArtifacts: async () => new Map(),
    readCommitDiff: async () => [],
    readCommitMeta: async (sha) => commits.find((entry) => entry.sha === sha)!,
    readCommitStack: async () => commits.toReversed(),
    readRangeFiles: async () => [],
  };

  const evolution = await classifyGitHubReviewVersionEvolution({
    control: { onMatcherDiagnostics: matcherDiagnostics },
    git,
    pull: { number: 16, owner: 'nkzw-tech', repo: 'codiff' },
    range: {
      fromVersionId: reviewVersionId(before),
      toVersionId: reviewVersionId(after),
    },
    versions,
  });

  expect(evolution.units).toHaveLength(40);
  const afterShas = evolution.units.flatMap((unit) =>
    'after' in unit && unit.after ? [unit.after.sha] : [],
  );
  expect(afterShas[0]).toBe(String(3).padStart(40, '0'));
  expect(afterShas.at(-1)).toBe(String(42).padStart(40, '0'));
  expect(evolution.warnings).toEqual(
    expect.arrayContaining([expect.stringContaining('latest 40 commits')]),
  );
  expect(matcherDiagnostics).toHaveBeenCalledWith(
    expect.objectContaining({
      primaryAssignment: null,
      targetBaseAssignment: null,
    }),
  );
});

test('normalizes GitHub merge stacks with every parent before its child', async () => {
  const base = gitSha('0'.repeat(40));
  const before = gitSha('a'.repeat(40));
  const after = gitSha('b'.repeat(40));
  const first = commit('c', 'First', base, '2026-01-01T00:00:00.000Z');
  const branch = commit('d', 'Branch', base, '2026-01-01T01:00:00.000Z');
  const merge = {
    ...commit('e', 'Merge', first.sha, '2026-01-01T02:00:00.000Z'),
    parentShas: [first.sha, branch.sha],
  };
  const versions = versionPair(base, before, after);
  const git: GitHubHistoryGit = {
    ensureCommit: async (sha) => sha,
    isAncestor: async () => false,
    mergeBase: async () => base,
    readCommitArtifacts: async () => new Map(),
    readCommitDiff: async () => [],
    readCommitMeta: async (sha) => [first, branch, merge].find((entry) => entry.sha === sha)!,
    readCommitStack: async () => [merge, branch, first],
    readRangeFiles: async () => [],
  };

  const evolution = await classifyGitHubReviewVersionEvolution({
    git,
    pull: { number: 17, owner: 'nkzw-tech', repo: 'codiff' },
    range: {
      fromVersionId: reviewVersionId(before),
      toVersionId: reviewVersionId(after),
    },
    versions,
  });

  expect(
    evolution.units.flatMap((unit) => ('after' in unit && unit.after ? [unit.after.sha] : [])),
  ).toEqual([first.sha, branch.sha, merge.sha]);
});
