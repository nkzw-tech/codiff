import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import type {
  DiffSection,
  DiffSectionContentRequest,
  RepositoryState,
  ReviewSource,
} from '../types.ts';

type StatusEntry = {
  oldPath?: string;
  path: string;
  staged: boolean;
  status: string;
  unstaged: boolean;
  untracked: boolean;
};

type PullRequestFileContent = {
  binary: boolean;
  file?: { cacheKey?: string; contents: string; name: string };
  fingerprint?: string;
  loadState?: string;
  summary?: unknown;
};

type GitStateModule = {
  collectResolvedReviewCommentIds: (
    threads: ReadonlyArray<{
      comments?: { nodes?: ReadonlyArray<{ databaseId?: number | null }> } | null;
      isResolved?: boolean;
    }>,
  ) => Set<number>;
  createPullRequestHistoryFetchRefspecs: (
    pullRequest: { number: number; owner: string; repo: string; url: string },
    metadata: { base?: { ref?: string; sha?: string } },
  ) => ReadonlyArray<string>;
  createPullRequestSection: (
    pullRequest: { number: number; owner: string; repo: string; url: string },
    file: { filename: string; patch?: string; previous_filename?: string; status: string },
    patch: string,
    oldFile?: PullRequestFileContent,
    newFile?: PullRequestFileContent,
  ) => DiffSection;
  getPullRequestHeadImageSource: (
    pullRequest: { number: number; owner: string; repo: string; url: string },
    metadata: {
      head?: {
        ref?: string;
        repo?: { full_name?: string; name?: string; owner?: { login?: string } } | null;
        sha?: string;
      };
    },
  ) => { owner: string; ref: string; repo: string };
  listRepositoryHistory: (
    launchPath: string,
    limit?: number,
    source?: ReviewSource,
  ) => Promise<{ entries: ReadonlyArray<unknown>; root: string }>;
  normalizeGitHubPullRequestCommit: (commit: Record<string, unknown>) => unknown;
  normalizeGitHubReviewComment: (comment: Record<string, unknown>) => unknown;
  normalizePullRequestComment: (comment: Record<string, unknown>) => Record<string, unknown>;
  parseGitHubPullRequestUrl: (value: string) => {
    number: number;
    owner: string;
    repo: string;
    url: string;
  };
  parseStatus: (raw: string) => Array<StatusEntry>;
  readDiffSectionContent: (
    launchPath: string,
    request: DiffSectionContentRequest,
  ) => Promise<DiffSection>;
  readRepositoryChangeSignature: (
    launchPath: string,
  ) => Promise<{ root: string; signature: string }>;
  readRepositoryState: (launchPath: string, source?: ReviewSource) => Promise<RepositoryState>;
  readWorkingTreeState: (launchPath: string) => Promise<RepositoryState>;
  resolvePullRequestContentRefs: (
    repoRoot: string,
    pullRequest: { number: number; owner: string; repo: string; url: string },
    metadata: { base?: { ref?: string; sha?: string }; head?: { ref?: string; sha?: string } },
  ) => Promise<{ base: string; head: string } | null>;
  selectUnresolvedReviewComments: (
    comments: ReadonlyArray<Record<string, unknown>>,
    resolvedCommentIds: ReadonlySet<number>,
  ) => Array<Record<string, unknown>>;
};

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const {
  collectResolvedReviewCommentIds,
  createPullRequestHistoryFetchRefspecs,
  createPullRequestSection,
  getPullRequestHeadImageSource,
  listRepositoryHistory,
  normalizeGitHubPullRequestCommit,
  normalizeGitHubReviewComment,
  normalizePullRequestComment,
  parseGitHubPullRequestUrl,
  parseStatus,
  readDiffSectionContent,
  readRepositoryChangeSignature,
  readRepositoryState,
  readWorkingTreeState,
  resolvePullRequestContentRefs,
  selectUnresolvedReviewComments,
} = require('../../electron/git-state.cjs') as GitStateModule;

const git = async (repo: string, args: ReadonlyArray<string>) => {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 16,
  });
  return stdout;
};

const createRepo = async () => {
  const repo = await mkdtemp(join(tmpdir(), 'codiff-git-state-'));
  await git(repo, ['init']);
  await git(repo, ['config', 'core.excludesfile', '/dev/null']);
  await git(repo, ['config', 'user.email', 'codiff@example.com']);
  await git(repo, ['config', 'user.name', 'Codiff Test']);
  return realpath(repo);
};

