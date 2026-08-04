import {
  createCommitArtifactRequestKey,
  createFileBlobArtifactRequestKey,
  createReviewArtifactRun,
} from '@nkzw/codiff-core';
import type { EvolutionUnitId, GitSha, ReviewVersionId } from '@nkzw/codiff-core/types';
import { parsePatchFiles } from '@pierre/diffs';
import { expect, test, vi } from 'vite-plus/test';
import { createFakeGitLabTransport } from '../../test/fake-provider-transports.ts';
import {
  createGitLabArtifactSource,
  createGitLabRangeArtifact,
  fetchGitLabCommitArtifacts,
  fetchGitLabHistoricalCommitStack,
  fetchGitLabMergeRequestCommits,
  fetchGitLabMergeRequestVersionCompare,
  fetchGitLabMergeRequestVersionCommitEvolution,
  fetchGitLabMergeRequestReviewerActivity,
  fetchGitLabMergeRequestVersions,
  fetchGitLabReviewVersionTimeline,
  fetchGitLabVersionCommitUnitDiff,
  projectCommitEvolution,
  projectReviewPlan,
  projectVersionCompare,
  toGitLabDiffIdentity,
  type GitLabTransport,
} from '../src/index.ts';
import {
  createCommitFingerprint,
  matchVersionCommitStacks,
  toCommitArtifact,
  type ReviewArtifactProject,
  type ReviewArtifactProvenance,
} from '../src/version-commit-evolution.ts';

const evolutionUnitId = (value: string) => value as EvolutionUnitId;
const gitSha = (value: string) => value as GitSha;
const reviewVersionId = (value: string) => value as ReviewVersionId;
const limitError = () => {
  const error = new Error('GitLab response exceeded the 8388608-byte Artifact safety limit.');
  error.name = 'ProviderOutputLimitError';
  return error;
};
const project: ReviewArtifactProject = {
  host: 'gitlab.example.com',
  project: 'group/project',
  provider: 'gitlab',
};
const provenance: ReviewArtifactProvenance = { kind: 'gitlab-api', project };
const commitArtifact = (
  commitSha: GitSha,
  files: Parameters<typeof toCommitArtifact>[0]['files'],
  parentSha: GitSha | null = null,
) => toCommitArtifact({ commitSha, files, parentSha, provenance });
const historyCommit = (sha: GitSha, parentSha: GitSha) => ({
  authoredDate: '2026-01-01T00:00:00.000Z',
  authorEmail: '',
  authorName: 'Ada',
  committedDate: '2026-01-01T00:00:00.000Z',
  committerName: 'Ada',
  message: 'Change behavior',
  parentShas: [parentSha],
  sha,
  shortSha: sha.slice(0, 7),
  title: 'Change behavior',
  webUrl: `https://gitlab.example/commit/${sha}`,
});

test('bounds provider Commit Artifact reads at eight and preserves truncation', async () => {
  const shas = Array.from({ length: 10 }, (_, index) => gitSha(String(index).padStart(40, '0')));
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
            diff: index === 0 ? '' : '@@ -1 +1 @@\n-old\n+new\n',
            new_path: `src/${index}.ts`,
            old_path: `src/${index}.ts`,
            too_large: index === 0,
          },
        ];
      },
    })),
  );

  const artifacts = await fetchGitLabCommitArtifacts({
    commits: shas.map((sha) => ({ parentSha: null, sha })),
    project,
    projectPath: 'group/project',
    transport,
  });

  expect(artifacts).toHaveLength(10);
  expect(artifacts.get(shas[0]!)?.coverage).toBe('truncated');
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
  expect(transport.calls).toHaveLength(10);
  expect(transport.calls.every((call) => call.maxBytes === 8 * 1024 * 1024)).toBe(true);
});

test('one GitLab Artifact Source populates stack, range, commit, and blob caches', async () => {
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
      path: `/api/v4/projects/group%2Fproject/repository/commits/${headSha}/diff`,
      response: [diff],
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
    provenance,
  });
  expect(blobs.get(objectId)?.bytes).toEqual(new Uint8Array([0, 1, 255]));
  expect(transport.calls.filter((call) => call.path.includes('/compare'))).toHaveLength(1);
  expect(transport.calls.filter((call) => call.path.endsWith(`/${headSha}/diff`))).toHaveLength(1);
  expect(transport.calls.filter((call) => call.path.endsWith(`/${objectId}/raw`))).toHaveLength(1);
  expect(transport.calls.every((call) => call.maxBytes === 8 * 1024 * 1024)).toBe(true);
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
    provenance,
  });
  expect(warm).toEqual(first);
  expect(transport.calls).toHaveLength(1);
});

test('keeps over-limit GitLab JSON Artifacts missing and reports range acquisition failure', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const headSha = gitSha('b'.repeat(40));
  const transport = createFakeGitLabTransport([
    {
      path: `/api/v4/projects/group%2Fproject/repository/commits/${headSha}/diff`,
      response: () => {
        throw limitError();
      },
    },
    {
      path: '/api/v4/projects/group%2Fproject/repository/compare',
      response: () => {
        throw limitError();
      },
    },
  ]);
  const source = createGitLabArtifactSource({ project, projectPath: 'group/project', transport });
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
  ).rejects.toThrow('GitLab response exceeded the 8388608-byte Artifact safety limit.');
  expect(transport.calls.every((call) => call.maxBytes === 8 * 1024 * 1024)).toBe(true);
});

test('bounds GitLab Blob Artifacts even when a host ignores the requested byte cap', async () => {
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
  } satisfies GitLabTransport;
  const source = createGitLabArtifactSource({
    maxBlobArtifactBytes: 2,
    project,
    projectPath: 'group/project',
    transport,
  });

  await expect(source.readBlobs([objectId], new AbortController().signal)).resolves.toEqual(
    new Map(),
  );
  expect(requestedMaxBytes).toBe(2);
});

