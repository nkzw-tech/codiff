import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import type { GitSha, ReviewVersionId, ReviewVersionOption } from '../../core/types.ts';

const git = (directory: string, args: ReadonlyArray<string>) =>
  execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();

const createHistoryRepository = async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'codiff-gh-base-'));
  execFileSync('git', ['init', '--quiet', directory]);
  git(directory, ['config', 'user.email', 'codiff@example.com']);
  git(directory, ['config', 'user.name', 'Codiff']);

  const commitFile = async (name: string, contents: string, message: string) => {
    await writeFile(join(directory, name), contents, 'utf8');
    git(directory, ['add', name]);
    git(directory, ['commit', '--quiet', '-m', message]);
    return git(directory, ['rev-parse', 'HEAD']);
  };

  const base = await commitFile('base.txt', 'base\n', 'base');
  return { base, commitFile, directory };
};

const reviewVersion = (base: string, head: string, createdAt: string): ReviewVersionOption => ({
  createdAt,
  range: {
    base: {
      kind: 'commit',
      label: { kind: 'commit', text: 'base' },
      sha: base as GitSha,
    },
    head: {
      kind: 'commit',
      label: { kind: 'version', text: head.slice(0, 7) },
      sha: head as GitSha,
    },
  },
  versionId: head as ReviewVersionId,
});

const compareBaseToVersion = async (
  directory: string,
  versions: ReadonlyArray<ReviewVersionOption>,
  target: string,
) => {
  const require = createRequire(import.meta.url);
  const { compareGitHubReviewVersions } =
    require('../git-state/github-history/github-review-history.cjs') as {
      compareGitHubReviewVersions: (
        repoRoot: string,
        source: {
          number: number;
          owner: string;
          provider: 'github';
          repo: string;
          type: 'pull-request';
          url: string;
        },
        range: { fromVersionId: string; toVersionId: string },
        versions: ReadonlyArray<ReviewVersionOption>,
      ) => Promise<{
        versionCompare: { files: ReadonlyArray<{ path: string }> };
      }>;
    };
  const targetVersion = versions.find((version) => version.versionId === target)!;
  if (!('sha' in targetVersion.range.base)) {
    throw new Error('Expected a commit-backed GitHub base.');
  }
  const baseVersion = reviewVersion(
    targetVersion.range.base.sha,
    targetVersion.range.base.sha,
    targetVersion.createdAt,
  );
  baseVersion.versionId = `github-base:${target}` as ReviewVersionId;
  return compareGitHubReviewVersions(
    directory,
    {
      number: 12,
      owner: 'nkzw-tech',
      provider: 'github',
      repo: 'codiff',
      type: 'pull-request',
      url: 'https://github.com/nkzw-tech/codiff/pull/12',
    },
    { fromVersionId: baseVersion.versionId, toVersionId: targetVersion.versionId },
    [baseVersion, ...versions],
  );
};

test('GitHub base comparison includes the complete diff for a single head', async () => {
  const { base, commitFile, directory } = await createHistoryRepository();
  const head = await commitFile('first.txt', 'first\n', 'first');

  const result = await compareBaseToVersion(
    directory,
    [reviewVersion(base, head, '2026-01-01')],
    head,
  );

  expect(result.versionCompare.files.map((file) => file.path)).toEqual(['first.txt']);
}, 30_000);

test('GitHub base comparison does not use the first head as its baseline', async () => {
  const { base, commitFile, directory } = await createHistoryRepository();
  const first = await commitFile('first.txt', 'first\n', 'first');
  const target = await commitFile('second.txt', 'second\n', 'second');
  const versions = [
    reviewVersion(base, first, '2026-01-01'),
    reviewVersion(base, target, '2026-01-02'),
  ];

  const result = await compareBaseToVersion(directory, versions, target);

  expect(result.versionCompare.files.map((file) => file.path).toSorted()).toEqual([
    'first.txt',
    'second.txt',
  ]);
}, 30_000);

