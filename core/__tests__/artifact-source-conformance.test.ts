import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import { createGitHubArtifactSource } from '../../github/src/history.ts';
import { createGitLabArtifactSource } from '../../gitlab/src/history.ts';
import {
  createFakeGitHubTransport,
  createFakeGitLabTransport,
} from '../../test/fake-provider-transports.ts';
import { createCommitFingerprint } from '../lib/commit-stack-evolution.ts';
import type { CommitArtifact, ReviewArtifactProject } from '../lib/review-artifacts.ts';
import type { GitSha } from '../types.ts';

const require = createRequire(import.meta.url);
const { parseCommitArtifactOutput } = require('../../electron/git-state/commit-artifacts.cjs') as {
  parseCommitArtifactOutput: (
    output: string,
    provenance: CommitArtifact['provenance'],
  ) => ReadonlyMap<GitSha, CommitArtifact>;
};

const gitSha = (value: string) => value as GitSha;

const parentSha = gitSha('a'.repeat(40));
const commitSha = gitSha('b'.repeat(40));
const oldObjectId = 'c'.repeat(40);
const newObjectId = 'd'.repeat(40);
const project: ReviewArtifactProject = {
  host: 'example.test',
  project: 'group/project',
  provider: 'gitlab',
};
const commit = { sha: commitSha, title: 'Update app' };
const hunk =
  '@@ -1,6 +1,6 @@\n before\n-old first value\n+new first value\n between\n-old second value\n+new second value\n after\n';
const nativeHunk =
  '@@ -2 +2 @@\n-old first value\n+new first value\n@@ -4 +4 @@\n-old second value\n+new second value\n';

const nativeArtifact = () => {
  const artifacts = parseCommitArtifactOutput(
    [
      `commit ${commitSha} ${parentSha}`,
      `:100644 100644 ${oldObjectId} ${newObjectId} M\tsrc/app.ts`,
      'diff --git a/src/app.ts b/src/app.ts',
      `index ${oldObjectId}..${newObjectId} 100644`,
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      nativeHunk.trimEnd(),
    ].join('\n'),
    { kind: 'native-git', project: { ...project, provider: 'git' } },
  );
  const artifact = artifacts.get(commitSha);
  if (!artifact) {
    throw new Error('Native fixture did not produce a Commit Artifact.');
  }
  return artifact;
};

const gitLabArtifact = async (): Promise<CommitArtifact> => {
  const transport = createFakeGitLabTransport([
    {
      path: `/api/v4/projects/group%2Fproject/repository/commits/${commitSha}/diff`,
      response: [
        {
          a_mode: '100644',
          b_mode: '100644',
          diff: hunk,
          new_id: newObjectId,
          new_path: 'src/app.ts',
          old_id: oldObjectId,
          old_path: 'src/app.ts',
        },
      ],
    },
  ]);
  const source = createGitLabArtifactSource({
    project,
    projectPath: project.project,
    transport,
  });
  const artifact = (
    await source.readCommitArtifacts(
      [{ commitSha: commitSha as never, parentSha: parentSha as never }],
      new AbortController().signal,
    )
  ).get(commitSha as never);
  if (!artifact) {
    throw new Error('GitLab fixture did not produce a Commit Artifact.');
  }
  return artifact as unknown as CommitArtifact;
};

const gitHubArtifact = async (): Promise<CommitArtifact> => {
  const transport = createFakeGitHubTransport([
    {
      path: `/repos/nkzw-tech/codiff/commits/${commitSha}`,
      response: {
        files: [
          {
            filename: 'src/app.ts',
            patch: hunk,
            sha: newObjectId,
            status: 'modified',
          },
        ],
        parents: [{ sha: parentSha }],
        sha: commitSha,
      },
    },
  ]);
  const source = createGitHubArtifactSource({
    project: { ...project, host: 'github.example.test', provider: 'github' },
    pull: { number: 12, owner: 'nkzw-tech', repo: 'codiff' },
    transport,
  });
  const artifact = (
    await source.readCommitArtifacts(
      [{ commitSha: commitSha as never, parentSha: parentSha as never }],
      new AbortController().signal,
    )
  ).get(commitSha as never);
  if (!artifact) {
    throw new Error('GitHub fixture did not produce a Commit Artifact.');
  }
  return artifact as unknown as CommitArtifact;
};

test('normalizes equivalent native, GitLab, and GitHub Commit Artifacts into one matcher input', async () => {
  const fingerprints = await Promise.all(
    [nativeArtifact(), await gitLabArtifact(), await gitHubArtifact()].map((artifact) =>
      createCommitFingerprint(commit, artifact),
    ),
  );

  expect(fingerprints).toEqual([
    expect.objectContaining({ coverage: 'complete', exactChangeId: expect.any(String) }),
    expect.objectContaining({ coverage: 'complete', exactChangeId: expect.any(String) }),
    expect.objectContaining({ coverage: 'complete', exactChangeId: expect.any(String) }),
  ]);
  expect(fingerprints.map((fingerprint) => fingerprint.exactChangeId)).toEqual([
    fingerprints[0]?.exactChangeId,
    fingerprints[0]?.exactChangeId,
    fingerprints[0]?.exactChangeId,
  ]);
  expect(fingerprints.map((fingerprint) => fingerprint.patchMaterial)).toEqual([
    fingerprints[0]?.patchMaterial,
    fingerprints[0]?.patchMaterial,
    fingerprints[0]?.patchMaterial,
  ]);
});
