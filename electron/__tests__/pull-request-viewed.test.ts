import { execFile } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';
import type { RepositoryState, SetPullRequestFileViewedRequest } from '../../core/types.ts';

const require = createRequire(import.meta.url);
const { readPullRequestState, readPullRequestViewedFiles, setPullRequestFileViewed } =
  require('../git-state/pull-request.cjs') as {
    readPullRequestState: (
      path: string,
      source: SetPullRequestFileViewedRequest['source'],
    ) => Promise<RepositoryState>;
    readPullRequestViewedFiles: (
      path: string,
      reference: typeof pullRequest,
    ) => Promise<{ headSha: string; paths: Set<string> }>;
    setPullRequestFileViewed: (
      path: string,
      request: SetPullRequestFileViewedRequest,
    ) => Promise<void>;
  };
const execFileAsync = promisify(execFile);
const pullRequest = {
  number: 12,
  owner: 'nkzw-tech',
  repo: 'codiff',
  url: 'https://github.com/nkzw-tech/codiff/pull/12',
};
const source = { provider: 'github', type: 'pull-request', url: pullRequest.url } as const;

const createFixture = async (path: string) => {
  const fakeGh = join(path, 'gh');
  const callsPath = join(path, 'calls.jsonl');
  await execFileAsync('git', ['-C', path, 'init']);
  await execFileAsync('git', [
    '-C',
    path,
    'remote',
    'add',
    'origin',
    'git@github.com:nkzw-tech/codiff.git',
  ]);
  await writeFile(
    fakeGh,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  appendFileSync(process.env.CODIFF_VIEWED_TEST_CALLS, JSON.stringify({args, input}) + '\\n');
  const payload = input ? JSON.parse(input) : null;
  let response;
  if (args.includes('graphql')) {
    if (process.env.CODIFF_VIEWED_TEST_ERROR) {
      response = {errors: [{message: 'Permission denied'}]};
    } else if (payload) {
      const mutation = payload.query.includes('unmarkFileAsViewed') ? 'unmarkFileAsViewed' : 'markFileAsViewed';
      response = {data: {[mutation]: {clientMutationId: null}}};
    } else if (args.some(arg => arg.includes('reviewThreads'))) {
      response = {};
    } else {
      const second = args.includes('cursor=next-page');
      response = {data: {repository: {pullRequest: {
        headRefOid: process.env.CODIFF_VIEWED_TEST_HEAD || 'head-sha',
        files: {
          nodes: second ? [{path: 'renamed.ts', viewerViewedState: 'VIEWED'}] : [
            {path: 'viewed.ts', viewerViewedState: 'VIEWED'},
            {path: 'dismissed.ts', viewerViewedState: 'DISMISSED'},
            {path: 'unviewed.ts', viewerViewedState: 'UNVIEWED'}
          ],
          pageInfo: {hasNextPage: !second, endCursor: second ? null : 'next-page'}
        }
      }}}};
    }
  } else if (args.some(arg => arg.includes('/files?'))) {
    response = [[...['viewed.ts', 'dismissed.ts', 'unviewed.ts', 'renamed.ts'].map(filename => ({filename, status: 'modified', patch: '@@ -1 +1 @@\\n-old\\n+new'}))]];
  } else if (args.some(arg => arg.includes('/comments?'))) {
    response = [[]];
  } else if (args.includes('Accept: application/vnd.github.v3.diff')) {
    process.stdout.write('');
    return;
  } else {
    response = {node_id: 'PR_test', head: {sha: 'head-sha'}, ...JSON.parse(process.env.CODIFF_PR_TEST_METADATA || '{}')};
  }
  process.stdout.write(JSON.stringify(response));
});
`,
  );
  await chmod(fakeGh, 0o755);
  return {
    callsPath,
    environment: createTemporaryEnvironment({
      CODIFF_GH_PATH: fakeGh,
      CODIFF_PR_TEST_METADATA: undefined,
      CODIFF_VIEWED_TEST_CALLS: callsPath,
      CODIFF_VIEWED_TEST_ERROR: undefined,
      CODIFF_VIEWED_TEST_HEAD: undefined,
      SHELL: undefined,
    }),
  };
};

test('loads viewed progress across pages and attaches current file fingerprints', async () => {
  await using directory = await createTemporaryDirectory('codiff-viewed-');
  const fixture = await createFixture(directory.path);
  using _environment = fixture.environment;
  const progress = await readPullRequestViewedFiles(directory.path, pullRequest);
  expect(progress.paths).toEqual(new Set(['viewed.ts', 'renamed.ts']));
  const state = await readPullRequestState(directory.path, source);
  expect(state.viewedFiles).toEqual(
    Object.fromEntries(
      state.files
        .filter((file) => file.path === 'viewed.ts' || file.path === 'renamed.ts')
        .map((file) => [file.path, file.fingerprint]),
    ),
  );
  expect(state.files).toHaveLength(4);
  expect(state.descriptionAssetUrls).toBeUndefined();
  const calls = (await readFile(fixture.callsPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(calls.some((call) => call.args.includes('cursor=next-page'))).toBe(true);
});

test('keeps signed PR attachment URLs separate from the serializable review source', async () => {
  await using directory = await createTemporaryDirectory('codiff-pr-assets-');
  const fixture = await createFixture(directory.path);
  using _environment = fixture.environment;
  const videoId = '013867d7-8788-4446-9c66-75d6ba74a91a';
  const imageId = 'c29fc8d3-f2b1-41e3-8759-83a840c6aef2';
  const description = `https://github.com/user-attachments/assets/${videoId}`;
  const video = `https://private-user-images.githubusercontent.com/1/2-${videoId}.webm?jwt=video`;
  const image = `https://private-user-images.githubusercontent.com/1/3-${imageId.toUpperCase()}.png?jwt=image&amp;v=1`;
  using _metadata = createTemporaryEnvironment({
    CODIFF_PR_TEST_METADATA: JSON.stringify({
      body: description,
      body_html: [
        `<video src="${video}" data-canonical-src="${video}" controls></video>`,
        `<a href="${image}"><img alt="screen" src="${image}"></a>`,
        '<img src="https://avatars.githubusercontent.com/u/1?v=4">',
      ].join('\n'),
    }),
  });

  const state = await readPullRequestState(directory.path, source);
  expect(state.descriptionAssetUrls).toEqual({
    [imageId]: image.replace('&amp;', '&'),
    [videoId]: video,
  });
  expect(state.source).toMatchObject({ description });
  expect(JSON.stringify(state.source)).not.toContain('jwt=');
});

