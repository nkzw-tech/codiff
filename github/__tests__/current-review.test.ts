import {
  createCommitArtifactRequestKey,
  createFileBlobArtifactRequestKey,
  createReviewArtifactRun,
  type ReviewArtifactProject,
} from '@nkzw/codiff-core';
import type { GitSha } from '@nkzw/codiff-core/types';
import { expect, test } from 'vite-plus/test';
import { createFakeGitHubTransport } from '../../test/fake-provider-transports.ts';
import { createGitHubArtifactSource, createGitHubRangeArtifact } from '../src/current-review.ts';

const gitSha = (value: string) => value as GitSha;
const project: ReviewArtifactProject = {
  host: 'github.com',
  project: 'nkzw-tech/codiff',
  provider: 'github',
};
const pull = { number: 12, owner: 'nkzw-tech', repo: 'codiff' };

test('normalizes GitHub patches into immutable Range Artifacts', () => {
  const range = createGitHubRangeArtifact({
    baseSha: gitSha('a'.repeat(40)),
    files: [
      {
        additions: 7,
        deletions: 3,
        filename: 'src/app.ts',
        patch: '@@ -1 +1 @@\n-old\n+new\n',
        status: 'modified',
      },
    ],
    headSha: gitSha('b'.repeat(40)),
    project,
  });

  expect(range).toMatchObject({
    coverage: 'complete',
    files: [
      {
        coverage: 'complete',
        lineCount: { additions: 7, deletions: 3 },
        patch:
          'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
      },
    ],
  });
});

test('preserves exact zero GitHub counts when a patch is omitted', () => {
  const range = createGitHubRangeArtifact({
    baseSha: gitSha('a'.repeat(40)),
    files: [
      {
        additions: 0,
        deletions: 0,
        filename: 'src/generated.txt',
        sha: 'c'.repeat(40),
        status: 'modified',
      },
    ],
    headSha: gitSha('b'.repeat(40)),
    project,
  });

  expect(range.files[0]).toMatchObject({
    lineCount: { additions: 0, deletions: 0 },
    path: 'src/generated.txt',
  });
});

test('one GitHub source populates stack, range, commit, and blob caches', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const headSha = gitSha('b'.repeat(40));
  const objectId = 'c'.repeat(40);
  const file = {
    filename: 'src/app.ts',
    patch: '@@ -1 +1 @@\n-old\n+new\n',
    sha: objectId,
    status: 'modified',
  };
  const commit = {
    commit: {
      author: { date: '2026-01-01T00:00:00.000Z', name: 'Ada' },
      message: 'Update app',
    },
    files: [file],
    parents: [{ sha: baseSha }],
    sha: headSha,
  };
  const comparePath = `/repos/nkzw-tech/codiff/compare/${baseSha}...${headSha}`;
  const commitPath = `/repos/nkzw-tech/codiff/commits/${headSha}`;
  const blobPath = `/repos/nkzw-tech/codiff/git/blobs/${objectId}`;
  const transport = createFakeGitHubTransport([
    {
      path: comparePath,
      response: {
        commits: [commit],
        files: [file],
        merge_base_commit: { sha: baseSha },
        total_commits: 1,
      },
    },
    { path: commitPath, response: commit },
    { bytes: new Uint8Array([0, 1, 255]), path: blobPath, response: null },
  ]);
  const run = createReviewArtifactRun(createGitHubArtifactSource({ project, pull, transport }));

  const firstRange = await run.readStackAndRange(
    { headSha, requestedBaseSha: baseSha },
    run.signal,
  );
  expect(await run.readStackAndRange({ headSha, requestedBaseSha: baseSha }, run.signal)).toBe(
    firstRange,
  );
  const artifacts = await run.readCommitArtifacts(
    [{ commitSha: headSha, parentSha: baseSha }],
    run.signal,
  );
  await run.readCommitArtifacts([{ commitSha: headSha, parentSha: baseSha }], run.signal);
  const blobs = await run.readBlobs([objectId], run.signal);
  await run.readBlobs([objectId], run.signal);

  expect(firstRange.stack.commits.map((entry) => entry.sha)).toEqual([headSha]);
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
  expect(run.diagnostics().sourceCalls).toEqual({ blobs: 1, commits: 1, stackAndRanges: 1 });
});

