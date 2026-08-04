import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitSha } from '@nkzw/codiff-core/types';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';
import {
  captureOptionalProviderRoute,
  sanitizeProviderTranscript,
} from '../../evals/provider-mock-capture.mjs';
import {
  loadGitHubScenarioMock,
  loadGitLabScenarioMock,
} from '../../evals/provider-mock-loader.mjs';
import { createGitHubArtifactSource } from '../../github/src/index.ts';
import { createGitLabArtifactSource } from '../../gitlab/src/index.ts';

const scenarioId = 'current-review';
const revisions = {
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
};
const objectId = 'c'.repeat(40);
let fixtureRoot = '';

const githubFixture = {
  kind: 'github-test-scenario-transcript-v1',
  routes: [
    {
      path: '/repos/{{repository}}/compare/{{revision:base}}...{{revision:head}}',
      query: { page: 1, per_page: 100 },
      response: {
        commits: [
          {
            commit: {
              author: { login: 'scenario-user', username: 'scenario-user' },
              message: 'Update app',
            },
            parents: [{ sha: '{{revision:base}}' }],
            sha: '{{revision:head}}',
          },
        ],
        files: [
          {
            filename: 'src/app.ts',
            patch: '@@ -1 +1 @@\n-old\n+new\n',
            sha: objectId,
            status: 'modified',
          },
        ],
        merge_base_commit: { sha: '{{revision:base}}' },
        total_commits: 1,
      },
    },
    {
      path: '/repos/{{repository}}/commits/{{revision:head}}',
      query: { page: 1, per_page: 100 },
      response: {
        files: [
          {
            filename: 'src/app.ts',
            patch: '@@ -1 +1 @@\n-old\n+new\n',
            sha: objectId,
            status: 'modified',
          },
        ],
        parents: [{ sha: '{{revision:base}}' }],
        sha: '{{revision:head}}',
      },
    },
    {
      path: '/repos/{{repository}}/contents/src/app.ts',
      query: { ref: '{{revision:head}}' },
      response: {
        content: btoa('provider mock'),
        encoding: 'base64',
        sha: objectId,
      },
    },
    { path: '/pagination', query: { page: 1 }, response: { page: 1 } },
    { path: '/pagination', query: { page: 2 }, response: { page: 2 } },
    { path: '/pagination', response: { page: 'queryless' } },
  ],
};

const gitlabFixture = {
  kind: 'gitlab-test-scenario-transcript-v1',
  routes: [
    {
      path: '/api/v4/projects/{{encodedRepository}}/repository/compare',
      query: {
        from: '{{revision:base}}',
        straight: 'true',
        to: '{{revision:head}}',
      },
      response: {
        commits: [
          {
            authored_date: '2026-07-29T00:00:00.000Z',
            id: '{{revision:head}}',
            parent_ids: ['{{revision:base}}'],
            title: 'Update app',
          },
        ],
        diffs: [
          {
            diff: '@@ -1 +1 @@\n-old\n+new\n',
            new_path: 'src/app.ts',
            old_path: 'src/app.ts',
          },
        ],
      },
    },
    {
      path: '/api/v4/projects/{{encodedRepository}}/repository/commits/{{revision:head}}/diff',
      query: { page: 1, per_page: 100 },
      response: [
        {
          diff: '@@ -1 +1 @@\n-old\n+new\n',
          new_path: 'src/app.ts',
          old_path: 'src/app.ts',
        },
      ],
    },
    {
      path: '/api/v4/projects/{{encodedRepository}}/repository/files/src%2Fapp.ts',
      query: { ref: '{{revision:head}}' },
      response: {
        blob_id: objectId,
        content: btoa('provider mock'),
        encoding: 'base64',
      },
    },
  ],
};

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'codiff-provider-mocks-'));
  const scenarioRoot = join(fixtureRoot, scenarioId);
  await mkdir(scenarioRoot, { recursive: true });
  await Promise.all([
    writeFile(join(scenarioRoot, 'github.json'), `${JSON.stringify(githubFixture, null, 2)}\n`),
    writeFile(join(scenarioRoot, 'gitlab.json'), `${JSON.stringify(gitlabFixture, null, 2)}\n`),
  ]);
});

afterAll(async () => {
  await rm(fixtureRoot, { force: true, recursive: true });
});

const identityObjectKeys = new Set([
  'actor',
  'author',
  'assignee',
  'closed_by',
  'committer',
  'merge_user',
  'owner',
  'reviewer',
  'user',
  'viewer',
]);
const forbiddenIdentityKeys = new Set([
  'author_email',
  'author_name',
  'avatar_url',
  'committer_email',
  'committer_name',
  'email',
  'node_id',
  'public_email',
]);

