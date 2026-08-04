import {
  createCommitFingerprint,
  matchVersionCommitStacks,
  projectCommitEvolution,
  toCommitArtifact,
} from '../../core/dist/index.mjs';

const logFormat = '%H%x1f%P%x1f%aI%x1f%an%x1f%s';

const readCommitStack = async ({ base, head, runGit }) => {
  if (base === head) {
    return [];
  }
  const output = await runGit(['log', '--reverse', `--format=${logFormat}`, `${base}..${head}`]);
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, parents, authoredDate, authorName, title] = line.split('\u001f');
      return {
        authoredDate,
        authorName,
        message: title,
        parentShas: parents ? parents.split(' ') : [],
        sha,
        shortSha: sha.slice(0, 8),
        title,
        webUrl: '',
      };
    });
};

/**
 * Builds provider-neutral version-comparison classifier input from a materialized Scenario.
 *
 * @param {{
 *   from: {base: string, head: string, id?: string},
 *   readCommitState: (sha: string) => Promise<{files: ReadonlyArray<unknown>}>,
 *   runGit: (args: ReadonlyArray<string>) => Promise<string>,
 *   to: {base: string, head: string, id?: string},
 * }} options
 */
export const buildScenarioHistorySource = async ({ from, readCommitState, runGit, to }) => {
  const [oldStack, newStack, baseStack] = await Promise.all([
    readCommitStack({ base: from.base, head: from.head, runGit }),
    readCommitStack({ base: to.base, head: to.head, runGit }),
    readCommitStack({ base: from.base, head: to.base, runGit }),
  ]);
  const uniqueCommits = [
    ...new Map(
      [...oldStack, ...newStack, ...baseStack].map((commit) => [commit.sha, commit]),
    ).values(),
  ];
  const fingerprints = new Map();
  await Promise.all(
    uniqueCommits.map(async (commit) => {
      const state = await readCommitState(commit.sha);
      fingerprints.set(
        commit.sha,
        await createCommitFingerprint(
          { sha: commit.sha, title: commit.title },
          toCommitArtifact({
            commitSha: commit.sha,
            files: state.files,
            parentSha: commit.parentShas[0] ?? null,
            provenance: {
              kind: 'native-git',
              project: { host: 'local', project: 'test-scenario', provider: 'git' },
            },
          }),
        ),
      );
    }),
  );
  const evolution = await matchVersionCommitStacks({
    baseCommits: baseStack,
    baseStackComplete: true,
    fingerprints,
    from: {
      baseSha: from.base,
      headSha: from.head,
      label: from.id ?? from.head.slice(0, 8),
      startSha: from.base,
      versionId: from.id ?? from.head,
    },
    newCommits: newStack,
    oldCommits: oldStack,
    stackCompleteness: { new: true, old: true },
    to: {
      baseSha: to.base,
      headSha: to.head,
      label: to.id ?? to.head.slice(0, 8),
      startSha: to.base,
      versionId: to.id ?? to.head,
    },
  });
  return {
    evolution: projectCommitEvolution(evolution),
    range: { from, to },
  };
};
