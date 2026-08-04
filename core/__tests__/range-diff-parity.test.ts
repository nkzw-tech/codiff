import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vite-plus/test';
import {
  createCommitFingerprint,
  matchVersionCommitStacks,
  type CommitFingerprint,
} from '../lib/commit-stack-evolution.ts';
import type { CommitArtifact } from '../lib/review-artifacts.ts';
import type { GitSha } from '../types.ts';

const require = createRequire(import.meta.url);
const { readCommitArtifacts } = require('../../electron/git-state/commit-artifacts.cjs') as {
  readCommitArtifacts: (
    repoRoot: string,
    commits: ReadonlyArray<GitSha>,
  ) => Promise<ReadonlyMap<GitSha, CommitArtifact>>;
};

type TestCommit = {
  authoredDate: string;
  authorName: string;
  message: string;
  parentShas: ReadonlyArray<GitSha>;
  sha: GitSha;
  shortSha: string;
  title: string;
  webUrl: string;
};

type RangeDiffRow = {
  after: number | null;
  before: number | null;
  symbol: '!' | '<' | '=' | '>';
};

const testDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    testDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const git = (directory: string, args: ReadonlyArray<string>) =>
  execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
  }).trim();

const gitSha = (value: string) => value as GitSha;

const betaContents = (lastLine: string) =>
  `${Array.from({ length: 19 }, (_, index) => `shared beta ${index + 1}`).join('\n')}\n${lastLine}\n`;

const readCommitStack = (directory: string, range: string): ReadonlyArray<TestCommit> =>
  git(directory, ['log', '--reverse', '--format=%H%x00%P%x00%an%x00%aI%x00%s', range])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, parents, authorName, authoredDate, subject] = line.split('\0');
      return {
        authoredDate,
        authorName,
        message: subject,
        parentShas: parents ? parents.split(' ').map(gitSha) : [],
        sha: gitSha(sha),
        shortSha: sha.slice(0, 8),
        title: subject,
        webUrl: '',
      };
    });

const createSyntheticStack = () => {
  let nextMark = 1;
  const records: Array<string> = [];
  const blob = (contents: string) => {
    const mark = `:${nextMark++}`;
    records.push('blob', `mark ${mark}`, `data ${Buffer.byteLength(contents)}`, contents);
    return mark;
  };
  const commit = (
    ref: string,
    parent: string | null,
    message: string,
    timestamp: number,
    updates: ReadonlyArray<{ contents: string; path: string }>,
  ) => {
    const mark = `:${nextMark++}`;
    records.push(
      `commit ${ref}`,
      `mark ${mark}`,
      `author Codiff Test <codiff@example.com> ${timestamp} +0000`,
      `committer Codiff Test <codiff@example.com> ${timestamp} +0000`,
      `data ${Buffer.byteLength(message)}`,
      message,
      ...(parent ? [`from ${parent}`] : []),
      ...updates.map(({ contents, path }) => `M 100644 ${blob(contents)} ${path}`),
    );
    return mark;
  };

  const base = commit('refs/heads/main', null, 'Create base', 1_767_225_600, [
    { contents: 'base\n', path: 'base.txt' },
  ]);
  const beforeAlpha = commit('refs/heads/before', base, 'Add alpha', 1_767_225_660, [
    { contents: 'alpha\n', path: 'alpha.txt' },
  ]);
  const beforeBeta = commit('refs/heads/before', beforeAlpha, 'Update beta', 1_767_225_720, [
    { contents: betaContents('old beta'), path: 'beta.txt' },
  ]);
  commit('refs/heads/before', beforeBeta, 'Remove obsolete implementation', 1_767_225_780, [
    {
      contents: `${Array.from({ length: 20 }, (_, index) => `removed ${index + 1}`).join('\n')}\n`,
      path: 'removed.txt',
    },
  ]);
  const afterAdded = commit(
    'refs/heads/after',
    base,
    'Add replacement implementation',
    1_767_225_840,
    [
      {
        contents: `${Array.from({ length: 20 }, (_, index) => `added ${index + 1}`).join('\n')}\n`,
        path: 'added.txt',
      },
    ],
  );
  const afterBeta = commit('refs/heads/after', afterAdded, 'Update beta', 1_767_225_720, [
    { contents: betaContents('new beta'), path: 'beta.txt' },
  ]);
  commit('refs/heads/after', afterBeta, 'Add alpha', 1_767_225_660, [
    { contents: 'alpha\n', path: 'alpha.txt' },
  ]);
  records.push('done');
  return `${records.join('\n')}\n`;
};

