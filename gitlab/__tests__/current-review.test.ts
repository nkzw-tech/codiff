import {
  createCommitArtifactRequestKey,
  createFileBlobArtifactRequestKey,
  createReviewArtifactRun,
  type ReviewArtifactProject,
} from '@nkzw/codiff-core';
import type { GitSha } from '@nkzw/codiff-core/types';
import { expect, test } from 'vite-plus/test';
import { createFakeGitLabTransport } from '../../test/fake-provider-transports.ts';
import {
  createGitLabArtifactSource,
  createGitLabRangeArtifact,
  fetchGitLabCommitArtifacts,
} from '../src/current-review.ts';

const gitSha = (value: string) => value as GitSha;
const project: ReviewArtifactProject = {
  host: 'gitlab.example.com',
  project: 'group/project',
  provider: 'gitlab',
};

test('normalizes GitLab patches into immutable Range Artifacts', () => {
  const range = createGitLabRangeArtifact({
    baseSha: gitSha('a'.repeat(40)),
    diffs: [
      {
        diff: '@@ -1 +1,2 @@\n-old\n+new\n+second\n',
        new_path: 'src/app.ts',
        old_path: 'src/app.ts',
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
        lineCount: { additions: 2, deletions: 1 },
        patch:
          'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n-old\n+new\n+second\n',
      },
    ],
  });
});

test('one GitLab source populates stack, range, commit, and blob caches', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const headSha = gitSha('b'.repeat(40));
  const objectId = 'c'.repeat(40);
  const diff = {
    diff: '@@ -1 +1 @@\n-old\n+new\n',
    new_path: 'src/app.ts',
    old_path: 'src/app.ts',
  };
  const transport = createFakeGitLabTransport([
    {
      path: '/api/v4/projects/group%2Fproject/repository/compare',
      query: { from: baseSha, straight: 'true', to: headSha },
      response: {
        commits: [
          {
            authored_date: '2026-01-01T00:00:00.000Z',
            id: headSha,
            parent_ids: [baseSha],
            title: 'Update app',
          },
        ],
        diffs: [diff],
      },
    },
    {
      bytes: new Uint8Array([0, 1, 255]),
      path: `/api/v4/projects/group%2Fproject/repository/blobs/${objectId}/raw`,
      response: null,
    },
  ]);
  const run = createReviewArtifactRun(
    createGitLabArtifactSource({ project, projectPath: 'group/project', transport }),
  );

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
    provenance: { kind: 'gitlab-api', project },
  });
  expect(blobs.get(objectId)?.bytes).toEqual(new Uint8Array([0, 1, 255]));
  expect(run.diagnostics().sourceCalls).toEqual({ blobs: 1, commits: 1, stackAndRanges: 1 });
});

test('resolves GitLab ref paths as bounded Blob Artifacts', async () => {
  const ref = gitSha('a'.repeat(40));
  const objectId = gitSha('b'.repeat(40));
  const request = { maxBytes: 32, path: 'images/logo.png', ref };
  const transport = createFakeGitLabTransport([
    {
      path: '/api/v4/projects/group%2Fproject/repository/files/images%2Flogo.png',
      query: { ref },
      response: {
        blob_id: objectId,
        content: btoa(String.fromCharCode(0, 1, 255)),
        encoding: 'base64',
      },
    },
  ]);
  const run = createReviewArtifactRun(
    createGitLabArtifactSource({ project, projectPath: 'group/project', transport }),
  );

  const first = await run.readFileBlobs([request], run.signal);
  const warm = await run.readFileBlobs([request], run.signal);

  expect(first.get(createFileBlobArtifactRequestKey(request))).toMatchObject({
    bytes: new Uint8Array([0, 1, 255]),
    objectId,
    provenance: { kind: 'gitlab-api', project },
  });
  expect(warm).toEqual(first);
  expect(transport.calls).toHaveLength(1);
});