const writeRepoFile = async (repo: string, path: string, contents: string | Uint8Array) => {
  const absolutePath = join(repo, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
};

const commitAll = async (repo: string, message: string) => {
  await git(repo, ['add', '--all']);
  await git(repo, ['commit', '-m', message]);
};

const withRepo = async (run: (repo: string) => Promise<void>) => {
  const repo = await createRepo();
  try {
    await run(repo);
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
};

test('parseStatus reads staged rename paths in porcelain v1 -z order', () => {
  expect(parseStatus('R  new.txt\0old.txt\0')).toEqual([
    {
      oldPath: 'old.txt',
      path: 'new.txt',
      staged: true,
      status: 'renamed',
      unstaged: false,
      untracked: false,
    },
  ]);
});

test('parseGitHubPullRequestUrl reads canonical pull request URLs', () => {
  expect(parseGitHubPullRequestUrl('https://github.com/nkzw-tech/codiff/pull/3')).toEqual({
    number: 3,
    owner: 'nkzw-tech',
    repo: 'codiff',
    url: 'https://github.com/nkzw-tech/codiff/pull/3',
  });
});

test('createPullRequestHistoryFetchRefspecs fetches PR and base refs into Codiff refs', () => {
  expect(
    createPullRequestHistoryFetchRefspecs(
      {
        number: 25,
        owner: 'nkzw-tech',
        repo: 'codiff',
        url: 'https://github.com/nkzw-tech/codiff/pull/25',
      },
      {
        base: {
          ref: 'main',
          sha: 'base-sha',
        },
      },
    ),
  ).toEqual([
    '+refs/pull/25/head:refs/codiff/pull-requests/25/head',
    '+refs/heads/main:refs/codiff/pull-requests/25/base',
  ]);
});

const pullRequestFixture = {
  number: 7,
  owner: 'nkzw-tech',
  repo: 'codiff',
  url: 'https://github.com/nkzw-tech/codiff/pull/7',
};

test('createPullRequestSection renders full contents so pull request diffs can expand context', () => {
  const section = createPullRequestSection(
    pullRequestFixture,
    { filename: 'src/app.ts', status: 'modified' },
    'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
    { binary: false, file: { cacheKey: 'base:src/app.ts', contents: 'old\n', name: 'src/app.ts' } },
    { binary: false, file: { cacheKey: 'head:src/app.ts', contents: 'new\n', name: 'src/app.ts' } },
  );

  expect(section.id).toBe('src/app.ts:pull-request:7');
  expect(section.binary).toBe(false);
  expect(section.loadState).toBe('ready');
  expect(section.oldFile?.contents).toBe('old\n');
  expect(section.newFile?.contents).toBe('new\n');
});

test('createPullRequestSection falls back to a non-loadable patch section without contents', () => {
  const section = createPullRequestSection(
    pullRequestFixture,
    { filename: 'src/app.ts', status: 'modified' },
    'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
  );

  expect(section.oldFile).toBeUndefined();
  expect(section.newFile).toBeUndefined();
  expect(section.loadState).toBe('ready');
  // Pull request contents load up front, so a patch-only fallback is not
  // loadable on demand (there is no pull-request section-content loader).
  expect(section.summary?.canLoad).toBe(false);
});

test('createPullRequestSection treats the binary marker as a diff line, not patch content', () => {
  // The patch's content adds a line that contains the binary-marker text. It
  // must not be mistaken for an actual binary diff.
  const patch =
    'diff --git a/re.ts b/re.ts\n@@ -1 +1 @@\n-const a = 1;\n+const re = /Binary files .* differ/;\n';
  const section = createPullRequestSection(
    pullRequestFixture,
    { filename: 're.ts', status: 'modified' },
    patch,
    { binary: false, file: { cacheKey: 'old', contents: 'const a = 1;\n', name: 're.ts' } },
    {
      binary: false,
      file: { cacheKey: 'new', contents: 'const re = /Binary files .* differ/;\n', name: 're.ts' },
    },
  );

  expect(section.binary).toBe(false);
  expect(section.loadState).toBe('ready');
  expect(section.oldFile?.contents).toBe('const a = 1;\n');
  expect(section.newFile?.contents).toBe('const re = /Binary files .* differ/;\n');
});

test('createPullRequestSection keeps full contents for added files', () => {
  const section = createPullRequestSection(
    pullRequestFixture,
    { filename: 'new.ts', status: 'added' },
    'diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+hello\n',
    { binary: false, file: { cacheKey: 'base:new.ts:empty', contents: '', name: 'new.ts' } },
    { binary: false, file: { cacheKey: 'head:new.ts', contents: 'hello\n', name: 'new.ts' } },
  );

  expect(section.oldFile?.contents).toBe('');
  expect(section.newFile?.contents).toBe('hello\n');
  expect(section.loadState).toBe('ready');
});

test('createPullRequestSection falls back to the patch for binary files', () => {
  const section = createPullRequestSection(
    pullRequestFixture,
    { filename: 'logo.png', status: 'modified' },
    'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n',
  );

  expect(section.binary).toBe(true);
  expect(section.loadState).toBe('binary');
  expect(section.oldFile).toBeUndefined();
  expect(section.newFile).toBeUndefined();
});

test('createPullRequestSection falls back to the patch when modified contents fail to load', () => {
  const patch = 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n';
  const section = createPullRequestSection(
    pullRequestFixture,
    { filename: 'src/app.ts', status: 'modified' },
    patch,
    { binary: false, file: { cacheKey: 'base:empty', contents: '', name: 'src/app.ts' } },
    { binary: false, file: { cacheKey: 'head:empty', contents: '', name: 'src/app.ts' } },
  );

  expect(section.oldFile).toBeUndefined();
  expect(section.newFile).toBeUndefined();
  expect(section.loadState).toBe('ready');
  expect(section.patch).toBe(patch);
  // Once a load has been attempted but could not produce usable contents, the
  // section is marked non-loadable so it is not requested again.
  expect(section.summary?.canLoad).toBe(false);
});

test('resolvePullRequestContentRefs resolves the diff against the merge base', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'base\n');
    await commitAll(repo, 'base');
    const mergeBase = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    // The pull request head branches off the merge base.
    await writeRepoFile(repo, 'file.txt', 'head change\n');
    await commitAll(repo, 'head');
    const headSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['update-ref', 'refs/codiff/pull-requests/7/head', headSha]);

    // The base branch advances past the merge base after the PR was opened.
    await git(repo, ['checkout', '-q', mergeBase]);
    await writeRepoFile(repo, 'file.txt', 'base advanced\n');
    await commitAll(repo, 'base advanced');
    const baseTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['update-ref', 'refs/codiff/pull-requests/7/base', baseTip]);

    const refs = await resolvePullRequestContentRefs(repo, pullRequestFixture, {
      base: { ref: 'main' },
      head: { sha: headSha },
    });

    expect(refs).toEqual({ base: mergeBase, head: 'refs/codiff/pull-requests/7/head' });
    // The base tip is intentionally not used; only the PR's own changes show.
    expect(refs?.base).not.toBe(baseTip);
  });
});

