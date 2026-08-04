import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, test } from 'vite-plus/test';

const { readPullRequestSectionsContent, readPullRequestState } =
  require('../git-state/pull-request.cjs') as {
    readPullRequestState: (
      repoRoot: string,
      source: { type: 'pull-request'; url: string },
    ) => Promise<import('../../core/types.ts').RepositoryState>;
    readPullRequestSectionsContent: (
      repoRoot: string,
      source: Extract<import('../../core/types.ts').ReviewSource, { type: 'pull-request' }>,
    ) => Promise<import('../../core/types.ts').DiffSectionsContentResult>;
  };
const { rangeArtifactToPullRequestFiles } = require('../git-state/review-range-sections.cjs') as {
  rangeArtifactToPullRequestFiles: (
    artifact: import('../../core/index.ts').RangeArtifact,
    number: number,
  ) => ReadonlyArray<import('../../core/types.ts').ChangedFile>;
};

test('renders returned files and a warning when overall Range Artifact coverage is truncated', () => {
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const files = rangeArtifactToPullRequestFiles(
    {
      baseSha,
      coverage: 'truncated',
      files: [
        {
          coverage: 'complete',
          lineCount: { additions: 1, deletions: 1 },
          patch: '@@ -1 +1 @@\n-old\n+new',
          path: 'src/app.ts',
          status: 'modified',
        },
      ],
      headSha,
      incompleteReason: 'GitLab returned only the first changed file.',
      provenance: {
        kind: 'gitlab-api',
        project: { host: 'gitlab.example.com', project: 'group/project', provider: 'gitlab' },
      },
    },
    7,
  );

  expect(files[0]?.sections[0]).toMatchObject({
    lineCount: { additions: 1, deletions: 1 },
    loadState: 'ready',
    patch: expect.stringContaining('+new'),
    summary: {
      canLoad: true,
      reason: 'Showing the provider patch for this file.',
    },
  });
  expect(files[0]?.sections[0]?.summary?.reason).not.toContain('Artifact coverage');
  expect(files).toHaveLength(2);
  expect(files[1]).toMatchObject({ path: 'Review diff incomplete', status: 'modified' });
  expect(files[1]?.sections[0]).toMatchObject({
    id: 'review-range-incomplete:7',
    loadState: 'error',
    summary: {
      canLoad: false,
      reason: 'GitLab returned only the first changed file.',
    },
  });
  expect(files[1]?.sections[0]).not.toHaveProperty('range');
});

test('keeps coverage warning identity distinct from real repository paths', () => {
  const files = rangeArtifactToPullRequestFiles(
    {
      baseSha: 'a'.repeat(40),
      coverage: 'truncated',
      files: [
        {
          coverage: 'complete',
          patch: '@@ -1 +1 @@\n-old\n+new',
          path: 'Review diff incomplete',
          status: 'modified',
        },
        {
          coverage: 'complete',
          patch: '@@ -1 +1 @@\n-old\n+new',
          path: 'Review diff incomplete (2)',
          status: 'modified',
        },
      ],
      headSha: 'b'.repeat(40),
      incompleteReason: 'The provider response was truncated.',
      provenance: {
        kind: 'gitlab-api',
        project: { host: 'gitlab.example.com', project: 'group/project', provider: 'gitlab' },
      },
    },
    7,
  );

  expect(files.map((file) => file.path)).toEqual([
    'Review diff incomplete',
    'Review diff incomplete (2)',
    'Review diff incomplete (3)',
  ]);
});

test('keeps a complete empty Range Artifact empty', () => {
  const files = rangeArtifactToPullRequestFiles(
    {
      baseSha: 'a'.repeat(40),
      coverage: 'complete',
      files: [],
      headSha: 'b'.repeat(40),
      provenance: {
        kind: 'gitlab-api',
        project: { host: 'gitlab.example.com', project: 'group/project', provider: 'gitlab' },
      },
    },
    7,
  );

  expect(files).toEqual([]);
});