test('normalizes GitLab range artifact patches into renderer-parseable unified diffs', () => {
  const baseSha = gitSha('a'.repeat(40));
  const headSha = gitSha('b'.repeat(40));
  const range = createGitLabRangeArtifact({
    baseSha,
    diffs: [
      {
        diff: '@@ -1 +1 @@\n-old\n+new\n',
        new_path: 'src/app.ts',
        old_path: 'src/app.ts',
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

test('orders historical commits by topology and provider timestamps', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const headSha = gitSha('b'.repeat(40));
  const earlierSha = gitSha('c'.repeat(40));
  const laterSha = gitSha('d'.repeat(40));
  const transport = createFakeGitLabTransport([
    {
      path: '/api/v4/projects/group%2Fproject/repository/compare',
      query: { from: baseSha, straight: 'true', to: headSha },
      response: {
        commits: [
          {
            authored_date: '2026-01-02T00:00:00.000Z',
            id: laterSha,
            message: 'Add response parsing',
            parent_ids: [baseSha],
            short_id: laterSha.slice(0, 8),
            title: 'Add response parsing',
          },
          {
            authored_date: '2026-01-01T00:00:00.000Z',
            id: earlierSha,
            message: 'Add request parsing',
            parent_ids: [baseSha],
            short_id: earlierSha.slice(0, 8),
            title: 'Add request parsing',
          },
        ],
      },
    },
  ]);

  const commits = await fetchGitLabHistoricalCommitStack({
    baseSha,
    headSha,
    projectPath: 'group/project',
    transport,
  });

  expect(commits.map((commit) => commit.sha)).toEqual([earlierSha, laterSha]);
});

test('orders merge request and historical merge commits parent-before-child', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const firstSha = gitSha('b'.repeat(40));
  const branchSha = gitSha('c'.repeat(40));
  const mergeSha = gitSha('d'.repeat(40));
  const rawCommits = [
    {
      authored_date: '2026-01-03T00:00:00.000Z',
      id: mergeSha,
      parent_ids: [firstSha, branchSha],
      title: 'Merge both changes',
    },
    {
      authored_date: '2026-01-02T00:00:00.000Z',
      id: branchSha,
      parent_ids: [baseSha],
      title: 'Add branch change',
    },
    {
      authored_date: '2026-01-01T00:00:00.000Z',
      id: firstSha,
      parent_ids: [baseSha],
      title: 'Add first change',
    },
  ];
  const transport = createFakeGitLabTransport([
    {
      path: '/api/v4/projects/group%2Fproject/merge_requests/7/commits',
      response: rawCommits,
    },
    {
      path: '/api/v4/projects/group%2Fproject/repository/compare',
      query: { from: baseSha, straight: 'true', to: mergeSha },
      response: { commits: rawCommits },
    },
  ]);

  const current = await fetchGitLabMergeRequestCommits({
    iid: 7,
    projectPath: 'group/project',
    transport,
  });
  const historical = await fetchGitLabHistoricalCommitStack({
    baseSha,
    headSha: mergeSha,
    projectPath: 'group/project',
    transport,
  });

  expect(current.map(({ sha }) => sha)).toEqual([firstSha, branchSha, mergeSha]);
  expect(historical.map(({ sha }) => sha)).toEqual([firstSha, branchSha, mergeSha]);
});

test('prefers one bulk local evidence read for evolution classification', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const oldHeadSha = gitSha('b'.repeat(40));
  const newHeadSha = gitSha('c'.repeat(40));
  const oldCommitSha = gitSha('d'.repeat(40));
  const newCommitSha = gitSha('e'.repeat(40));
  const oldCommit = historyCommit(oldCommitSha, baseSha);
  const newCommit = historyCommit(newCommitSha, baseSha);
  const changedFiles = [
    {
      fingerprint: 'src/app.ts',
      path: 'src/app.ts',
      sections: [
        {
          binary: false,
          id: 'src/app.ts:commit:0',
          kind: 'commit' as const,
          patch: '@@ -1 +1 @@\n-old\n+new\n',
        },
      ],
      status: 'modified' as const,
    },
  ];
  const transport = createFakeGitLabTransport([]);
  const stackReads: Array<string> = [];
  const diffReads: Array<string> = [];

  const evolution = await fetchGitLabMergeRequestVersionCommitEvolution({
    from: { baseSha, headSha: oldHeadSha, kind: 'diff-identity', startSha: baseSha },
    iid: 7,
    project,
    projectPath: 'group/project',
    readers: {
      readCommitArtifacts: async (commits) => {
        diffReads.push(...commits.map(({ commitSha }) => commitSha));
        return new Map(
          commits.map(({ commitSha, parentSha }) => [
            commitSha,
            commitArtifact(commitSha, changedFiles, parentSha),
          ]),
        );
      },
      readCommitStack: async (_base, head) => {
        stackReads.push(head);
        return head === oldHeadSha ? [oldCommit] : [newCommit];
      },
    },
    to: { baseSha, headSha: newHeadSha, kind: 'diff-identity', startSha: baseSha },
    transport,
  });

  expect(evolution.units).toHaveLength(1);
  expect(stackReads).toEqual([oldHeadSha, newHeadSha]);
  expect(diffReads).toEqual([oldCommitSha, newCommitSha]);
  expect(transport.calls).toEqual([]);
});

test('keeps bounded host Commit Artifacts inside their authoritative source', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const oldHeadSha = gitSha('b'.repeat(40));
  const newHeadSha = gitSha('c'.repeat(40));
  const oldCommitSha = gitSha('d'.repeat(40));
  const newCommitSha = gitSha('e'.repeat(40));
  const oldCommit = historyCommit(oldCommitSha, baseSha);
  const newCommit = historyCommit(newCommitSha, baseSha);
  const nativeProvenance: ReviewArtifactProvenance = { kind: 'native-git', project };
  const truncatedArtifact = (commitSha: GitSha, parentSha: GitSha) => ({
    commitSha,
    coverage: 'truncated' as const,
    files: [
      {
        coverage: 'truncated' as const,
        path: 'src/app.ts',
        status: 'modified' as const,
      },
    ],
    parentSha,
    provenance: nativeProvenance,
  });
  const transport = createFakeGitLabTransport([]);

  const evolution = await fetchGitLabMergeRequestVersionCommitEvolution({
    from: { baseSha, headSha: oldHeadSha, kind: 'diff-identity', startSha: baseSha },
    iid: 7,
    project,
    projectPath: 'group/project',
    readers: {
      readCommitArtifacts: async (commits) =>
        new Map(
          commits.map(({ commitSha, parentSha }) => [
            commitSha,
            truncatedArtifact(commitSha, parentSha ?? baseSha),
          ]),
        ),
      readCommitStack: async (_base, head) => (head === oldHeadSha ? [oldCommit] : [newCommit]),
    },
    to: { baseSha, headSha: newHeadSha, kind: 'diff-identity', startSha: baseSha },
    transport,
  });

  expect(evolution.units).toHaveLength(1);
  expect(transport.calls).toEqual([]);
});

test('normalizes complete local stacks before keeping the latest evolution window', async () => {
  const baseSha = gitSha('f'.repeat(40));
  const oldHeadSha = gitSha('a'.repeat(40));
  const newHeadSha = gitSha('b'.repeat(40));
  const commits = Array.from({ length: 42 }, (_, index) => {
    const sha = gitSha(String(index + 1).padStart(40, '0'));
    const parentSha = index === 0 ? baseSha : gitSha(String(index).padStart(40, '0'));
    return {
      ...historyCommit(sha, parentSha),
      authoredDate: `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`,
      committedDate: `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`,
    };
  });

  const evolution = await fetchGitLabMergeRequestVersionCommitEvolution({
    from: { baseSha, headSha: oldHeadSha, kind: 'diff-identity', startSha: baseSha },
    iid: 7,
    project,
    projectPath: 'group/project',
    readers: {
      readCommitStack: async () => commits.toReversed(),
    },
    to: { baseSha, headSha: newHeadSha, kind: 'diff-identity', startSha: baseSha },
    transport: createFakeGitLabTransport([]),
  });

  expect(evolution.units).toHaveLength(40);
  expect(evolution.units[0]?.after?.sha).toBe(String(3).padStart(40, '0'));
  expect(evolution.units.at(-1)?.after?.sha).toBe(String(42).padStart(40, '0'));
  expect(evolution.warnings).toEqual(
    expect.arrayContaining([expect.stringContaining('latest 40 commits')]),
  );
});

test('skips moved-base reads when MR commits pair and reports named phases', async () => {
  const oldBaseSha = gitSha('a'.repeat(40));
  const newBaseSha = gitSha('b'.repeat(40));
  const headSha = gitSha('c'.repeat(40));
  const sharedCommit = historyCommit(headSha, oldBaseSha);
  const stackReads: Array<readonly [GitSha, GitSha]> = [];
  const evidenceReads: Array<GitSha> = [];
  const progress: Array<{ message: string; phase: string }> = [];
  const matcherDiagnostics = vi.fn();

  const evolution = await fetchGitLabMergeRequestVersionCommitEvolution({
    control: {
      onMatcherDiagnostics: matcherDiagnostics,
      onProgress: (event) => progress.push(event),
    },
    from: { baseSha: oldBaseSha, headSha, kind: 'diff-identity', startSha: oldBaseSha },
    iid: 7,
    project,
    projectPath: 'group/project',
    readers: {
      readCommitArtifacts: async (commits) => {
        evidenceReads.push(...commits.map(({ commitSha }) => commitSha));
        return new Map();
      },
      readCommitStack: async (base, head) => {
        stackReads.push([base, head]);
        return [sharedCommit];
      },
    },
    to: { baseSha: newBaseSha, headSha, kind: 'diff-identity', startSha: newBaseSha },
    transport: createFakeGitLabTransport([]),
  });

  expect(evolution.summary.retained).toBe(1);
  expect(stackReads).toEqual([
    [oldBaseSha, headSha],
    [newBaseSha, headSha],
  ]);
  expect(evidenceReads).toEqual([]);
  expect(progress.map(({ phase }) => phase)).toEqual([
    'reading-stacks',
    'reading-mr-evidence',
    'reading-mr-evidence',
    'composing-units',
  ]);
  expect(progress.at(-1)?.message).toBe('Composing Evolution Units');
  expect(matcherDiagnostics).toHaveBeenCalledWith(
    expect.objectContaining({
      ambiguousUnitCount: 0,
      primaryAssignment: null,
      targetBaseAssignment: null,
    }),
  );
});

test('cancels the single bulk evidence read for a superseded evolution', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const oldHeadSha = gitSha('b'.repeat(40));
  const newHeadSha = gitSha('c'.repeat(40));
  const oldCommits = Array.from({ length: 6 }, (_, index) =>
    historyCommit(gitSha(`${index + 1}`.repeat(40)), baseSha),
  );
  const newCommits = Array.from({ length: 6 }, (_, index) =>
    historyCommit(gitSha(String.fromCharCode(100 + index).repeat(40)), baseSha),
  );
  const controller = new AbortController();
  let evidenceReads = 0;

  await expect(
    fetchGitLabMergeRequestVersionCommitEvolution({
      control: { signal: controller.signal },
      from: { baseSha, headSha: oldHeadSha, kind: 'diff-identity', startSha: baseSha },
      iid: 7,
      project,
      projectPath: 'group/project',
      readers: {
        readCommitArtifacts: async () => {
          evidenceReads += 1;
          controller.abort();
          return new Map();
        },
        readCommitStack: async (_base, head) => (head === oldHeadSha ? oldCommits : newCommits),
      },
      to: { baseSha, headSha: newHeadSha, kind: 'diff-identity', startSha: baseSha },
      transport: createFakeGitLabTransport([]),
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });

  expect(evidenceReads).toBe(1);
});

test('loads merge request versions through the injected transport', async () => {
  const transport = createFakeGitLabTransport([
    {
      path: '/api/v4/projects/group%2Fproject/merge_requests/7/versions',
      response: [
        {
          base_commit_sha: 'a'.repeat(40),
          created_at: '2026-01-02T00:00:00.000Z',
          head_commit_sha: 'b'.repeat(40),
          id: 2,
          start_commit_sha: 'a'.repeat(40),
        },
        {
          base_commit_sha: 'a'.repeat(40),
          created_at: '2026-01-01T00:00:00.000Z',
          head_commit_sha: 'c'.repeat(40),
          id: 1,
          start_commit_sha: 'a'.repeat(40),
        },
      ],
    },
  ]);

  const timeline = await fetchGitLabReviewVersionTimeline({
    iid: 7,
    projectPath: 'group/project',
    transport,
  });
  const versions = await fetchGitLabMergeRequestVersions({
    iid: 7,
    projectPath: 'group/project',
    transport,
  });

  expect(timeline.map((version) => version.versionId)).toEqual(['1', '2']);
  expect(timeline.map((version) => version.label)).toEqual([
    expect.stringContaining('v1'),
    expect.stringContaining('v2'),
  ]);
  expect(versions).toHaveLength(2);
  expect(versions[0]?.versionId).toBe('2');
  expect(versions[0]?.label).toContain('v2');
  expect(toGitLabDiffIdentity(versions[0]!).headSha).toBe('b'.repeat(40));
  expect(transport.calls[0]?.path).toContain('/merge_requests/7/versions');
});

test('attributes authenticated comments and approval notes to review versions', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const firstHead = gitSha('b'.repeat(40));
  const secondHead = gitSha('c'.repeat(40));
  const transport = createFakeGitLabTransport([
    { path: '/api/v4/user', response: { id: 9, username: 'reviewer' } },
    {
      path: '/api/v4/projects/group%2Fproject/merge_requests/7/versions',
      response: [
        {
          base_commit_sha: baseSha,
          created_at: '2026-01-02T00:00:00.000Z',
          head_commit_sha: secondHead,
          id: 2,
          start_commit_sha: baseSha,
        },
        {
          base_commit_sha: baseSha,
          created_at: '2026-01-01T00:00:00.000Z',
          head_commit_sha: firstHead,
          id: 1,
          start_commit_sha: baseSha,
        },
      ],
    },
    {
      path: '/api/v4/projects/group%2Fproject/merge_requests/7/discussions',
      response: [
        {
          notes: [
            {
              author: { id: 9 },
              body: 'Please adjust this.',
              created_at: '2026-01-01T12:00:00.000Z',
              id: 41,
              position: { head_sha: firstHead },
            },
          ],
        },
      ],
    },
    {
      path: '/api/v4/projects/group%2Fproject/merge_requests/7/notes',
      response: [
        {
          author: { id: 9 },
          body: 'approved this merge request',
          created_at: '2026-01-02T12:00:00.000Z',
          id: 42,
          system: true,
        },
      ],
    },
  ]);

  const activity = await fetchGitLabMergeRequestReviewerActivity({
    iid: 7,
    projectPath: 'group/project',
    transport,
  });

  expect(activity.get(reviewVersionId('1'))?.reasons).toEqual([
    { kind: 'comment', occurredAt: '2026-01-01T12:00:00.000Z' },
  ]);
  expect(activity.get(reviewVersionId('2'))?.reasons).toEqual([
    { kind: 'approval', occurredAt: '2026-01-02T12:00:00.000Z' },
  ]);
  expect(
    transport.calls
      .filter(
        (call) =>
          call.path === '/api/v4/user' ||
          call.path.endsWith('/discussions') ||
          call.path.endsWith('/notes'),
      )
      .every((call) => call.maxBytes === 2 * 1024 * 1024),
  ).toBe(true);
});

test('keeps available GitLab reviewer activity when one optional feed fails', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const headSha = gitSha('b'.repeat(40));
  const transport = createFakeGitLabTransport([
    { path: '/api/v4/user', response: { id: 9, username: 'reviewer' } },
    {
      path: '/api/v4/projects/group%2Fproject/merge_requests/7/discussions',
      response: () => {
        throw new Error('ProviderOutputLimitError');
      },
    },
    {
      path: '/api/v4/projects/group%2Fproject/merge_requests/7/notes',
      response: [
        {
          author: { id: 9 },
          body: 'approved this merge request',
          created_at: '2026-01-02T12:00:00.000Z',
          id: 42,
          system: true,
        },
      ],
    },
  ]);

  const activity = await fetchGitLabMergeRequestReviewerActivity({
    iid: 7,
    projectPath: 'group/project',
    transport,
    versions: [
      {
        baseSha,
        createdAt: '2026-01-01T00:00:00.000Z',
        headSha,
        label: 'v1',
        startSha: baseSha,
        versionId: reviewVersionId('1'),
      },
    ],
  });

  expect(activity.get(reviewVersionId('1'))?.reasons).toEqual([
    { kind: 'approval', occurredAt: '2026-01-02T12:00:00.000Z' },
  ]);
});