test('resolvePullRequestContentRefs refetches when the fetched base no longer matches the base sha', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'base\n');
    await commitAll(repo, 'base');
    const mergeBase = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    await writeRepoFile(repo, 'file.txt', 'head change\n');
    await commitAll(repo, 'head');
    const headSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['update-ref', 'refs/codiff/pull-requests/7/head', headSha]);
    await git(repo, ['checkout', '-q', mergeBase]);
    await writeRepoFile(repo, 'file.txt', 'base advanced\n');
    await commitAll(repo, 'base advanced');
    const baseTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['update-ref', 'refs/codiff/pull-requests/7/base', baseTip]);

    // GitHub reports a base sha that no longer matches the fetched base ref (the
    // base branch moved or the pull request was retargeted). Resolution must
    // refetch rather than diff against the stale local base; with no remote
    // configured here the refetch fails and resolution reports it cannot resolve.
    const refs = await resolvePullRequestContentRefs(repo, pullRequestFixture, {
      base: { ref: 'main', sha: '0'.repeat(40) },
      head: { sha: headSha },
    });

    expect(refs).toBeNull();
  });
});

test('getPullRequestHeadImageSource uses fork repository metadata', () => {
  expect(
    getPullRequestHeadImageSource(
      {
        number: 25,
        owner: 'base-owner',
        repo: 'base-repo',
        url: 'https://github.com/base-owner/base-repo/pull/25',
      },
      {
        head: {
          repo: {
            name: 'fork-repo',
            owner: {
              login: 'fork-owner',
            },
          },
          sha: 'fork-head-sha',
        },
      },
    ),
  ).toEqual({
    owner: 'fork-owner',
    ref: 'fork-head-sha',
    repo: 'fork-repo',
  });
});

test('getPullRequestHeadImageSource falls back to the base repository PR head ref', () => {
  expect(
    getPullRequestHeadImageSource(
      {
        number: 25,
        owner: 'base-owner',
        repo: 'base-repo',
        url: 'https://github.com/base-owner/base-repo/pull/25',
      },
      {
        head: {
          sha: 'fork-head-sha',
        },
      },
    ),
  ).toEqual({
    owner: 'base-owner',
    ref: 'refs/pull/25/head',
    repo: 'base-repo',
  });
});

test('normalizeGitHubReviewComment preserves multi-line ranges', () => {
  expect(
    normalizeGitHubReviewComment({
      body: 'Check these together.',
      created_at: '2026-05-19T00:00:00Z',
      html_url: 'https://github.com/nkzw-tech/codiff/pull/1#discussion_r1',
      id: 1,
      line: 8,
      path: 'src/file.ts',
      side: 'RIGHT',
      start_line: 5,
      start_side: 'RIGHT',
      user: {
        login: 'reviewer',
      },
    }),
  ).toMatchObject({
    body: 'Check these together.',
    filePath: 'src/file.ts',
    lineNumber: 8,
    side: 'additions',
    startLineNumber: 5,
  });
});

test('normalizeGitHubReviewComment flags comments anchored to outdated lines', () => {
  expect(
    normalizeGitHubReviewComment({
      body: 'This moved.',
      created_at: '2026-05-19T00:00:00Z',
      html_url: 'https://github.com/nkzw-tech/codiff/pull/1#discussion_r7',
      id: 7,
      line: null,
      original_line: 12,
      path: 'src/file.ts',
      side: 'RIGHT',
      user: {
        login: 'reviewer',
      },
    }),
  ).toMatchObject({
    body: 'This moved.',
    isOutdated: true,
    lineNumber: 12,
  });
});

test('normalizeGitHubReviewComment leaves current comments unflagged', () => {
  const comment = normalizeGitHubReviewComment({
    body: 'Still current.',
    created_at: '2026-05-19T00:00:00Z',
    html_url: 'https://github.com/nkzw-tech/codiff/pull/1#discussion_r8',
    id: 8,
    line: 20,
    path: 'src/file.ts',
    side: 'RIGHT',
    user: {
      login: 'reviewer',
    },
  });

  expect(comment).toMatchObject({ lineNumber: 20 });
  expect(comment).not.toHaveProperty('isOutdated');
});