test('renders a visible unavailable item for a wholly truncated Range Artifact', () => {
  const files = rangeArtifactToPullRequestFiles(
    {
      baseSha: 'a'.repeat(40),
      coverage: 'truncated',
      files: [],
      headSha: 'b'.repeat(40),
      incompleteReason: 'GitLab merge request diffs exceeded the 8.0 MiB limit.',
      provenance: {
        kind: 'gitlab-api',
        project: { host: 'gitlab.example.com', project: 'group/project', provider: 'gitlab' },
      },
    },
    7,
  );

  expect(files).toEqual([
    expect.objectContaining({ path: 'Review diff unavailable', status: 'modified' }),
  ]);
  expect(files[0]?.sections[0]).toMatchObject({
    loadState: 'error',
    summary: {
      canLoad: false,
      reason: 'GitLab merge request diffs exceeded the 8.0 MiB limit.',
    },
  });
  expect(files[0]?.sections[0]).not.toHaveProperty('range');
});

const { createGitLabPosition, readMergeRequestSectionsContent, readMergeRequestState } =
  require('../git-state/merge-request.cjs') as {
    createGitLabPosition: (comment: unknown, metadata: unknown, diff?: unknown) => unknown;
    readMergeRequestState: (
      repoRoot: string,
      source: { provider: 'gitlab'; type: 'pull-request'; url: string },
    ) => Promise<import('../../core/types.ts').RepositoryState>;
    readMergeRequestSectionsContent: (
      repoRoot: string,
      source: Extract<import('../../core/types.ts').ReviewSource, { type: 'pull-request' }>,
    ) => Promise<import('../../core/types.ts').DiffSectionsContentResult>;
  };

const git = (directory: string, args: ReadonlyArray<string>) =>
  execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();

const createRepository = async (remote: string) => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-provider-state-'));
  execFileSync('git', ['init', '--quiet', directory]);
  git(directory, ['config', 'user.email', 'codiff@example.com']);
  git(directory, ['config', 'user.name', 'Codiff Test']);
  git(directory, ['remote', 'add', 'origin', remote]);
  return directory;
};

const createReviewRange = async (
  directory: string,
  refs: { base: string; head: string },
  paths: ReadonlyArray<string> = ['src/app.ts'],
) => {
  await mkdir(join(directory, 'src'), { recursive: true });
  await Promise.all(paths.map((path) => writeFile(join(directory, path), `old ${path}\n`, 'utf8')));
  git(directory, ['add', '.']);
  git(directory, ['commit', '--quiet', '-m', 'Create review base']);
  const baseSha = git(directory, ['rev-parse', 'HEAD']);
  await Promise.all(paths.map((path) => writeFile(join(directory, path), `new ${path}\n`, 'utf8')));
  git(directory, ['add', '.']);
  git(directory, ['commit', '--quiet', '-m', 'Create review head']);
  const headSha = git(directory, ['rev-parse', 'HEAD']);
  git(directory, ['update-ref', refs.base, baseSha]);
  git(directory, ['update-ref', refs.head, headSha]);
  return { baseSha, headSha };
};