test('reuses supplied versions and cached fingerprints for independent evolution loading', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const oldHead = gitSha('b'.repeat(40));
  const newHead = gitSha('c'.repeat(40));
  const oldCommit = gitSha('d'.repeat(40));
  const newCommit = gitSha('e'.repeat(40));
  const versions = [
    {
      baseSha,
      createdAt: '2026-01-02T00:00:00.000Z',
      headSha: newHead,
      label: 'v2',
      startSha: baseSha,
      versionId: reviewVersionId('2'),
    },
    {
      baseSha,
      createdAt: '2026-01-01T00:00:00.000Z',
      headSha: oldHead,
      label: 'v1',
      startSha: baseSha,
      versionId: reviewVersionId('1'),
    },
  ];
  const commitResponse = (sha: GitSha, title: string) => ({
    commits: [
      {
        authored_date: '2026-01-01T00:00:00.000Z',
        committed_date: '2026-01-01T00:00:00.000Z',
        id: sha,
        message: title,
        parent_ids: [baseSha],
        short_id: sha.slice(0, 8),
        title,
      },
    ],
  });
  const transport = createFakeGitLabTransport([
    {
      path: '/api/v4/projects/group%2Fproject/repository/compare',
      query: { from: baseSha, straight: 'true', to: oldHead },
      response: commitResponse(oldCommit, 'Update request handling'),
    },
    {
      path: '/api/v4/projects/group%2Fproject/repository/compare',
      query: { from: baseSha, straight: 'true', to: newHead },
      response: commitResponse(newCommit, 'Update request handling'),
    },
    {
      path: `/api/v4/projects/group%2Fproject/repository/commits/${oldCommit}/diff`,
      response: [
        {
          diff: '@@ -1 +1 @@\n-old\n+new\n',
          new_path: 'src/request.ts',
          old_path: 'src/request.ts',
        },
      ],
    },
    {
      path: `/api/v4/projects/group%2Fproject/repository/commits/${newCommit}/diff`,
      response: [
        {
          diff: '@@ -1 +1 @@\n-old\n+new\n',
          new_path: 'src/request.ts',
          old_path: 'src/request.ts',
        },
      ],
    },
  ]);
  const fingerprints = new Map<GitSha, Awaited<ReturnType<typeof createCommitFingerprint>>>();
  const cache = {
    read: async (shas: ReadonlyArray<GitSha>) =>
      new Map(
        shas
          .map((sha) => [sha, fingerprints.get(sha)] as const)
          .filter(
            (
              entry,
            ): entry is readonly [GitSha, Awaited<ReturnType<typeof createCommitFingerprint>>] =>
              entry[1] != null,
          ),
      ),
    write: async (values: ReadonlyArray<Awaited<ReturnType<typeof createCommitFingerprint>>>) => {
      for (const fingerprint of values) {
        fingerprints.set(fingerprint.commitSha, fingerprint);
      }
    },
  };
  const input = {
    cache,
    from: { kind: 'mr-version' as const, versionId: reviewVersionId('1') },
    iid: 7,
    project,
    projectPath: 'group/project',
    to: { kind: 'mr-version' as const, versionId: reviewVersionId('2') },
    transport,
    versions,
  };

  await fetchGitLabMergeRequestVersionCommitEvolution(input);
  await fetchGitLabMergeRequestVersionCommitEvolution(input);

  expect(transport.calls.filter((call) => call.path.endsWith('/versions'))).toHaveLength(0);
  expect(transport.calls.filter((call) => call.path.endsWith('/diff'))).toHaveLength(2);
});

