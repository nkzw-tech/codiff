import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const {
  compareGitLabReviewVersionAggregate,
  listGitLabRepositoryHistory,
  listGitLabReviewVersions,
  readLocalCommitStack,
  toGitLabAlgorithmUnit,
  toGitLabEvolutionCommit,
  toRequestedCompareEndpoint,
} = require('../git-state/gitlab-review-history.cjs') as {
  compareGitLabReviewVersionAggregate: (
    repoRoot: string,
    source: {
      host: string;
      number: number;
      projectPath: string;
      provider: 'gitlab';
      type: 'pull-request';
      url: string;
    },
    range: { fromVersionId: string; toVersionId: string },
  ) => Promise<import('../../core/types.ts').DiffComparisonView>;
  listGitLabRepositoryHistory: (
    repoRoot: string,
    source: {
      host: string;
      number: number;
      projectPath: string;
      provider: 'gitlab';
      type: 'pull-request';
      url: string;
    },
    limit?: number,
  ) => Promise<{
    entries: ReadonlyArray<{ scope?: string; sha: string }>;
    root: string;
  }>;
  listGitLabReviewVersions: (
    repoRoot: string,
    source: {
      host: string;
      number: number;
      projectPath: string;
      provider: 'gitlab';
      type: 'pull-request';
      url: string;
    },
    options?: { includeActivity?: boolean },
  ) => Promise<
    ReadonlyArray<{
      isHead?: boolean;
      number?: number;
      range: { head: { sha: string } };
      versionId: string;
    }>
  >;
  readLocalCommitStack: (
    repoRoot: string,
    baseSha: string,
    headSha: string,
    source: {
      provider: 'gitlab';
      type: 'pull-request';
      url: string;
    },
  ) => Promise<ReadonlyArray<{ parentShas: ReadonlyArray<string>; sha: string }>>;
  toGitLabAlgorithmUnit: (unit: {
    after: { sha: string };
    before: { sha: string };
    confidence: 'unmatched';
    order: number;
    kind: 'ambiguous';
    reviewable: true;
    unitId: string;
  }) => { kind: string; reviewable: boolean; unitId: string };
  toGitLabEvolutionCommit: (
    commit: {
      authoredAt: string;
      authorName: string;
      parentShas: ReadonlyArray<string>;
      sha: string;
      shortSha: string;
      subject: string;
    },
    source: { url: string },
  ) => {
    authoredDate: string;
    message: string;
    title: string;
    webUrl: string;
  };
  toRequestedCompareEndpoint: (
    endpoint: {
      baseSha: string;
      commentId: string;
      headSha: string;
      kind: 'comment-position';
      startSha: string;
    },
    fallbackVersionId: string | undefined,
    versions: ReadonlyArray<unknown>,
    forCommitEvolution?: boolean,
  ) => { commentId?: string; headSha?: string; kind: string };
};
const { normalizeGitLabDiscussion, readMergeRequestReviewComments } =
  require('../git-state/merge-request.cjs') as {
    normalizeGitLabDiscussion: (
      discussion: Record<string, unknown>,
      url: string,
    ) => ReadonlyArray<{
      filePath: string;
      id: string;
      isThreadResolved?: boolean;
      lineNumber?: number;
      threadId?: string;
    }>;
    readMergeRequestReviewComments: (
      repoRoot: string,
      source: { url: string },
    ) => Promise<ReadonlyArray<unknown>>;
  };

const previousGlabPath = process.env.CODIFF_GLAB_PATH;
const git = (repo: string, args: ReadonlyArray<string>) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

afterEach(() => {
  if (previousGlabPath == null) {
    delete process.env.CODIFF_GLAB_PATH;
  } else {
    process.env.CODIFF_GLAB_PATH = previousGlabPath;
  }
});