test('keeps the PR usable when progress lookup fails or belongs to a newer head', async () => {
  await using directory = await createTemporaryDirectory('codiff-viewed-');
  const fixture = await createFixture(directory.path);
  using _environment = fixture.environment;
  using _error = createTemporaryEnvironment({ CODIFF_VIEWED_TEST_ERROR: '1' });
  const failed = await readPullRequestState(directory.path, source);
  expect(failed.files).toHaveLength(4);
  expect(failed.viewedFiles).toBeUndefined();
  using _newHead = createTemporaryEnvironment({
    CODIFF_VIEWED_TEST_ERROR: undefined,
    CODIFF_VIEWED_TEST_HEAD: 'new-head',
  });
  expect((await readPullRequestState(directory.path, source)).viewedFiles).toBeUndefined();
});

test('saves both checkbox states using GraphQL variables and reports API errors', async () => {
  await using directory = await createTemporaryDirectory('codiff-viewed-');
  const fixture = await createFixture(directory.path);
  using _environment = fixture.environment;
  const path = 'src/a "quoted" file.ts';
  await setPullRequestFileViewed(directory.path, { path, source, viewed: true });
  await setPullRequestFileViewed(directory.path, { path, source, viewed: false });
  const calls = (await readFile(fixture.callsPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const mutations = calls.filter((call) => call.input).map((call) => JSON.parse(call.input));
  expect(mutations).toHaveLength(2);
  expect(mutations[0].query).toContain('markFileAsViewed');
  expect(mutations[1].query).toContain('unmarkFileAsViewed');
  expect(mutations.map((mutation) => mutation.variables)).toEqual([
    { input: { path, pullRequestId: 'PR_test' } },
    { input: { path, pullRequestId: 'PR_test' } },
  ]);
  using _error = createTemporaryEnvironment({ CODIFF_VIEWED_TEST_ERROR: '1' });
  await expect(
    setPullRequestFileViewed(directory.path, { path, source, viewed: true }),
  ).rejects.toThrow('Permission denied');
});

test('requires a refresh before marking an older PR head as viewed', async () => {
  await using directory = await createTemporaryDirectory('codiff-viewed-');
  const fixture = await createFixture(directory.path);
  using _environment = fixture.environment;
  await expect(
    setPullRequestFileViewed(directory.path, {
      path: 'viewed.ts',
      source: { ...source, headSha: 'old-head' },
      viewed: true,
    }),
  ).rejects.toThrow('Refresh before marking files as Viewed');
  const calls = (await readFile(fixture.callsPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(calls.some((call) => call.input)).toBe(false);
});