test('uses paginated discussion anchors for replies with an original root position', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const commentHeadSha = gitSha('b'.repeat(40));
  const latestHeadSha = gitSha('c'.repeat(40));
  const transport = createFakeGitLabTransport([
    {
      path: '/api/v4/projects/group%2Fproject/merge_requests/7/versions',
      response: [
        {
          base_commit_sha: baseSha,
          created_at: '2026-01-02T00:00:00.000Z',
          head_commit_sha: latestHeadSha,
          id: 2,
          start_commit_sha: baseSha,
        },
        {
          base_commit_sha: baseSha,
          created_at: '2026-01-01T00:00:00.000Z',
          head_commit_sha: commentHeadSha,
          id: 1,
          start_commit_sha: baseSha,
        },
      ],
    },
    {
      path: '/api/v4/projects/group%2Fproject/merge_requests/7/discussions',
      response: [
        {
          notes: [
            {
              id: 42,
              original_position: {
                base_sha: baseSha,
                head_sha: commentHeadSha,
                new_line: 1,
                new_path: 'src/app.ts',
                start_sha: baseSha,
              },
            },
            { id: 43, in_reply_to_id: 42 },
          ],
        },
      ],
    },
    {
      path: '/api/v4/projects/group%2Fproject/merge_requests/7/versions/1',
      response: { diffs: [] },
    },
    {
      path: '/api/v4/projects/group%2Fproject/merge_requests/7/versions/2',
      response: { diffs: [] },
    },
  ]);

  const comparison = await fetchGitLabMergeRequestVersionCompare({
    comments: [
      {
        commentId: 'gitlab:7',
        filePath: 'src/unrelated.ts',
        position: { baseSha, headSha: latestHeadSha, startSha: baseSha },
      },
    ],
    from: { commentId: 'gitlab:43', kind: 'comment-position' },
    iid: 7,
    projectPath: 'group/project',
    to: { kind: 'mr-version', versionId: reviewVersionId('2') },
    transport,
  });

  expect(comparison.range.from.headSha).toBe(commentHeadSha);
  expect(transport.calls.some((call) => call.path.endsWith('/merge_requests/7/discussions'))).toBe(
    true,
  );
  expect(
    transport.calls.some(
      (call) =>
        call.path.endsWith('/merge_requests/7/discussions') &&
        call.query?.page === 1 &&
        call.query?.per_page === 100,
    ),
  ).toBe(true);
});