test('collectResolvedReviewCommentIds gathers comment ids from resolved threads only', () => {
  expect(
    collectResolvedReviewCommentIds([
      {
        comments: { nodes: [{ databaseId: 1 }, { databaseId: 2 }] },
        isResolved: true,
      },
      {
        comments: { nodes: [{ databaseId: 3 }] },
        isResolved: false,
      },
      {
        comments: { nodes: [{ databaseId: 4 }, { databaseId: null }] },
        isResolved: true,
      },
    ]),
  ).toEqual(new Set([1, 2, 4]));
});

test('collectResolvedReviewCommentIds tolerates missing thread and comment data', () => {
  expect(
    collectResolvedReviewCommentIds([
      { isResolved: true },
      { comments: null, isResolved: true },
      { comments: { nodes: undefined }, isResolved: true },
    ]),
  ).toEqual(new Set());
});

test('selectUnresolvedReviewComments drops comments that belong to resolved threads', () => {
  const comments = [
    {
      body: 'This is resolved already.',
      id: 1,
      line: 5,
      path: 'src/a.ts',
      side: 'RIGHT',
      user: { login: 'reviewer' },
    },
    {
      body: 'This still needs attention.',
      id: 2,
      line: 8,
      path: 'src/b.ts',
      side: 'RIGHT',
      user: { login: 'reviewer' },
    },
  ];

  const result = selectUnresolvedReviewComments(comments, new Set([1]));

  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    body: 'This still needs attention.',
    filePath: 'src/b.ts',
    id: 'github:2',
  });
});

test('selectUnresolvedReviewComments keeps every comment when nothing is resolved', () => {
  const comments = [
    { body: 'One.', id: 10, line: 1, path: 'src/a.ts', side: 'RIGHT', user: { login: 'reviewer' } },
    { body: 'Two.', id: 11, line: 2, path: 'src/a.ts', side: 'RIGHT', user: { login: 'reviewer' } },
  ];

  expect(selectUnresolvedReviewComments(comments, new Set()).map((comment) => comment.id)).toEqual([
    'github:10',
    'github:11',
  ]);
});

test('normalizeGitHubPullRequestCommit reads GitHub PR commit metadata', () => {
  expect(
    normalizeGitHubPullRequestCommit({
      author: {
        avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
      },
      commit: {
        author: {
          date: '2026-05-22T12:34:56Z',
          email: 'author@example.com',
          name: 'PR Author',
        },
        message: 'Feature commit\n\nBody',
      },
      parents: [{ sha: 'parent-sha' }],
      sha: 'commit-sha',
    }),
  ).toEqual({
    author: 'PR Author',
    committedAt: Date.parse('2026-05-22T12:34:56Z'),
    gravatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    parents: ['parent-sha'],
    ref: 'commit-sha',
    scope: 'pull-request',
    subject: 'Feature commit',
  });
});

test('normalizePullRequestComment uses the start side for ranged comments', () => {
  expect(
    normalizePullRequestComment({
      body: 'Check the old context.',
      filePath: 'src/file.ts',
      lineNumber: 8,
      side: 'additions',
      startLineNumber: 5,
      startSide: 'deletions',
    }),
  ).toMatchObject({
    body: 'Check the old context.',
    line: 8,
    path: 'src/file.ts',
    side: 'RIGHT',
    start_line: 5,
    start_side: 'LEFT',
  });
});

test('parseStatus preserves staged and unstaged flags on the same file', () => {
  expect(parseStatus('MM file.txt\0')).toEqual([
    {
      oldPath: undefined,
      path: 'file.txt',
      staged: true,
      status: 'modified',
      unstaged: true,
      untracked: false,
    },
  ]);
});

test('readWorkingTreeState separates staged and unstaged modifications', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'one\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'file.txt', 'two\n');
    await git(repo, ['add', 'file.txt']);
    await writeRepoFile(repo, 'file.txt', 'three\n');

    const state = await readWorkingTreeState(repo);

    expect(state.root).toBe(repo);
    expect(state.files).toHaveLength(1);
    expect(state.files[0].path).toBe('file.txt');
    expect(state.files[0].status).toBe('modified');
    expect(state.files[0].sections.map((section) => section.kind)).toEqual(['staged', 'unstaged']);
    expect(state.files[0].sections[0].oldFile?.contents).toBe('one\n');
    expect(state.files[0].sections[0].newFile?.contents).toBe('two\n');
    expect(state.files[0].sections[1].oldFile?.contents).toBe('two\n');
    expect(state.files[0].sections[1].newFile?.contents).toBe('three\n');
  });
});

test('readWorkingTreeState ignores files saved only in the stash', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'tracked.txt', 'tracked\n');
    await writeRepoFile(repo, 'other.txt', 'other\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'tracked.txt', 'stashed tracked\n');
    await writeRepoFile(repo, 'new.txt', 'stashed untracked\n');
    await git(repo, ['stash', 'push', '--include-untracked', '-m', 'codiff test stash']);
    await writeRepoFile(repo, 'other.txt', 'visible local change\n');

    const state = await readWorkingTreeState(repo);

    expect(state.files.map((file) => file.path)).toEqual(['other.txt']);
    expect(state.files[0].sections[0].newFile?.contents).toBe('visible local change\n');
  });
});