test('orders local GitHub merge stacks by topology instead of git log direction', async () => {
  const { base, commitFile, directory } = await createHistoryRepository();
  git(directory, ['switch', '--quiet', '-c', 'left']);
  const left = await commitFile('left.txt', 'left\n', 'left');
  git(directory, ['switch', '--quiet', '-c', 'right', base]);
  const right = await commitFile('right.txt', 'right\n', 'right');
  git(directory, ['merge', '--quiet', '--no-ff', left, '-m', 'Merge left']);
  const merge = git(directory, ['rev-parse', 'HEAD']);
  const require = createRequire(import.meta.url);
  const { readCommitStack } = require('../git-state/github-history/github-review-history.cjs') as {
    readCommitStack: (
      repoRoot: string,
      baseSha: string,
      headSha: string,
    ) => Promise<ReadonlyArray<{ parentShas: ReadonlyArray<string>; sha: string }>>;
  };

  const commits = await readCommitStack(directory, base, merge);
  const order = new Map(commits.map((commit, index) => [commit.sha, index]));

  expect(commits.at(-1)?.sha).toBe(merge);
  expect(order.get(left)).toBeLessThan(order.get(merge)!);
  expect(order.get(right)).toBeLessThan(order.get(merge)!);
}, 30_000);

test('defers and reuses GitHub reviewer activity after the head timeline', async () => {
  const { chmod, mkdtemp, readFile, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const directory = await mkdtemp(join(tmpdir(), 'codiff-gh-history-'));
  const fakeGh = join(directory, 'gh');
  const callLogPath = join(directory, 'gh-calls.log');
  const before = 'a'.repeat(40);
  const after = 'b'.repeat(40);
  const current = 'c'.repeat(40);
  const base = '0'.repeat(40);
  execFileSync('git', ['init', '--quiet', directory]);
  git(directory, ['remote', 'add', 'origin', 'https://github.com/nkzw-tech/codiff.git']);
  await writeFile(
    fakeGh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const pathArg = args.find((a) => a.startsWith('/')) || '';
require('node:fs').appendFileSync(${JSON.stringify(callLogPath)}, pathArg + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  if (pathArg.includes('/timeline')) {
    process.stdout.write(JSON.stringify([
      {
        event: 'head_ref_force_pushed',
        before: '${before}',
        after: '${after}',
        created_at: '2026-01-02T00:00:00.000Z',
        actor: { login: 'ada' },
      },
    ]));
  } else if (pathArg.endsWith('/pulls/12')) {
    process.stdout.write(JSON.stringify({
      created_at: '2026-01-01T00:00:00.000Z',
      head: {
        sha: '${current}',
        ref: 'feature',
        repo: { name: 'codiff', owner: { login: 'nkzw-tech' } },
      },
      base: { sha: '${base}' },
    }));
  } else if (pathArg === '/user') {
    process.stdout.write(JSON.stringify({ login: 'reviewer' }));
  } else if (
    pathArg.endsWith('/reviews') ||
    pathArg.endsWith('/comments')
  ) {
    process.stdout.write('[]');
  } else if (pathArg.includes('/events')) {
    process.stdout.write('[]');
  } else {
    process.stdout.write('[]');
  }
  process.exit(0);
});

`,
    'utf8',
  );
  await chmod(fakeGh, 0o755);
  const previous = process.env.CODIFF_GH_PATH;
  process.env.CODIFF_GH_PATH = fakeGh;
  try {
    const require = createRequire(import.meta.url);
    const { listGitHubReviewVersions } =
      require('../git-state/github-history/github-review-history.cjs') as {
        listGitHubReviewVersions: (
          repoRoot: string,
          source: {
            number: number;
            owner: string;
            provider: 'github';
            repo: string;
            type: 'pull-request';
            url: string;
          },
          options?: { includeActivity?: boolean },
        ) => Promise<{
          versions: ReadonlyArray<{
            range: { head: { label: { text: string } } };
            versionId: string;
          }>;
          warning: string | null;
        }>;
      };
    const { readPullRequestReviewComments } = require('../git-state/pull-request.cjs') as {
      readPullRequestReviewComments: (
        repoRoot: string,
        source: { url: string },
      ) => Promise<ReadonlyArray<unknown>>;
    };
    const source = {
      number: 12,
      owner: 'nkzw-tech',
      provider: 'github',
      repo: 'codiff',
      type: 'pull-request',
      url: 'https://github.com/nkzw-tech/codiff/pull/12',
    } as const;
    const [initial, warmInitial] = await Promise.all([
      listGitHubReviewVersions(directory, source, { includeActivity: false }),
      listGitHubReviewVersions(directory, source, { includeActivity: false }),
    ]);
    const initialCalls = (await readFile(callLogPath, 'utf8')).split('\n').filter(Boolean);
    expect(initialCalls).not.toContain('/user');
    expect(initialCalls.every((call) => !call.includes('/reviews'))).toBe(true);
    expect(initialCalls.every((call) => !call.includes('/comments'))).toBe(true);

    const commentsRequest = readPullRequestReviewComments(directory, source);
    const [comments, enriched, warmEnriched] = await Promise.all([
      commentsRequest,
      listGitHubReviewVersions(directory, source, { includeActivity: true }),
      listGitHubReviewVersions(directory, source, { includeActivity: true }),
    ]);
    expect(comments).toEqual([]);
    const { versions, warning } = initial;
    expect(warning).toBeNull();
    expect(warmInitial.versions).toEqual(versions);
    expect(enriched.versions).toEqual(versions);
    expect(warmEnriched.versions).toEqual(versions);
    expect(versions.map((v) => v.versionId)).toEqual([before, after, current]);
    const labels = versions.map((v) => v.range.head.label.text);
    expect(labels.some((label) => label.startsWith('Head ·'))).toBe(true);
    expect(labels.some((label) => label.startsWith('Force-push ·'))).toBe(true);
    expect(labels.at(-1)).toBe('Current head');
    expect(labels.every((label) => !/^v\d+/.test(label))).toBe(true);
    const calls = (await readFile(callLogPath, 'utf8')).split('\n').filter(Boolean);
    expect(calls.filter((call) => call === '/user')).toHaveLength(1);
    expect(calls.filter((call) => call.includes('/pulls/12/reviews'))).toHaveLength(1);
    expect(calls.filter((call) => call.includes('/pulls/12/comments'))).toHaveLength(1);
    expect(calls.filter((call) => call.includes('/issues/12/comments'))).toHaveLength(1);
    expect(calls.indexOf('/user')).toBeGreaterThanOrEqual(initialCalls.length);
    expect(calls).toHaveLength(new Set(calls).size);
  } finally {
    if (previous == null) delete process.env.CODIFF_GH_PATH;
    else process.env.CODIFF_GH_PATH = previous;
  }
}, 30_000);

test('missing GitHub objects do not fall back to an unrelated origin', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const directory = await mkdtemp(join(tmpdir(), 'codiff-gh-fetch-'));
  execFileSync('git', ['init', '--quiet', directory]);
  execFileSync('git', [
    '-C',
    directory,
    'remote',
    'add',
    'origin',
    'https://github.com/other/repo.git',
  ]);

  const require = createRequire(import.meta.url);
  const { ensureCommitAvailable } =
    require('../git-state/github-history/github-review-history.cjs') as {
      ensureCommitAvailable: (
        repoRoot: string,
        sha: string,
        repositories: ReadonlyArray<{ owner: string; repo: string }>,
      ) => Promise<string>;
    };

  await expect(
    ensureCommitAvailable(directory, 'a'.repeat(40), [
      { owner: 'nkzw-tech', repo: 'codiff' },
      { owner: 'nkzw-tech', repo: 'codiff-base' },
    ]),
  ).rejects.toThrow('is not available locally');
});

test('parses adjacent pretty-printed gh pagination documents', () => {
  const require = createRequire(import.meta.url);
  const { parseJsonDocuments } = require('../git-state/github-history/gh-github-transport.cjs') as {
    parseJsonDocuments: (value: string) => Array<unknown>;
  };
  expect(parseJsonDocuments('[\n {"id": 1, "text": "} \\\"quoted\\\""}\n][{"id": 2}]')).toEqual([
    [{ id: 1, text: '} "quoted"' }],
    [{ id: 2 }],
  ]);
});

test('preserves query parameters for GitHub binary transport requests', () => {
  const require = createRequire(import.meta.url);
  const { appendQuery } = require('../git-state/github-history/gh-github-transport.cjs') as {
    appendQuery: (
      path: string,
      query?: Readonly<Record<string, boolean | number | string>>,
    ) => string;
  };

  expect(
    appendQuery('repos/nkzw-tech/codiff/contents/docs/image.png', {
      ref: 'feature/image + fix',
    }),
  ).toBe('/repos/nkzw-tech/codiff/contents/docs/image.png?ref=feature%2Fimage+%2B+fix');
});