test('defers and reuses GitLab reviewer activity after version options', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-gitlab-history-'));
  git(directory, ['init', '--quiet']);
  git(directory, ['remote', 'add', 'origin', 'https://gitlab.example.com/group/project.git']);
  const fakeGlabPath = join(directory, 'glab');
  const callLogPath = join(directory, 'glab-calls.log');
  await writeFile(
    fakeGlabPath,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const resource = args.find((arg) => arg.startsWith('/')) || '';
appendFileSync(${JSON.stringify(callLogPath)}, resource + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  if (resource.includes('/merge_requests/7/versions')) {
    process.stdout.write(JSON.stringify([
      {
        id: 2,
        head_commit_sha: ${JSON.stringify('c'.repeat(40))},
        base_commit_sha: ${JSON.stringify('a'.repeat(40))},
        start_commit_sha: ${JSON.stringify('a'.repeat(40))},
        created_at: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 1,
        head_commit_sha: ${JSON.stringify('b'.repeat(40))},
        base_commit_sha: ${JSON.stringify('a'.repeat(40))},
        start_commit_sha: ${JSON.stringify('a'.repeat(40))},
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]));
  } else if (resource === '/user') {
    process.stdout.write(JSON.stringify({ id: 9, username: 'reviewer' }));
  } else {
    process.stdout.write('[]');
  }
  process.exit(0);
});

`,
    'utf8',
  );
  await chmod(fakeGlabPath, 0o755);
  process.env.CODIFF_GLAB_PATH = fakeGlabPath;

  const source = {
    host: 'gitlab.example.com',
    number: 7,
    projectPath: 'group/project',
    provider: 'gitlab',
    type: 'pull-request',
    url: 'https://gitlab.example.com/group/project/-/merge_requests/7',
  } as const;
  const [versions, warmVersions] = await Promise.all([
    listGitLabReviewVersions(directory, source, { includeActivity: false }),
    listGitLabReviewVersions(directory, source, { includeActivity: false }),
  ]);
  const initialCalls = (await readFile(callLogPath, 'utf8')).split('\n').filter(Boolean);
  expect(initialCalls).not.toContain('/user');
  expect(initialCalls.every((call) => !call.includes('/discussions'))).toBe(true);
  expect(initialCalls.every((call) => !call.includes('/notes'))).toBe(true);

  const commentsRequest = readMergeRequestReviewComments(directory, source);
  const [comments, enrichedVersions, warmEnrichedVersions] = await Promise.all([
    commentsRequest,
    listGitLabReviewVersions(directory, source, { includeActivity: true }),
    listGitLabReviewVersions(directory, source, { includeActivity: true }),
  ]);
  expect(comments).toEqual([]);

  expect(versions.map((version) => version.versionId)).toEqual(['mr-base', '1', '2']);
  expect(warmVersions).toEqual(versions);
  expect(enrichedVersions).toEqual(versions);
  expect(warmEnrichedVersions).toEqual(versions);
  expect(versions[0]?.number).toBe(0);
  expect(versions[2]?.isHead).toBe(true);
  expect(versions[2]?.range.head.sha).toBe('c'.repeat(40));
  const calls = (await readFile(callLogPath, 'utf8')).split('\n').filter(Boolean);
  expect(calls.filter((call) => call.includes('/merge_requests/7/versions'))).toHaveLength(1);
  expect(calls.filter((call) => call === '/user')).toHaveLength(1);
  expect(calls.filter((call) => call.includes('/discussions'))).toHaveLength(1);
  expect(calls.filter((call) => call.includes('/notes'))).toHaveLength(1);
  expect(calls.indexOf('/user')).toBeGreaterThanOrEqual(initialCalls.length);
}, 30_000);

test('repository history never requests GitLab reviewer activity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-gitlab-repository-history-'));
  git(directory, ['init', '--quiet']);
  git(directory, ['config', 'user.name', 'Codiff Test']);
  git(directory, ['config', 'user.email', 'codiff@example.com']);
  git(directory, [
    'remote',
    'add',
    'origin',
    'https://gitlab.example.com/group/history-project.git',
  ]);
  await writeFile(join(directory, 'base.txt'), 'base\n', 'utf8');
  git(directory, ['add', '.']);
  git(directory, ['commit', '--quiet', '-m', 'Add base']);
  const baseSha = git(directory, ['rev-parse', 'HEAD']);
  await writeFile(join(directory, 'review.txt'), 'review\n', 'utf8');
  git(directory, ['add', '.']);
  git(directory, ['commit', '--quiet', '-m', 'Add review']);
  const headSha = git(directory, ['rev-parse', 'HEAD']);

  const fakeGlabPath = join(directory, 'glab');
  const callLogPath = join(directory, 'glab-calls.log');
  await writeFile(
    fakeGlabPath,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const resource = args.find((arg) => arg.startsWith('/')) || '';
appendFileSync(${JSON.stringify(callLogPath)}, resource + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  if (resource.includes('/merge_requests/17/versions')) {
    process.stdout.write(JSON.stringify([
      {
        id: 1,
        head_commit_sha: ${JSON.stringify(headSha)},
        base_commit_sha: ${JSON.stringify(baseSha)},
        start_commit_sha: ${JSON.stringify(baseSha)},
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]));
  } else if (resource === '/user') {
    process.stdout.write(JSON.stringify({ id: 9, username: 'reviewer' }));
  } else {
    process.stdout.write('[]');
  }
  process.exit(0);
});

`,
    'utf8',
  );
  await chmod(fakeGlabPath, 0o755);
  process.env.CODIFF_GLAB_PATH = fakeGlabPath;

  const source = {
    host: 'gitlab.example.com',
    number: 17,
    projectPath: 'group/history-project',
    provider: 'gitlab',
    type: 'pull-request',
    url: 'https://gitlab.example.com/group/history-project/-/merge_requests/17',
  } as const;
  const history = await listGitLabRepositoryHistory(directory, source, 20);

  expect(history.root).toBe(directory);
  expect(history.entries.some((entry) => entry.sha === headSha)).toBe(true);
  const calls = (await readFile(callLogPath, 'utf8')).split('\n').filter(Boolean);
  expect(calls.filter((call) => call.includes('/merge_requests/17/versions'))).toHaveLength(1);
  expect(calls).not.toContain('/user');
  expect(calls.every((call) => !call.includes('/discussions'))).toBe(true);
  expect(calls.every((call) => !call.includes('/notes'))).toBe(true);
}, 30_000);