test('readRepositoryState and history handle fresh repositories', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'notes/todo.txt', 'write tests\n');

    const [state, history] = await Promise.all([
      readRepositoryState(repo),
      listRepositoryHistory(repo),
    ]);

    expect(history).toEqual({
      entries: [],
      root: repo,
    });
    expect(state.root).toBe(repo);
    expect(state.files.map((file) => file.path)).toEqual(['notes/todo.txt']);
  });
});

test('readRepositoryState reports commit metadata for root commits', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'notes/todo.txt', 'write tests\nship polish\n');
    await commitAll(repo, 'initial commit');
    const commit = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    const state = await readRepositoryState(repo, { ref: commit, type: 'commit' });
    const metadata = state.commitMetadata;

    if (!metadata) {
      throw new Error('Expected commit metadata.');
    }
    expect(metadata.ref).toBe(commit);
    expect(metadata.subject).toBe('initial commit');
    expect(metadata.parents).toEqual([]);
    expect(metadata.stats).toEqual({
      additions: 2,
      binaryFiles: 0,
      deletions: 0,
      files: 1,
      renamedFiles: 0,
    });
    expect(metadata.files).toEqual([
      {
        additions: 2,
        binary: false,
        deletions: 0,
        oldPath: undefined,
        path: 'notes/todo.txt',
        status: 'added',
      },
    ]);
  });
});

test('readRepositoryState reports commit body, trailers, refs, and rename stats', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'old.txt', 'one\n');
    await commitAll(repo, 'initial commit');
    await git(repo, ['mv', 'old.txt', 'new.txt']);
    await writeRepoFile(repo, 'new.txt', 'one\ntwo\n');
    await git(repo, ['add', '--all']);
    await git(repo, [
      'commit',
      '-m',
      'rename file',
      '-m',
      'Detailed comment.',
      '-m',
      'Co-authored-by: Second Author <second@example.com>',
    ]);
    const commit = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['tag', 'v-test', commit]);

    const state = await readRepositoryState(repo, { ref: 'HEAD', type: 'commit' });
    const metadata = state.commitMetadata;

    if (!metadata) {
      throw new Error('Expected commit metadata.');
    }
    expect(metadata.ref).toBe(commit);
    expect(metadata.body).toBe('Detailed comment.');
    expect(metadata.body).not.toContain('Co-authored-by');
    expect(metadata.trailers).toEqual([
      {
        key: 'Co-authored-by',
        value: 'Second Author <second@example.com>',
      },
    ]);
    expect(metadata.refs).toContain('v-test');
    expect(metadata.stats).toMatchObject({
      additions: 1,
      binaryFiles: 0,
      deletions: 0,
      files: 1,
      renamedFiles: 1,
    });
    expect(metadata.files).toEqual([
      {
        additions: 1,
        binary: false,
        deletions: 0,
        oldPath: 'old.txt',
        path: 'new.txt',
        status: 'renamed',
      },
    ]);
  });
});

test('readRepositoryState preserves numstat for committed paths with tabs', async () => {
  await withRepo(async (repo) => {
    const path = 'notes/with\ttab.txt';
    await writeRepoFile(repo, path, 'one\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, path, 'one\ntwo\n');
    await commitAll(repo, 'modify tab path');

    const state = await readRepositoryState(repo, { ref: 'HEAD', type: 'commit' });
    const metadata = state.commitMetadata;

    if (!metadata) {
      throw new Error('Expected commit metadata.');
    }
    expect(metadata.stats).toMatchObject({
      additions: 1,
      deletions: 0,
      files: 1,
    });
    expect(metadata.files).toEqual([
      {
        additions: 1,
        binary: false,
        deletions: 0,
        oldPath: undefined,
        path,
        status: 'modified',
      },
    ]);
  });
});

test('readRepositoryState opens branch refs as history-focused sources', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'base\n');
    await commitAll(repo, 'initial commit');
    const baseBranch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();

    await git(repo, ['checkout', '-b', 'feature']);
    await writeRepoFile(repo, 'file.txt', 'feature one\n');
    await commitAll(repo, 'feature one');
    await writeRepoFile(repo, 'file.txt', 'feature two\n');
    await commitAll(repo, 'feature two');

    await git(repo, ['checkout', baseBranch]);
    await writeRepoFile(repo, 'file.txt', 'main change\n');
    await commitAll(repo, 'main change');

    const [state, history] = await Promise.all([
      readRepositoryState(repo, { ref: 'feature', type: 'branch' }),
      listRepositoryHistory(repo, 10, { ref: 'feature', type: 'branch' }),
    ]);

    expect(state.files).toEqual([]);
    expect(state.source).toEqual({ ref: 'feature', type: 'branch' });
    expect(history.entries.map((entry) => (entry as { subject: string }).subject)).toEqual([
      'feature two',
      'feature one',
      'initial commit',
    ]);
  });
});

test('readWorkingTreeState reports staged pure renames with old and new paths', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'old.txt', 'same contents\n');
    await commitAll(repo, 'initial commit');
    await git(repo, ['mv', 'old.txt', 'new.txt']);

    const state = await readWorkingTreeState(repo);

    expect(state.files).toHaveLength(1);
    expect(state.files[0].oldPath).toBe('old.txt');
    expect(state.files[0].path).toBe('new.txt');
    expect(state.files[0].status).toBe('renamed');
    expect(state.files[0].sections).toHaveLength(1);
    expect(state.files[0].sections[0].kind).toBe('staged');
    expect(state.files[0].sections[0].oldFile?.name).toBe('old.txt');
    expect(state.files[0].sections[0].oldFile?.contents).toBe('same contents\n');
    expect(state.files[0].sections[0].newFile?.name).toBe('new.txt');
    expect(state.files[0].sections[0].newFile?.contents).toBe('same contents\n');
  });
});