test('uses GitHub merge_base_commit as the effective artifact base', async () => {
  const requestedBaseSha = gitSha('a'.repeat(40));
  const effectiveBaseSha = gitSha('b'.repeat(40));
  const headSha = gitSha('c'.repeat(40));
  const transport = createFakeGitHubTransport([
    {
      path: `/repos/nkzw-tech/codiff/compare/${requestedBaseSha}...${headSha}`,
      response: {
        commits: [
          {
            commit: {
              author: { date: '2026-01-01T00:00:00.000Z', name: 'Ada' },
              message: 'Update app',
            },
            parents: [{ sha: effectiveBaseSha }],
            sha: headSha,
          },
        ],
        files: [],
        merge_base_commit: { sha: effectiveBaseSha },
        total_commits: 1,
      },
    },
  ]);
  const run = createReviewArtifactRun(createGitHubArtifactSource({ project, pull, transport }));

  const result = await run.readStackAndRange({ headSha, requestedBaseSha }, run.signal);

  expect(result.range).toMatchObject({ baseSha: effectiveBaseSha, headSha });
  expect(result.stack).toMatchObject({ baseSha: effectiveBaseSha, headSha });
  expect(run.diagnostics().acquired.stackAndRanges).toEqual({
    [`${requestedBaseSha}:${headSha}`]: 1,
  });
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
  const run = createReviewArtifactRun(createGitHubArtifactSource({ project, pull, transport }));

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

test('caps current GitHub commit stacks at forty', async () => {
  const baseSha = gitSha('f'.repeat(40));
  const commits = Array.from({ length: 41 }, (_, index) => {
    const sha = gitSha(index.toString(16).padStart(40, '0'));
    const parent = index === 0 ? baseSha : gitSha((index - 1).toString(16).padStart(40, '0'));
    return {
      commit: {
        author: { date: new Date(index * 1000).toISOString(), name: 'Ada' },
        message: `Commit ${index}`,
      },
      parents: [{ sha: parent }],
      sha,
    };
  });
  const headSha = commits.at(-1)!.sha;
  const transport = createFakeGitHubTransport([
    {
      path: `/repos/nkzw-tech/codiff/compare/${baseSha}...${headSha}`,
      response: {
        commits,
        files: [],
        merge_base_commit: { sha: baseSha },
        total_commits: commits.length,
      },
    },
  ]);

  const result = await createGitHubArtifactSource({ project, pull, transport }).readStackAndRange(
    { headSha, requestedBaseSha: baseSha },
    new AbortController().signal,
  );

  expect(result.stack.commits).toHaveLength(40);
  expect(result.stack.commits[0]?.sha).toBe(commits[1]?.sha);
  expect(result.stack.coverage).toBe('truncated');
});

test('retains commits 81 through 120 from a paginated GitHub comparison', async () => {
  const baseSha = gitSha('f'.repeat(40));
  const commits = Array.from({ length: 120 }, (_, index) => {
    const sha = gitSha((index + 1).toString(16).padStart(40, '0'));
    const parent = index === 0 ? baseSha : gitSha(index.toString(16).padStart(40, '0'));
    return {
      commit: {
        author: { date: new Date(index * 1000).toISOString(), name: 'Ada' },
        message: `Commit ${index + 1}`,
      },
      parents: [{ sha: parent }],
      sha,
    };
  });
  const headSha = commits.at(-1)!.sha;
  const comparePath = `/repos/nkzw-tech/codiff/compare/${baseSha}...${headSha}`;
  const transport = createFakeGitHubTransport([
    {
      path: comparePath,
      response: ({ query }: { query?: Readonly<Record<string, boolean | number | string>> }) => ({
        commits: query?.page === 2 ? commits.slice(100) : commits.slice(0, 100),
        files: [],
        merge_base_commit: { sha: baseSha },
        total_commits: commits.length,
      }),
    },
  ]);

  const result = await createGitHubArtifactSource({ project, pull, transport }).readStackAndRange(
    { headSha, requestedBaseSha: baseSha },
    new AbortController().signal,
  );

  expect(result.stack.commits.map((commit) => commit.sha)).toEqual(
    commits.slice(80).map((commit) => commit.sha),
  );
  expect(transport.calls.map((call) => call.query?.page)).toEqual([1, 2]);
  expect(result.stack.coverage).toBe('truncated');
});

test('bounds GitHub Commit Artifact reads at eight concurrent requests', async () => {
  const shas = Array.from({ length: 10 }, (_, index) => gitSha(index.toString().padStart(40, '0')));
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
              status: 'modified',
            },
          ],
          parents: [],
          sha,
        };
      },
    })),
  );

  const artifacts = await createGitHubArtifactSource({
    project,
    pull,
    transport,
  }).readCommitArtifacts(
    shas.map((commitSha) => ({ commitSha, parentSha: null })),
    new AbortController().signal,
  );

  expect(artifacts).toHaveLength(10);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
});

test('preserves GitHub merge artifacts for two selected parents without calling mismatches complete', async () => {
  const firstParent = gitSha('a'.repeat(40));
  const secondParent = gitSha('b'.repeat(40));
  const mergeSha = gitSha('c'.repeat(40));
  const path = `/repos/nkzw-tech/codiff/commits/${mergeSha}`;
  const transport = createFakeGitHubTransport([
    {
      path,
      response: {
        files: [
          {
            filename: 'src/merge.ts',
            patch: '@@ -1 +1 @@\n-old\n+new\n',
            status: 'modified',
          },
        ],
        parents: [{ sha: firstParent }, { sha: secondParent }],
        sha: mergeSha,
      },
    },
  ]);
  const requests = [
    { commitSha: mergeSha, parentSha: firstParent },
    { commitSha: mergeSha, parentSha: secondParent },
  ];

  const artifacts = await createGitHubArtifactSource({
    project,
    pull,
    transport,
  }).readCommitArtifacts(requests, new AbortController().signal);

  expect(artifacts).toHaveLength(2);
  expect(artifacts.get(createCommitArtifactRequestKey(requests[0]!))?.coverage).toBe('complete');
  expect(artifacts.get(createCommitArtifactRequestKey(requests[1]!))?.coverage).not.toBe(
    'complete',
  );
  expect(transport.calls.filter((call) => call.path === path)).toHaveLength(2);
});