test('uses host Range Artifacts without provider diff or raw-file requests', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const fromHeadSha = gitSha('b'.repeat(40));
  const toHeadSha = gitSha('c'.repeat(40));
  const versions = [
    {
      baseSha,
      createdAt: '2026-01-01T00:00:00.000Z',
      headSha: fromHeadSha,
      label: 'v1',
      startSha: baseSha,
      versionId: reviewVersionId('1'),
    },
    {
      baseSha,
      createdAt: '2026-01-02T00:00:00.000Z',
      headSha: toHeadSha,
      label: 'v2',
      startSha: baseSha,
      versionId: reviewVersionId('2'),
    },
  ];
  const transport = createFakeGitLabTransport([]);
  const readBlob = vi.fn(async () => null);
  const readRangeFiles = vi.fn(async (_baseSha: GitSha, headSha: GitSha) => [
    {
      newPath: 'src/app.ts',
      oldPath: 'src/app.ts',
      patchBody: headSha === fromHeadSha ? '@@ -1 +1 @@\n-base\n+old' : '@@ -1 +1 @@\n-base\n+new',
      status: 'modified' as const,
    },
  ]);

  const comparison = await fetchGitLabMergeRequestVersionCompare({
    comments: [
      {
        commentId: 'gitlab:1',
        filePath: 'src/app.ts',
        position: { baseSha, headSha: fromHeadSha, startSha: baseSha },
      },
    ],
    from: { kind: 'mr-version', versionId: reviewVersionId('1') },
    iid: 7,
    projectPath: 'group/project',
    readBlob,
    readRangeFiles,
    to: { kind: 'mr-version', versionId: reviewVersionId('2') },
    transport,
    versions,
  });

  expect(comparison.files).toHaveLength(1);
  expect(readRangeFiles).toHaveBeenCalledTimes(2);
  expect(readBlob).toHaveBeenCalled();
  expect(transport.calls).toEqual([]);

  const view = projectVersionCompare(comparison);
  expect(view.files[0]?.regionalReplay).toEqual(comparison.files[0]?.projection);
});

test('uses one host replay-evidence batch instead of serial raw-file reads', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const fromHeadSha = gitSha('b'.repeat(40));
  const toHeadSha = gitSha('c'.repeat(40));
  const versions = [
    {
      baseSha,
      createdAt: '2026-01-01T00:00:00.000Z',
      headSha: fromHeadSha,
      label: 'v1',
      startSha: baseSha,
      versionId: reviewVersionId('1'),
    },
    {
      baseSha,
      createdAt: '2026-01-02T00:00:00.000Z',
      headSha: toHeadSha,
      label: 'v2',
      startSha: baseSha,
      versionId: reviewVersionId('2'),
    },
  ];
  const contents = new Map<string, string>([
    [`${baseSha}:src/app.ts`, 'base\n'],
    [`${fromHeadSha}:src/app.ts`, 'old\n'],
    [`${toHeadSha}:src/app.ts`, 'new\n'],
  ]);
  const readBlob = vi.fn(async () => {
    throw new Error('A batch-capable host must not issue serial raw-file reads.');
  });
  const readBlobs = vi.fn(
    async (requests: ReadonlyArray<{ path: string; ref: string }>) =>
      new Map(
        requests.map((request) => [
          `${request.ref}:${request.path}`,
          contents.get(`${request.ref}:${request.path}`) ?? null,
        ]),
      ),
  );
  const onReplayDiagnostics = vi.fn();
  const readRangeFiles = vi.fn(async (_baseSha: GitSha, headSha: GitSha) => [
    {
      newPath: 'src/app.ts',
      oldPath: 'src/app.ts',
      patchBody: headSha === fromHeadSha ? '@@ -1 +1 @@\n-base\n+old' : '@@ -1 +1 @@\n-base\n+new',
      status: 'modified' as const,
    },
  ]);

  const comparison = await fetchGitLabMergeRequestVersionCompare({
    from: { kind: 'mr-version', versionId: reviewVersionId('1') },
    iid: 7,
    onReplayDiagnostics,
    projectPath: 'group/project',
    readBlob,
    readBlobs,
    readRangeFiles,
    to: { kind: 'mr-version', versionId: reviewVersionId('2') },
    transport: createFakeGitLabTransport([]),
    versions,
  });

  expect(comparison.files).toHaveLength(1);
  expect(readRangeFiles).toHaveBeenCalledTimes(2);
  expect(readBlobs).toHaveBeenCalledTimes(1);
  expect(readBlob).not.toHaveBeenCalled();
  expect(onReplayDiagnostics).toHaveBeenCalledWith(
    expect.objectContaining({
      evidence: expect.objectContaining({ requested: 3 }),
      projection: expect.objectContaining({ attemptedPairs: 1, renderedFiles: 1 }),
    }),
  );
});