test('readWorkingTreeState reports staged and unstaged deletions', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'staged-delete.txt', 'staged\n');
    await writeRepoFile(repo, 'unstaged-delete.txt', 'unstaged\n');
    await commitAll(repo, 'initial commit');
    await git(repo, ['rm', 'staged-delete.txt']);
    await rm(join(repo, 'unstaged-delete.txt'));

    const state = await readWorkingTreeState(repo);
    const stagedDelete = state.files.find((file) => file.path === 'staged-delete.txt');
    const unstagedDelete = state.files.find((file) => file.path === 'unstaged-delete.txt');

    expect(stagedDelete?.status).toBe('deleted');
    expect(stagedDelete?.sections).toHaveLength(1);
    expect(stagedDelete?.sections[0].kind).toBe('staged');
    expect(stagedDelete?.sections[0].oldFile?.contents).toBe('staged\n');
    expect(stagedDelete?.sections[0].newFile?.contents).toBe('');

    expect(unstagedDelete?.status).toBe('deleted');
    expect(unstagedDelete?.sections).toHaveLength(1);
    expect(unstagedDelete?.sections[0].kind).toBe('unstaged');
    expect(unstagedDelete?.sections[0].oldFile?.contents).toBe('unstaged\n');
    expect(unstagedDelete?.sections[0].newFile?.contents).toBe('');
  });
});

test('readWorkingTreeState reports untracked text and binary files', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'tracked.txt', 'tracked\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'notes/new.txt', 'untracked\n');
    await writeRepoFile(repo, 'raw.bin', Uint8Array.from([0, 1, 2, 3]));

    const state = await readWorkingTreeState(repo);
    const textFile = state.files.find((file) => file.path === 'notes/new.txt');
    const binaryFile = state.files.find((file) => file.path === 'raw.bin');

    expect(textFile?.status).toBe('untracked');
    expect(textFile?.sections).toHaveLength(1);
    expect(textFile?.sections[0].kind).toBe('unstaged');
    expect(textFile?.sections[0].binary).toBe(false);
    expect(textFile?.sections[0].oldFile?.contents).toBe('');
    expect(textFile?.sections[0].newFile?.contents).toBe('untracked\n');
    expect(textFile?.sections[0].patch).toContain('new file mode');

    expect(binaryFile?.status).toBe('untracked');
    expect(binaryFile?.sections).toHaveLength(1);
    expect(binaryFile?.sections[0].kind).toBe('unstaged');
    expect(binaryFile?.sections[0].binary).toBe(true);
    expect(binaryFile?.sections[0].newFile).toBeUndefined();
  });
});

test('readWorkingTreeState defers large untracked text files and loads them on demand', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'tracked.txt', 'tracked\n');
    await commitAll(repo, 'initial commit');
    const contents = `${'large line\n'.repeat(100_000)}end\n`;
    await writeRepoFile(repo, 'large.txt', contents);

    const state = await readWorkingTreeState(repo);
    const file = state.files.find((candidate) => candidate.path === 'large.txt');
    const section = file?.sections[0];

    expect(file?.status).toBe('untracked');
    expect(section?.loadState).toBe('deferred');
    expect(section?.newFile).toBeUndefined();
    expect(section?.patch).toBe('');

    const loadedSection = await readDiffSectionContent(repo, {
      force: true,
      kind: 'unstaged',
      path: 'large.txt',
    });

    expect(loadedSection.loadState).toBe('ready');
    expect(loadedSection.newFile?.contents).toBe(contents);
    expect(loadedSection.patch).toContain('new file mode');
  });
});

test('readWorkingTreeState summarizes extremely large untracked files', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'tracked.txt', 'tracked\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'huge.txt', 'x'.repeat(2 * 1024 * 1024 + 1));

    const state = await readWorkingTreeState(repo);
    const section = state.files.find((file) => file.path === 'huge.txt')?.sections[0];

    expect(section?.loadState).toBe('too-large');
    expect(section?.summary?.canLoad).toBe(false);
    expect(section?.newFile).toBeUndefined();
    expect(section?.patch).toBe('');
  });
});

test('readWorkingTreeState collapses generated untracked directories', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'tracked.txt', 'tracked\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
    await writeRepoFile(repo, 'packages/app/node_modules/pkg/index.js', 'module.exports = 2;\n');
    await writeRepoFile(repo, 'src/new.ts', 'export const value = 1;\n');

    const state = await readWorkingTreeState(repo);
    const paths = state.files.map((file) => file.path);
    const nodeModules = state.files.find((file) => file.path === 'node_modules');
    const nestedNodeModules = state.files.find((file) => file.path === 'packages/app/node_modules');
    const sourceFile = state.files.find((file) => file.path === 'src/new.ts');

    expect(paths).not.toContain('node_modules/pkg/index.js');
    expect(paths).not.toContain('packages/app/node_modules/pkg/index.js');
    expect(nodeModules?.status).toBe('untracked');
    expect(nodeModules?.sections[0].loadState).toBe('directory');
    expect(nestedNodeModules?.sections[0].loadState).toBe('directory');
    expect(sourceFile?.sections[0].loadState).toBe('ready');
    expect(sourceFile?.sections[0].newFile?.contents).toBe('export const value = 1;\n');
  });
});