const normalizeRows = (rows: ReadonlyArray<RangeDiffRow>) =>
  rows.map(({ after, before, symbol }) => `${before ?? '-'}:${symbol}:${after ?? '-'}`).toSorted();

const readGitRangeDiffRows = (
  directory: string,
  base: GitSha,
  before: GitSha,
  after: GitSha,
  creationFactor?: number,
) => {
  const output = git(directory, [
    'range-diff',
    '--no-color',
    ...(creationFactor == null ? [] : [`--creation-factor=${creationFactor}`]),
    `${base}..${before}`,
    `${base}..${after}`,
  ]);
  return output.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+|-):\s+[0-9a-f-]+\s+([!<=>])\s+(\d+|-):/i);
    if (!match) {
      return [];
    }
    const [, beforeIndex, symbol, afterIndex] = match;
    return [
      {
        after: afterIndex === '-' ? null : Number(afterIndex),
        before: beforeIndex === '-' ? null : Number(beforeIndex),
        symbol: symbol as RangeDiffRow['symbol'],
      },
    ];
  });
};

const readFingerprints = async (directory: string, commits: ReadonlyArray<TestCommit>) => {
  const artifacts = await readCommitArtifacts(
    directory,
    commits.map((commit) => commit.sha),
  );
  const entries: ReadonlyArray<readonly [GitSha, CommitFingerprint]> = await Promise.all(
    commits.map(async (commit): Promise<readonly [GitSha, CommitFingerprint]> => {
      const artifact = artifacts.get(commit.sha);
      if (!artifact) {
        throw new Error(`Missing synthetic Commit Artifact for ${commit.sha}.`);
      }
      return [commit.sha, await createCommitFingerprint(commit, artifact)];
    }),
  );
  return new Map<GitSha, CommitFingerprint>(entries);
};

test('matches Git range-diff symbols for a reordered, revised, added, and removed synthetic stack', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-range-diff-parity-'));
  testDirectories.push(directory);
  git(directory, ['init', '--quiet', '--initial-branch=main']);
  execFileSync('git', ['-C', directory, 'fast-import', '--quiet'], {
    encoding: 'utf8',
    input: createSyntheticStack(),
  });
  const base = gitSha(git(directory, ['rev-parse', 'refs/heads/main']));
  const beforeCommits = readCommitStack(directory, `${base}..refs/heads/before`);
  const afterCommits = readCommitStack(directory, `${base}..refs/heads/after`);
  const beforeHead = beforeCommits.at(-1)?.sha;
  const afterHead = afterCommits.at(-1)?.sha;
  if (!beforeHead || !afterHead) {
    throw new Error('Synthetic range-diff fixture did not create both commit stacks.');
  }
  const evolution = await matchVersionCommitStacks({
    fingerprints: await readFingerprints(directory, [...beforeCommits, ...afterCommits]),
    from: { baseSha: base, headSha: beforeHead, versionId: 'before' as never },
    newCommits: afterCommits,
    oldCommits: beforeCommits,
    to: { baseSha: base, headSha: afterHead, versionId: 'after' as never },
  });
  const codiffRows = evolution.units.flatMap<RangeDiffRow>((unit) => {
    const before = unit.before
      ? beforeCommits.findIndex((commit) => commit.sha === unit.before?.sha) + 1
      : null;
    const after = unit.after
      ? afterCommits.findIndex((commit) => commit.sha === unit.after?.sha) + 1
      : null;
    const symbol: RangeDiffRow['symbol'] | null =
      unit.kind === 'rewritten-same-patch'
        ? '='
        : unit.kind === 'likely-revised'
          ? '!'
          : unit.kind === 'removed'
            ? '<'
            : unit.kind === 'added'
              ? '>'
              : null;
    return symbol ? [{ after, before, symbol }] : [];
  });

  const expectedRows = [
    { after: 3, before: 1, symbol: '=' },
    { after: 2, before: 2, symbol: '!' },
    { after: null, before: 3, symbol: '<' },
    { after: 1, before: null, symbol: '>' },
  ] satisfies ReadonlyArray<RangeDiffRow>;

  expect(normalizeRows(codiffRows)).toEqual(normalizeRows(expectedRows));
  for (const creationFactor of [undefined, 80]) {
    expect(
      normalizeRows(readGitRangeDiffRows(directory, base, beforeHead, afterHead, creationFactor)),
    ).toEqual(normalizeRows(expectedRows));
  }
}, 30_000);