const assertSanitizedTranscript = (value: unknown, key = ''): void => {
  if (Array.isArray(value)) {
    value.forEach((item) => assertSanitizedTranscript(item, key));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && value.startsWith('http')) {
      expect(value).toMatch(/^https?:\/\/(?:api\.)?provider\.example\.test\//);
    }
    return;
  }
  if (identityObjectKeys.has(key)) {
    expect(value).toEqual({ login: 'scenario-user', username: 'scenario-user' });
    return;
  }
  for (const [entryKey, item] of Object.entries(value)) {
    expect(forbiddenIdentityKeys.has(entryKey)).toBe(false);
    assertSanitizedTranscript(item, entryKey);
  }
};

test('keeps provider transcript inputs synthetic and host-neutral', async () => {
  for (const provider of ['github.json', 'gitlab.json']) {
    const transcript = JSON.parse(await readFile(join(fixtureRoot, scenarioId, provider), 'utf8'));
    assertSanitizedTranscript(transcript);
  }
});

test('checked-in provider snapshots replay through the normal eval loader', async () => {
  const scenarios = {
    'current-commit-stack': {
      head: 'e'.repeat(40),
      revisions: {
        base: 'a'.repeat(40),
        'delivery-orchestration': 'c'.repeat(40),
        'lifecycle-verification': 'e'.repeat(40),
        'policy-contract': 'b'.repeat(40),
        'preference-audit': 'd'.repeat(40),
      },
    },
    'unstructured-commits': {
      head: 'f'.repeat(40),
      revisions: {
        base: 'a'.repeat(40),
        'bucket-1': 'b'.repeat(40),
        'bucket-2': 'c'.repeat(40),
        'bucket-3': 'd'.repeat(40),
        'bucket-4': 'e'.repeat(40),
        'bucket-5': 'f'.repeat(40),
      },
    },
  };

  for (const [checkedInScenario, definition] of Object.entries(scenarios)) {
    const checkedInRevisions = definition.revisions;
    const head = definition.head as GitSha;
    const base = checkedInRevisions.base as GitSha;
    const owner = 'fixture';
    const github = await loadGitHubScenarioMock({
      owner,
      revisions: checkedInRevisions,
      scenarioId: checkedInScenario,
    });
    const githubProfile = github.transcript.routes.find(
      (route: { path: string; response?: unknown }) => route.path === '/user',
    );
    expect(githubProfile?.response).toEqual({
      login: 'scenario-user',
      username: 'scenario-user',
    });
    const githubSource = createGitHubArtifactSource({
      project: {
        host: 'github.example.test',
        project: `${owner}/${checkedInScenario}`,
        provider: 'github',
      },
      pull: { number: 1, owner, repo: checkedInScenario },
      transport: github.transport,
    });
    await expect(
      githubSource.readStackAndRange(
        { headSha: head, requestedBaseSha: base },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ range: { files: expect.any(Array) } });

    const projectPath = `fixture/${checkedInScenario}`;
    const gitlab = await loadGitLabScenarioMock({
      projectPath,
      revisions: checkedInRevisions,
      scenarioId: checkedInScenario,
    });
    const gitlabProfile = gitlab.transcript.routes.find(
      (route: { path: string; response?: unknown }) => route.path === '/api/v4/user',
    );
    expect(gitlabProfile?.response).toEqual({
      login: 'scenario-user',
      username: 'scenario-user',
    });
    const gitlabSource = createGitLabArtifactSource({
      project: {
        host: 'gitlab.example.test',
        project: projectPath,
        provider: 'gitlab',
      },
      projectPath,
      transport: gitlab.transport,
    });
    await expect(
      gitlabSource.readStackAndRange(
        { headSha: head, requestedBaseSha: base },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ range: { files: expect.any(Array) } });
  }
});

test('capture normalization removes identities and replaces repository revisions', () => {
  expect(
    sanitizeProviderTranscript(
      {
        author_email: 'person@example.com',
        commit: revisions.head,
        path: `/api/v4/projects/${encodeURIComponent(`private-owner/${scenarioId}`)}`,
        url: `https://github.com/private-owner/${scenarioId}/commit/${revisions.head}`,
        user: { avatar_url: 'https://avatars.example/person', login: 'private-user' },
      },
      {
        repository: `private-owner/${scenarioId}`,
        revisions,
        url: `https://github.com/private-owner/${scenarioId}/pull/1`,
      },
    ),
  ).toEqual({
    commit: '{{revision:head}}',
    path: '/api/v4/projects/{{encodedRepository}}',
    url: 'https://provider.example.test/{{repository}}/commit/{{revision:head}}',
    user: { login: 'scenario-user', username: 'scenario-user' },
  });
});

test('capture normalization fully anonymizes top-level provider profiles', () => {
  expect(
    sanitizeProviderTranscript(
      {
        kind: 'github-test-scenario-transcript-v1',
        routes: [
          {
            path: '/user',
            response: {
              avatar_url: 'https://avatars.example/private',
              bio: 'Private biography',
              company: 'Private company',
              id: 123,
              location: 'Private location',
              login: 'private-user',
              name: 'Private Name',
            },
          },
        ],
      },
      {
        repository: `private-owner/${scenarioId}`,
        revisions,
        url: `https://github.com/private-owner/${scenarioId}/pull/1`,
      },
    ),
  ).toEqual({
    kind: 'github-test-scenario-transcript-v1',
    routes: [
      {
        path: '/user',
        response: { login: 'scenario-user', username: 'scenario-user' },
      },
    ],
  });
});