test('readWorkingTreeState marks modified binary files as binary sections', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'raw.bin', Uint8Array.from([0, 1, 2, 3]));
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'raw.bin', Uint8Array.from([0, 9, 2, 3]));

    const state = await readWorkingTreeState(repo);

    expect(state.files).toHaveLength(1);
    expect(state.files[0].path).toBe('raw.bin');
    expect(state.files[0].status).toBe('modified');
    expect(state.files[0].sections).toHaveLength(1);
    expect(state.files[0].sections[0].binary).toBe(true);
    expect(state.files[0].sections[0].oldFile).toBeUndefined();
    expect(state.files[0].sections[0].newFile).toBeUndefined();
  });
});

test('readWorkingTreeState reads changed symlinks as link text', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'target-v1.txt', 'target v1 contents\n');
    await writeRepoFile(repo, 'target-v2.txt', 'target v2 contents\n');
    await symlink('target-v1.txt', join(repo, 'link.txt'));
    await commitAll(repo, 'initial commit');
    await rm(join(repo, 'link.txt'));
    await symlink('target-v2.txt', join(repo, 'link.txt'));

    const state = await readWorkingTreeState(repo);
    const link = state.files.find((file) => file.path === 'link.txt');

    expect(link?.status).toBe('modified');
    expect(link?.sections).toHaveLength(1);
    expect(link?.sections[0].oldFile?.contents).toBe('target-v1.txt');
    expect(link?.sections[0].newFile?.contents).toBe('target-v2.txt');
    expect(link?.sections[0].patch).toContain('-target-v1.txt');
    expect(link?.sections[0].patch).toContain('+target-v2.txt');
  });
});

test('readRepositoryChangeSignature changes for unstaged content edits', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'one\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'file.txt', 'two changed\n');

    const before = await readRepositoryChangeSignature(repo);
    await writeRepoFile(repo, 'file.txt', 'three\n');
    const after = await readRepositoryChangeSignature(repo);

    expect(before.root).toBe(repo);
    expect(after.signature).not.toBe(before.signature);
  });
});

test('readRepositoryChangeSignature ignores staging and unstaging tracked changes', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'one\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'file.txt', 'two changed\n');

    const before = await readRepositoryChangeSignature(repo);
    await git(repo, ['add', 'file.txt']);
    const staged = await readRepositoryChangeSignature(repo);
    await git(repo, ['reset', 'HEAD', '--', 'file.txt']);
    const unstaged = await readRepositoryChangeSignature(repo);

    expect(staged.signature).toBe(before.signature);
    expect(unstaged.signature).toBe(before.signature);
  });
});

test('readRepositoryChangeSignature changes for untracked content edits', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'one\n');

    const before = await readRepositoryChangeSignature(repo);
    await writeRepoFile(repo, 'file.txt', 'two changed\n');
    const after = await readRepositoryChangeSignature(repo);

    expect(after.signature).not.toBe(before.signature);
  });
});

test('readRepositoryChangeSignature changes for edits inside untracked directories', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'nested/file.txt', 'one\n');

    const before = await readRepositoryChangeSignature(repo);
    await writeRepoFile(repo, 'nested/file.txt', 'two changed\n');
    const after = await readRepositoryChangeSignature(repo);

    expect(after.signature).not.toBe(before.signature);
  });
});

test('readWorkingTreeState changes binary fingerprints when binary contents change', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'raw.bin', Uint8Array.from([0, 1, 2, 3]));
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'raw.bin', Uint8Array.from([0, 9, 2, 3]));

    const before = await readWorkingTreeState(repo);
    await writeRepoFile(repo, 'raw.bin', Uint8Array.from([0, 8, 2, 3]));
    const after = await readWorkingTreeState(repo);

    expect(after.files[0].fingerprint).not.toBe(before.files[0].fingerprint);
  });
});

test('readRepositoryChangeSignature ignores staging and unstaging untracked files', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'one\n');

    const before = await readRepositoryChangeSignature(repo);
    await git(repo, ['add', 'file.txt']);
    const staged = await readRepositoryChangeSignature(repo);
    await git(repo, ['reset', 'HEAD', '--', 'file.txt']);
    const unstaged = await readRepositoryChangeSignature(repo);

    expect(staged.signature).toBe(before.signature);
    expect(unstaged.signature).toBe(before.signature);
  });
});

test('readRepositoryChangeSignature ignores staging and unstaging renamed files', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'old.txt', 'one\n');
    await commitAll(repo, 'initial commit');
    await git(repo, ['mv', 'old.txt', 'new.txt']);
    await git(repo, ['reset', 'HEAD', '--', 'old.txt', 'new.txt']);

    const before = await readRepositoryChangeSignature(repo);
    await git(repo, ['add', '--all']);
    const staged = await readRepositoryChangeSignature(repo);
    await git(repo, ['reset', 'HEAD', '--', 'old.txt', 'new.txt']);
    const unstaged = await readRepositoryChangeSignature(repo);

    expect(staged.signature).toBe(before.signature);
    expect(unstaged.signature).toBe(before.signature);
  });
});