test('bounds GitLab Commit Artifact reads at eight concurrent requests', async () => {
  const shas = Array.from({ length: 10 }, (_, index) => gitSha(index.toString().padStart(40, '0')));
  let active = 0;
  let peak = 0;
  const transport = createFakeGitLabTransport(
    shas.map((sha, index) => ({
      path: `/api/v4/projects/group%2Fproject/repository/commits/${sha}/diff`,
      response: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return [
          {
            diff: '@@ -1 +1 @@\n-old\n+new\n',
            new_path: `src/${index}.ts`,
            old_path: `src/${index}.ts`,
          },
        ];
      },
    })),
  );

  const artifacts = await fetchGitLabCommitArtifacts({
    commits: shas.map((commitSha) => ({ commitSha, parentSha: null })),
    project,
    projectPath: 'group/project',
    transport,
  });

  expect(artifacts).toHaveLength(10);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
});

test('preserves one GitLab merge commit relative to two selected parents', async () => {
  const firstParent = gitSha('a'.repeat(40));
  const secondParent = gitSha('b'.repeat(40));
  const mergeSha = gitSha('c'.repeat(40));
  const comparePath = '/api/v4/projects/group%2Fproject/repository/compare';
  const transport = createFakeGitLabTransport([
    {
      path: comparePath,
      query: { from: firstParent, straight: 'true', to: mergeSha },
      response: {
        diffs: [
          {
            diff: '@@ -1 +1 @@\n-old\n+first\n',
            new_path: 'src/first.ts',
            old_path: 'src/first.ts',
          },
        ],
      },
    },
    {
      path: comparePath,
      query: { from: secondParent, straight: 'true', to: mergeSha },
      response: {
        diffs: [
          {
            diff: '@@ -1 +1 @@\n-old\n+second\n',
            new_path: 'src/second.ts',
            old_path: 'src/second.ts',
          },
        ],
      },
    },
  ]);
  const requests = [
    { commitSha: mergeSha, parentSha: firstParent },
    { commitSha: mergeSha, parentSha: secondParent },
  ];

  const artifacts = await fetchGitLabCommitArtifacts({
    commits: requests,
    project,
    projectPath: 'group/project',
    transport,
  });

  expect(artifacts).toHaveLength(2);
  expect(artifacts.get(createCommitArtifactRequestKey(requests[0]!))?.files[0]?.path).toBe(
    'src/first.ts',
  );
  expect(artifacts.get(createCommitArtifactRequestKey(requests[1]!))?.files[0]?.path).toBe(
    'src/second.ts',
  );
  expect(transport.calls.map((call) => call.query?.from)).toEqual([firstParent, secondParent]);
});

test.each(['compare_timeout', 'overflow'] as const)(
  'does not mark GitLab %s comparison evidence complete',
  async (flag) => {
    const parentSha = gitSha('a'.repeat(40));
    const commitSha = gitSha('b'.repeat(40));
    const transport = createFakeGitLabTransport([
      {
        path: '/api/v4/projects/group%2Fproject/repository/compare',
        query: { from: parentSha, straight: 'true', to: commitSha },
        response: {
          diffs: [
            {
              diff: '@@ -1 +1 @@\n-old\n+new\n',
              new_path: 'src/app.ts',
              old_path: 'src/app.ts',
            },
          ],
          [flag]: true,
        },
      },
    ]);
    const request = { commitSha, parentSha };

    const artifacts = await fetchGitLabCommitArtifacts({
      commits: [request],
      project,
      projectPath: 'group/project',
      transport,
    });

    expect(artifacts.get(createCommitArtifactRequestKey(request))?.coverage).toBe('truncated');
  },
);

test('uses the GitLab commit-diff endpoint only for root commits', async () => {
  const commitSha = gitSha('d'.repeat(40));
  const path = `/api/v4/projects/group%2Fproject/repository/commits/${commitSha}/diff`;
  const transport = createFakeGitLabTransport([
    {
      path,
      response: [
        {
          diff: '@@ -1 +1 @@\n-old\n+root\n',
          new_path: 'src/root.ts',
          old_path: 'src/root.ts',
        },
      ],
    },
  ]);
  const request = { commitSha, parentSha: null };

  const artifacts = await fetchGitLabCommitArtifacts({
    commits: [request],
    project,
    projectPath: 'group/project',
    transport,
  });

  expect(artifacts.get(createCommitArtifactRequestKey(request))?.files[0]?.path).toBe(
    'src/root.ts',
  );
  expect(transport.calls[0]?.path).toBe(path);
});