test('does not retry an unavailable authoritative host Range Artifact', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const fromHeadSha = gitSha('b'.repeat(40));
  const toHeadSha = gitSha('c'.repeat(40));
  const versions = [
    {
      baseSha,
      createdAt: '2026-01-01T00:00:00.000Z',
      headSha: fromHeadSha,
      label: 'v1',
      startSha: baseSha,
      versionId: reviewVersionId('1'),
    },
    {
      baseSha,
      createdAt: '2026-01-02T00:00:00.000Z',
      headSha: toHeadSha,
      label: 'v2',
      startSha: baseSha,
      versionId: reviewVersionId('2'),
    },
  ];
  const transport = createFakeGitLabTransport([
    {
      path: '/api/v4/projects/group%2Fproject/merge_requests/7/versions',
      response: versions.toReversed().map((version) => ({
        base_commit_sha: version.baseSha,
        created_at: version.createdAt,
        head_commit_sha: version.headSha,
        id: Number(version.versionId),
        start_commit_sha: version.startSha,
      })),
    },
    ...versions.map((version) => ({
      path: `/api/v4/projects/group%2Fproject/merge_requests/7/versions/${version.versionId}`,
      response: {
        diffs: [
          {
            diff:
              version.headSha === fromHeadSha
                ? '@@ -1 +1 @@\n-base\n+old'
                : '@@ -1 +1 @@\n-base\n+new',
            new_path: 'src/app.ts',
            old_path: 'src/app.ts',
          },
        ],
      },
    })),
  ]);
  const readRangeFiles = vi.fn(async () => {
    throw new Error('Historical head is not available locally.');
  });

  await expect(
    fetchGitLabMergeRequestVersionCompare({
      comments: [
        {
          commentId: 'gitlab:1',
          filePath: 'src/app.ts',
          position: { baseSha, headSha: fromHeadSha, startSha: baseSha },
        },
      ],
      from: { kind: 'mr-version', versionId: reviewVersionId('1') },
      iid: 7,
      projectPath: 'group/project',
      readBlob: async () => null,
      readRangeFiles,
      to: { kind: 'mr-version', versionId: reviewVersionId('2') },
      transport,
      versions,
    }),
  ).rejects.toThrow('Historical head is not available locally.');
  expect(readRangeFiles).toHaveBeenCalledTimes(2);
  expect(transport.calls).toEqual([]);
});

test('preserves incomplete host Range Artifacts without a second provider read', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const fromHeadSha = gitSha('b'.repeat(40));
  const toHeadSha = gitSha('c'.repeat(40));
  const versions = [
    {
      baseSha,
      createdAt: '2026-01-01T00:00:00.000Z',
      headSha: fromHeadSha,
      label: 'v1',
      startSha: baseSha,
      versionId: reviewVersionId('1'),
    },
    {
      baseSha,
      createdAt: '2026-01-02T00:00:00.000Z',
      headSha: toHeadSha,
      label: 'v2',
      startSha: baseSha,
      versionId: reviewVersionId('2'),
    },
  ];
  const transport = createFakeGitLabTransport(
    versions.map((version) => ({
      path: `/api/v4/projects/group%2Fproject/merge_requests/7/versions/${version.versionId}`,
      response: {
        diffs: [
          {
            diff:
              version.headSha === fromHeadSha
                ? '@@ -1 +1 @@\n-base\n+provider-old'
                : '@@ -1 +1 @@\n-base\n+provider-new',
            new_path: 'src/app.ts',
            old_path: 'src/app.ts',
          },
        ],
      },
    })),
  );
  const readRangeFiles = vi.fn(async () => ({
    coverage: 'truncated' as const,
    files: [
      {
        coverage: 'complete' as const,
        newPath: 'src/app.ts',
        oldPath: 'src/app.ts',
        patchBody: '@@ -1 +1 @@\n-base\n+local-prefix',
        status: 'modified' as const,
      },
    ],
  }));

  const comparison = await fetchGitLabMergeRequestVersionCompare({
    comments: [
      {
        commentId: 'gitlab:1',
        filePath: 'src/app.ts',
        position: { baseSha, headSha: fromHeadSha, startSha: baseSha },
      },
    ],
    from: { kind: 'mr-version', versionId: reviewVersionId('1') },
    iid: 7,
    projectPath: 'group/project',
    readBlob: async () => null,
    readRangeFiles,
    to: { kind: 'mr-version', versionId: reviewVersionId('2') },
    transport,
    versions,
  });

  expect(comparison.files).toHaveLength(1);
  expect(readRangeFiles).toHaveBeenCalledTimes(2);
  expect(transport.calls).toEqual([]);
});