test('derives GitLab base movement without an extra provider compare request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-gitlab-base-movement-'));
  git(directory, ['init', '--quiet']);
  git(directory, ['config', 'user.name', 'Codiff Test']);
  git(directory, ['config', 'user.email', 'codiff@example.com']);
  git(directory, ['remote', 'add', 'origin', 'https://gitlab.example.com/group/movement.git']);

  await writeFile(join(directory, 'base.txt'), 'base one\n', 'utf8');
  git(directory, ['add', '.']);
  git(directory, ['commit', '--quiet', '-m', 'Create first base']);
  const firstBaseSha = git(directory, ['rev-parse', 'HEAD']);

  git(directory, ['switch', '--quiet', '-c', 'review-v1']);
  await writeFile(join(directory, 'review.txt'), 'old review\n', 'utf8');
  git(directory, ['add', '.']);
  git(directory, ['commit', '--quiet', '-m', 'Create first review version']);
  const firstHeadSha = git(directory, ['rev-parse', 'HEAD']);

  git(directory, ['switch', '--quiet', '-c', 'base-v2', firstBaseSha]);
  await writeFile(join(directory, 'base.txt'), 'base two\n', 'utf8');
  git(directory, ['add', '.']);
  git(directory, ['commit', '--quiet', '-m', 'Move review base']);
  const secondBaseSha = git(directory, ['rev-parse', 'HEAD']);

  git(directory, ['switch', '--quiet', '-c', 'review-v2']);
  await writeFile(join(directory, 'review.txt'), 'new review\n', 'utf8');
  git(directory, ['add', '.']);
  git(directory, ['commit', '--quiet', '-m', 'Create second review version']);
  const secondHeadSha = git(directory, ['rev-parse', 'HEAD']);

  const fakeGlabPath = join(directory, 'glab');
  const callLogPath = join(directory, 'glab-calls.log');
  await writeFile(
    fakeGlabPath,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const resource = args.find((arg) => arg.startsWith('/')) || '';
appendFileSync(${JSON.stringify(callLogPath)}, resource + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  if (resource.includes('/merge_requests/23/versions')) {
    process.stdout.write(JSON.stringify([
      {
        id: 2,
        head_commit_sha: ${JSON.stringify(secondHeadSha)},
        base_commit_sha: ${JSON.stringify(secondBaseSha)},
        start_commit_sha: ${JSON.stringify(secondBaseSha)},
        created_at: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 1,
        head_commit_sha: ${JSON.stringify(firstHeadSha)},
        base_commit_sha: ${JSON.stringify(firstBaseSha)},
        start_commit_sha: ${JSON.stringify(firstBaseSha)},
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]));
  } else {
    process.stdout.write('[]');
  }
  process.exit(0);
});

`,
    'utf8',
  );
  await chmod(fakeGlabPath, 0o755);
  process.env.CODIFF_GLAB_PATH = fakeGlabPath;

  const source = {
    host: 'gitlab.example.com',
    number: 23,
    projectPath: 'group/movement',
    provider: 'gitlab',
    type: 'pull-request',
    url: 'https://gitlab.example.com/group/movement/-/merge_requests/23',
  } as const;
  const comparison = await compareGitLabReviewVersionAggregate(directory, source, {
    fromVersionId: '1',
    toVersionId: '2',
  });

  expect(comparison.analysis.baseMovement).toMatchObject({
    changed: true,
    from: { sha: firstBaseSha },
    relationship: 'forward',
    to: { sha: secondBaseSha },
  });
  const calls = (await readFile(callLogPath, 'utf8')).split('\n').filter(Boolean);
  expect(calls.filter((call) => call.includes('/merge_requests/23/versions'))).toHaveLength(1);
  expect(calls.filter((call) => call.includes('/repository/compare'))).toHaveLength(0);
}, 30_000);

test('orders local GitLab merge stacks by topology instead of git log direction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-gitlab-stack-'));
  git(directory, ['init', '--quiet']);
  git(directory, ['config', 'user.name', 'Codiff Test']);
  git(directory, ['config', 'user.email', 'codiff@example.com']);
  await writeFile(join(directory, 'base.txt'), 'base\n', 'utf8');
  git(directory, ['add', '.']);
  git(directory, ['commit', '--quiet', '-m', 'Add base']);
  const baseSha = git(directory, ['rev-parse', 'HEAD']);

  git(directory, ['switch', '--quiet', '-c', 'left']);
  await writeFile(join(directory, 'left.txt'), 'left\n', 'utf8');
  git(directory, ['add', '.']);
  git(directory, ['commit', '--quiet', '-m', 'Add left']);
  const leftSha = git(directory, ['rev-parse', 'HEAD']);

  git(directory, ['switch', '--quiet', '-c', 'right', baseSha]);
  await writeFile(join(directory, 'right.txt'), 'right\n', 'utf8');
  git(directory, ['add', '.']);
  git(directory, ['commit', '--quiet', '-m', 'Add right']);
  const rightSha = git(directory, ['rev-parse', 'HEAD']);
  git(directory, ['merge', '--quiet', '--no-ff', leftSha, '-m', 'Merge left']);
  const mergeSha = git(directory, ['rev-parse', 'HEAD']);

  const commits = await readLocalCommitStack(directory, baseSha, mergeSha, {
    provider: 'gitlab',
    type: 'pull-request',
    url: 'https://gitlab.example.com/group/project/-/merge_requests/7',
  });

  const order = new Map(commits.map((commit, index) => [commit.sha, index]));
  expect(commits.at(-1)?.sha).toBe(mergeSha);
  expect(order.get(leftSha)).toBeLessThan(order.get(mergeSha)!);
  expect(order.get(rightSha)).toBeLessThan(order.get(mergeSha)!);
}, 30_000);

test('adapts Artifact Source stack commits for GitLab evolution matching', () => {
  const sha = 'a'.repeat(40);
  const authoredAt = '2026-01-01T00:00:00.000Z';

  expect(
    toGitLabEvolutionCommit(
      {
        authoredAt,
        authorName: 'Ada',
        parentShas: ['b'.repeat(40)],
        sha,
        shortSha: sha.slice(0, 7),
        subject: 'Change behavior',
      },
      { url: 'https://gitlab.example.com/group/project/-/merge_requests/7' },
    ),
  ).toMatchObject({
    authoredDate: authoredAt,
    message: 'Change behavior',
    title: 'Change behavior',
    webUrl: `https://gitlab.example.com/group/project/-/commit/${sha}`,
  });
});