test('readRepositoryChangeSignature changes when a commit is made', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'one\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'file.txt', 'two changed\n');

    const before = await readRepositoryChangeSignature(repo);
    await commitAll(repo, 'second commit');
    const after = await readRepositoryChangeSignature(repo);

    expect(after.signature).not.toBe(before.signature);
  });
});

test('readRepositoryState reads commit diffs from short hashes', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'one\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'file.txt', 'two\n');
    await writeRepoFile(repo, 'new.txt', 'created\n');
    await commitAll(repo, 'second commit');
    const commit = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const shortCommit = commit.slice(0, 8);

    const state = await readRepositoryState(repo, {
      ref: shortCommit,
      type: 'commit',
    });

    expect(state.source).toEqual({
      ref: commit,
      type: 'commit',
    });
    expect(state.files.map((file) => file.path).sort()).toEqual(['file.txt', 'new.txt']);
    expect(state.files.every((file) => file.sections[0]?.kind === 'commit')).toBe(true);
    expect(state.files.find((file) => file.path === 'file.txt')?.sections[0].patch).toContain(
      '+two',
    );
  });
});

test('readRepositoryState reads merge commits against the first parent', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'base.txt', 'base\n');
    await commitAll(repo, 'initial commit');
    const baseBranch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();

    await git(repo, ['checkout', '-b', 'feature']);
    await writeRepoFile(repo, 'feature.txt', 'feature\n');
    await commitAll(repo, 'feature commit');
    await git(repo, ['checkout', baseBranch]);
    await git(repo, ['merge', '--no-ff', 'feature', '-m', 'merge feature']);

    const mergeCommit = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const state = await readRepositoryState(repo, {
      ref: mergeCommit,
      type: 'commit',
    });

    expect(state.files.map((file) => file.path)).toEqual(['feature.txt']);
    expect(state.files[0].sections[0].oldFile?.contents).toBe('');
    expect(state.files[0].sections[0].newFile?.contents).toBe('feature\n');
    expect(state.files[0].sections[0].patch).toContain('+feature');
  });
});

test('benchmarks commit diff generation duration for many changed files', async () => {
  await withRepo(async (repo) => {
    const fileCount = 80;
    await Promise.all(
      Array.from({ length: fileCount }, (_, index) =>
        writeRepoFile(
          repo,
          `src/module-${index.toString().padStart(3, '0')}.ts`,
          `${'export const beforeValue = 1;\n'.repeat(60)}export const file = ${index};\n`,
        ),
      ),
    );
    await commitAll(repo, 'initial commit');
    await Promise.all(
      Array.from({ length: fileCount }, (_, index) =>
        writeRepoFile(
          repo,
          `src/module-${index.toString().padStart(3, '0')}.ts`,
          `${'export const afterValue = 2;\n'.repeat(80)}export const file = ${index};\n`,
        ),
      ),
    );
    await commitAll(repo, 'large history commit');
    const commit = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    const startedAt = performance.now();
    const state = await readRepositoryState(repo, {
      ref: commit,
      type: 'commit',
    });
    const duration = performance.now() - startedAt;

    expect(state.files).toHaveLength(fileCount);
    expect(duration).toBeLessThan(5000);
  });
});

test('readRepositoryState summarizes committed files over the manual text limit', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'base.txt', 'base\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'huge.txt', 'x'.repeat(2 * 1024 * 1024 + 1));
    await commitAll(repo, 'large commit');

    const state = await readRepositoryState(repo, {
      ref: 'HEAD',
      type: 'commit',
    });
    const section = state.files.find((file) => file.path === 'huge.txt')?.sections[0];

    expect(section?.loadState).toBe('too-large');
    expect(section?.summary?.canLoad).toBe(false);
    expect(section?.newFile).toBeUndefined();
    expect(section?.patch).toBe('');
  });
});

test('readRepositoryState defers medium committed files and loads them on demand', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'base.txt', 'base\n');
    await commitAll(repo, 'initial commit');
    const contents = `${'large committed line\n'.repeat(60_000)}end\n`;
    await writeRepoFile(repo, 'large.txt', contents);
    await commitAll(repo, 'large commit');
    const commit = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    const state = await readRepositoryState(repo, {
      ref: commit,
      type: 'commit',
    });
    const section = state.files.find((file) => file.path === 'large.txt')?.sections[0];

    expect(section?.loadState).toBe('deferred');
    expect(section?.summary?.canLoad).toBe(true);
    expect(section?.newFile).toBeUndefined();
    expect(section?.patch).toBe('');

    const loadedSection = await readDiffSectionContent(repo, {
      force: true,
      kind: 'commit',
      path: 'large.txt',
      source: {
        ref: commit,
        type: 'commit',
      },
    });

    expect(loadedSection.loadState).toBe('ready');
    expect(loadedSection.newFile?.contents).toBe(contents);
    expect(loadedSection.patch).toContain('+large committed line');
  });
});

test('readRepositoryState rejects non-repository launch paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-not-a-repo-'));
  try {
    await expect(readRepositoryState(directory)).rejects.toThrow(/not a git repository/i);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