test('uses GitLab version object IDs to avoid materializing matching modified heads', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const fromHeadSha = gitSha('b'.repeat(40));
  const toHeadSha = gitSha('c'.repeat(40));
  const finalObjectId = 'd'.repeat(40);
  const versions = [
    {
      baseSha,
      createdAt: '2026-01-01T00:00:00.000Z',
      headSha: fromHeadSha,
      label: 'v1',
      startSha: baseSha,
      versionId: reviewVersionId('1'),
    },
    {
      baseSha,
      createdAt: '2026-01-02T00:00:00.000Z',
      headSha: toHeadSha,
      label: 'v2',
      startSha: baseSha,
      versionId: reviewVersionId('2'),
    },
  ];
  const transport = createFakeGitLabTransport([
    {
      path: '/api/v4/projects/group%2Fproject/merge_requests/7/versions/1',
      response: {
        diffs: [
          {
            diff: '@@ -1 +1 @@\n-base\n+final\n',
            new_id: finalObjectId,
            new_path: 'src/app.ts',
            old_id: 'e'.repeat(40),
            old_path: 'src/app.ts',
          },
        ],
      },
    },
    {
      path: '/api/v4/projects/group%2Fproject/merge_requests/7/versions/2',
      response: {
        diffs: [
          {
            diff: '@@ -1 +1 @@\n-updated base\n+final\n',
            new_id: finalObjectId,
            new_path: 'src/app.ts',
            old_id: 'f'.repeat(40),
            old_path: 'src/app.ts',
          },
        ],
      },
    },
  ]);
  const readBlob = vi.fn(async () => {
    throw new Error('Equal complete GitLab version objects must not read raw files.');
  });

  const comparison = await fetchGitLabMergeRequestVersionCompare({
    comments: [
      {
        commentId: 'gitlab:1',
        filePath: 'src/app.ts',
        position: { baseSha, headSha: fromHeadSha, startSha: baseSha },
      },
    ],
    from: { kind: 'mr-version', versionId: reviewVersionId('1') },
    iid: 7,
    projectPath: 'group/project',
    readBlob,
    to: { kind: 'mr-version', versionId: reviewVersionId('2') },
    transport,
    versions,
  });

  expect(comparison.files).toEqual([]);
  expect(readBlob).not.toHaveBeenCalled();
  expect(transport.calls.map((call) => call.path)).toEqual([
    '/api/v4/projects/group%2Fproject/merge_requests/7/versions/1',
    '/api/v4/projects/group%2Fproject/merge_requests/7/versions/2',
  ]);
});

test('projects algorithm evolution into Core review plans', async () => {
  const from = {
    baseSha: gitSha('a'.repeat(40)),
    createdAt: '2026-01-01T00:00:00.000Z',
    headSha: gitSha('b'.repeat(40)),
    label: 'v1',
    startSha: gitSha('a'.repeat(40)),
    versionId: reviewVersionId('1'),
  };
  const to = {
    baseSha: gitSha('a'.repeat(40)),
    createdAt: '2026-01-02T00:00:00.000Z',
    headSha: gitSha('c'.repeat(40)),
    label: 'v2',
    startSha: gitSha('a'.repeat(40)),
    versionId: reviewVersionId('2'),
  };
  const oldCommit = {
    authoredDate: '2026-01-01T00:00:00.000Z',
    authorName: 'Ada',
    message: 'feat: one\n',
    parentShas: [from.baseSha],
    sha: gitSha('d'.repeat(40)),
    shortSha: 'ddddddd',
    title: 'feat: one',
    webUrl: 'https://example.test/d',
  };
  const newCommit = {
    ...oldCommit,
    sha: gitSha('e'.repeat(40)),
    shortSha: 'eeeeeee',
  };
  const files = [
    {
      fingerprint: 'f',
      path: 'a.ts',
      sections: [
        {
          binary: false,
          id: 'a.ts:commit:1',
          kind: 'commit' as const,
          patch: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
        },
      ],
      status: 'modified' as const,
    },
  ];
  const oldFingerprint = await createCommitFingerprint(
    oldCommit,
    commitArtifact(oldCommit.sha, files, oldCommit.parentShas[0] ?? null),
  );
  const newFingerprint = await createCommitFingerprint(
    newCommit,
    commitArtifact(newCommit.sha, files, newCommit.parentShas[0] ?? null),
  );
  const evolution = await matchVersionCommitStacks({
    fingerprints: new Map([
      [oldCommit.sha, oldFingerprint],
      [newCommit.sha, newFingerprint],
    ]),
    from,
    newCommits: [newCommit],
    oldCommits: [oldCommit],
    to,
  });
  const projected = projectCommitEvolution(evolution);
  expect(
    projected.units.some(
      (unit) =>
        unit.kind === 'revised' || unit.kind === 'rewritten-same-patch' || unit.kind === 'retained',
    ),
  ).toBe(true);
  const plan = projectReviewPlan({ evolution, structure: 'auto' });
  expect(plan.structure === 'complete-comparison' || plan.structure === 'commit-evolution').toBe(
    true,
  );
});

test('adds the comparison target range only to addressable evolution units', async () => {
  const baseSha = gitSha('a'.repeat(40));
  const headSha = gitSha('b'.repeat(40));
  const targetRange = {
    base: {
      kind: 'commit' as const,
      label: { kind: 'version' as const, text: 'v1' },
      sha: baseSha,
    },
    head: {
      kind: 'commit' as const,
      label: { kind: 'version' as const, text: 'v2' },
      sha: headSha,
    },
  };
  const after = {
    authoredAt: '2026-01-02T00:00:00.000Z',
    authorName: 'Ada',
    parentShas: [baseSha],
    sha: headSha,
    shortSha: 'bbbbbbb',
    subject: 'Add target',
    webUrl: `https://gitlab.example/commit/${headSha}`,
  };
  const before = { ...after, sha: gitSha('c'.repeat(40)), shortSha: 'ccccccc' };
  const transport = createFakeGitLabTransport([
    {
      path: `/api/v4/projects/group%2Fproject/repository/commits/${headSha}/diff`,
      response: [
        {
          diff: '@@ -0,0 +1 @@\n+target\n',
          new_file: true,
          new_path: 'src/target.ts',
          old_path: 'src/target.ts',
        },
      ],
    },
    {
      path: `/api/v4/projects/group%2Fproject/repository/compare`,
      query: { from: before.sha, straight: 'true', to: baseSha },
      response: {
        diffs: [
          {
            deleted_file: true,
            diff: '@@ -1 +0,0 @@\n-removed\n',
            new_path: 'src/removed.ts',
            old_path: 'src/removed.ts',
          },
        ],
      },
    },
  ]);

  const introduced = await fetchGitLabVersionCommitUnitDiff({
    projectPath: 'group/project',
    targetRange,
    transport,
    unit: {
      after,
      confidence: 'exact',
      kind: 'added',
      order: 0,
      reviewable: true,
      unitId: evolutionUnitId('introduced'),
    },
  });
  const removed = await fetchGitLabVersionCommitUnitDiff({
    projectPath: 'group/project',
    targetRange,
    transport,
    unit: {
      before,
      confidence: 'exact',
      kind: 'removed',
      order: 1,
      reviewable: true,
      unitId: evolutionUnitId('removed'),
    },
  });

  expect(introduced[0]?.sections[0]?.range).toEqual(targetRange);
  expect(removed[0]?.sections[0]?.range).toBeUndefined();
});