test('paired ambiguous GitLab units use the shared revised materializer', () => {
  expect(
    toGitLabAlgorithmUnit({
      after: { sha: 'b'.repeat(40) },
      before: { sha: 'a'.repeat(40) },
      confidence: 'unmatched',
      order: 0,
      kind: 'ambiguous',
      reviewable: true,
      unitId: 'ambiguous:a:b',
    }),
  ).toMatchObject({
    kind: 'likely-revised',
    reviewable: true,
    unitId: 'ambiguous:a:b',
  });
});

test('keeps exact comment diff identity for commit evolution', () => {
  const endpoint = {
    baseSha: 'a'.repeat(40),
    commentId: 'gitlab:42',
    headSha: 'b'.repeat(40),
    kind: 'comment-position' as const,
    startSha: 'c'.repeat(40),
  };

  expect(toRequestedCompareEndpoint(endpoint, undefined, [])).toEqual({
    commentId: 'gitlab:42',
    kind: 'comment-position',
  });
  expect(toRequestedCompareEndpoint(endpoint, undefined, [], true)).toEqual({
    baseSha: endpoint.baseSha,
    headSha: endpoint.headSha,
    kind: 'diff-identity',
    startSha: endpoint.startSha,
  });
});

test('normalizes GitLab replies as one resolved thread with inherited root position', () => {
  const comments = normalizeGitLabDiscussion(
    {
      id: 'discussion-42',
      notes: [
        {
          author: { username: 'reviewer' },
          body: 'Root',
          created_at: '2026-01-01T00:00:00.000Z',
          id: 42,
          position: {
            base_sha: 'a'.repeat(40),
            head_sha: 'b'.repeat(40),
            new_line: 7,
            new_path: 'src/app.ts',
            start_sha: 'a'.repeat(40),
          },
          resolved: true,
        },
        {
          author: { username: 'author' },
          body: 'Reply',
          created_at: '2026-01-01T01:00:00.000Z',
          id: 43,
        },
      ],
    },
    'https://gitlab.example/group/project/-/merge_requests/7',
  );

  expect(comments).toHaveLength(2);
  expect(comments[1]).toMatchObject({
    filePath: 'src/app.ts',
    id: 'gitlab:43',
    isThreadResolved: true,
    lineNumber: 7,
    threadId: 'discussion-42',
  });
});