test('optional capture suppresses only genuine provider not-found responses', async () => {
  await expect(
    captureOptionalProviderRoute(async () => {
      throw new Error('HTTP 404: Not Found');
    }),
  ).resolves.toBeNull();
  for (const reason of [
    'authentication failed',
    'authentication token not found',
    'credential not found',
    'HTTP 429: rate limit exceeded',
    'network socket disconnected',
    'malformed provider path',
  ]) {
    await expect(
      captureOptionalProviderRoute(async () => {
        throw new Error(reason);
      }),
    ).rejects.toThrow(reason);
  }
});

test('provider replay requires exact queries and distinct pagination routes', async () => {
  const { transport } = await loadGitHubScenarioMock({
    fixtureRoot,
    owner: 'fixture',
    revisions,
    scenarioId,
  });
  await expect(transport.request({ path: '/pagination', query: { page: 1 } })).resolves.toEqual({
    page: 1,
  });
  await expect(transport.request({ path: '/pagination', query: { page: 2 } })).resolves.toEqual({
    page: 2,
  });
  await expect(transport.request({ path: '/pagination', query: { page: 3 } })).rejects.toThrow(
    'No provider transcript route for GET /pagination?page=3',
  );
  await expect(transport.request({ path: '/pagination' })).resolves.toEqual({
    page: 'queryless',
  });
});

test('replays a GitHub transcript through the current-review artifact source', async () => {
  const owner = 'fixture';
  const { transport } = await loadGitHubScenarioMock({
    fixtureRoot,
    owner,
    revisions,
    scenarioId,
  });
  const source = createGitHubArtifactSource({
    project: {
      host: 'github.example.test',
      project: `${owner}/${scenarioId}`,
      provider: 'github',
    },
    pull: { number: 1, owner, repo: scenarioId },
    transport,
  });
  const signal = new AbortController().signal;
  const result = await source.readStackAndRange(
    { headSha: revisions.head as GitSha, requestedBaseSha: revisions.base as GitSha },
    signal,
  );
  const commits = await source.readCommitArtifacts(
    [{ commitSha: revisions.head as GitSha, parentSha: revisions.base as GitSha }],
    signal,
  );
  const blobs = await source.readFileBlobs?.(
    [{ path: 'src/app.ts', ref: revisions.head as GitSha }],
    signal,
  );

  expect(commits.size).toBe(1);
  expect(result.stack.commits.map((commit: { sha: string }) => commit.sha)).toEqual([
    revisions.head,
  ]);
  expect(result.range.files).toHaveLength(1);
  expect([...blobs!.values()][0]?.bytes).toEqual(new TextEncoder().encode('provider mock'));
  expect(transport.calls.map(({ path }) => path)).toEqual([
    `/repos/${owner}/${scenarioId}/compare/${revisions.base}...${revisions.head}`,
    `/repos/${owner}/${scenarioId}/commits/${revisions.head}`,
    `/repos/${owner}/${scenarioId}/contents/src/app.ts`,
  ]);
});

test('replays a GitLab transcript through the current-review artifact source', async () => {
  const projectPath = `fixture/${scenarioId}`;
  const { transport } = await loadGitLabScenarioMock({
    fixtureRoot,
    projectPath,
    revisions,
    scenarioId,
  });
  const source = createGitLabArtifactSource({
    project: {
      host: 'gitlab.example.test',
      project: projectPath,
      provider: 'gitlab',
    },
    projectPath,
    transport,
  });
  const signal = new AbortController().signal;
  const result = await source.readStackAndRange(
    { headSha: revisions.head as GitSha, requestedBaseSha: revisions.base as GitSha },
    signal,
  );
  const commits = await source.readCommitArtifacts(
    [{ commitSha: revisions.head as GitSha, parentSha: revisions.base as GitSha }],
    signal,
  );
  const blobs = await source.readFileBlobs?.(
    [{ path: 'src/app.ts', ref: revisions.head as GitSha }],
    signal,
  );

  expect(commits.size).toBe(1);
  expect(result.stack.commits.map((commit: { sha: string }) => commit.sha)).toEqual([
    revisions.head,
  ]);
  expect(result.range.files).toHaveLength(1);
  expect([...blobs!.values()][0]?.bytes).toEqual(new TextEncoder().encode('provider mock'));
  expect(transport.calls.map(({ path }) => path)).toEqual([
    `/api/v4/projects/${encodeURIComponent(projectPath)}/repository/compare`,
    `/api/v4/projects/${encodeURIComponent(projectPath)}/repository/compare`,
    `/api/v4/projects/${encodeURIComponent(projectPath)}/repository/files/src%2Fapp.ts`,
  ]);
});