test('uses local commit and reverse-range diffs for evolution units', async () => {
  const parentSha = gitSha('a'.repeat(40));
  const commitSha = gitSha('b'.repeat(40));
  const commit = {
    authoredAt: '2026-01-02T00:00:00.000Z',
    authorName: 'Ada',
    parentShas: [parentSha],
    sha: commitSha,
    shortSha: commitSha.slice(0, 7),
    subject: 'Change target',
    webUrl: `https://gitlab.example/commit/${commitSha}`,
  };
  const localFiles = [
    {
      fingerprint: 'src/local.ts',
      path: 'src/local.ts',
      sections: [
        {
          binary: false,
          id: 'src/local.ts:commit:0',
          kind: 'commit' as const,
          patch: '@@ -1 +1 @@\n-old\n+new\n',
        },
      ],
      status: 'modified' as const,
    },
  ];
  const transport = createFakeGitLabTransport([]);
  const commitReads: Array<string> = [];
  const rangeReads: Array<string> = [];
  const readers = {
    readCommitDiff: async (sha: GitSha) => {
      commitReads.push(sha);
      return localFiles;
    },
    readRangeDiff: async (from: GitSha, to: GitSha) => {
      rangeReads.push(`${from}:${to}`);
      return localFiles;
    },
  };

  const introduced = await fetchGitLabVersionCommitUnitDiff({
    projectPath: 'group/project',
    readers,
    transport,
    unit: {
      after: commit,
      confidence: 'exact',
      kind: 'added',
      order: 0,
      reviewable: true,
      unitId: evolutionUnitId('introduced-local'),
    },
  });
  const removed = await fetchGitLabVersionCommitUnitDiff({
    projectPath: 'group/project',
    readers,
    transport,
    unit: {
      before: commit,
      confidence: 'exact',
      kind: 'removed',
      order: 1,
      reviewable: true,
      unitId: evolutionUnitId('removed-local'),
    },
  });

  expect(introduced[0]?.path).toBe('src/local.ts');
  expect(removed[0]?.path).toBe('src/local.ts');
  expect(commitReads).toEqual([commitSha]);
  expect(rangeReads).toEqual([`${commitSha}:${parentSha}`]);
  expect(transport.calls).toEqual([]);
});

test('uses one bounded replay-evidence batch for revised evolution units', async () => {
  const oldBaseSha = gitSha('a'.repeat(40));
  const oldHeadSha = gitSha('b'.repeat(40));
  const newBaseSha = gitSha('c'.repeat(40));
  const newHeadSha = gitSha('d'.repeat(40));
  const before = {
    authoredAt: '2026-01-01T00:00:00.000Z',
    authorName: 'Ada',
    parentShas: [oldBaseSha],
    sha: oldHeadSha,
    shortSha: oldHeadSha.slice(0, 7),
    subject: 'Update app',
    webUrl: `https://gitlab.example/commit/${oldHeadSha}`,
  };
  const after = {
    ...before,
    parentShas: [newBaseSha],
    sha: newHeadSha,
    shortSha: newHeadSha.slice(0, 7),
    webUrl: `https://gitlab.example/commit/${newHeadSha}`,
  };
  const oldFiles = [
    {
      newPath: 'src/app.ts',
      oldPath: 'src/app.ts',
      patchBody: '@@ -2 +2 @@\n-old\n+prior\n',
      status: 'modified' as const,
    },
  ];
  const newFiles = [
    {
      newPath: 'src/app.ts',
      oldPath: 'src/app.ts',
      patchBody: '@@ -2 +2 @@\n-base\n+current\n',
      status: 'modified' as const,
    },
  ];
  const contents = new Map<string, string>([
    [`${oldBaseSha}:src/app.ts`, 'first\nold\nlast\n'],
    [`${oldHeadSha}:src/app.ts`, 'first\nprior\nlast\n'],
    [`${newBaseSha}:src/app.ts`, 'first\nbase\nlast\n'],
    [`${newHeadSha}:src/app.ts`, 'first\ncurrent\nlast\n'],
  ]);
  const readBlob = vi.fn(async () => {
    throw new Error('A batch-capable revised unit must not read blobs serially.');
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

  const files = await fetchGitLabVersionCommitUnitDiff({
    projectPath: 'group/project',
    readers: {
      readBlob,
      readCommitPatchFiles: async (sha) => (sha === oldHeadSha ? oldFiles : newFiles),
      readReplayBlobs,
    },
    transport: createFakeGitLabTransport([]),
    unit: {
      after,
      before,
      confidence: 'high',
      kind: 'likely-revised',
      order: 0,
      reviewable: true,
      unitId: evolutionUnitId('revised-batch'),
    },
  });

  expect(files).toHaveLength(1);
  expect(readReplayBlobs).toHaveBeenCalledTimes(1);
  expect(readReplayBlobs.mock.calls[0]?.[0]).toEqual(
    expect.arrayContaining([
      { path: 'src/app.ts', ref: oldBaseSha },
      { path: 'src/app.ts', ref: oldHeadSha },
      { path: 'src/app.ts', ref: newBaseSha },
      { path: 'src/app.ts', ref: newHeadSha },
    ]),
  );
  expect(readBlob).not.toHaveBeenCalled();

  const providerTransport = createFakeGitLabTransport(
    [oldBaseSha, oldHeadSha, newBaseSha, newHeadSha].map((ref) => ({
      bytes: new TextEncoder().encode(contents.get(`${ref}:src/app.ts`) ?? ''),
      path: '/api/v4/projects/group%2Fproject/repository/files/src%2Fapp.ts/raw',
      query: { ref },
      response: null,
    })),
  );
  const providerFiles = await fetchGitLabVersionCommitUnitDiff({
    projectPath: 'group/project',
    readers: {
      readCommitPatchFiles: async (sha) => (sha === oldHeadSha ? oldFiles : newFiles),
    },
    transport: providerTransport,
    unit: {
      after,
      before,
      confidence: 'high',
      kind: 'likely-revised',
      order: 0,
      reviewable: true,
      unitId: evolutionUnitId('revised-provider-cap'),
    },
  });

  expect(providerFiles).toHaveLength(1);
  expect(providerTransport.calls).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        maxBytes: 8 * 1024 * 1024,
        path: '/api/v4/projects/group%2Fproject/repository/files/src%2Fapp.ts/raw',
      }),
    ]),
  );
});