test('returns a GitHub Range Artifact before exact file hydration', async () => {
  const directory = await createRepository('https://github.com/nkzw-tech/codiff.git');
  const fakeGh = join(directory, 'gh');
  const callLog = join(directory, 'gh-calls.jsonl');
  const gitTrace = join(directory, 'git-trace.log');
  const { baseSha, headSha } = await createReviewRange(
    directory,
    {
      base: 'refs/codiff/pull-requests/7/base',
      head: 'refs/codiff/pull-requests/7/head',
    },
    ['src/app.ts', 'src/other.ts'],
  );
  await writeFile(
    fakeGh,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');
const resource = args.find((arg) => arg.includes('repos/')) || '';
if (resource.includes('/compare/')) {
  process.stdout.write(JSON.stringify({
    commits: [{
      commit: { author: { date: '2026-01-01T00:00:00.000Z', name: 'Ada' }, message: 'Update app' },
      parents: [{ sha: '${baseSha}' }],
      sha: '${headSha}',
    }],
    merge_base_commit: { sha: '${baseSha}' },
    files: ['src/app.ts', 'src/other.ts'].map((path) => ({
      filename: path,
      patch: '@@ -1 +1 @@\\n-old\\n+new\\n',
      status: 'modified',
    })),
    total_commits: 1,
  }));
} else {
  process.stdout.write(JSON.stringify({
    base: { ref: 'main', sha: '${baseSha}' },
    head: { sha: '${headSha}' },
    title: 'Review Range Artifacts',
    user: { login: 'ada' },
  }));
}
`,
    'utf8',
  );
  await chmod(fakeGh, 0o755);
  const previousPath = process.env.PATH;
  const previousGitTrace = process.env.GIT_TRACE;
  process.env.PATH = `${directory}${delimiter}${previousPath ?? ''}`;
  process.env.GIT_TRACE = gitTrace;
  try {
    const source = {
      type: 'pull-request',
      url: 'https://github.com/nkzw-tech/codiff/pull/7',
    } as const;
    const state = await readPullRequestState(directory, source);

    expect(state.files).toHaveLength(2);
    expect(state.files[0]).toMatchObject({ path: 'src/app.ts', status: 'modified' });
    expect(state.files[0]?.sections[0]).toMatchObject({
      id: 'src/app.ts:pull-request:7',
      kind: 'pull-request',
      loadState: 'ready',
      range: { base: { sha: baseSha }, head: { sha: headSha } },
      summary: { canLoad: true },
    });
    expect(state.files[0]?.sections[0]?.patch).toMatch(
      /^diff --git a\/src\/app\.ts b\/src\/app\.ts/,
    );
    expect(state.files[0]?.sections[0]).not.toHaveProperty('newFile');
    expect(state.files[0]?.sections[0]).not.toHaveProperty('oldFile');
    expect(state.reviewComments).toBeUndefined();
    const [hydrated, joinedHydration] = await Promise.all([
      readPullRequestSectionsContent(directory, state.source),
      readPullRequestSectionsContent(directory, state.source),
    ]);
    expect(joinedHydration).toBe(hydrated);
    expect(hydrated.headSha).toBe(headSha);
    expect(hydrated.sections).toHaveLength(2);
    expect(hydrated.sections.map(({ path }) => path)).toEqual(['src/app.ts', 'src/other.ts']);
    expect(hydrated.sections.every(({ section }) => section.loadState === 'ready')).toBe(true);
    expect(hydrated.sections[0]?.section).toMatchObject({
      newFile: { contents: 'new src/app.ts\n', name: 'src/app.ts' },
      oldFile: { contents: 'old src/app.ts\n', name: 'src/app.ts' },
    });
    const calls = (await readFile(callLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Array<string>);
    expect(calls).toHaveLength(2);
    expect(calls.filter((args) => args.some((arg) => arg.includes('/compare/')))).toHaveLength(1);
    expect(calls.flat()).not.toContainEqual(expect.stringMatching(/\/pulls\/7\/files/));
    expect(calls.flat()).not.toContainEqual(
      expect.stringMatching(/comments|contents|graphql|application\/vnd\.github\.v3\.diff/),
    );
    const trace = (await readFile(gitTrace, 'utf8')).split('\n');
    expect(trace.filter((line) => line.includes('built-in: git ls-tree '))).toHaveLength(2);
    expect(
      trace.filter((line) => line.includes('git cat-file') && line.includes('--batch-check')),
    ).toHaveLength(2);
    expect(trace.filter((line) => line.endsWith('git cat-file --batch'))).toHaveLength(2);
  } finally {
    if (previousPath == null) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousGitTrace == null) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previousGitTrace;
  }
}, 30_000);

test('returns a GitLab Range Artifact before exact file hydration', async () => {
  const directory = await createRepository('https://gitlab.example.com/group/project.git');
  const fakeGlab = join(directory, 'glab');
  const callLog = join(directory, 'glab-calls.jsonl');
  const { baseSha, headSha } = await createReviewRange(
    directory,
    {
      base: 'refs/codiff/merge-requests/7/base',
      head: 'refs/codiff/merge-requests/7/head',
    },
    ['src/app.ts', 'src/other.ts'],
  );
  const startSha = 'd'.repeat(40);
  await writeFile(
    fakeGlab,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');
const resource = args.find((arg) => arg.includes('projects/')) || '';
if (resource.includes('/repository/compare?')) {
  process.stdout.write(JSON.stringify({
    commits: [{
      authored_date: '2026-01-01T00:00:00.000Z',
      author_name: 'Ada',
      id: '${headSha}',
      parent_ids: ['${baseSha}'],
      title: 'Update app',
    }],
    diffs: ['src/app.ts', 'src/other.ts'].map((path) => ({
      a_mode: '100644',
      b_mode: '100644',
      diff: '@@ -1 +1 @@\\n-old\\n+new',
      new_path: path,
      old_path: path,
    })),
  }));
} else {
  process.stdout.write(JSON.stringify({
    author: { username: 'ada' },
    diff_refs: { base_sha: '${baseSha}', head_sha: '${headSha}', start_sha: '${startSha}' },
    sha: '${headSha}',
    title: 'Review Range Artifacts',
    web_url: 'https://gitlab.example.com/group/project/-/merge_requests/7',
  }));
}
`,
    'utf8',
  );
  await chmod(fakeGlab, 0o755);
  const previous = process.env.CODIFF_GLAB_PATH;
  process.env.CODIFF_GLAB_PATH = fakeGlab;
  try {
    const source = {
      provider: 'gitlab',
      type: 'pull-request',
      url: 'https://gitlab.example.com/group/project/-/merge_requests/7',
    } as const;
    const state = await readMergeRequestState(directory, source);

    expect(state.files).toHaveLength(2);
    expect(state.files[0]).toMatchObject({ path: 'src/app.ts', status: 'modified' });
    expect(state.files[0]?.sections[0]).toMatchObject({
      id: 'src/app.ts:pull-request:7',
      kind: 'pull-request',
      loadState: 'ready',
      range: { base: { sha: baseSha }, head: { sha: headSha } },
      summary: { canLoad: true },
    });
    expect(state.files[0]?.sections[0]?.patch).toMatch(
      /^diff --git a\/src\/app\.ts b\/src\/app\.ts/,
    );
    expect(state.files[0]?.sections[0]).not.toHaveProperty('newFile');
    expect(state.files[0]?.sections[0]).not.toHaveProperty('oldFile');
    expect(state.reviewComments).toBeUndefined();
    expect(state.files.every((file) => !('oldFile' in (file.sections[0] ?? {})))).toBe(true);
    expect(
      createGitLabPosition(
        { anchor: 'file', filePath: 'src/app.ts' },
        { diff_refs: { base_sha: baseSha, head_sha: headSha, start_sha: startSha } },
        { new_path: 'src/app.ts', old_path: 'src/app.ts' },
      ),
    ).toMatchObject({ base_sha: baseSha, head_sha: headSha, start_sha: startSha });
    const hydrated = await readMergeRequestSectionsContent(directory, state.source);
    expect(hydrated.headSha).toBe(headSha);
    expect(hydrated.sections).toHaveLength(2);
    expect(hydrated.sections.every(({ section }) => section.loadState === 'ready')).toBe(true);
    expect(hydrated.sections[0]?.section).toMatchObject({
      newFile: { contents: 'new src/app.ts\n', name: 'src/app.ts' },
      oldFile: { contents: 'old src/app.ts\n', name: 'src/app.ts' },
    });
    const calls = (await readFile(callLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Array<string>);
    expect(calls).toHaveLength(2);
    const compare = calls.find((args) => args.some((arg) => arg.includes('/repository/compare')));
    expect(compare).toBeDefined();
    expect(compare?.join(' ')).toContain(`from=${baseSha}`);
    expect(compare?.join(' ')).not.toContain(startSha);
    expect(calls.flat()).not.toContainEqual(expect.stringMatching(/merge_requests\/7\/diffs/));
    expect(calls.flat()).not.toContainEqual(
      expect.stringMatching(/discussions|repository\/files|versions/),
    );
  } finally {
    if (previous == null) delete process.env.CODIFF_GLAB_PATH;
    else process.env.CODIFF_GLAB_PATH = previous;
  }
}, 30_000);
